// 本地存储与安全校验：缓存、配置、本机状态、本地图片落盘/清理、外链与路径白名单校验
// 职责：把业务逻辑与本机临时/持久化存储从 preload.js 剥离，避免非用户数据写入同步数据库
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')

const DEFAULT_CACHE_TTL = 5 * 60 * 1000
const DEFAULT_STALE_TTL = 24 * 60 * 60 * 1000
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_IMAGE_MAX_AGE_MS = 30 * 24 * 3600 * 1000
const DEFAULT_MAX_IMAGE_TOTAL_BYTES = 200 * 1024 * 1024
const CACHE_KEY_RE = /^[a-z0-9_-]{1,40}$/i
const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'webp', 'gif', 'bmp', 'svg', 'avif'])
const FORBIDDEN_LOCAL_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isSafeLocalKey(key) {
  const k = String(key || '')
  return !!(k && !FORBIDDEN_LOCAL_KEYS.has(k))
}

function estimateBase64Bytes(b64) {
  const clean = String(b64 || '').replace(/\s+/g, '')
  if (!clean) return 0
  let pad = 0
  if (clean.endsWith('==')) pad = 2
  else if (clean.endsWith('=')) pad = 1
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad)
}

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

function matchAllowedDir(targetDir, allowedDirs) {
  const raw = typeof targetDir === 'string' ? targetDir.trim() : ''
  if (!raw) return ''
  let realTarget
  try {
    realTarget = fs.realpathSync(raw)
    if (!fs.statSync(realTarget).isDirectory()) return ''
  } catch (_) {
    return ''
  }
  const normTarget = normalizeForCompare(realTarget)
  for (const dir of (allowedDirs || [])) {
    if (!dir || typeof dir !== 'string' || !dir.trim()) continue
    try {
      const realAllowed = fs.realpathSync(dir.trim())
      if (normalizeForCompare(realAllowed) === normTarget) return realTarget
    } catch (_) {}
  }
  return ''
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
  const imageDir = options.imageDir || path.join(os.homedir(), '.pideck', 'images')
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  const imageMaxAgeMs = options.imageMaxAgeMs ?? DEFAULT_IMAGE_MAX_AGE_MS
  const maxImageTotalBytes = options.maxImageTotalBytes ?? DEFAULT_MAX_IMAGE_TOTAL_BYTES
  const asyncCleanup = !!options.asyncCleanup
  let now = options.now || Date.now
  let _cfgCache = null
  let _cfgCacheMtime = -1
  let _localDictCache = null
  let _lastAsyncCleanupAt = 0

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
    if (dict) {
      _localDictCache = Object.assign(Object.create(null), dict)
    }
    return _localDictCache
  }

  async function loadLocalDictAsync() {
    if (_localDictCache) return _localDictCache
    const dict = await readJsonObjectAsync(localStateFile)
    if (dict) {
      _localDictCache = Object.assign(Object.create(null), dict)
    }
    return _localDictCache
  }

  function readLocal(key, fallback) {
    if (!isSafeLocalKey(key)) return fallback
    const k = String(key)
    const dict = loadLocalDict()
    if (!dict || !Object.prototype.hasOwnProperty.call(dict, k)) return fallback
    return dict[k] === undefined ? fallback : dict[k]
  }

  async function readLocalAsync(key, fallback) {
    if (!isSafeLocalKey(key)) return fallback
    const k = String(key)
    const dict = await loadLocalDictAsync()
    if (!dict || !Object.prototype.hasOwnProperty.call(dict, k)) return fallback
    return dict[k] === undefined ? fallback : dict[k]
  }

  function writeLocal(key, value) {
    if (!isSafeLocalKey(key)) return false
    const k = String(key)
    const curDict = loadLocalDict()
    const dict = Object.assign(Object.create(null), curDict || {})
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
    if (!isSafeLocalKey(key)) return false
    const k = String(key)
    const curDict = loadLocalDict()
    if (!curDict || !Object.prototype.hasOwnProperty.call(curDict, k)) return true
    const dict = Object.assign(Object.create(null), curDict)
    delete dict[k]
    if (!writeJsonAtomic(localStateFile, dict, false)) return false
    _localDictCache = dict
    return true
  }

  function cleanupImages(opts = {}) {
    try {
      if (!fs.existsSync(imageDir)) return 0
      const protect = opts && opts.protect ? normalizeForCompare(opts.protect) : ''
      const ts = now()
      let removed = 0
      const kept = []
      for (const f of fs.readdirSync(imageDir)) {
        const p = path.join(imageDir, f)
        try {
          const st = fs.lstatSync(p)
          if (st.isSymbolicLink() || !st.isFile()) continue
          const isProtected = protect && normalizeForCompare(p) === protect
          if (!isProtected && imageMaxAgeMs > 0 && ts - st.mtimeMs > imageMaxAgeMs) {
            fs.unlinkSync(p)
            removed++
            continue
          }
          kept.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, isProtected })
        } catch (_) {}
      }
      if (maxImageTotalBytes > 0) {
        let totalBytes = kept.reduce((sum, item) => sum + item.size, 0)
        if (totalBytes > maxImageTotalBytes) {
          kept.sort((a, b) => (a.mtimeMs - b.mtimeMs) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          for (const item of kept) {
            if (totalBytes <= maxImageTotalBytes) break
            if (item.isProtected) continue
            try {
              fs.unlinkSync(item.path)
              totalBytes -= item.size
              removed++
            } catch (_) {}
          }
        }
      }
      return removed
    } catch (_) {
      return 0
    }
  }

  async function cleanupImagesAsync(opts = {}) {
    try {
      try { await fsp.access(imageDir) } catch (_) { return 0 }
      const protect = opts && opts.protect ? normalizeForCompare(opts.protect) : ''
      const ts = now()
      let removed = 0
      const kept = []
      const files = await fsp.readdir(imageDir)
      for (const f of files) {
        const p = path.join(imageDir, f)
        try {
          const st = await fsp.lstat(p)
          if (st.isSymbolicLink() || !st.isFile()) continue
          const isProtected = protect && normalizeForCompare(p) === protect
          if (!isProtected && imageMaxAgeMs > 0 && ts - st.mtimeMs > imageMaxAgeMs) {
            await fsp.unlink(p)
            removed++
            continue
          }
          kept.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, isProtected })
        } catch (_) {}
      }
      if (maxImageTotalBytes > 0) {
        let totalBytes = kept.reduce((sum, item) => sum + item.size, 0)
        if (totalBytes > maxImageTotalBytes) {
          kept.sort((a, b) => (a.mtimeMs - b.mtimeMs) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          for (const item of kept) {
            if (totalBytes <= maxImageTotalBytes) break
            if (item.isProtected) continue
            try {
              await fsp.unlink(item.path)
              totalBytes -= item.size
              removed++
            } catch (_) {}
          }
        }
      }
      return removed
    } catch (_) {
      return 0
    }
  }

  function deleteImages(paths) {
    if (!Array.isArray(paths) || !paths.length || !fs.existsSync(imageDir)) return 0
    let realImgDir
    try {
      realImgDir = fs.realpathSync(imageDir)
    } catch (_) {
      return 0
    }
    let removed = 0
    const seen = new Set()
    for (const raw of paths) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      const candidate = path.resolve(raw.trim())
      const normKey = normalizeForCompare(candidate)
      if (seen.has(normKey)) continue
      seen.add(normKey)
      if (!isPathWithinRoot(candidate, imageDir) && !isPathWithinRoot(candidate, realImgDir)) continue
      try {
        const st = fs.lstatSync(candidate)
        if (st.isSymbolicLink() || !st.isFile()) continue
        const realTarget = fs.realpathSync(candidate)
        if (normalizeForCompare(realTarget) === normalizeForCompare(realImgDir)) continue
        if (!isPathWithinRoot(realTarget, realImgDir)) continue
        fs.unlinkSync(realTarget)
        removed++
      } catch (_) {}
    }
    return removed
  }

  function clearImages() {
    try {
      if (!fs.existsSync(imageDir)) return 0
      let removed = 0
      for (const f of fs.readdirSync(imageDir)) {
        const p = path.join(imageDir, f)
        try {
          const st = fs.lstatSync(p)
          if (st.isSymbolicLink() || !st.isFile()) continue
          fs.unlinkSync(p)
          removed++
        } catch (_) {}
      }
      return removed
    } catch (_) {
      return 0
    }
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
    // 解码前先按 base64 长度预估体积，避免超大输入先分配 Buffer
    const estBytes = estimateBase64Bytes(m[2])
    if (estBytes > maxImageBytes) {
      throw new Error(`图片过大（${(estBytes / 1048576).toFixed(1)}MB），单张上限 ${maxImageBytes / 1048576}MB`)
    }
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length > maxImageBytes) {
      throw new Error(`图片过大（${(buf.length / 1048576).toFixed(1)}MB），单张上限 ${maxImageBytes / 1048576}MB`)
    }
    fs.mkdirSync(imageDir, { recursive: true })
    const file = path.join(imageDir, `img-${now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`)
    fs.writeFileSync(file, buf)
    if (asyncCleanup) {
      const ts = now()
      if (ts - _lastAsyncCleanupAt > 15000) {
        _lastAsyncCleanupAt = ts
        setImmediate(() => { cleanupImagesAsync({ protect: file }).catch(() => {}) })
      }
    } else {
      try { cleanupImages({ protect: file }) } catch (_) {}
    }
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
    cleanupImagesAsync,
    deleteImages,
    clearImages,
    saveImage,
    isAllowedExternalUrl,
    isPathWithinRoot,
    resolveSafeOpenTarget,
    matchAllowedDir,
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
  matchAllowedDir,
  writeJsonAtomic,
  estimateBase64Bytes,
}
