// PiDeck preload：渲染进程 ↔ Node 桥接
// 核心逻辑在 shared/pi-core.cjs（dev 用 ../shared，构建后 dist 用 ./shared）
let core = null
let coreErr = ''
try { core = require('./shared/pi-core.cjs') }
catch (e1) {
  try { core = require('../shared/pi-core.cjs') }
  catch (e2) { coreErr = `${e1.message} / ${e2.message}` }
}
let rpcEngine = null
try { rpcEngine = require('./shared/rpc-engine.cjs') }
catch (_) { try { rpcEngine = require('../shared/rpc-engine.cjs') } catch (_) {} }

// core 加载失败时不崩溃，降级为只暴露 resolvePi 错误信息
const { spawn } = require('node:child_process')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

if (!core) {
  // core 加载失败时的降级桥：字段需与正常分支保持一致，避免前端取到 undefined
  window.piBridge = {
    resolvePi: () => ({ ok: false, error: 'pi-core 加载失败：' + coreErr }),
    getConfig: () => ({}), setConfig: () => ({}),
    prewarmRpc: () => Promise.resolve(false), stopRpc: () => {},
    listSkills: () => [], listModels: () => [], listModelsAsync: () => Promise.resolve([]),
    listFiles: () => [], refreshModels: () => [],
    detectContextFiles: () => [], getDefaults: () => Promise.resolve({}),
    getEnv: () => ({ ok: false, errorCode: '', error: 'pi-core 加载失败', agentDir: '', configs: [] }),
    deletePiSession: () => ({ ok: false, removed: 0 }),
    saveTextFile: () => ({ ok: false, unsupported: true }),
    openExternal: () => false, openPath: () => false,
    run: () => { throw new Error('pi-core 加载失败：' + coreErr) },
    cancel: () => {}, saveImage: () => { throw new Error('pi-core 加载失败') },
    pickFolder: () => null, validateCwd: () => false, effectiveCwd: p => p || os.homedir(),
    homedir: () => os.homedir(),
  }
} else {
  boot()
}

function boot() {

// uTools 可能在 Vue 挂载前派发进入事件：preload 最早接住并缓存，渲染层挂载后再取
if (window.utools && window.utools.onPluginEnter) {
  window.__pideckEnterQueue = window.__pideckEnterQueue || []
  window.utools.onPluginEnter(action => {
    window.__pideckEnterQueue.push(action)
    window.dispatchEvent(new CustomEvent('pideck:enter', { detail: action }))
  })
}

// ---------- 全局配置（跨唤起持久） ----------
const CONFIG_FILE = core.path.join(core.os.homedir(), '.pideck', 'config.json')
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch (_) { return {} }
}
function saveConfig(patch) {
  try {
    const c = { ...loadConfig(), ...patch }
    fs.mkdirSync(core.path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2))
    return c
  } catch (_) { return loadConfig() }
}

const resolvePi = core.resolvePi
const effectiveCwd = core.effectiveCwd
const validateCwd = core.validateCwd
const makeLineBuffer = core.makeLineBuffer
const pushChunk = core.pushChunk

// ---------- 图片落盘 ----------
const MAX_IMAGE_BYTES = 20 * 1024 * 1024   // 单图上限 20MB
const IMAGE_DIR = path.join(os.tmpdir(), 'pideck-images')
// 清理临时图片：超过 24h 的删除，避免长期使用堆积
function cleanupImages() {
  try {
    if (!fs.existsSync(IMAGE_DIR)) return 0
    const now = Date.now()
    let n = 0
    for (const f of fs.readdirSync(IMAGE_DIR)) {
      const p = path.join(IMAGE_DIR, f)
      try {
        const st = fs.statSync(p)
        if (!st.isFile()) continue
        if (now - st.mtimeMs > 24 * 3600 * 1000) { fs.unlinkSync(p); n++ }
      } catch (_) {}
    }
    return n
  } catch (_) { return 0 }
}
function saveImage(dataUrl) {
  const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.*)$/s.exec(dataUrl || '')
  if (!m) throw new Error('图片格式无效，仅支持 data:image/...;base64,...')
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg')
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大（${(buf.length / 1048576).toFixed(1)}MB），单张上限 ${MAX_IMAGE_BYTES / 1048576}MB`)
  }
  const dir = IMAGE_DIR
  fs.mkdirSync(dir, { recursive: true })
  maybeCleanupImages()
  const file = path.join(dir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`)
  fs.writeFileSync(file, buf)
  return file
}
// 首次落盘时顺带清理过期图片（此时 IMAGE_DIR 已初始化）
let _imgCleaned = false
function maybeCleanupImages() {
  if (_imgCleaned) return
  _imgCleaned = true
  try { cleanupImages() } catch (_) {}
}

// 保存文本文件：优先 uTools 保存对话框（Electron 下 a[download] 不可靠）
function saveTextFile(name, content) {
  const safeName = String(name || 'export.md').replace(/[\\/:*?"<>|]/g, '_')
  try {
    if (window.utools && window.utools.showSaveDialog) {
      const target = window.utools.showSaveDialog({
        title: '导出会话',
        defaultPath: path.join(os.homedir(), safeName),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (!target) return { ok: false, canceled: true }
      fs.writeFileSync(target, content, 'utf8')
      return { ok: true, path: target }
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
  return { ok: false, unsupported: true }
}

// 用系统浏览器打开外链（uTools 内 target=_blank 常被拦）
function openExternal(url) {
  try {
    if (window.utools && window.utools.shellOpenExternal) { window.utools.shellOpenExternal(url); return true }
    if (window.utools && window.utools.shellOpenPath) { window.utools.shellOpenPath(url); return true }
  } catch (_) {}
  return false
}

// ---------- Pi 调用 ----------
let currentChild = null

function run(opts, handlers) {
  if (currentChild) throw new Error('已有任务运行中，请先取消')
  // 禁工具的纯文本分组：必须替换 system prompt，否则模型输出原始工具调用标记
  if (core.permFlags(opts.perm, opts).noTools && !opts.systemPrompt) opts = { ...opts, systemPrompt: core.LEAN_SYSTEM_PROMPT }
  const cfg = loadConfig()
  // RPC 引擎：已预热则走长驻进程（零冷启动）；否则回退 JSON 模式
  if (cfg.engine === 'rpc' && rpcEngine && rpcEngine.isReady(opts.cwd, opts)) {
    let rpcHandle
    try {
      rpcHandle = rpcEngine.prompt(opts.cwd, opts, {
        ...handlers,
        onDone: payload => { handlers.onDone && handlers.onDone(payload) },
      })
      return {
        cancel: () => { if (rpcHandle && rpcHandle.cancel) rpcHandle.cancel() },
        mode: 'rpc',
      }
    } catch (_) {
      // RPC 不可用，静默回退 JSON
    }
  }

  const { node } = resolvePi()
  const args = core.buildArgs(opts)

  const child = spawn(node, args, {
    cwd: effectiveCwd(opts.cwd),
    env: { ...process.env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  currentChild = child

  const buf = makeLineBuffer()
  let settled = false
  let aborted = false
  const finish = (payload) => {
    if (settled) return
    settled = true
    handlers.onDone && handlers.onDone(payload)
  }

  child.stdout.on('data', chunk => {
    pushChunk(buf, chunk, rec => {
      const settled = core.mapPiEvent(rec, handlers)
      if (settled) finish({ aborted: false })
    })
  })

  let stderr = ''
  child.stderr.on('data', c => {
    if (stderr.length < 16000) stderr += c.toString('utf8').slice(0, 8000)
  })

  const release = () => {
    if (currentChild === child) currentChild = null
  }
  child.on('error', err => {
    settled = true
    release()
    handlers.onError && handlers.onError(String(err && err.message || err))
  })
  child.on('close', code => {
    release()
    if (!settled) {
      settled = true
      if (aborted) finish({ aborted: true })
      else {
        const msg = stderr.trim()
        handlers.onError && handlers.onError(msg ? `pi 退出（code ${code}）：${msg.slice(-1200)}` : `pi 退出（code ${code}）`)
      }
    } else {
      handlers.onClose && handlers.onClose(code)
    }
  })

  // watchdog：15 分钟无结束则强杀
  const timer = setTimeout(() => {
    if (!settled) {
      aborted = true
      try { child.kill() } catch (_) {}
      handlers.onError && handlers.onError('pi 运行超时（15 分钟），已终止')
    }
  }, 15 * 60 * 1000)
  child.on('close', () => clearTimeout(timer))

  return {
    cancel: () => {
      aborted = true
      // 立即释放，避免 kill→close 窗口期内新发送被"任务运行中"拒绝
      if (currentChild === child) currentChild = null
      try { child.kill() } catch (_) {}
    },
    mode: 'json',
  }
}

function cancel() {
  if (!currentChild) return false
  const child = currentChild
  // 立即释放引用：kill 到 close 有延迟，期间用户再发送会被误判为"任务运行中"
  currentChild = null
  try { child.kill(); return true } catch (_) { return false }
}

function pickFolder() {
  if (!window.utools || !window.utools.showOpenDialog) return null
  const r = window.utools.showOpenDialog({
    title: '选择工作文件夹',
    defaultPath: os.homedir(),
    properties: ['openDirectory'],
  })
  return r && r[0] ? r[0] : null
}

// 异步模型列表（不阻塞 preload 线程）
function listModelsAsync() {
  return new Promise((resolve, reject) => {
    const { node, cli } = resolvePi()
    execFile(node, [cli, '--list-models'], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      const out = []
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim() || /^provider\s+model/i.test(line)) continue
        const parts = line.trim().split(/\s{2,}|\s+/)
        if (parts.length >= 2) out.push({ provider: parts[0], model: parts[1], display: `${parts[0]}/${parts[1]}` })
      }
      resolve(out)
    })
  })
}

window.piBridge = {
  run,
  cancel,
  saveImage,
  pickFolder,
  validateCwd,
  effectiveCwd,
  listSkills: core.listSkills,
  listModels: core.listModels,
  listModelsAsync,
  refreshModels: () => core.listModels(true),
  listFiles: core.listFiles,
  detectContextFiles: cwd => core.detectContextFiles(cwd),
  getDefaults: cwd => core.getDefaults(cwd),
  deletePiSession: id => core.deletePiSession(id),
  getEnv: () => core.getEnv(),
  saveTextFile,
  openExternal,
  // 在系统文件管理器中定位文件/目录（uTools 能力）
  openPath: p => {
    try {
      let isDir = false
      try { isDir = !!(p && fs.existsSync(p) && fs.statSync(p).isDirectory()) } catch (_) {}
      if (isDir && window.utools && window.utools.shellOpenPath) {
        window.utools.shellOpenPath(p); return true
      }
      if (!isDir && window.utools && window.utools.shellShowItemInFolder && fs.existsSync(p)) {
        window.utools.shellShowItemInFolder(p); return true
      }
      if (window.utools && window.utools.shellOpenPath) { window.utools.shellOpenPath(p); return true }
    } catch (_) {}
    return false
  },
  // RPC 引擎与配置
  getConfig: loadConfig,
  setConfig: patch => saveConfig(patch),
  prewarmRpc: (cwd, flags) => {
    if (!rpcEngine) return Promise.resolve(false)
    const f = flags || {}
    return rpcEngine.prewarm(cwd, core.permFlags(f.perm, f).noTools && !f.systemPrompt ? { ...f, systemPrompt: core.LEAN_SYSTEM_PROMPT } : f)
  },
  stopRpc: () => (rpcEngine ? rpcEngine.stop() : null),
  resolvePi: () => {
    try { const r = resolvePi(); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: String(e.message || e) } }
  },
  homedir: () => os.homedir(),
}
}
