// dev-only vite 插件：本地 API 代理，让浏览器预览能真实调用 pi CLI
// 核心逻辑复用 shared/pi-core.cjs 与 shared/runner.cjs
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const core = require('./shared/pi-core.cjs')
const localStore = require('./shared/local-store.cjs')
const runnerMod = require('./shared/runner.cjs')

const devRunner = runnerMod.createRunner({ core, loadConfig: () => ({ engine: 'json' }) })

function resolveDevCwd(rawCwd, { allowEmpty = false } = {}) {
  const s = typeof rawCwd === 'string' ? rawCwd.trim() : ''
  if (!s) return allowEmpty ? '' : core.resolveCwd('')
  const allowedRoots = [process.cwd(), core.resolveCwd('')]
  try {
    const real = core.fs.realpathSync(s)
    if (allowedRoots.some(r => {
      try { return localStore.isPathWithinRoot(real, core.fs.realpathSync(r)) } catch (_) { return false }
    })) {
      return real
    }
  } catch (_) {}
  return null
}

function filterDevFiles(files, safeCwd) {
  if (!Array.isArray(files) || !files.length) return []
  const allowedRoots = [safeCwd, process.cwd(), core.resolveCwd(''), localStore.imageDir].filter(Boolean)
  const realRoots = []
  for (const r of allowedRoots) {
    try { realRoots.push(core.fs.realpathSync(r)) } catch (_) {}
  }
  const out = []
  for (const item of files) {
    if (typeof item !== 'string' || !item.trim()) continue
    const raw = item.trim()
    if (/^data:/i.test(raw) || /[\r\n\0]/.test(raw)) {
      throw new Error('附件路径不合法')
    }
    let realFile = ''
    try {
      realFile = core.fs.realpathSync(raw)
      if (!core.fs.statSync(realFile).isFile()) throw new Error('非文件')
    } catch (_) {
      throw new Error('附件文件不可访问')
    }
    if (!realRoots.some(r => localStore.isPathWithinRoot(realFile, r))) {
      throw new Error('附件不在 dev 授权工作区内')
    }
    out.push(realFile)
  }
  return out
}

function filterDevSkillPaths(skillPaths, safeCwd) {
  if (!Array.isArray(skillPaths) || !skillPaths.length) return []
  const roots = core.skillRoots ? core.skillRoots(safeCwd) : []
  const realRoots = []
  for (const r of roots) {
    try { realRoots.push(core.fs.realpathSync(r)) } catch (_) {}
  }
  const discoveredDirs = new Set()
  if (core.listSkills) {
    try {
      for (const sk of (core.listSkills(safeCwd) || [])) {
        if (!sk || !sk.dir) continue
        try {
          const realSk = core.fs.realpathSync(sk.dir)
          discoveredDirs.add(process.platform === 'win32' ? realSk.toLowerCase() : realSk)
        } catch (_) {}
      }
    } catch (_) {}
  }
  const out = []
  for (const raw of skillPaths) {
    if (typeof raw !== 'string') continue
    const s = raw.trim()
    if (!s || s.startsWith('-') || /[\r\n\0]/.test(s)) continue
    try {
      const real = core.fs.realpathSync(s)
      if (!core.fs.statSync(real).isDirectory()) continue
      const normReal = process.platform === 'win32' ? real.toLowerCase() : real
      if (realRoots.some(r => localStore.isPathWithinRoot(real, r)) || discoveredDirs.has(normReal)) {
        out.push(real)
      }
    } catch (_) {}
  }
  return out
}

function readJson(req) {
  return new Promise(resolve => {
    const MAX = 8 * 1024 * 1024   // 8MB：容纳长 prompt + 引用文件
    let size = 0
    let d = ''
    let tooLarge = false
    let settled = false
    const finish = val => {
      if (settled) return
      settled = true
      resolve(val)
    }
    const ts = core.makeTextStream()   // 跨 chunk UTF-8 安全
    req.on('data', c => {
      size += c.length
      if (size > MAX) { tooLarge = true; return }
      d += ts.push(c)
    })
    req.on('end', () => {
      if (tooLarge) return finish({ __tooLarge: true })
      d += ts.end()
      try { finish(JSON.parse(d || '{}')) } catch (_) { finish({}) }
    })
    req.on('error', () => finish({}))
    req.on('aborted', () => finish({}))
  })
}

export function piDevApi() {
  return {
    name: 'pideck-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__pideck/api', async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const p = url.pathname.replace(/^\//, '')
        // dev-only 安全：仅允许本机来源（Origin 校验浏览器请求）+ Host 校验（防 DNS rebinding）
        const origin = req.headers.origin || ''
        const localOriginRe = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
        if (origin && !localOriginRe.test(origin)) {
          res.statusCode = 403; res.end('forbidden'); return
        }
        if (req.method === 'POST' && !localOriginRe.test(origin)) {
          res.statusCode = 403; res.end('forbidden'); return
        }
        const host = String(req.headers.host || '').toLowerCase()
        if (host && !/^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/.test(host)) {
          res.statusCode = 403; res.end('forbidden'); return
        }

        if (p === 'resolve') {
          res.setHeader('Content-Type', 'application/json')
          try { const r = await core.resolvePiAsync(); res.end(JSON.stringify({ ok: true, ...r })) }
          catch (e) { res.end(JSON.stringify({ ok: false, error: e.message })) }
          return
        }
        if (p === 'homedir') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ homedir: core.os.homedir() }))
          return
        }
        if (p === 'models') {
          res.setHeader('Content-Type', 'application/json')
          try { res.end(JSON.stringify(await devRunner.listModelsAsync({ force: url.searchParams.get('force') === '1' }))) }
          catch (e) { res.statusCode = 500; res.end(String(e.message)) }
          return
        }
        if (p === 'files') {
          res.setHeader('Content-Type', 'application/json')
          const safeCwd = resolveDevCwd(url.searchParams.get('cwd'))
          if (!safeCwd) { res.end('[]'); return }
          res.end(JSON.stringify(await core.listFilesAsync(safeCwd, url.searchParams.get('q'))))
          return
        }
        if (p === 'skills') {
          res.setHeader('Content-Type', 'application/json')
          const safeCwd = resolveDevCwd(url.searchParams.get('cwd'), { allowEmpty: true })
          if (safeCwd === null) { res.end('[]'); return }
          res.end(JSON.stringify(await core.listSkillsAsync(safeCwd)))
          return
        }
        if (p === 'context') {
          res.setHeader('Content-Type', 'application/json')
          const safeCwd = resolveDevCwd(url.searchParams.get('cwd'), { allowEmpty: true })
          if (safeCwd === null) { res.end('[]'); return }
          try { res.end(JSON.stringify(core.detectContextFiles(safeCwd))) }
          catch (_) { res.end('[]') }
          return
        }
        if (p === 'env') {
          res.setHeader('Content-Type', 'application/json')
          try { res.end(JSON.stringify(await core.getEnvAsync())) }
          catch (e) { res.end(JSON.stringify({ ok: false, error: String(e.message || e) })) }
          return
        }
        if (p === 'delete-session') {
          if (req.method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return }
          res.setHeader('Content-Type', 'application/json')
          try { res.end(JSON.stringify(core.deletePiSession(url.searchParams.get('id')))) }
          catch (e) { res.end(JSON.stringify({ ok: false, error: String(e.message || e) })) }
          return
        }
        if (p === 'defaults') {
          res.setHeader('Content-Type', 'application/json')
          const safeCwd = resolveDevCwd(url.searchParams.get('cwd'))
          if (!safeCwd) { res.end(JSON.stringify({})); return }
          try { res.end(JSON.stringify(await core.getDefaults(safeCwd))) }
          catch (e) { res.end(JSON.stringify({ error: String(e.message || e) })) }
          return
        }
        if (p === 'reset-cache') {
          if (req.method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return }
          core.resetPiCache()
          if (devRunner.resetModelsCache) devRunner.resetModelsCache()
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
          return
        }
        if (p === 'run') {
          if (req.method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return }
          let body = await readJson(req)
          if (body && body.__tooLarge) { res.statusCode = 413; res.end('payload too large'); return }
          const safeCwd = resolveDevCwd(body && body.cwd)
          if (!safeCwd) { res.statusCode = 403; res.end('forbidden cwd'); return }
          let safeFiles = []
          try { safeFiles = filterDevFiles(body && body.files, safeCwd) }
          catch (e) { res.statusCode = 403; res.end(String(e.message || 'forbidden files')); return }
          const nextTool = (body && body.tool && typeof body.tool === 'object')
            ? { ...body.tool, skillPaths: filterDevSkillPaths(body.tool.skillPaths, safeCwd) }
            : (body && body.tool)
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`) } catch (_) {} }
          let ended = false
          const endStream = () => { if (!ended) { ended = true; res.end() } }
          let handle
          try {
            handle = devRunner.run({ ...body, cwd: safeCwd, files: safeFiles, tool: nextTool }, {
              onEvent: r => send('event', r),
              onText: d => send('text', d),
              onThinking: d => send('thinking', d),
              onUsage: u => send('usage', u),
              onTool: (phase, name, payload, id) => send(
                phase === 'start' ? 'tool_start' : 'tool_end',
                phase === 'start' ? { name, args: payload, id } : { name, result: payload, id },
              ),
              onDone: payload => { send('done', payload); send('close', { code: 0 }); endStream() },
              onError: msg => { send('error', msg); send('close', { code: 1 }); endStream() },
              onClose: code => { send('close', { code }); endStream() },
            })
          } catch (e) {
            send('error', String(e.message || e))
            endStream()
            return
          }
          req.on('close', () => {
            if (!ended && handle && handle.cancel) {
              try { handle.cancel() } catch (_) {}
            }
            ended = true
          })
          return
        }
        res.statusCode = 404; res.end('not found')
      })
    },
  }
}
