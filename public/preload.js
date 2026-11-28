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
const { Buffer } = require('node:buffer')

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
    deletePiSessions: () => ({ ok: false, removed: 0 }),
    saveTextFile: () => ({ ok: false, unsupported: true }),
    openExternal: () => false, openPath: () => false,
    run: () => { throw new Error('pi-core 加载失败：' + errMsg) },
    cancel: () => {}, saveImage: () => { throw new Error('pi-core 加载失败') },
    deleteImages: () => 0, clearImages: () => 0,
    pickFolder: () => null, pickFiles: () => null,
    pickExecutable: () => ({ ok: false, error: 'pi-core 加载失败' }),
    clearExecutable: () => ({ ok: false, error: 'pi-core 加载失败' }),
    isWorkspaceApproved: () => false,
    homedir: () => os.homedir(),
    auditTail: () => [], auditTailAsync: () => Promise.resolve([]),
    auditExport: () => '', auditExportAsync: () => Promise.resolve(''),
    auditDir: () => '', auditClear: () => ({ removed: 0, failed: 0 }),
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
  // 同时登记经系统入口传入的本地文件到本机授权白名单
  if (window.utools && window.utools.onPluginEnter) {
    window.__pideckEnterQueue = window.__pideckEnterQueue || []
    window.utools.onPluginEnter(action => {
      try { recordEnterApprovedFiles(action) } catch (_) {}
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
      asyncCleanup: true,
    })
    return _storeInstance
  }

  // 渲染层可访问的缓存与本机状态 key 白名单（禁止读写内部路径/任意膨胀数据）
  const RENDERER_CACHE_KEY_RE = /^(models|skills|defaults|env|auth_[a-z0-9_-]{1,35})$/i
  const RENDERER_LOCAL_KEY_RE = /^pideck\.drafts\.v1$/
  const MAX_LOCAL_VALUE_BYTES = 512 * 1024
  function isRendererCacheKey(key) {
    return RENDERER_CACHE_KEY_RE.test(String(key || ''))
  }
  function isRendererLocalKey(key) {
    return RENDERER_LOCAL_KEY_RE.test(String(key || ''))
  }

  function sanitizePublicConfig(cfg) {
    const c = (cfg && typeof cfg === 'object') ? cfg : {}
    return {
      engine: c.engine === 'rpc' ? 'rpc' : 'json',
      nodePath: typeof c.nodePath === 'string' ? c.nodePath : '',
      piCliPath: typeof c.piCliPath === 'string' ? c.piCliPath : '',
    }
  }

  // 懒注入本机手动指定的 Node / pi CLI 路径覆盖（必须先通过严格校验）；未覆盖时校验并使用上次解析快路径缓存
  let _piConfigured = false
  let _piConfiguredAsyncPromise = null
  function isValidCachedNodePath(nodePath, nodeVersion) {
    const raw = typeof nodePath === 'string' ? nodePath.trim() : ''
    if (!raw || !core.isNodeExecutableName(raw)) return ''
    const m = /^v(\d+)\.(\d+)/.exec(String(nodeVersion || '').trim())
    if (!m) return ''
    const major = +m[1], minor = +m[2]
    if (!(major > 22 || (major === 22 && minor >= 19))) return ''
    try {
      const real = fs.realpathSync(raw)
      if (!core.isNodeExecutableName(real) || !fs.statSync(real).isFile()) return ''
      return real
    } catch (_) {
      return ''
    }
  }
  async function isValidCachedNodePathAsync(nodePath, nodeVersion) {
    const raw = typeof nodePath === 'string' ? nodePath.trim() : ''
    if (!raw || !core.isNodeExecutableName(raw)) return ''
    const m = /^v(\d+)\.(\d+)/.exec(String(nodeVersion || '').trim())
    if (!m) return ''
    const major = +m[1], minor = +m[2]
    if (!(major > 22 || (major === 22 && minor >= 19))) return ''
    try {
      const real = await fs.promises.realpath(raw)
      if (!core.isNodeExecutableName(real) || !(await fs.promises.stat(real)).isFile()) return ''
      return real
    } catch (_) {
      return ''
    }
  }
  function applyPiConfig(cfg, resolvedCache) {
    let validNode = ''
    let validPi = ''
    if (cfg && cfg.nodePath) {
      const r = core.validateNodeExecutable(cfg.nodePath)
      if (r.ok) validNode = r.path
    }
    if (cfg && cfg.piCliPath) {
      const r = core.validatePiCliPath(cfg.piCliPath)
      if (r.ok) validPi = r.path
    }
    core.setPathOverrides({ nodePath: validNode, piCliPath: validPi })
    if (!(cfg && (cfg.nodePath || cfg.piCliPath)) && core.seedResolvedPaths && resolvedCache && resolvedCache.data) {
      const cachedNode = isValidCachedNodePath(resolvedCache.data.nodePath, resolvedCache.data.nodeVersion)
      const cachedPi = resolvedCache.data.piPath ? core.validatePiCliPath(resolvedCache.data.piPath) : { ok: false }
      if (cachedNode && cachedPi.ok) {
        core.seedResolvedPaths({
          nodePath: cachedNode,
          nodeVersion: String(resolvedCache.data.nodeVersion || '').trim(),
          piPath: cachedPi.path,
        })
      }
    }
    _piConfigured = true
  }
  async function applyPiConfigAsync(cfg, resolvedCache) {
    const [nodeRes, piRes] = await Promise.all([
      (cfg && cfg.nodePath && core.validateNodeExecutableAsync)
        ? core.validateNodeExecutableAsync(cfg.nodePath)
        : Promise.resolve(cfg && cfg.nodePath ? core.validateNodeExecutable(cfg.nodePath) : { ok: false }),
      (cfg && cfg.piCliPath && core.validatePiCliPathAsync)
        ? core.validatePiCliPathAsync(cfg.piCliPath)
        : Promise.resolve(cfg && cfg.piCliPath ? core.validatePiCliPath(cfg.piCliPath) : { ok: false }),
    ])
    const validNode = nodeRes && nodeRes.ok ? nodeRes.path : ''
    const validPi = piRes && piRes.ok ? piRes.path : ''
    if (_piConfigured) return
    core.setPathOverrides({ nodePath: validNode, piCliPath: validPi })
    if (!(cfg && (cfg.nodePath || cfg.piCliPath)) && core.seedResolvedPaths && resolvedCache && resolvedCache.data) {
      const [cachedNode, cachedPi] = await Promise.all([
        isValidCachedNodePathAsync(resolvedCache.data.nodePath, resolvedCache.data.nodeVersion),
        resolvedCache.data.piPath
          ? (core.validatePiCliPathAsync ? core.validatePiCliPathAsync(resolvedCache.data.piPath) : Promise.resolve(core.validatePiCliPath(resolvedCache.data.piPath)))
          : Promise.resolve({ ok: false }),
      ])
      if (_piConfigured) return
      if (cachedNode && cachedPi && cachedPi.ok) {
        core.seedResolvedPaths({
          nodePath: cachedNode,
          nodeVersion: String(resolvedCache.data.nodeVersion || '').trim(),
          piPath: cachedPi.path,
        })
      }
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
      if (!_piConfigured) await applyPiConfigAsync(cfg, resolvedCache)
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

  // 仅记录用户通过原生对话框 pickFolder() / pickFiles() 或 onPluginEnter 系统动作授权的目录与文件；严禁从渲染层或 dbStorage 写入白名单
  const workspaceRoots = new Set()
  const approvedFileSet = new Set()
  const MAX_APPROVED_WORKSPACES = 50
  const MAX_APPROVED_FILES = 200

  function persistApprovedWorkspace(realDir) {
    try {
      const st = getStore()
      const cfg = st.loadConfig() || {}
      const prev = Array.isArray(cfg.approvedWorkspaces) ? cfg.approvedWorkspaces.filter(x => typeof x === 'string' && x) : []
      const merged = [realDir, ...prev.filter(x => x !== realDir)].slice(0, MAX_APPROVED_WORKSPACES)
      st.saveConfig({ approvedWorkspaces: merged })
    } catch (_) {}
  }
  function getApprovedWorkspaces() {
    const out = new Set(workspaceRoots)
    try {
      const cfg = getStore().loadConfig() || {}
      if (Array.isArray(cfg.approvedWorkspaces)) {
        for (const d of cfg.approvedWorkspaces) {
          if (typeof d === 'string' && d.trim()) out.add(d.trim())
        }
      }
    } catch (_) {}
    return [...out]
  }
  function persistApprovedFiles(realPaths) {
    if (!realPaths.length) return
    try {
      const st = getStore()
      const cfg = st.loadConfig() || {}
      const prev = Array.isArray(cfg.approvedFiles) ? cfg.approvedFiles.filter(x => typeof x === 'string' && x) : []
      const merged = [...new Set([...realPaths, ...prev])].slice(0, MAX_APPROVED_FILES)
      st.saveConfig({ approvedFiles: merged })
    } catch (_) {}
  }
  function registerApprovedFiles(rawList) {
    const added = []
    for (const raw of (rawList || [])) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      try {
        const real = fs.realpathSync(raw.trim())
        if (fs.statSync(real).isFile()) {
          approvedFileSet.add(real)
          added.push(real)
        }
      } catch (_) {}
    }
    if (added.length) persistApprovedFiles(added)
    return added
  }
  function recordEnterApprovedFiles(action) {
    if (!action || typeof action !== 'object') return
    if (action.type === 'files' && Array.isArray(action.payload)) {
      const paths = action.payload.map(p => (p && typeof p === 'object' ? p.path : p)).filter(Boolean)
      registerApprovedFiles(paths)
    } else if (action.type === 'img' && typeof action.payload === 'string') {
      const p = action.payload.trim()
      if (p && !p.startsWith('data:') && !p.startsWith('file:')) registerApprovedFiles([p])
    }
  }
  function getApprovedFilesSet() {
    const out = new Set(approvedFileSet)
    try {
      const cfg = getStore().loadConfig() || {}
      if (Array.isArray(cfg.approvedFiles)) {
        for (const f of cfg.approvedFiles) {
          if (typeof f === 'string' && f.trim()) out.add(f.trim())
        }
      }
    } catch (_) {}
    return out
  }
  function resolveAllowedWorkspaceCwd(cwd, opts) {
    const raw = typeof cwd === 'string' ? cwd.trim() : ''
    if (!raw) return (opts && opts.allowEmpty) ? '' : core.resolveCwd('')
    const allowed = [
      core.resolveCwd(''),
      ...getApprovedWorkspaces(),
    ]
    const matched = localStoreMod.matchAllowedDir(raw, allowed)
    return matched || null
  }
  function isWorkspaceApproved(cwd) {
    const raw = typeof cwd === 'string' ? cwd.trim() : ''
    if (!raw) return true
    return !!resolveAllowedWorkspaceCwd(raw)
  }

  function resolveAllowedRunFiles(files, safeCwd) {
    if (!Array.isArray(files) || !files.length) return []
    const st = getStore()
    const imgDir = st.imageDir
    let realImgDir = ''
    try { if (imgDir && fs.existsSync(imgDir)) realImgDir = fs.realpathSync(imgDir) } catch (_) {}
    const allowedRoots = [core.resolveCwd(''), ...getApprovedWorkspaces()]
    if (safeCwd) allowedRoots.unshift(safeCwd)
    const realRoots = []
    for (const r of allowedRoots) {
      try { realRoots.push(fs.realpathSync(r)) } catch (_) {}
    }
    const approvedFiles = getApprovedFilesSet()
    const out = []
    for (const item of files) {
      if (typeof item !== 'string' || !item.trim()) continue
      const raw = item.trim()
      if (/^data:image\//i.test(raw)) {
        const savedPath = st.saveImage(raw)
        try {
          out.push(fs.realpathSync(savedPath))
        } catch (_) {
          out.push(savedPath)
        }
        continue
      }
      let realFile = ''
      try {
        const lst = fs.lstatSync(raw)
        if (lst.isSymbolicLink() && realImgDir && localStoreMod.isPathWithinRoot(raw, realImgDir)) {
          throw new Error('不支持链接形式的临时图片')
        }
        realFile = fs.realpathSync(raw)
        if (!fs.statSync(realFile).isFile()) throw new Error('附件路径必须是常规文件')
      } catch (e) {
        throw new Error(`附件文件不可访问：${path.basename(raw) || raw}`)
      }
      const inImgDir = !!(realImgDir && localStoreMod.isPathWithinRoot(realFile, realImgDir))
      const inWorkspace = realRoots.some(r => localStoreMod.isPathWithinRoot(realFile, r))
      const inApprovedFiles = approvedFiles.has(realFile)
      if (!inImgDir && !inWorkspace && !inApprovedFiles) {
        throw new Error(`附件文件「${path.basename(raw) || raw}」未在本机授权，请通过回形针按钮重新选择`)
      }
      out.push(realFile)
    }
    return out
  }

  function filterAllowedSkillPaths(skillPaths, safeCwd) {
    if (!Array.isArray(skillPaths) || !skillPaths.length) return []
    const roots = core.skillRoots ? core.skillRoots(safeCwd) : []
    const realRoots = []
    for (const r of roots) {
      try { realRoots.push(fs.realpathSync(r)) } catch (_) {}
    }
    let discoveredDirs = null
    const getDiscoveredDirs = () => {
      if (discoveredDirs) return discoveredDirs
      discoveredDirs = new Set()
      if (core.listSkills) {
        try {
          for (const sk of (core.listSkills(safeCwd) || [])) {
            if (!sk || !sk.dir) continue
            try {
              const realSk = fs.realpathSync(sk.dir)
              discoveredDirs.add(process.platform === 'win32' ? realSk.toLowerCase() : realSk)
            } catch (_) {}
          }
        } catch (_) {}
      }
      return discoveredDirs
    }
    const out = []
    for (const raw of skillPaths) {
      if (typeof raw !== 'string') continue
      const s = raw.trim()
      if (!s || s.startsWith('-') || /[\r\n\0]/.test(s)) continue
      try {
        const real = fs.realpathSync(s)
        if (!fs.statSync(real).isDirectory()) continue
        const inRoot = realRoots.some(r => localStoreMod.isPathWithinRoot(real, r))
        const normReal = process.platform === 'win32' ? real.toLowerCase() : real
        if (inRoot || getDiscoveredDirs().has(normReal)) {
          out.push(real)
        }
      } catch (_) {}
    }
    return out
  }

  function getAllowedOpenRoots() {
    const a = getAudit()
    const { localRoot } = getPluginRoots()
    return [
      core.agentDir(),
      a ? a.dir() : (localRoot ? path.join(localRoot, 'audit') : path.join(os.homedir(), '.pideck', 'audit')),
      core.resolveCwd(''),
      ...getApprovedWorkspaces(),
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
    if (picked && core.validateCwd(picked)) {
      let realPicked = picked
      try { realPicked = fs.realpathSync(picked) } catch (_) {}
      workspaceRoots.add(realPicked)
      persistApprovedWorkspace(realPicked)
      return realPicked
    }
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
    const picked = Array.isArray(r) ? r.filter(Boolean) : []
    return picked.length ? registerApprovedFiles(picked) : []
  }

  function pickExecutable(kind) {
    if (kind !== 'node' && kind !== 'pi') return { ok: false, error: '无效的路径类型' }
    if (!window.utools || !window.utools.showOpenDialog) return { ok: false, error: '当前环境不支持文件选择对话框' }
    const r = window.utools.showOpenDialog({
      title: kind === 'node' ? '选择 Node 可执行文件' : '选择 pi cli.js',
      defaultPath: os.homedir(),
      properties: ['openFile'],
    })
    const picked = r && r[0] ? r[0] : ''
    if (!picked) return { ok: false, canceled: true }
    const res = kind === 'node' ? core.validateNodeExecutable(picked) : core.validatePiCliPath(picked)
    if (!res.ok) return { ok: false, error: res.error || '路径校验失败' }
    const st = getStore()
    const next = st.saveConfig(kind === 'node' ? { nodePath: res.path } : { piCliPath: res.path })
    const validNode = kind === 'node'
      ? res.path
      : (next.nodePath && core.validateNodeExecutable(next.nodePath).ok ? next.nodePath : '')
    const validPi = kind === 'pi'
      ? res.path
      : (next.piCliPath && core.validatePiCliPath(next.piCliPath).ok ? next.piCliPath : '')
    core.setPathOverrides({ nodePath: validNode, piCliPath: validPi })
    if (st.removeCache) st.removeCache('pi-resolved')
    _piConfigured = true
    if (_rpcEngine) { try { _rpcEngine.stop() } catch (_) {} }
    return { ok: true, path: res.path, version: res.version || '' }
  }

  function clearExecutable(kind) {
    if (kind !== 'node' && kind !== 'pi') return { ok: false, error: '无效的路径类型' }
    const st = getStore()
    const next = st.saveConfig(kind === 'node' ? { nodePath: '' } : { piCliPath: '' })
    const validNode = next.nodePath && core.validateNodeExecutable(next.nodePath).ok ? next.nodePath : ''
    const validPi = next.piCliPath && core.validatePiCliPath(next.piCliPath).ok ? next.piCliPath : ''
    core.setPathOverrides({ nodePath: validNode, piCliPath: validPi })
    if (st.removeCache) st.removeCache('pi-resolved')
    _piConfigured = true
    if (_rpcEngine) { try { _rpcEngine.stop() } catch (_) {} }
    return { ok: true }
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
    run: (opts, handlers) => {
      const o = (opts && typeof opts === 'object') ? opts : {}
      const safeCwd = resolveAllowedWorkspaceCwd(o.cwd)
      if (!safeCwd) {
        throw new Error(`工作目录「${o.cwd || ''}」尚未在本机授权，请在设置中点击「选择」重新授权`)
      }
      const safeFiles = resolveAllowedRunFiles(o.files, safeCwd)
      const nextTool = (o.tool && typeof o.tool === 'object')
        ? { ...o.tool, skillPaths: filterAllowedSkillPaths(o.tool.skillPaths, safeCwd) }
        : o.tool
      return getRunner().run({ ...o, cwd: safeCwd, files: safeFiles, tool: nextTool }, handlers)
    },
    cancel: () => (_runnerInstance ? _runnerInstance.cancel() : false),
    saveImage: dataUrl => getStore().saveImage(dataUrl),
    deleteImages: paths => getStore().deleteImages(paths),
    clearImages: () => getStore().clearImages(),
    pickFolder,
    pickFiles,
    pickExecutable,
    clearExecutable,
    isWorkspaceApproved,
    listSkillsAsync: cwd => {
      const safe = resolveAllowedWorkspaceCwd(cwd, { allowEmpty: true })
      if (safe === null) return Promise.resolve([])
      return core.listSkillsAsync(safe)
    },
    listModelsAsync: opts => ensurePiConfiguredAsync().then(() => getRunner().listModelsAsync(opts)),
    listFilesAsync: (cwd, query) => {
      const safe = resolveAllowedWorkspaceCwd(cwd)
      if (!safe) return Promise.resolve([])
      return core.listFilesAsync(safe, query)
    },
    detectContextFiles: cwd => {
      const safe = resolveAllowedWorkspaceCwd(cwd, { allowEmpty: true })
      if (safe === null) return []
      return core.detectContextFiles(safe)
    },
    getDefaults: cwd => {
      const safe = resolveAllowedWorkspaceCwd(cwd)
      if (!safe) return Promise.resolve({})
      ensurePiConfigured()
      return core.getDefaults(safe)
    },
    deletePiSession: id => core.deletePiSession(id),
    deletePiSessions: ids => (core.deletePiSessions ? core.deletePiSessions(ids) : { ok: false, removed: 0 }),
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
    readCache: key => (isRendererCacheKey(key) ? getStore().readCache(key) : null),
    readCacheMeta: key => (isRendererCacheKey(key) ? getStore().readCacheMeta(key) : null),
    readCacheMetaAsync: key => (isRendererCacheKey(key) ? getStore().readCacheMetaAsync(key) : Promise.resolve(null)),
    writeCache: (key, data) => (isRendererCacheKey(key) ? getStore().writeCache(key, data) : false),
    readLocal: (key, fallback) => (isRendererLocalKey(key) ? getStore().readLocal(key, fallback) : fallback),
    readLocalAsync: (key, fallback) => (isRendererLocalKey(key) ? getStore().readLocalAsync(key, fallback) : Promise.resolve(fallback)),
    writeLocal: (key, value) => {
      if (!isRendererLocalKey(key)) return false
      if (value !== undefined) {
        try {
          const encoded = JSON.stringify(value)
          if (!encoded || Buffer.byteLength(encoded, 'utf8') > MAX_LOCAL_VALUE_BYTES) return false
        } catch (_) {
          return false
        }
      }
      return getStore().writeLocal(key, value)
    },
    // RPC 引擎与配置（setConfig 仅接受引擎偏好，路径只能经 pickExecutable/clearExecutable 变更）
    getConfig: () => sanitizePublicConfig(getStore().loadConfig()),
    getConfigAsync: () => getStore().loadConfigAsync().then(sanitizePublicConfig),
    setConfig: patch => {
      const st = getStore()
      if (!patch || typeof patch !== 'object') return sanitizePublicConfig(st.loadConfig())
      const allowed = {}
      if (patch.engine === 'json' || patch.engine === 'rpc') allowed.engine = patch.engine
      if (!Object.keys(allowed).length) return sanitizePublicConfig(st.loadConfig())
      return sanitizePublicConfig(st.saveConfig(allowed))
    },
    prewarmRpc: (cwd, flags) => {
      const safeCwd = resolveAllowedWorkspaceCwd(cwd)
      if (!safeCwd) return Promise.resolve(false)
      const eng = getRpcEngine()
      if (!eng) return Promise.resolve(false)
      const safeFlags = (flags && typeof flags === 'object' && flags.tool && typeof flags.tool === 'object')
        ? { ...flags, tool: { ...flags.tool, skillPaths: filterAllowedSkillPaths(flags.tool.skillPaths, safeCwd) } }
        : (flags || {})
      return ensurePiConfiguredAsync()
        .then(() => core.resolvePiAsync())
        .then(() => eng.prewarm(safeCwd, core.applyLeanSystemPrompt(safeFlags)))
        .catch(() => false)
    },
    stopRpc: () => (_rpcEngine ? _rpcEngine.stop() : null),
    getRpcDefaults: (cwd, flags) => {
      const safeCwd = resolveAllowedWorkspaceCwd(cwd)
      if (!safeCwd) return null
      const eng = _rpcEngine || getRpcEngine()
      const safeFlags = (flags && typeof flags === 'object' && flags.tool && typeof flags.tool === 'object')
        ? { ...flags, tool: { ...flags.tool, skillPaths: filterAllowedSkillPaths(flags.tool.skillPaths, safeCwd) } }
        : (flags || {})
      return (eng && eng.getCachedDefaults) ? eng.getCachedDefaults(safeCwd, core.applyLeanSystemPrompt(safeFlags)) : null
    },
    // 操作审计：本地 JSONL，脱敏、按天分片（写入仅限 runner 内部，不向渲染层开放）
    auditTail: n => { const a = getAudit(); return a ? a.tail(n) : [] },
    auditTailAsync: n => { const a = getAudit(); return (a && a.tailAsync) ? a.tailAsync(n) : Promise.resolve(a ? a.tail(n) : []) },
    auditExport: days => { const a = getAudit(); return a ? a.exportMd(days) : '' },
    auditExportAsync: days => { const a = getAudit(); return (a && a.exportMdAsync) ? a.exportMdAsync(days) : Promise.resolve(a ? a.exportMd(days) : '') },
    auditDir: () => { const a = getAudit(); return a ? a.dir() : '' },
    auditClear: () => { const a = getAudit(); return a ? a.clear() : { removed: 0, failed: 0 } },
    // pi 配置：读写 settings.json / models.json（不回传密钥）
    configState: () => { const c = getConfigCore(); return c ? { ok: true, ...c.getState() } : { ok: false, error: '配置模块加载失败' } },
    configSave: input => { const c = getConfigCore(); return c ? c.save(input) : { ok: false, error: '配置模块加载失败' } },
    configRemoveKey: provider => { const c = getConfigCore(); return c ? c.removeKey(provider) : { ok: false, error: '配置模块加载失败' } },
    configAuthCheck: provider => ensurePiConfiguredAsync()
      .then(() => { const c = getConfigCore(); return c ? c.authCheck(provider) : { status: 'unavailable' } })
      .catch(() => ({ status: 'unavailable' })),
    configLoginCommand: provider => { ensurePiConfigured(); const c = getConfigCore(); return c ? c.loginCommand(provider) : '' },
    openTerminalForProvider: provider => {
      try { ensurePiConfigured(); return getRunner().openLoginTerminal(provider) }
      catch (_) { return false }
    },
    installPiInTerminal: () => {
      try { return getRunner().openInstallTerminal() }
      catch (_) { return false }
    },
    resetPiCache: () => {
      core.resetPiCache()
      if (_runnerInstance && _runnerInstance.resetModelsCache) _runnerInstance.resetModelsCache()
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
