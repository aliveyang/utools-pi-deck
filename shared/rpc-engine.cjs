// RPC 长驻引擎：按 cwd + 权限 + systemPrompt 维护 pi --mode rpc 子进程，预热后发送零冷启动
// 失败/不存活/含非图片附件时由调用方回退 JSON 模式
const childProcess = require('node:child_process')
const defaultCore = require('./pi-core.cjs')

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif'])

function isImageFile(f) {
  if (typeof f !== 'string' || !f) return false
  if (/^data:image\//i.test(f)) return true
  const m = /\.([a-zA-Z0-9]+)$/.exec(f)
  return !!(m && IMAGE_EXTS.has(m[1].toLowerCase()))
}

function hasNonImageFiles(files) {
  return Array.isArray(files) && files.some(f => f && !isImageFile(f))
}

function createRpcEngine(deps = {}) {
  const spawn = deps.spawn || childProcess.spawn
  const core = deps.core || defaultCore
  const IDLE_TTL = deps.idleTtl ?? (10 * 60 * 1000)
  const MAX_PROCS = deps.maxProcs ?? 3
  const CLEANUP_INTERVAL = deps.cleanupInterval ?? (60 * 1000)

  const processes = new Map() // key -> entry
  let seq = 0

  function isBusy(e) {
    return !!(e && (e.listeners.size > 0 || e.pending.size > 0))
  }

  // 超出上限时只淘汰空闲且最久未使用的进程，避免误杀正在运行中的任务或刚创建的条目
  function evictOverflow(keepKey) {
    while (processes.size > MAX_PROCS) {
      let oldestKey = null, oldest = Infinity
      for (const [k, e] of processes) {
        if (k === keepKey || isBusy(e)) continue
        if (!e.lastUsed || e.lastUsed < oldest) { oldest = e.lastUsed || 0; oldestKey = k }
      }
      if (!oldestKey) break
      const e = processes.get(oldestKey)
      try { e.child.stdin.end() } catch (_) {}
      setTimeout(() => { try { e.child.kill() } catch (_) {} }, 3000)
      processes.delete(oldestKey)
    }
  }

  function getEntry(key) {
    const e = processes.get(key)
    if (e && e.alive) { e.lastUsed = Date.now(); return e }
    if (e && !e.alive) processes.delete(key)
    return null
  }

  function keyOf(cwd, flags) {
    const f = flags || {}
    return [core.effectiveCwd(cwd), core.buildPermArgs(f.tool, f).join('\0'), f.systemPrompt || ''].join('\x1f')
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
      try {
        e.child.stdin.write(JSON.stringify({ ...cmdObj, id }) + '\n')
      } catch (err) {
        clearTimeout(timer)
        e.pending.delete(id)
        reject(err)
      }
    })
  }

  // 启动/复用一个 key 对应的 RPC 进程；并发调用复用同一 readyPromise
  function ensure(cwd, flags) {
    const f = flags || {}
    const key = keyOf(cwd, f)
    const existing = getEntry(key)
    if (existing) return existing.readyPromise
    const { node, cli } = core.resolvePi()
    const args = [cli, '--mode', 'rpc', '--no-session']
    args.push(...core.buildPermArgs(f.tool, f))
    if (f.systemPrompt) args.push('--system-prompt', f.systemPrompt)
    const child = spawn(node, args, {
      cwd: core.effectiveCwd(cwd), windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const e = {
      child, key, alive: true, ready: false, lastUsed: Date.now(),
      sessionId: '',
      defaultModel: '', defaultThinking: '',
      curModel: '', curThinking: '',
      lineBuf: core.makeLineBuffer(),
      pending: new Map(), listeners: new Set(),
      readyPromise: null,
    }
    processes.set(key, e)
    evictOverflow(key)

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
      core.pushChunk(e.lineBuf, chunk, handle)
    })
    child.stderr.on('data', () => {})
    const die = () => {
      e.alive = false; e.ready = false
      // 仅当 map 里还是本条目时才移除：延迟 kill 期间同 key 可能已重建新进程
      if (processes.get(key) === e) processes.delete(key)
      // 挂起中的 RPC 命令立即拒绝，不等 60s 超时；监听器一并清理
      for (const p of e.pending.values()) { try { p.reject(new Error('RPC 进程已退出')) } catch (_) {} }
      e.pending.clear()
      e.listeners.clear()
    }
    child.on('error', die)
    child.on('exit', die)

    // get_state 探测就绪并记录默认模型/思考强度，便于切换回默认分组时复位
    e.readyPromise = send(e, { type: 'get_state' }).then(d => {
      const state = d || {}
      e.defaultModel = (state.model && state.model.id) || ''
      e.defaultThinking = state.thinkingLevel || ''
      e.curModel = e.defaultModel
      e.curThinking = e.defaultThinking
      e.ready = true
      return e
    })
    // 防止无人 await 时触发 unhandledRejection
    e.readyPromise.catch(() => {})
    return e.readyPromise
  }

  // 发送 prompt，事件通过 handlers 回调等价格式（与 JSON 模式一致）
  // 前置条件不满足时同步抛错，确保调用方 try/catch 可立即回退 JSON 模式
  function prompt(cwd, opts, handlers) {
    const o = opts || {}
    const h = handlers || {}
    if (hasNonImageFiles(o.files)) throw new Error('RPC 模式不支持非图片文件')
    const key = keyOf(cwd, o)
    const entry = getEntry(key)
    if (!entry || !entry.alive || !entry.ready) throw new Error('RPC 未预热')
    if (isBusy(entry)) throw new Error('RPC 进程忙碌中')

    const applyCfg = async () => {
      // PiDeck 会话切换时先重置进程内对话；未传 sessionId 时也强制重置防止串上下文
      if (!o.sessionId || (entry.sessionId || '') !== (o.sessionId || '')) {
        await send(entry, { type: 'new_session' })
        entry.sessionId = o.sessionId || ''
      }
      const wantModel = o.model || entry.defaultModel
      if (wantModel && wantModel !== entry.curModel) {
        await send(entry, { type: 'set_model', model: wantModel })
          .then(() => { entry.curModel = wantModel })
          .catch(() => {})
      }
      const wantThinking = o.thinking || entry.defaultThinking
      if (wantThinking && wantThinking !== entry.curThinking) {
        await send(entry, { type: 'set_thinking_level', level: wantThinking })
          .then(() => { entry.curThinking = wantThinking })
          .catch(() => {})
      }
    }

    let aborted = false
    let settled = false

    const cleanup = () => {
      clearTimeout(watchdog)
      entry.listeners.delete(listener)
      if (entry.child.off) entry.child.off('exit', onExit)
      else if (entry.child.removeListener) entry.child.removeListener('exit', onExit)
      entry.lastUsed = Date.now()
    }
    const finish = payload => {
      if (settled) return
      settled = true
      cleanup()
      h.onDone && h.onDone(payload)
    }
    const fail = msg => {
      if (settled) return
      settled = true
      cleanup()
      h.onError && h.onError(msg)
    }

    const listener = rec => {
      const done = core.mapPiEvent(rec, h)
      if (done && !aborted) finish({ aborted: false })
    }
    entry.listeners.add(listener)

    // 与 JSON 模式一致的 15 分钟看门狗：防止 RPC 卡死导致界面永远"运行中"
    const watchdog = setTimeout(() => {
      if (settled) return
      aborted = true
      send(entry, { type: 'abort' }).catch(() => {})
      fail('运行超时（15 分钟），已中止')
    }, 15 * 60 * 1000)

    // 进程中途退出：立即报错收口，不等 15 分钟 watchdog
    const onExit = () => fail('RPC 进程已退出，本次回答中断')
    entry.child.once('exit', onExit)

    // 图片：RPC 不支持 @file，用 images 字段
    const images = []
    for (const f of (o.files || [])) {
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
      .then(() => {
        if (settled) return
        return send(entry, { type: 'prompt', message: o.prompt || '', images })
      })
      .catch(err => fail(String((err && err.message) || err)))

    return {
      cancel: () => {
        aborted = true
        send(entry, { type: 'abort' }).catch(() => {})
        finish({ aborted: true })
      },
    }
  }

  function prewarm(cwd, flags) {
    return ensure(cwd, flags).then(() => true).catch(() => false)
  }

  function isReady(cwd, flags) {
    const e = getEntry(keyOf(cwd, flags))
    return !!(e && e.alive && e.ready)
  }

  // 该 key 的常驻进程当前是否正持有指定会话（用于判断历史会话能否走 RPC 续接）
  function hasSession(cwd, flags, sessionId) {
    if (!sessionId) return false
    const e = getEntry(keyOf(cwd, flags))
    return !!(e && e.alive && e.ready && e.sessionId === sessionId)
  }

  function stop() {
    for (const [, e] of processes) {
      try { e.child.stdin.end() } catch (_) {}
      setTimeout(() => { try { e.child.kill() } catch (_) {} }, 3000)
    }
    processes.clear()
  }

  function cleanupIdle() {
    const now = Date.now()
    for (const [key, e] of processes) {
      if (e.alive && !isBusy(e) && now - e.lastUsed > IDLE_TTL) {
        try { e.child.stdin.end() } catch (_) {}
        // 对齐 stop/evict：stdin 关闭后 3s 仍不退出则强杀，避免孤儿进程滞留
        setTimeout(() => { try { e.child.kill() } catch (_) {} }, 3000)
        processes.delete(key)
      }
    }
  }

  const cleanupTimer = setInterval(cleanupIdle, CLEANUP_INTERVAL)
  if (cleanupTimer.unref) cleanupTimer.unref()

  return { prewarm, isReady, hasSession, prompt, stop, ensure, keyOf, cleanupIdle, isBusy, _processes: processes }
}

const defaultEngine = createRpcEngine()

module.exports = {
  ...defaultEngine,
  createRpcEngine,
  isImageFile,
  hasNonImageFiles,
}
