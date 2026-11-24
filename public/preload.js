// PiDeck preload：渲染进程 ↔ Node/uTools 薄桥接层
// 核心逻辑在 shared/*.cjs（dev 用 ../shared，构建后 dist 用 ./shared）
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
let localStoreMod = null
try { localStoreMod = require('./shared/local-store.cjs') }
catch (_) { try { localStoreMod = require('../shared/local-store.cjs') } catch (_) {} }
let runnerMod = null
try { runnerMod = require('./shared/runner.cjs') }
catch (_) { try { runnerMod = require('../shared/runner.cjs') } catch (_) {} }

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

if (!core || !localStoreMod || !runnerMod) {
  const errMsg = coreErr || 'shared 模块加载失败'
  // 降级桥：字段需与正常分支保持一致，避免前端取到 undefined
  window.piBridge = {
    resolvePi: () => ({ ok: false, error: 'pi-core 加载失败：' + errMsg }),
    getConfig: () => ({}), setConfig: () => ({}),
    readCache: () => null, writeCache: () => false,
    readLocal: (_k, fb) => fb, writeLocal: () => false,
    prewarmRpc: () => Promise.resolve(false), stopRpc: () => {},
    listSkills: () => [], listModels: () => [], listModelsAsync: () => Promise.resolve([]),
    listFiles: () => [], refreshModels: () => [],
    detectContextFiles: () => [], getDefaults: () => Promise.resolve({}),
    getEnv: () => ({ ok: false, errorCode: '', error: 'pi-core 加载失败', agentDir: '', configs: [] }),
    deletePiSession: () => ({ ok: false, removed: 0 }),
    saveTextFile: () => ({ ok: false, unsupported: true }),
    openExternal: () => false, openPath: () => false,
    run: () => { throw new Error('pi-core 加载失败：' + errMsg) },
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

  // 优先使用 uTools 插件专属临时目录与本地数据目录（不参与云同步）
  let pluginTempRoot = ''
  let pluginLocalRoot = ''
  try {
    if (window.utools && typeof window.utools.getPluginTempPath === 'function') {
      pluginTempRoot = window.utools.getPluginTempPath() || ''
    }
  } catch (_) {}
  try {
    if (window.utools && typeof window.utools.getPluginLocalDataPath === 'function') {
      pluginLocalRoot = window.utools.getPluginLocalDataPath() || ''
    }
  } catch (_) {}

  const store = localStoreMod.createLocalStore({
    ...(pluginTempRoot ? { cacheDir: path.join(pluginTempRoot, 'cache'), imageDir: path.join(pluginTempRoot, 'images') } : {}),
    ...(pluginLocalRoot ? { configFile: path.join(pluginLocalRoot, 'config.json'), localStateFile: path.join(pluginLocalRoot, 'state.json') } : {}),
    legacyConfigFile: path.join(os.homedir(), '.pideck', 'config.json'),
  })

  const audit = auditCore
    ? (pluginLocalRoot ? auditCore.createAudit({ root: path.join(pluginLocalRoot, 'audit') }) : auditCore)
    : null

  function auditRecord(entry) {
    if (!audit) return false
    try { return audit.record(entry) } catch (_) { return false }
  }

  const runner = runnerMod.createRunner({
    core,
    rpcEngine,
    auditRecord,
    loadConfig: () => store.loadConfig(),
    tempDir: pluginTempRoot || os.tmpdir(),
  })

  // 仅记录用户通过原生对话框 pickFolder() 亲自选取的目录；严禁渲染层传参写入白名单
  const workspaceRoots = new Set()
  function getAllowedOpenRoots() {
    return [
      core.agentDir(),
      audit ? audit.dir() : path.join(os.homedir(), '.pideck', 'audit'),
      core.resolveCwd(''),
      ...workspaceRoots,
    ]
  }

  function pickFolder() {
    if (!window.utools || !window.utools.showOpenDialog) return null
    const r = window.utools.showOpenDialog({
      title: '选择工作文件夹',
      defaultPath: os.homedir(),
      properties: ['openDirectory'],
    })
    const picked = r && r[0] ? r[0] : null
    if (picked && core.validateCwd(picked)) workspaceRoots.add(picked)
    return picked
  }

  // 保存文本文件：优先 uTools 下载目录与保存对话框
  function saveTextFile(name, content) {
    const safeName = String(name || 'export.md').replace(/[\\/:*?"<>|]/g, '_')
    let defaultDir = os.homedir()
    try {
      if (window.utools && typeof window.utools.getPath === 'function') {
        defaultDir = window.utools.getPath('downloads') || defaultDir
      }
    } catch (_) {}
    try {
      if (window.utools && window.utools.showSaveDialog) {
        const target = window.utools.showSaveDialog({
          title: '导出会话',
          defaultPath: path.join(defaultDir, safeName),
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

  // 用系统浏览器打开外链：严格仅允许 http/https，绝不回退 shellOpenPath
  function openExternal(url) {
    const safeUrl = store.isAllowedExternalUrl(url)
    if (!safeUrl) return false
    try {
      if (window.utools && window.utools.shellOpenExternal) {
        Promise.resolve(window.utools.shellOpenExternal(safeUrl)).catch(() => {})
        return true
      }
    } catch (_) {}
    return false
  }

  // 打开目录或定位文件：严格限定在白名单根目录内，且文件只做文件夹定位而不直接执行
  function openPath(p) {
    const res = store.resolveSafeOpenTarget(p, getAllowedOpenRoots())
    if (!res.ok) return false
    try {
      if (res.isDir && window.utools && window.utools.shellOpenPath) {
        Promise.resolve(window.utools.shellOpenPath(res.path)).catch(() => {})
        return true
      }
      if (res.isFile && window.utools && window.utools.shellShowItemInFolder) {
        window.utools.shellShowItemInFolder(res.path)
        return true
      }
    } catch (_) {}
    return false
  }

  window.piBridge = {
    run: (opts, handlers) => runner.run(opts, handlers),
    cancel: () => runner.cancel(),
    saveImage: dataUrl => store.saveImage(dataUrl),
    pickFolder,
    validateCwd: core.validateCwd,
    effectiveCwd: core.effectiveCwd,
    resolveCwd: core.resolveCwd,
    listSkills: core.listSkills,
    listModels: core.listModels,
    listModelsAsync: () => runner.listModelsAsync(),
    refreshModels: () => core.listModels(true),
    listFiles: core.listFiles,
    detectContextFiles: cwd => core.detectContextFiles(cwd),
    getDefaults: cwd => core.getDefaults(cwd),
    deletePiSession: id => core.deletePiSession(id),
    getEnv: () => core.getEnv(),
    saveTextFile,
    openExternal,
    openPath,
    // 本机缓存与本机状态（写入临时目录/本地数据目录，不进入同步数据库）
    readCache: key => store.readCache(key),
    writeCache: (key, data) => store.writeCache(key, data),
    readLocal: (key, fallback) => store.readLocal(key, fallback),
    writeLocal: (key, value) => store.writeLocal(key, value),
    // RPC 引擎与配置
    getConfig: () => store.loadConfig(),
    setConfig: patch => store.saveConfig(patch),
    prewarmRpc: (cwd, flags) => {
      if (!rpcEngine) return Promise.resolve(false)
      return rpcEngine.prewarm(cwd, core.applyLeanSystemPrompt(flags || {}))
    },
    stopRpc: () => (rpcEngine ? rpcEngine.stop() : null),
    // 操作审计：本地 JSONL，脱敏、按天分片
    auditTail: n => (audit ? audit.tail(n) : []),
    auditExport: days => (audit ? audit.exportMd(days) : ''),
    auditDir: () => (audit ? audit.dir() : ''),
    auditClear: () => (audit ? audit.clear() : { removed: 0, failed: 0 }),
    auditRecord,
    // pi 配置：读写 settings.json / models.json（不回传密钥）
    configState: () => (configCore ? { ok: true, ...configCore.getState() } : { ok: false, error: '配置模块加载失败' }),
    configSave: input => (configCore ? configCore.save(input) : { ok: false, error: '配置模块加载失败' }),
    configRemoveKey: provider => (configCore ? configCore.removeKey(provider) : { ok: false, error: '配置模块加载失败' }),
    configAuthCheck: provider => (configCore ? configCore.authCheck(provider) : Promise.resolve({ status: 'unavailable' })),
    configLoginCommand: provider => (configCore ? configCore.loginCommand(provider) : ''),
    openTerminalForProvider: provider => (configCore ? runner.openTerminal(configCore.loginCommand(provider)) : false),
    resolvePi: () => {
      try { const r = core.resolvePi(); return { ok: true, ...r } }
      catch (e) { return { ok: false, error: String(e.message || e) } }
    },
    homedir: () => os.homedir(),
  }
}
