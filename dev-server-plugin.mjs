// dev-only vite 插件：本地 API 代理，让浏览器预览能真实调用 pi CLI
// 核心逻辑复用 shared/pi-core.cjs
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
const require = createRequire(import.meta.url)
const core = require('./shared/pi-core.cjs')

const { execFileSync } = require('node:child_process')

function readJson(req) {
  return new Promise(resolve => {
    let d = ''
    const MAX = 8 * 1024 * 1024   // 8MB：容纳长 prompt + 引用文件，超限截断
    req.on('data', c => { if (d.length < MAX) d += c })
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch (_) { resolve({}) } })
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
        // dev-only 安全：仅允许本机来源
        const origin = req.headers.origin || ''
        if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
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
        if (p === 'run') {
          const body = await readJson(req)
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`) } catch (_) {} }

          let node, args
          try {
            // 禁工具的纯文本分组：替换 system prompt，避免模型输出原始工具调用标记
            if (core.permFlags(body.perm, body).noTools && !body.systemPrompt) body.systemPrompt = core.LEAN_SYSTEM_PROMPT
            node = core.resolvePi().node; args = core.buildArgs(body)
          }
          catch (e) { send('error', e.message); res.end(); return }

          const child = spawn(node, args, {
            cwd: core.effectiveCwd(body.cwd), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          })
          const buf = core.makeLineBuffer()
          let doneFired = false
          const finish = data => { if (!doneFired) { doneFired = true; send('done', data) } }
          child.stdout.on('data', chunk => {
            core.pushChunk(buf, chunk, rec => {
              const settled = core.mapPiEvent(rec, {
                onText: d => send('text', d),
                onThinking: d => send('thinking', d),
                onUsage: u => send('usage', u),
                onTool: (phase, name, payload, id) => send(phase === 'start' ? 'tool_start' : 'tool_end',
                  phase === 'start' ? { name, args: payload, id } : { name, result: payload, id }),
                onEvent: r => send('event', r),
              })
              if (settled) finish({ aborted: false })
            })
          })
          child.stderr.on('data', c => send('stderr', c.toString('utf8').slice(0, 500)))
          child.on('close', code => {
            if (!doneFired) finish({ aborted: false, code })
            send('close', { code })
            res.end()
          })
          const timer = setTimeout(() => {
            try { child.kill() } catch (_) {}
            send('error', 'pi 运行超时（15 分钟）')
          }, 15 * 60 * 1000)
          child.on('close', () => clearTimeout(timer))
          req.on('close', () => { try { child.kill() } catch (_) {} })
          return
        }
        res.statusCode = 404; res.end('not found')
      })
    },
  }
}
