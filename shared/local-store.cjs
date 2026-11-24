// 本地存储与安全校验：缓存、配置、本机状态、临时图片落盘/清理、外链与路径白名单校验
// 职责：把业务逻辑与本机临时/持久化存储从 preload.js 剥离，避免非用户数据写入同步数据库
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')

const DEFAULT_CACHE_TTL = 5 * 60 * 1000
const DEFAULT_STALE_TTL = 24 * 60 * 60 * 1000
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_MAX_AGE_MS = 24 * 3600 * 1000
const CACHE_KEY_RE = /^[a-z0-9_-]{1,40}$/i
const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'webp', 'gif', 'bmp', 'svg', 'avif'])

function isAllowedExternalUrl(url) {
  const s = String(url || '').trim()
  if (!s) return ''
  try {
    const parsed = new URL(s)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href
    return ''
  } catch (_) {
    return ''
  }
}

function normalizeForCompare(p) {
  let resolved = path.resolve(String(p))
  while (resolved.length > 1 && resolved.endsWith(path.sep) && !/^[A-Za-z]:\\$/.test(resolved)) {
    resolved = resolved.slice(0, -1)
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPathWithinRoot(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false
  const target = normalizeForCompare(targetPath)
  const root = normalizeForCompare(rootPath)
  if (target === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return target.startsWith(prefix)
}

function resolveSafeOpenTarget(targetPath, allowedRoots) {
  const raw = typeof targetPath === 'string' ? targetPath.trim() : ''
  if (!raw) return { ok: false }
  let realTarget
  try {
    realTarget = fs.realpathSync(raw)
  } catch (_) {
    return { ok: false }
  }
  let matched = false
  for (const root of (allowedRoots || [])) {
    if (!root || typeof root !== 'string') continue
    try {
      const realRoot = fs.realpathSync(root)
      if (isPathWithinRoot(realTarget, realRoot)) {
        matched = true
        break
      }
    } catch (_) {}
  }
  if (!matched) return { ok: false }
  try {
    const st = fs.statSync(realTarget)
    return { ok: true, path: realTarget, isDir: st.isDirectory(), isFile: st.isFile() }
  } catch (_) {
    return { ok: false }
  }
}

function readJsonObject(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null
  } catch (_) {
    return null
  }
}

async function readJsonObjectAsync(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null
  } catch (_) {
    return null
  }
}

function writeJsonAtomic(file, data, opts) {
  const options = typeof opts === 'boolean' ? { pretty: opts } : (opts || {})
  const pretty = !!options.pretty
  const mode = options.mode
  const dir = path.dirname(file)
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 7)}`
  try {
    fs.mkdirSync(dir, { recursive: true, ...(mode ? { mode: 0o700 } : {}) })
    const text = (pretty ? JSON.stringify(data, null, 2) + '\n' : JSON.stringify(data))
    const writeOpts = mode ? { encoding: 'utf8', mode } : 'utf8'
    fs.writeFileSync(tmp, text, writeOpts)
    try {
      fs.renameSync(tmp, file)
    } catch (_) {
      fs.writeFileSync(file, text, writeOpts)
    }
    if (mode) {
      try { fs.chmodSync(file, mode) } catch (_) {}
    }
    return true
  } catch (_) {
    return false
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (_) {}
  }
}

function createLocalStore(options = {}) {
  const cacheDir = options.cacheDir || path.join(os.tmpdir(), 'pideck-cache')
  const cacheTtl = options.cacheTtl ?? DEFAULT_CACHE_TTL
  const staleTtl = options.staleTtl ?? DEFAULT_STALE_TTL
  const configFile = options.configFile || path.join(os.homedir(), '.pideck', 'config.json')
  const legacyConfigFile = options.legacyConfigFile || ''
  const localStateFile = options.localStateFile || path.join(os.homedir(), '.pideck', 'state.json')
  const imageDir = options.imageDir || path.join(os.tmpdir(), 'pideck-images')
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  let now = options.now || Date.now
  let imgCleaned = false
  let _cfgCache = null
  let _cfgCacheMtime = -1
  let _localDictCache = null

  function cacheFilePath(key) {
    const k = String(key || '')
    if (!CACHE_KEY_RE.test(k)) return ''
    return path.join(cacheDir, `${k}.json`)
  }

  function readCacheMeta(key) {
    const file = cacheFilePath(key)
    if (!file) return null
    const entry = readJsonObject(file)
    if (!entry || typeof entry.t !== 'number' || entry.data === undefined) return null
    const ageMs = Math.max(0, now() - entry.t)
    if (ageMs > staleTtl) return null
    return { data: entry.data, fresh: ageMs <= cacheTtl, ageMs }
  }

  async function readCacheMetaAsync(key) {
    const file = cacheFilePath(key)
    if (!file) return null
    const entry = await readJsonObjectAsync(file)
    if (!entry || typeof entry.t !== 'number' || entry.data === undefined) return null
    const ageMs = Math.max(0, now() - entry.t)
    if (ageMs > staleTtl) return null
    return { data: entry.data, fresh: ageMs <= cacheTtl, ageMs }
  }

  function readCache(key) {
    const meta = readCacheMeta(key)
    return (meta && meta.fresh) ? meta.data : null
  }

  function writeCache(key, data) {
    const file = cacheFilePath(key)
    if (!file) return false
    return writeJsonAtomic(file, { t: now(), data }, false)
  }

  function removeCache(key) {
    const file = cacheFilePath(key)
    if (!file) return false
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file)
      return true
    } catch (_) {
      return false
    }
  }

  function clearCache() {
    let removed = 0
    try {
      if (!fs.existsSync(cacheDir)) return 0
      for (const name of fs.readdirSync(cacheDir)) {
        if (!name.endsWith('.json')) continue
        try { fs.unlinkSync(path.join(cacheDir, name)); removed++ } catch (_) {}
      }
    } catch (_) {}
    return removed
  }

  function loadConfig() {
    try {
      const st = fs.statSync(configFile)
      if (_cfgCache && _cfgCacheMtime === st.mtimeMs) return _cfgCache
      const primary = readJsonObject(configFile)
      if (primary) {
        _cfgCache = primary
        _cfgCacheMtime = st.mtimeMs
        return primary
      }
    } catch (_) {
      _cfgCache = null
      _cfgCacheMtime = -1
    }
    if (legacyConfigFile && legacyConfigFile !== configFile) {
      const legacy = readJsonObject(legacyConfigFile)
      if (legacy) return legacy
    }
    return {}
  }

  async function loadConfigAsync() {
    try {
      const st = await fsp.stat(configFile)
      if (_cfgCache && _cfgCacheMtime === st.mtimeMs) return _cfgCache
      const primary = await readJsonObjectAsync(configFile)
      if (primary) {
        _cfgCache = primary
        _cfgCacheMtime = st.mtimeMs
        return primary
      }
    } catch (_) {
      _cfgCache = null
      _cfgCacheMtime = -1
    }
    if (legacyConfigFile && legacyConfigFile !== configFile) {
      const legacy = await readJsonObjectAsync(legacyConfigFile)
      if (legacy) return legacy
    }
    return {}
  }

  function saveConfig(patch) {
    const next = { ...loadConfig(), ...(patch && typeof patch === 'object' ? patch : {}) }
    if (writeJsonAtomic(configFile, next, true)) {
      _cfgCache = next
      try { _cfgCacheMtime = fs.statSync(configFile).mtimeMs } catch (_) { _cfgCacheMtime = -1 }
    }
    return next
  }

  function loadLocalDict() {
    if (_localDictCache) return _localDictCache
    const dict = readJsonObject(localStateFile)
    if (dict) _localDictCache = dict
    return dict
  }

  async function loadLocalDictAsync() {
    if (_localDictCache) return _localDictCache
    const dict = await readJsonObjectAsync(localStateFile)
    if (dict) _localDictCache = dict
    return dict
  }

  function readLocal(key, fallback) {
    const k = String(key || '')
    if (!k) return fallback
    const dict = loadLocalDict()
    if (!dict || !Object.prototype.hasOwnProperty.call(dict, k)) return fallback
    return dict[k] === undefined ? fallback : dict[k]
  }

  async function readLocalAsync(key, fallback) {
    const k = String(key || '')
    if (!k) return fallback
    const dict = await loadLocalDictAsync()
    if (!dict || !Object.prototype.hasOwnProperty.call(dict, k)) return fallback
    return dict[k] === undefined ? fallback : dict[k]
  }

  function writeLocal(key, value) {
    const k = String(key || '')
    if (!k) return false
    const curDict = loadLocalDict()
    const dict = curDict ? { ...curDict } : {}
    if (value === undefined) {
      if (!Object.prototype.hasOwnProperty.call(dict, k)) return true
      delete dict[k]
    } else {
      const prevJson = Object.prototype.hasOwnProperty.call(dict, k) ? JSON.stringify(dict[k]) : undefined
      const nextJson = JSON.stringify(value)
      if (prevJson === nextJson) return true
      dict[k] = value
    }
    if (!writeJsonAtomic(localStateFile, dict, false)) return false
    _localDictCache = dict
    return true
  }

  function removeLocal(key) {
    const k = String(key || '')
    if (!k) return false
    const curDict = loadLocalDict()
    if (!curDict || !Object.prototype.hasOwnProperty.call(curDict, k)) return true
    const dict = { ...curDict }
    delete dict[k]
    if (!writeJsonAtomic(localStateFile, dict, false)) return false
    _localDictCache = dict
    return true
  }

  function cleanupImages() {
    try {
      if (!fs.existsSync(imageDir)) return 0
      const ts = now()
      let n = 0
      for (const f of fs.readdirSync(imageDir)) {
        const p = path.join(imageDir, f)
        try {
          const st = fs.statSync(p)
          if (!st.isFile()) continue
          if (ts - st.mtimeMs > IMAGE_MAX_AGE_MS) {
            fs.unlinkSync(p)
            n++
          }
        } catch (_) {}
      }
      return n
    } catch (_) {
      return 0
    }
  }

  function maybeCleanupImages() {
    if (imgCleaned) return
    imgCleaned = true
    try { cleanupImages() } catch (_) {}
  }

  function saveImage(dataUrl) {
    const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.*)$/s.exec(dataUrl || '')
    if (!m) throw new Error('图片格式无效，仅支持 data:image/...;base64,...')
    let ext = m[1].toLowerCase()
    if (ext === 'jpeg') ext = 'jpg'
    else if (ext === 'svg+xml') ext = 'svg'
    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      throw new Error(`不支持的图片格式：${ext}`)
    }
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length > maxImageBytes) {
      throw new Error(`图片过大（${(buf.length / 1048576).toFixed(1)}MB），单张上限 ${maxImageBytes / 1048576}MB`)
    }
    fs.mkdirSync(imageDir, { recursive: true })
    maybeCleanupImages()
    const file = path.join(imageDir, `img-${now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`)
    fs.writeFileSync(file, buf)
    return file
  }

  return {
    cacheDir,
    configFile,
    localStateFile,
    imageDir,
    readCache,
    readCacheMeta,
    readCacheMetaAsync,
    writeCache,
    removeCache,
    clearCache,
    loadConfig,
    loadConfigAsync,
    saveConfig,
    readLocal,
    readLocalAsync,
    writeLocal,
    removeLocal,
    cleanupImages,
    saveImage,
    isAllowedExternalUrl,
    isPathWithinRoot,
    resolveSafeOpenTarget,
    _setNow: fn => { if (fn) now = fn },
  }
}

const defaultStore = createLocalStore()

module.exports = {
  ...defaultStore,
  createLocalStore,
  isAllowedExternalUrl,
  isPathWithinRoot,
  resolveSafeOpenTarget,
  writeJsonAtomic,
}
