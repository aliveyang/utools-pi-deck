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
const LOCAL_CACHE_PREFIX = 'pideck.localcache.'

export function readCache(key) {
  try {
    if (window.piBridge && typeof window.piBridge.readCache === 'function') {
      return window.piBridge.readCache(key)
    }
  } catch (_) {}
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(LOCAL_CACHE_PREFIX + key)
    if (!raw) return null
    const entry = JSON.parse(raw)
    if (!entry || typeof entry.t !== 'number' || Date.now() - entry.t > CACHE_TTL) return null
    return entry.data === undefined ? null : entry.data
  } catch (_) { return null }
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
