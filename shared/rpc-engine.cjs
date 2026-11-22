// RPC 长驻引擎：按 cwd 维护 pi --mode rpc 子进程，预热后发送零冷启动
// 失败/不存活时由调用方回退 JSON 模式
const { spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')
const core = require('./pi-core.cjs')

const processes = new Map()   // key -> { child, buf, decoder, pending, alive, ready }
let seq = 0
const IDLE_TTL = 10 * 60 * 1000
const MAX_PROCS = 3           // 最多同时保留 3 个长驻进程，超出淘汰最久未用

// 超出上限时淘汰最久未使用的进程，避免内存无限增长
function evictOverflow() {
  while (processes.size > MAX_PROCS) {
    let oldestKey = null, oldest = Infinity
    for (const [k, e] of processes) {
      if (!e.lastUsed || e.lastUsed < oldest) { oldest = e.lastUsed || 0; oldestKey = k }
    }
    if (!oldestKey) break
    const e = processes.get(oldestKey)
    try { e.child.stdin.end() } catch (_) {}
    setTimeout(() => { try { e.child.kill() } catch (_) {} }, 3000)
    processes.delete(oldestKey)
  }
}

function getEntry(cwd) {
  let e = processes.get(cwd)
  if (e && e.alive) { e.lastUsed = Date.now(); return e }
  if (e && !e.alive) processes.delete(cwd)
  return null
}

// 启动/复用一个 cwd 对应的 RPC 进程（按 cwd + 上下文精简配置区分）
function ensure(cwd, flags) {
  const f = flags || {}
  const key = keyOf(cwd, f)
  const existing = getEntry(key)
  if (existing) return Promise.resolve(existing)
  const { node, cli } = core.resolvePi()
  const args = [cli, '--mode', 'rpc', '--no-session']
  args.push(...core.buildPermArgs(f.tool, f))
  if (f.systemPrompt) args.push('--system-prompt', f.systemPrompt)
  const child = spawn(node, args, {
    cwd: core.effectiveCwd(cwd), windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const e = {
    child, cwd: key, alive: true, ready: false, lastUsed: Date.now(),
    buf: '', decoder: new StringDecoder('utf8'),
    pending: new Map(), listeners: new Set(),
  }
  processes.set(key, e)
  evictOverflow()

  const handle = rec => {
    if (rec.type === 'response' && rec.id && e.pending.has(rec.id)) {
      const { resolve, reject } = e.pending.get(rec.id)
      e.pending.delete(rec.id)
      rec.success === false ? reject(new Error(rec.error || 'RPC 命令失败')) : resolve(rec.data)
      return
    }
    for (const l of e.listeners) { try { l(rec) } catch (_) {} }
  }
  child.stdout.on('data', chunk => {
    e.buf += e.decoder.write(chunk)
    let nl
    while ((nl = e.buf.indexOf('\n')) !== -1) {
      let line = e.buf.slice(0, nl); e.buf = e.buf.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line.trim()) continue
      let rec; try { rec = JSON.parse(line) } catch (_) { continue }
      handle(rec)
    }
  })
  child.stderr.on('data', () => {})
  const die = () => { e.alive = false; e.ready = false; processes.delete(key) }
  child.on('error', die)
  child.on('exit', die)

  // get_state 探测就绪
  return send(e, { type: 'get_state' }).then(() => { e.ready = true; return e })
}

function send(e, cmdObj) {
  if (!e.alive) return Promise.reject(new Error('RPC 进程已退出'))
  const id = cmdObj.id || ('r' + (++seq))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { e.pending.delete(id); reject(new Error('RPC 命令超时')) }, 60000)
    e.pending.set(id, {
      resolve: d => { clearTimeout(timer); resolve(d) },
      reject: err => { clearTimeout(timer); reject(err) },
    })
    e.child.stdin.write(JSON.stringify({ ...cmdObj, id }) + '\n')
  })
}

// 发送 prompt，事件通过 handlers 回调等价格式（与 JSON 模式一致）
function prompt(cwd, opts, handlers) {
  const key = keyOf(cwd, opts)
  let entry
  try { entry = getEntry(key) } catch (_) { return Promise.reject(new Error('RPC 未预热')) }
  if (!entry) return Promise.reject(new Error('RPC 未预热'))

  const applyCfg = async () => {
    if (opts.model) await send(entry, { type: 'set_model', model: opts.model }).catch(() => {})
    if (opts.thinking) await send(entry, { type: 'set_thinking_level', level: opts.thinking }).catch(() => {})
  }

  let aborted = false
  let settled = false
  const finish = payload => {
    if (settled) return
    settled = true
    clearTimeout(watchdog)
    entry.listeners.delete(listener)
    handlers.onDone && handlers.onDone(payload)
  }
  const listener = rec => {
    const settled = core.mapPiEvent(rec, handlers)
    if (settled && !aborted) finish({ aborted: false })
  }
  entry.listeners.add(listener)

  // 与 JSON 模式一致的 15 分钟看门狗：防止 RPC 卡死导致界面永远"运行中"
  const watchdog = setTimeout(() => {
    if (settled) return
    aborted = true
    entry.listeners.delete(listener)
    settled = true
    send(entry, { type: 'abort' }).catch(() => {})
    handlers.onError && handlers.onError('运行超时（15 分钟），已中止')
  }, 15 * 60 * 1000)

  // 图片：RPC 不支持 @file，用 images 字段
  const images = []
  for (const f of (opts.files || [])) {
    try {
      if (f.startsWith('data:')) {
        const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.*)$/s.exec(f)
        if (m) images.push({ type: 'image', data: m[2], mimeType: 'image/' + m[1] })
      } else {
        const data = core.fs.readFileSync(f)
        const ext = core.path.extname(f).slice(1).toLowerCase()
        images.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/' + (ext === 'jpg' ? 'jpeg' : ext || 'png') })
      }
    } catch (_) {}
  }

  applyCfg()
    .then(() => send(entry, { type: 'prompt', message: opts.prompt || '', images }))
    .then(() => {})
    .catch(err => {
      entry.listeners.delete(listener)
      handlers.onError && handlers.onError(String(err.message || err))
    })

  return {
    cancel: () => {
      aborted = true
      send(entry, { type: 'abort' }).catch(() => {})
      finish({ aborted: true })
    },
  }
}

function keyOf(cwd, flags) {
  const f = flags || {}
  return core.effectiveCwd(cwd) + '|' + [
    f.perm || '', f.tool ? JSON.stringify(f.tool) : '', f.systemPrompt ? 'sp' : '',
  ].join('')
}
function prewarm(cwd, flags) {
  return ensure(cwd, flags).then(() => true).catch(() => false)
}
function isReady(cwd, flags) {
  const e = getEntry(keyOf(cwd, flags))
  return !!(e && e.alive && e.ready)
}
function stop() {
  for (const [cwd, e] of processes) {
    try { e.child.stdin.end() } catch (_) {}
    setTimeout(() => { try { e.child.kill() } catch (_) {} }, 3000)
  }
  processes.clear()
}
function cleanupIdle() {
  const now = Date.now()
  for (const [cwd, e] of processes) {
    if (e.alive && now - e.lastUsed > IDLE_TTL) {
      try { e.child.stdin.end() } catch (_) {}
      processes.delete(cwd)
    }
  }
}
const cleanupTimer = setInterval(cleanupIdle, 60 * 1000)
if (cleanupTimer.unref) cleanupTimer.unref()

module.exports = { prewarm, isReady, prompt, stop, ensure }
