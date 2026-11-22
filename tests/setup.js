// 测试环境 stub：storage.js 依赖 window.utools.dbStorage 或 localStorage
// 用 Map + Proxy 模拟 localStorage，使 Object.keys(localStorage) 能枚举已存 key
// （sessions.listItemIds 的 localStorage 兜底分支依赖该行为）
const store = new Map()

globalThis.localStorage = new Proxy({}, {
  get(_, k) {
    if (k === 'getItem') return key => (store.has(key) ? store.get(key) : null)
    if (k === 'setItem') return (key, v) => { store.set(key, String(v)) }
    if (k === 'removeItem') return key => { store.delete(key) }
    if (k === 'clear') return () => store.clear()
    return store.has(k) ? store.get(k) : undefined
  },
  set(_, k, v) { store.set(k, String(v)); return true },
  deleteProperty(_, k) { store.delete(k); return true },
  ownKeys() { return [...store.keys()] },
  getOwnPropertyDescriptor() {
    // enumerable 使 Object.keys 可枚举全部存储 key
    return { enumerable: true, configurable: true, writable: true }
  },
})

// 无 uTools 环境：storage.backend() 走 localStorage 分支
globalThis.window = { utools: undefined }
