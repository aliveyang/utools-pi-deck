// dev-only vite 插件：本地 API 代理，让浏览器预览能真实调用 pi CLI
// 核心逻辑复用 shared/pi-core.cjs 与 shared/runner.cjs
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const core = require('./shared/pi-core.cjs')
const runnerMod = require('./shared/runner.cjs')

function readJson(req) {
  return new Promise(resolve => {
    const MAX = 8 * 1024 * 1024   // 8MB：容纳长 prompt + 引用文件
    let size = 0
    let d = ''
    let tooLarge = false
    const ts = core.makeTextStream()   // 跨 chunk UTF-8 安全
    req.on('data', c => {
      size += c.length
      if (size > MAX) { tooLarge = true; return }
      d += ts.push(c)
    })
    req.on('end', () => {
      if (tooLarge) return resolve({ __tooLarge: true })
      d += ts.end()
      try { resolve(JSON.parse(d || '{}')) } catch (_) { resolve({}) }
    })
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
        if (origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
          res.statusCode = 403; res.end('forbidden'); return
        }
        const host = String(req.headers.host || '').toLowerCase()
        if (host && !/^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/.test(host)) {
          res.statusCode = 403; res.end('forbidden'); return
        }

        if (p === 'resolve') {
          res.setHeader('Content-Type', 'application/json')
          try { const r = core.resolvePi(); res.end(JSON.stringify({ ok: true, ...r })) }
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
          try { res.end(JSON.stringify(core.listModels(url.searchParams.get('force') === '1'))) }
          catch (e) { res.statusCode = 500; res.end(String(e.message)) }
          return
        }
        if (p === 'files') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(core.listFiles(url.searchParams.get('cwd'), url.searchParams.get('q'))))
          return
        }
        if (p === 'skills') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(core.listSkills(url.searchParams.get('cwd'))))
          return
        }
        if (p === 'context') {
          res.setHeader('Content-Type', 'application/json')
          try { res.end(JSON.stringify(core.detectContextFiles(url.searchParams.get('cwd')))) }
          catch (_) { res.end('[]') }
          return
        }
        if (p === 'env') {
          res.setHeader('Content-Type', 'application/json')
          try { res.end(JSON.stringify(core.getEnv())) }
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
          try { res.end(JSON.stringify(await core.getDefaults(url.searchParams.get('cwd')))) }
          catch (e) { res.end(JSON.stringify({ error: String(e.message || e) })) }
          return
        }
        if (p === 'reset-cache') {
          if (req.method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return }
          core.resetPiCache()
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
          return
        }
        if (p === 'run') {
          if (req.method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return }
          let body = await readJson(req)
          if (body && body.__tooLarge) { res.statusCode = 413; res.end('payload too large'); return }
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`) } catch (_) {} }
          const devRunner = runnerMod.createRunner({ core, loadConfig: () => ({ engine: 'json' }) })
          let ended = false
          const endStream = () => { if (!ended) { ended = true; res.end() } }
          let handle
          try {
            handle = devRunner.run(body, {
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
