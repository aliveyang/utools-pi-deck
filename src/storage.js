// 统一存储层：uTools dbStorage 优先，localStorage 降级
// 契约：存 JSON 字符串（避开 Electron IPC 无法克隆 Proxy），读兼容对象/字符串/旧数据
function backend() {
  return (window.utools && window.utools.dbStorage) ? window.utools.dbStorage : localStorage
}

export function read(key, fallback) {
  try {
    const raw = backend().getItem(key)
    if (raw == null) return fallback
    if (Array.isArray(raw)) return raw          // 旧数据：dbStorage 存的对象
    if (typeof raw === 'object') return raw     // 旧数据：dbStorage 返回对象
    if (typeof raw === 'string') return JSON.parse(raw)
    return fallback
  } catch (_) { return fallback }
}

export function write(key, value) {
  // 关键：必须存字符串，uTools dbStorage 走 IPC 无法克隆 Vue Proxy
  backend().setItem(key, JSON.stringify(value))
}

export function remove(key) {
  backend().removeItem(key)
}

const CACHE_TTL = 5 * 60 * 1000
// 带 TTL 的缓存：命中返回 data，未命中/过期返回 null
export function readCache(key) {
  const entry = read('pideck.cache.' + key, null)
  if (!entry || !entry.t || Date.now() - entry.t > CACHE_TTL) return null
  return entry.data
}
export function writeCache(key, data) {
  write('pideck.cache.' + key, { t: Date.now(), data })
}
