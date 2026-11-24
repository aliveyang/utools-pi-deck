// PiDeck preload：渲染进程 ↔ Node/uTools 薄桥接层
// 核心逻辑在 shared/*.cjs（dev 用 ../shared，构建后 dist 用 ./shared）
let coreErr = ''
function loadShared(name, recordErr) {
  for (const rel of [`./shared/${name}`, `../shared/${name}`]) {
    try { return require(rel) }
    catch (e) { if (recordErr) coreErr = (coreErr ? coreErr + ' / ' : '') + e.message }
  }
  return null
}

const core = loadShared('pi-core.cjs', true)
const localStoreMod = loadShared('local-store.cjs', true)

let _rpcEngineLoaded = false
let _rpcEngine = null
function getRpcEngine() {
  if (!_rpcEngineLoaded) {
    _rpcEngineLoaded = true
    _rpcEngine = loadShared('rpc-engine.cjs')
  }
  return _rpcEngine
}

let _auditLoaded = false
let _auditMod = null
function getAuditMod() {
  if (!_auditLoaded) {
    _auditLoaded = true
    _auditMod = loadShared('audit.cjs')
  }
  return _auditMod
}

let _configLoaded = false
let _configCore = null
function getConfigCore() {
  if (!_configLoaded) {
    _configLoaded = true
    _configCore = loadShared('config.cjs')
  }
  return _configCore
}

let _runnerLoaded = false
let _runnerMod = null
function getRunnerMod() {
  if (!_runnerLoaded) {
    _runnerLoaded = true
    _runnerMod = loadShared('runner.cjs')
  }
  return _runnerMod
}

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

if (!core || !localStoreMod) {
  const errMsg = coreErr || 'shared 模块加载失败'
  // 降级桥：字段需与正常分支保持一致，避免前端取到 undefined
  window.piBridge = {
    resolvePiAsync: () => Promise.resolve({ ok: false, error: 'pi-core 加载失败：' + errMsg }),
    resetPiCache: () => {},
    installPiInTerminal: () => false,
    getConfig: () => ({}), getConfigAsync: () => Promise.resolve({}), setConfig: () => ({}),
    readCache: () => null, readCacheMeta: () => null, readCacheMetaAsync: () => Promise.resolve(null), writeCache: () => false,
    readLocal: (_k, fb) => fb, readLocalAsync: (_k, fb) => Promise.resolve(fb), writeLocal: () => false,
    prewarmRpc: () => Promise.resolve(false), stopRpc: () => {}, getRpcDefaults: () => null,
    listSkillsAsync: () => Promise.resolve([]),
    listModelsAsync: () => Promise.resolve([]),
    listFilesAsync: () => Promise.resolve([]),
    detectContextFiles: () => [], getDefaults: () => Promise.resolve({}),
    getEnvAsync: () => Promise.resolve({ ok: false, errorCode: '', error: 'pi-core 加载失败', agentDir: '', configs: [] }),
    deletePiSession: () => ({ ok: false, removed: 0 }),
    saveTextFile: () => ({ ok: false, unsupported: true }),
    openExternal: () => false, openPath: () => false,
    run: () => { throw new Error('pi-core 加载失败：' + errMsg) },
    cancel: () => {}, saveImage: () => { throw new Error('pi-core 加载失败') },
    deleteImages: () => 0, clearImages: () => 0,
    pickFolder: () => null, pickFiles: () => null, pickExecutable: () => null,
    validateCwd: () => false,
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

function perfNow() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now()
}

function boot() {
  const perf = window.__pideckPerf = window.__pideckPerf || {}
  perf.preloadStart = perfNow()

  // uTools 可能在 Vue 挂载前派发进入事件：preload 最早接住并缓存，渲染层挂载后再取
  if (window.utools && window.utools.onPluginEnter) {
    window.__pideckEnterQueue = window.__pideckEnterQueue || []
    window.utools.onPluginEnter(action => {
      window.__pideckEnterQueue.push(action)
      window.dispatchEvent(new CustomEvent('pideck:enter', { detail: action }))
    })
  }

  // 延迟获取 uTools 插件专属临时目录与本地数据目录（零启动期同步 IPC / 磁盘 I/O）
  let _rootsResolved = false
  let _pluginTempRoot = ''
  let _pluginLocalRoot = ''
  function getPluginRoots() {
    if (_rootsResolved) return { tempRoot: _pluginTempRoot, localRoot: _pluginLocalRoot }
    _rootsResolved = true
    try {
      if (window.utools && typeof window.utools.getPluginTempPath === 'function') {
        _pluginTempRoot = window.utools.getPluginTempPath() || ''
      }
    } catch (_) {}
    try {
      if (window.utools && typeof window.utools.getPluginLocalDataPath === 'function') {
        _pluginLocalRoot = window.utools.getPluginLocalDataPath() || ''
      }
    } catch (_) {}
    return { tempRoot: _pluginTempRoot, localRoot: _pluginLocalRoot }
  }

  let _storeInstance = null
  function getStore() {
    if (_storeInstance) return _storeInstance
    const { tempRoot, localRoot } = getPluginRoots()
    _storeInstance = localStoreMod.createLocalStore({
      ...(tempRoot ? { cacheDir: path.join(tempRoot, 'cache') } : {}),
      ...(localRoot ? { configFile: path.join(localRoot, 'config.json'), localStateFile: path.join(localRoot, 'state.json'), imageDir: path.join(localRoot, 'images') } : {}),
      legacyConfigFile: path.join(os.homedir(), '.pideck', 'config.json'),
    })
    return _storeInstance
  }

  // 懒注入本机手动指定的 Node / pi CLI 路径覆盖；未覆盖时注入上次解析快路径缓存
  let _piConfigured = false
  let _piConfiguredAsyncPromise = null
  function applyPiConfig(cfg, resolvedCache) {
    if (cfg && (cfg.nodePath || cfg.piCliPath)) {
      core.setPathOverrides({ nodePath: cfg.nodePath || '', piCliPath: cfg.piCliPath || '' })
    } else if (core.seedResolvedPaths && resolvedCache && resolvedCache.data) {
      core.seedResolvedPaths(resolvedCache.data)
    }
    _piConfigured = true
  }
  function ensurePiConfigured() {
    if (_piConfigured) return
    const st = getStore()
    const cfg = st.loadConfig()
    const resolvedCache = (cfg && (cfg.nodePath || cfg.piCliPath))
      ? null
      : (st.readCacheMeta ? st.readCacheMeta('pi-resolved') : null)
    applyPiConfig(cfg, resolvedCache)
  }
  function ensurePiConfiguredAsync() {
    if (_piConfigured) return Promise.resolve()
    if (_piConfiguredAsyncPromise) return _piConfiguredAsyncPromise
    _piConfiguredAsyncPromise = (async () => {
      const st = getStore()
      const cfg = await st.loadConfigAsync()
      if (_piConfigured) return
      const resolvedCache = (cfg && (cfg.nodePath || cfg.piCliPath))
        ? null
        : (st.readCacheMetaAsync ? await st.readCacheMetaAsync('pi-resolved') : null)
      if (!_piConfigured) applyPiConfig(cfg, resolvedCache)
    })().finally(() => { _piConfiguredAsyncPromise = null })
    return _piConfiguredAsyncPromise
  }

  let _auditInstance = null
  function getAudit() {
    if (_auditInstance) return _auditInstance
    const mod = getAuditMod()
    if (!mod) return null
    const { localRoot } = getPluginRoots()
    _auditInstance = localRoot ? mod.createAudit({ root: path.join(localRoot, 'audit') }) : mod
    return _auditInstance
  }

  function auditRecord(entry) {
    const a = getAudit()
    if (!a) return false
    try { return a.record(entry) } catch (_) { return false }
  }

  let _runnerInstance = null
  function getRunner() {
    ensurePiConfigured()
    if (_runnerInstance) return _runnerInstance
    const mod = getRunnerMod()
    if (!mod) throw new Error('runner 模块加载失败')
    const { tempRoot } = getPluginRoots()
    const st = getStore()
    _runnerInstance = mod.createRunner({
      core,
      rpcEngine: getRpcEngine(),
      auditRecord,
      loadConfig: () => st.loadConfig(),
      tempDir: tempRoot || os.tmpdir(),
    })
    return _runnerInstance
  }

  // 仅记录用户通过原生对话框 pickFolder() 亲自选取的目录；严禁渲染层传参写入白名单
  const workspaceRoots = new Set()
  function getAllowedOpenRoots() {
    const a = getAudit()
    const { localRoot } = getPluginRoots()
    return [
      core.agentDir(),
      a ? a.dir() : (localRoot ? path.join(localRoot, 'audit') : path.join(os.homedir(), '.pideck', 'audit')),
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

  function pickFiles() {
    if (!window.utools || !window.utools.showOpenDialog) return null
    const r = window.utools.showOpenDialog({
      title: '选择图片或文件',
      defaultPath: os.homedir(),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '支持的文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'txt', 'md', 'pdf', 'json', 'csv', 'js', 'ts', 'py', 'html', 'css'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    return Array.isArray(r) ? r.filter(Boolean) : []
  }

  function pickExecutable(kind) {
    if (!window.utools || !window.utools.showOpenDialog) return null
    const r = window.utools.showOpenDialog({
      title: kind === 'node' ? '选择 Node 可执行文件' : '选择 pi cli.js',
      defaultPath: os.homedir(),
      properties: ['openFile'],
    })
    return r && r[0] ? r[0] : null
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
    const safeUrl = localStoreMod.isAllowedExternalUrl(url)
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
    const res = localStoreMod.resolveSafeOpenTarget(p, getAllowedOpenRoots())
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
    run: (opts, handlers) => getRunner().run(opts, handlers),
    cancel: () => (_runnerInstance ? _runnerInstance.cancel() : false),
    saveImage: dataUrl => getStore().saveImage(dataUrl),
    deleteImages: paths => getStore().deleteImages(paths),
    clearImages: () => getStore().clearImages(),
    pickFolder,
    pickFiles,
    pickExecutable,
    validateCwd: core.validateCwd,
    listSkillsAsync: cwd => core.listSkillsAsync(cwd),
    listModelsAsync: () => ensurePiConfiguredAsync().then(() => getRunner().listModelsAsync()),
    listFilesAsync: (cwd, query) => core.listFilesAsync(cwd, query),
    detectContextFiles: cwd => core.detectContextFiles(cwd),
    getDefaults: cwd => { ensurePiConfigured(); return core.getDefaults(cwd) },
    deletePiSession: id => core.deletePiSession(id),
    getEnvAsync: () => ensurePiConfiguredAsync()
      .then(() => core.getEnvAsync())
      .then(env => {
        if (env && env.ok) {
          getStore().writeCache('pi-resolved', { nodePath: env.nodePath, nodeVersion: env.nodeVersion, piPath: env.piPath })
        }
        return env
      }),
    saveTextFile,
    openExternal,
    openPath,
    // 本机缓存与本机状态（写入临时目录/本地数据目录，不进入同步数据库）
    readCache: key => getStore().readCache(key),
    readCacheMeta: key => getStore().readCacheMeta(key),
    readCacheMetaAsync: key => getStore().readCacheMetaAsync(key),
    writeCache: (key, data) => getStore().writeCache(key, data),
    readLocal: (key, fallback) => getStore().readLocal(key, fallback),
    readLocalAsync: (key, fallback) => getStore().readLocalAsync(key, fallback),
    writeLocal: (key, value) => getStore().writeLocal(key, value),
    // RPC 引擎与配置
    getConfig: () => getStore().loadConfig(),
    getConfigAsync: () => getStore().loadConfigAsync(),
    setConfig: patch => {
      const st = getStore()
      const next = st.saveConfig(patch)
      if (patch && ('nodePath' in patch || 'piCliPath' in patch)) {
        core.setPathOverrides({ nodePath: next.nodePath || '', piCliPath: next.piCliPath || '' })
        if (st.removeCache) st.removeCache('pi-resolved')
        _piConfigured = true
      }
      return next
    },
    prewarmRpc: (cwd, flags) => {
      const eng = getRpcEngine()
      if (!eng) return Promise.resolve(false)
      return ensurePiConfiguredAsync()
        .then(() => core.resolvePiAsync())
        .then(() => eng.prewarm(cwd, core.applyLeanSystemPrompt(flags || {})))
        .catch(() => false)
    },
    stopRpc: () => (_rpcEngine ? _rpcEngine.stop() : null),
    getRpcDefaults: (cwd, flags) => {
      const eng = _rpcEngine || getRpcEngine()
      return (eng && eng.getCachedDefaults) ? eng.getCachedDefaults(cwd, core.applyLeanSystemPrompt(flags || {})) : null
    },
    // 操作审计：本地 JSONL，脱敏、按天分片
    auditTail: n => { const a = getAudit(); return a ? a.tail(n) : [] },
    auditExport: days => { const a = getAudit(); return a ? a.exportMd(days) : '' },
    auditDir: () => { const a = getAudit(); return a ? a.dir() : '' },
    auditClear: () => { const a = getAudit(); return a ? a.clear() : { removed: 0, failed: 0 } },
    auditRecord,
    // pi 配置：读写 settings.json / models.json（不回传密钥）
    configState: () => { const c = getConfigCore(); return c ? { ok: true, ...c.getState() } : { ok: false, error: '配置模块加载失败' } },
    configSave: input => { const c = getConfigCore(); return c ? c.save(input) : { ok: false, error: '配置模块加载失败' } },
    configRemoveKey: provider => { const c = getConfigCore(); return c ? c.removeKey(provider) : { ok: false, error: '配置模块加载失败' } },
    configAuthCheck: provider => ensurePiConfiguredAsync()
      .then(() => { const c = getConfigCore(); return c ? c.authCheck(provider) : { status: 'unavailable' } })
      .catch(() => ({ status: 'unavailable' })),
    configLoginCommand: provider => { ensurePiConfigured(); const c = getConfigCore(); return c ? c.loginCommand(provider) : '' },
    openTerminalForProvider: provider => {
      try { ensurePiConfigured(); const c = getConfigCore(); return c ? getRunner().openTerminal(c.loginCommand(provider)) : false }
      catch (_) { return false }
    },
    installPiInTerminal: () => {
      try { return getRunner().openTerminal(core.PI_INSTALL_CMD) }
      catch (_) { return false }
    },
    resetPiCache: () => {
      core.resetPiCache()
      const st = getStore()
      if (st.removeCache) st.removeCache('pi-resolved')
      _piConfigured = false
    },
    resolvePiAsync: () => ensurePiConfiguredAsync()
      .then(() => core.resolvePiAsync())
      .then(r => ({ ok: true, ...r }))
      .catch(e => ({ ok: false, error: String(e.message || e) })),
    homedir: () => os.homedir(),
  }

  perf.preloadEnd = perfNow()
  perf.preloadMs = Number((perf.preloadEnd - perf.preloadStart).toFixed(2))
}
