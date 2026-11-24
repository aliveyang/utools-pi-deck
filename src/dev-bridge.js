// dev 模式 piBridge：通过本地 vite API 调用真实 pi CLI（无 uTools 时）
const BASE = '/__pideck/api'

function saveImage() {
  throw new Error('dev 预览模式不支持图片落盘，请在 uTools 中测试图片功能')
}

let activeCtrl = null
function run(opts, handlers) {
  const ctrl = new AbortController()
  activeCtrl = ctrl
  fetch(BASE + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
    signal: ctrl.signal,
  }).then(async res => {
    if (!res.ok) {
      handlers.onError && handlers.onError('dev API 请求失败：HTTP ' + res.status)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = '', doneFired = false
    const finish = data => { if (!doneFired) { doneFired = true; handlers.onDone && handlers.onDone(data) } }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let sep
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, sep); buf = buf.slice(sep + 2)
        const line = chunk.split('\n').find(l => l.startsWith('data: '))
        if (!line) continue
        let msg
        try { msg = JSON.parse(line.slice(6)) } catch (_) { continue }
        switch (msg.type) {
          case 'event': handlers.onEvent && handlers.onEvent(msg.data); break
          case 'text': handlers.onText && handlers.onText(msg.data); break
          case 'thinking': handlers.onThinking && handlers.onThinking(msg.data); break
          case 'usage': handlers.onUsage && handlers.onUsage(msg.data); break
          case 'stderr': console.warn('[pi]', msg.data); break
          case 'tool_start': handlers.onTool && handlers.onTool('start', msg.data.name, msg.data.args, msg.data.id); break
          case 'tool_end': handlers.onTool && handlers.onTool('end', msg.data.name, msg.data.result, msg.data.id); break
          case 'error': handlers.onError && handlers.onError(msg.data); break
          case 'done': finish(msg.data); break
          case 'close':
            if (!doneFired) { if (msg.data && msg.data.code !== 0) handlers.onError && handlers.onError('pi 退出 code ' + msg.data.code); else finish({}) }
            break
        }
      }
    }
    if (!doneFired) finish({})
  }).catch(err => {
    if (err.name === 'AbortError') return
    handlers.onError && handlers.onError(String(err.message || err))
  })
  return { cancel: () => ctrl.abort() }
}

function syncReq(method, path) {
  try {
    const x = new XMLHttpRequest()
    x.open(method, BASE + path, false)
    x.send()
    return x.status === 200 ? JSON.parse(x.responseText) : null
  } catch (_) { return null }
}
function syncGet(path) { return syncReq('GET', path) }
function syncPost(path) { return syncReq('POST', path) }

let homedir = (syncGet('/homedir') || {}).homedir || ''

function listModelsAsync() {
  // 与 preload.listModelsAsync 对齐：强制绕过 dev-server 的 60s TTL 缓存
  return fetch(BASE + '/models?force=1').then(r => r.json())
}

window.piBridge = {
  run,
  cancel: () => { if (activeCtrl) activeCtrl.abort() },
  saveImage,
  pickFolder: () => null,
  pickFiles: () => null,
  pickExecutable: () => null,
  validateCwd: p => !!(p),
  listSkillsAsync: async cwd => {
    try { return await fetch(BASE + '/skills?cwd=' + encodeURIComponent(cwd || '')).then(r => r.json()) }
    catch (_) { return [] }
  },
  listModelsAsync,
  listFilesAsync: async (cwd, query) => {
    try { return await fetch(BASE + '/files?cwd=' + encodeURIComponent(cwd || '') + '&q=' + encodeURIComponent(query || '')).then(r => r.json()) }
    catch (_) { return [] }
  },
  detectContextFiles: cwd => syncGet('/context?cwd=' + encodeURIComponent(cwd || '')) || [],
  getDefaults: async cwd => {
    try { return await fetch(BASE + '/defaults?cwd=' + encodeURIComponent(cwd || '')).then(r => r.json()) }
    catch (_) { return {} }
  },
  deletePiSession: id => {
    try { return syncPost('/delete-session?id=' + encodeURIComponent(id || '')) || { ok: false } }
    catch (_) { return { ok: false } }
  },
  getEnvAsync: async () => {
    try { return await fetch(BASE + '/env').then(r => r.json()) }
    catch (_) { return {} }
  },
  openPath: () => false,   // 浏览器预览无法打开系统文件管理器
  saveTextFile: () => ({ ok: false, unsupported: true }),   // 走前端 Blob 降级
  openExternal: url => {
    try {
      const parsed = new URL(String(url || '').trim())
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      window.open(parsed.href, '_blank', 'noopener,noreferrer')
      return true
    } catch (_) { return false }
  },
  // 本地缓存与本机状态（与 preload 签名对齐，走浏览器 localStorage 隔离前缀）
  readCacheMeta: key => {
    try {
      const raw = localStorage.getItem('pideck.devcache.' + key)
      if (!raw) return null
      const e = JSON.parse(raw)
      if (!e || typeof e.t !== 'number' || e.data === undefined) return null
      const ageMs = Math.max(0, Date.now() - e.t)
      if (ageMs > 24 * 60 * 60 * 1000) return null
      return { data: e.data, fresh: ageMs <= 5 * 60 * 1000, ageMs }
    } catch (_) { return null }
  },
  readCacheMetaAsync: key => Promise.resolve(window.piBridge.readCacheMeta(key)),
  readCache: key => {
    const meta = window.piBridge.readCacheMeta(key)
    return (meta && meta.fresh) ? meta.data : null
  },
  writeCache: (key, data) => {
    try { localStorage.setItem('pideck.devcache.' + key, JSON.stringify({ t: Date.now(), data })); return true }
    catch (_) { return false }
  },
  readLocal: (key, fallback) => {
    try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw) }
    catch (_) { return fallback }
  },
  readLocalAsync: (key, fallback) => Promise.resolve(window.piBridge.readLocal(key, fallback)),
  writeLocal: (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); return true }
    catch (_) { return false }
  },
  // dev 模式不启用 RPC（走 dev-server JSON），保留接口形状一致
  getConfig: () => ({ engine: 'json' }),
  getConfigAsync: () => Promise.resolve({ engine: 'json' }),
  setConfig: () => ({}),
  prewarmRpc: () => Promise.resolve(false),
  stopRpc: () => {},
  getRpcDefaults: () => null,
  resolvePiAsync: async () => {
    try { return await fetch(BASE + '/resolve').then(r => r.json()) }
    catch (_) { return { ok: false, error: 'dev API 不可用' } }
  },
  resetPiCache: () => { try { syncPost('/reset-cache') } catch (_) {} },
  installPiInTerminal: () => false,
  homedir: () => homedir,
  // dev 预览不读写真实 pi 配置与审计目录
  auditTail: () => [],
  auditExport: () => '',
  auditDir: () => '',
  auditClear: () => ({ removed: 0, failed: 0 }),
  auditRecord: () => false,
  configState: () => ({ ok: false, error: 'dev 预览不支持修改 pi 配置，请在 uTools 中使用' }),
  configSave: () => ({ ok: false, error: 'dev 预览不支持修改 pi 配置' }),
  configRemoveKey: () => ({ ok: false, error: 'dev 预览不支持修改 pi 配置' }),
  configAuthCheck: () => Promise.resolve({ status: 'unavailable' }),
  configLoginCommand: provider => 'pi auth login ' + provider,
  openTerminalForProvider: () => false,
}
