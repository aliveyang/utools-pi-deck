// 统一存储层：uTools dbStorage 优先，localStorage 降级
// 契约：
// - 用户数据（分组、会话、偏好）使用 read/write/remove 存入 dbStorage（随账号同步）
// - 本机状态（草稿）使用 readLocal/writeLocal 存入本地数据目录/localStorage（不同步）
// - 可重建缓存（模型列表、技能列表、默认配置）使用 readCache/writeCache 存入临时目录/localStorage（不同步）
function backend() {
  return (window.utools && window.utools.dbStorage) ? window.utools.dbStorage : localStorage
}

function parseRaw(raw, fallback) {
  if (raw == null) return fallback
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'object') return raw
  if (typeof raw === 'string') return JSON.parse(raw)
  return fallback
}

export function read(key, fallback) {
  try {
    return parseRaw(backend().getItem(key), fallback)
  } catch (_) { return fallback }
}

export function write(key, value) {
  // 关键：必须存字符串，uTools dbStorage 走 IPC 无法克隆 Vue Proxy
  try {
    backend().setItem(key, JSON.stringify(value))
    return true
  } catch (e) {
    console.warn('[PiDeck] storage write failed:', key, e)
    return false
  }
}

export function remove(key) {
  try {
    backend().removeItem(key)
    return true
  } catch (e) {
    console.warn('[PiDeck] storage remove failed:', key, e)
    return false
  }
}

export function readLocal(key, fallback) {
  try {
    if (window.piBridge && typeof window.piBridge.readLocal === 'function') {
      return window.piBridge.readLocal(key, fallback)
    }
  } catch (_) {}
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : parseRaw(raw, fallback)
  } catch (_) { return fallback }
}

export async function readLocalAsync(key, fallback) {
  try {
    if (window.piBridge && typeof window.piBridge.readLocalAsync === 'function') {
      return await window.piBridge.readLocalAsync(key, fallback)
    }
  } catch (_) {}
  return readLocal(key, fallback)
}

export function writeLocal(key, value) {
  try {
    if (window.piBridge && typeof window.piBridge.writeLocal === 'function') {
      return !!window.piBridge.writeLocal(key, value)
    }
  } catch (_) {}
  try {
    if (typeof localStorage === 'undefined') return false
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (_) { return false }
}

const CACHE_TTL = 5 * 60 * 1000
const STALE_TTL = 24 * 60 * 60 * 1000
const LOCAL_CACHE_PREFIX = 'pideck.localcache.'

export function readCacheMeta(key) {
  try {
    if (window.piBridge && typeof window.piBridge.readCacheMeta === 'function') {
      return window.piBridge.readCacheMeta(key)
    }
    if (window.piBridge && typeof window.piBridge.readCache === 'function') {
      const data = window.piBridge.readCache(key)
      return data == null ? null : { data, fresh: true, ageMs: 0 }
    }
  } catch (_) {}
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(LOCAL_CACHE_PREFIX + key)
    if (!raw) return null
    const entry = JSON.parse(raw)
    if (!entry || typeof entry.t !== 'number' || entry.data === undefined) return null
    const ageMs = Math.max(0, Date.now() - entry.t)
    if (ageMs > STALE_TTL) return null
    return { data: entry.data, fresh: ageMs <= CACHE_TTL, ageMs }
  } catch (_) { return null }
}

export async function readCacheMetaAsync(key) {
  try {
    if (window.piBridge && typeof window.piBridge.readCacheMetaAsync === 'function') {
      return await window.piBridge.readCacheMetaAsync(key)
    }
  } catch (_) {}
  return readCacheMeta(key)
}

export function readCache(key) {
  const meta = readCacheMeta(key)
  return (meta && meta.fresh) ? meta.data : null
}

export function writeCache(key, data) {
  try {
    if (window.piBridge && typeof window.piBridge.writeCache === 'function') {
      return !!window.piBridge.writeCache(key, data)
    }
  } catch (_) {}
  try {
    if (typeof localStorage === 'undefined') return false
    localStorage.setItem(LOCAL_CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), data }))
    return true
  } catch (_) { return false }
}

// 用户偏好合并读写（单 key 减少启动期同步 IPC 往返，兼容旧 4 个分离 key）
export const PREFS_KEY = 'pideck.prefs.v1'
export const LEGACY_PREF_KEYS = {
  defaultCwd: 'pideck.defaultCwd.v1',
  sendKey: 'pideck.sendKey.v1',
  layout: 'pideck.layout.v1',
  activeId: 'pideck.active.v1',
}

function normalizePrefs(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  return {
    defaultCwd: typeof src.defaultCwd === 'string' ? src.defaultCwd : '',
    sendKey: src.sendKey === 'enter' ? 'enter' : 'ctrl',
    layout: src.layout === 'console' ? 'console' : 'classic',
    activeId: (typeof src.activeId === 'string' && src.activeId) ? src.activeId : 'chat',
  }
}

export function loadPrefsBundle() {
  const bundled = read(PREFS_KEY, null)
  if (bundled && typeof bundled === 'object' && !Array.isArray(bundled)) {
    return { prefs: normalizePrefs(bundled), needsMigration: false }
  }
  const legacyCwd = read(LEGACY_PREF_KEYS.defaultCwd, null)
  const legacySendKey = read(LEGACY_PREF_KEYS.sendKey, null)
  const legacyLayout = read(LEGACY_PREF_KEYS.layout, null)
  const legacyActiveId = read(LEGACY_PREF_KEYS.activeId, null)
  const hasLegacy = legacyCwd !== null || legacySendKey !== null || legacyLayout !== null || legacyActiveId !== null
  const prefs = normalizePrefs({
    defaultCwd: legacyCwd || '',
    sendKey: legacySendKey || 'ctrl',
    layout: legacyLayout || 'classic',
    activeId: legacyActiveId || 'chat',
  })
  return { prefs, needsMigration: hasLegacy }
}

export function savePrefsBundle(prefs) {
  const next = normalizePrefs(prefs)
  write(PREFS_KEY, next)
  return next
}

export function savePrefsPatch(patch) {
  const { prefs } = loadPrefsBundle()
  return savePrefsBundle({ ...prefs, ...(patch && typeof patch === 'object' ? patch : {}) })
}
