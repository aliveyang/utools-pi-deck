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
let auditCore = null
try { auditCore = require('./shared/audit.cjs') }
catch (_) { try { auditCore = require('../shared/audit.cjs') } catch (_) {} }
let configCore = null
try { configCore = require('./shared/config.cjs') }
catch (_) { try { configCore = require('../shared/config.cjs') } catch (_) {} }

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
    pickFolder: () => null, validateCwd: () => false, effectiveCwd: p => p || os.homedir(), resolveCwd: p => p || os.homedir(),
    homedir: () => os.homedir(),
    auditTail: () => [], auditExport: () => '', auditDir: () => '', auditClear: () => ({ removed: 0, failed: 0 }), auditRecord: () => false,
    configState: () => ({ ok: false, error: 'pi-core 加载失败' }),
    configSave: () => ({ ok: false, error: 'pi-core 加载失败' }),
    configRemoveKey: () => ({ ok: false, error: 'pi-core 加载失败' }),
    configAuthCheck: () => Promise.resolve({ status: 'unavailable' }),
    configLoginCommand: () => '',
    openTerminalForProvider: () => false,
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
const resolveCwd = core.resolveCwd
const validateCwd = core.validateCwd
const makeLineBuffer = core.makeLineBuffer
const makeTextStream = core.makeTextStream
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

// 用系统浏览器打开外链（uTools 内 target=_blank 常被拦，仅允许 http/https）
function openExternal(url) {
  const s = String(url || '').trim()
  if (!/^https?:\/\//i.test(s)) return false
  try {
    if (window.utools && window.utools.shellOpenExternal) { window.utools.shellOpenExternal(s); return true }
    if (window.utools && window.utools.shellOpenPath) { window.utools.shellOpenPath(s); return true }
  } catch (_) {}
  return false
}

// ---------- 操作审计（失败绝不影响主流程） ----------
function toolSummary(t) {
  if (!t) return '无工具'
  const bits = [(t.list || []).join(',') || '无内置工具']
  bits.push(t.mcp === 'off' ? 'MCP 关' : t.mcp === 'all' ? 'MCP 全部' : 'MCP ' + (t.mcpServers || '未指定'))
  if (t.ext) bits.push('扩展开')
  if (t.skills === 'off') bits.push('技能关')
  else if (t.skills === 'some') bits.push('技能 ' + (t.skillPaths || []).length + ' 个')
  if (t.context) bits.push('项目规范')
  if (t.trust) bits.push('项目配置')
  return bits.join(' · ')
}
function isRiskTool(name) {
  // 只读类之外的都算风险：覆盖 MCP / 扩展带来的写文件、执行命令等工具
  return !['read', 'grep', 'find', 'ls'].includes(String(name || ''))
}
function auditRecord(entry) {
  if (!auditCore) return false
  try { return auditCore.record(entry) } catch (_) { return false }
}
// 包装 handlers：工具级立即落盘，运行结束补一条汇总
function wrapHandlers(opts, handlers, ctx) {
  const h = handlers || {}
  const started = new Map()
  let usage = null
  let finished = false
  const base = {
    groupId: opts.groupId || '',
    groupName: opts.groupName || '',
    cwd: opts.cwd || '',
    perm: toolSummary(opts.tool),
    promptPreview: opts.promptPreview || '',
  }
  return {
    ...h,
    onUsage: u => { usage = u; h.onUsage && h.onUsage(u) },
    onTool: (phase, name, payload, id) => {
      const key = id || ('name:' + name)
      if (phase === 'start') {
        started.set(key, { args: payload, ts: Date.now() })
      } else {
        const s = started.get(key) || {}
        started.delete(key)
        auditRecord({
          type: 'tool', ...base, engine: ctx.engine, risk: isRiskTool(name),
          tool: { name, args: s.args, result: payload, durationMs: s.ts ? Date.now() - s.ts : 0 },
        })
      }
      h.onTool && h.onTool(phase, name, payload, id)
    },
    onDone: payload => {
      if (finished) return
      finished = true
      auditRecord({ type: 'run', ...base, engine: ctx.engine, usage, aborted: !!(payload && payload.aborted) })
      h.onDone && h.onDone(payload)
    },
    onError: msg => {
      if (finished) return
      finished = true
      auditRecord({ type: 'run', ...base, engine: ctx.engine, usage, error: String(msg || '') })
      h.onError && h.onError(msg)
    },
  }
}

// 打开终端执行登录命令：Windows 写临时 .cmd 规避引号转义，macOS 走 AppleScript
function openTerminal(command) {
  const safeCmd = String(command || '').trim()
  if (!safeCmd) return false
  try {
    if (process.platform === 'win32') {
      const file = path.join(os.tmpdir(), 'pideck-login.cmd')
      fs.writeFileSync(file, `@echo off\r\n${safeCmd}\r\n`, { encoding: 'utf8', mode: 0o600 })
      // start 的第一个参数是窗口标题（空串）；文件路径加引号以兼容含空格的 %TEMP%
      const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', `"${file}"`], {
        detached: true, stdio: 'ignore', windowsHide: false,
      })
      child.on('error', () => {})
      child.unref()
      return true
    }
    if (process.platform === 'darwin') {
      const script = `tell application "Terminal" to do script ${JSON.stringify(safeCmd)}`
      const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
      return true
    }
    return false
  } catch (_) { return false }
}

// ---------- Pi 调用 ----------
let currentChild = null
let activeRpcCancel = null

function run(opts, handlers) {
  if (currentChild || activeRpcCancel) throw new Error('已有任务运行中，请先取消')
  // 禁工具且未开 MCP/扩展的纯文本分组：替换 system prompt，避免模型输出原始工具调用标记
  opts = core.applyLeanSystemPrompt(opts)
  const cfg = loadConfig()
  // RPC 引擎：已预热且无非图片附件时走长驻进程；否则回退 JSON 模式并懒预热
  const canRpc = !(rpcEngine && rpcEngine.hasNonImageFiles && rpcEngine.hasNonImageFiles(opts.files))
  // 历史会话只有在常驻进程已持有同一会话时才走 RPC；否则强制单次调用，保证落盘会话续接
  const rpcHasSession = (canRpc && rpcEngine && rpcEngine.hasSession)
    ? rpcEngine.hasSession(opts.cwd, opts, opts.sessionId) : false
  const mustUseJson = !!opts.hasLocalHistory && !rpcHasSession
  const ctx = { engine: 'json' }
  const wrapped = wrapHandlers(opts, handlers, ctx)
  if (cfg.engine === 'rpc' && rpcEngine && canRpc && !mustUseJson) {
    if (!rpcEngine.isReady(opts.cwd, opts)) {
      // 懒预热：本条回退 JSON，后台建立长驻进程，下一条新会话起零冷启动
      try { rpcEngine.prewarm(opts.cwd, opts).catch(() => {}) } catch (_) {}
    } else {
      try {
        const clearActive = () => { if (activeRpcCancel === doCancel) activeRpcCancel = null }
        let rpcHandle = null
        const doCancel = () => {
          clearActive()
          if (rpcHandle && rpcHandle.cancel) rpcHandle.cancel()
        }
        activeRpcCancel = doCancel
        ctx.engine = 'rpc'
        rpcHandle = rpcEngine.prompt(opts.cwd, opts, {
          ...wrapped,
          onDone: payload => { clearActive(); wrapped.onDone && wrapped.onDone(payload) },
          onError: msg => { clearActive(); wrapped.onError && wrapped.onError(msg) },
        })
        return { cancel: doCancel, mode: 'rpc' }
      } catch (_) {
        activeRpcCancel = null
        // RPC 不可用，静默回退 JSON
      }
    }
  }

  ctx.engine = 'json'
  // 该会话是否已落盘：RPC 产生历史没有磁盘文件，回退 JSON 时模型看不到旧上下文
  const sessionResumed = mustUseJson && core.hasPiSession ? core.hasPiSession(opts.sessionId) : true
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
    wrapped.onDone && wrapped.onDone(payload)
  }

  child.stdout.on('data', chunk => {
    pushChunk(buf, chunk, rec => {
      const settled = core.mapPiEvent(rec, wrapped)
      if (settled) finish({ aborted: false })
    })
  })

  let stderr = ''
  const errStream = makeTextStream()
  child.stderr.on('data', c => {
    if (stderr.length < 16000) stderr += errStream.push(c).slice(0, 8000)
  })

  const release = () => {
    if (currentChild === child) currentChild = null
  }
  child.on('error', err => {
    settled = true
    release()
    wrapped.onError && wrapped.onError(String(err && err.message || err))
  })
  child.on('close', code => {
    release()
    if (!settled) {
      settled = true
      if (aborted) finish({ aborted: true })
      else {
        const msg = stderr.trim()
        wrapped.onError && wrapped.onError(msg ? `pi 退出（code ${code}）：${msg.slice(-1200)}` : `pi 退出（code ${code}）`)
      }
    } else {
      wrapped.onClose && wrapped.onClose(code)
    }
  })

  // watchdog：15 分钟无结束则强杀
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true
      aborted = true
      release()
      try { child.kill() } catch (_) {}
      wrapped.onError && wrapped.onError('pi 运行超时（15 分钟），已终止')
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
    sessionResumed,
  }
}

function cancel() {
  if (activeRpcCancel) {
    const fn = activeRpcCancel
    activeRpcCancel = null
    try { fn(); return true } catch (_) { return false }
  }
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
      resolve(core.parseModelsOutput(stdout))
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
  resolveCwd,
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
    return rpcEngine.prewarm(cwd, core.applyLeanSystemPrompt(flags || {}))
  },
  stopRpc: () => (rpcEngine ? rpcEngine.stop() : null),
  // 操作审计：本地 JSONL，脱敏、按天分片
  auditTail: n => (auditCore ? auditCore.tail(n) : []),
  auditExport: days => (auditCore ? auditCore.exportMd(days) : ''),
  auditDir: () => (auditCore ? auditCore.dir() : ''),
  auditClear: () => (auditCore ? auditCore.clear() : { removed: 0, failed: 0 }),
  auditRecord,
  // pi 配置：读写 settings.json / models.json（不回传密钥）
  configState: () => (configCore ? { ok: true, ...configCore.getState() } : { ok: false, error: '配置模块加载失败' }),
  configSave: input => (configCore ? configCore.save(input) : { ok: false, error: '配置模块加载失败' }),
  configRemoveKey: provider => (configCore ? configCore.removeKey(provider) : { ok: false, error: '配置模块加载失败' }),
  configAuthCheck: provider => (configCore ? configCore.authCheck(provider) : Promise.resolve({ status: 'unavailable' })),
  configLoginCommand: provider => (configCore ? configCore.loginCommand(provider) : ''),
  openTerminalForProvider: provider => (configCore ? openTerminal(configCore.loginCommand(provider)) : false),
  resolvePi: () => {
    try { const r = resolvePi(); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: String(e.message || e) } }
  },
  homedir: () => os.homedir(),
}
}
