// pi-core：preload 与 dev-server 共用的 Node 侧核心逻辑
// 职责：pi 定位（多平台）、JSONL 解析、技能/模型/文件扫描
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')
const { execFile, execFileSync, spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')

// ---------- pi 定位（多平台） ----------
const PI_INSTALL_CMD = 'npm i -g @earendil-works/pi-coding-agent'
let _piCache = null
let _nodeCache = null
let _nodeVersionCache = ''
let _resolvedHint = { nodePath: '', nodeVersion: '', piPath: '' }
let _findNodePromise = null
let _findPiPromise = null
let _overrides = { nodePath: '', piCliPath: '' }

function resetPiCache() {
  _piCache = null
  _nodeCache = null
  _nodeVersionCache = ''
  _resolvedHint = { nodePath: '', nodeVersion: '', piPath: '' }
  _findNodePromise = null
  _findPiPromise = null
  _modelsCache = null
  _modelsAt = 0
}

function seedResolvedPaths(hint) {
  if (!hint || typeof hint !== 'object') return
  _resolvedHint = {
    nodePath: String(hint.nodePath || '').trim(),
    nodeVersion: String(hint.nodeVersion || '').trim(),
    piPath: String(hint.piPath || '').trim(),
  }
}

function setPathOverrides(patch) {
  const p = patch && typeof patch === 'object' ? patch : {}
  if ('nodePath' in p) _overrides.nodePath = String(p.nodePath || '').trim()
  if ('piCliPath' in p) _overrides.piCliPath = String(p.piCliPath || '').trim()
  resetPiCache()
}

function parseNodeVersionStr(out) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(out || '').trim())
  return m ? { major: +m[1], minor: +m[2], raw: String(out || '').trim() } : null
}

function isSupportedNodeVersion(v) {
  return !!(v && (v.major > 22 || (v.major === 22 && v.minor >= 19)))
}

function nodeMajor(cmd) {
  try {
    const out = execFileSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()
    return parseNodeVersionStr(out)
  } catch (_) { return null }
}

function nodeMajorAsync(cmd) {
  return new Promise(resolve => {
    execFile(cmd, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(parseNodeVersionStr(stdout))
    })
  })
}

async function existsAsync(p) {
  if (!p) return false
  try { await fsp.access(p); return true } catch (_) { return false }
}

function parseSemverTag(name) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(name || ''))
  return m ? [+m[1], +m[2], +m[3]] : null
}

function listVersionDirsDesc(root, relBin) {
  try {
    if (!root || !fs.existsSync(root)) return []
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && parseSemverTag(d.name))
      .sort((a, b) => {
        const va = parseSemverTag(a.name), vb = parseSemverTag(b.name)
        return (vb[0] - va[0]) || (vb[1] - va[1]) || (vb[2] - va[2])
      })
    return dirs.map(d => path.join(root, d.name, relBin))
  } catch (_) { return [] }
}

async function listVersionDirsDescAsync(root, relBin) {
  try {
    if (!root || !(await existsAsync(root))) return []
    const entries = await fsp.readdir(root, { withFileTypes: true })
    const dirs = entries
      .filter(d => d.isDirectory() && parseSemverTag(d.name))
      .sort((a, b) => {
        const va = parseSemverTag(a.name), vb = parseSemverTag(b.name)
        return (vb[0] - va[0]) || (vb[1] - va[1]) || (vb[2] - va[2])
      })
    return dirs.map(d => path.join(root, d.name, relBin))
  } catch (_) { return [] }
}

function buildNodeCandidatesSync() {
  const home = os.homedir()
  return [
    _overrides.nodePath,
    process.env.PIDECK_NODE,
    // Windows 版本管理器与常见安装路径
    process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, 'node.exe') : '',
    ...listVersionDirsDesc(process.env.NVM_HOME || path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'nvm'), 'node.exe'),
    path.join(home, '.volta', 'bin', 'node.exe'),
    path.join(home, 'scoop', 'shims', 'node.exe'),
    ...listVersionDirsDesc(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'fnm', 'node-versions'), path.join('installation', 'node.exe')),
    path.join(home, 'AppData', 'Roaming', 'npm', 'node.exe'),
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    // macOS / Linux 版本管理器与系统路径
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    path.join(home, '.volta', 'bin', 'node'),
    ...listVersionDirsDesc(path.join(home, '.nvm', 'versions', 'node'), path.join('bin', 'node')),
    ...listVersionDirsDesc(path.join(home, '.fnm', 'node-versions'), path.join('installation', 'bin', 'node')),
    'node',
  ].filter(Boolean)
}

async function buildNodeCandidatesAsync() {
  const home = os.homedir()
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const [winNvm, winFnm, unixNvm, unixFnm] = await Promise.all([
    listVersionDirsDescAsync(process.env.NVM_HOME || path.join(appData, 'nvm'), 'node.exe'),
    listVersionDirsDescAsync(path.join(appData, 'fnm', 'node-versions'), path.join('installation', 'node.exe')),
    listVersionDirsDescAsync(path.join(home, '.nvm', 'versions', 'node'), path.join('bin', 'node')),
    listVersionDirsDescAsync(path.join(home, '.fnm', 'node-versions'), path.join('installation', 'bin', 'node')),
  ])
  return [
    _overrides.nodePath,
    process.env.PIDECK_NODE,
    process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, 'node.exe') : '',
    ...winNvm,
    path.join(home, '.volta', 'bin', 'node.exe'),
    path.join(home, 'scoop', 'shims', 'node.exe'),
    ...winFnm,
    path.join(home, 'AppData', 'Roaming', 'npm', 'node.exe'),
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    path.join(home, '.volta', 'bin', 'node'),
    ...unixNvm,
    ...unixFnm,
    'node',
  ].filter(Boolean)
}

function findNode() {
  if (_nodeCache) return _nodeCache
  const rawCandidates = buildNodeCandidatesSync()
  const seen = new Set()
  for (const cmd of rawCandidates) {
    if (seen.has(cmd)) continue
    seen.add(cmd)
    if (cmd !== 'node' && !fs.existsSync(cmd)) continue
    const v = nodeMajor(cmd)
    if (isSupportedNodeVersion(v)) {
      _nodeCache = cmd
      _nodeVersionCache = v.raw
      return cmd
    }
  }
  const err = new Error('未找到 Node.js >= 22.19，请安装：https://nodejs.org')
  err.code = 'NODE_MISSING'
  throw err
}

function findNodeAsync() {
  if (_nodeCache) return Promise.resolve(_nodeCache)
  if (_findNodePromise) return _findNodePromise
  _findNodePromise = (async () => {
    if (!_overrides.nodePath && !process.env.PIDECK_NODE && _resolvedHint.nodePath && _resolvedHint.nodePath !== 'node') {
      const hv = parseNodeVersionStr(_resolvedHint.nodeVersion)
      if (isSupportedNodeVersion(hv) && await existsAsync(_resolvedHint.nodePath)) {
        _nodeCache = _resolvedHint.nodePath
        _nodeVersionCache = hv.raw
        return _nodeCache
      }
    }
    const rawCandidates = await buildNodeCandidatesAsync()
    const seen = new Set()
    for (const cmd of rawCandidates) {
      if (seen.has(cmd)) continue
      seen.add(cmd)
      if (cmd !== 'node' && !(await existsAsync(cmd))) continue
      const v = await nodeMajorAsync(cmd)
      if (isSupportedNodeVersion(v)) {
        _nodeCache = cmd
        _nodeVersionCache = v.raw
        return cmd
      }
    }
    const err = new Error('未找到 Node.js >= 22.19，请安装：https://nodejs.org')
    err.code = 'NODE_MISSING'
    throw err
  })().finally(() => { _findNodePromise = null })
  return _findNodePromise
}

function buildPiBaseCandidatesSync() {
  const home = os.homedir()
  const pkgCli = path.join('@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')
  const relCli = path.join('node_modules', pkgCli)
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  return {
    relCli,
    candidates: [
      _overrides.piCliPath,
      process.env.PIDECK_PI_CLI,
      path.join(appData, 'npm', relCli),
      path.join(home, '.local', 'share', 'pnpm', 'global', relCli),
      path.join(localAppData, 'pnpm', 'global', '5', relCli),
      path.join(home, 'scoop', 'persist', 'nodejs', relCli),
      path.join(home, '.volta', 'tools', 'image', 'packages', '@earendil-works', 'pi-coding-agent', 'lib', relCli),
      process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, relCli) : '',
      ...listVersionDirsDesc(process.env.NVM_HOME || path.join(appData, 'nvm'), relCli),
      '/usr/local/lib/' + relCli,
      '/opt/homebrew/lib/' + relCli,
      ...listVersionDirsDesc(path.join(home, '.nvm', 'versions', 'node'), path.join('lib', relCli)),
    ].filter(Boolean),
  }
}

async function buildPiBaseCandidatesAsync() {
  const home = os.homedir()
  const pkgCli = path.join('@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')
  const relCli = path.join('node_modules', pkgCli)
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const [winNvm, unixNvm] = await Promise.all([
    listVersionDirsDescAsync(process.env.NVM_HOME || path.join(appData, 'nvm'), relCli),
    listVersionDirsDescAsync(path.join(home, '.nvm', 'versions', 'node'), path.join('lib', relCli)),
  ])
  return {
    relCli,
    candidates: [
      _overrides.piCliPath,
      process.env.PIDECK_PI_CLI,
      path.join(appData, 'npm', relCli),
      path.join(home, '.local', 'share', 'pnpm', 'global', relCli),
      path.join(localAppData, 'pnpm', 'global', '5', relCli),
      path.join(home, 'scoop', 'persist', 'nodejs', relCli),
      path.join(home, '.volta', 'tools', 'image', 'packages', '@earendil-works', 'pi-coding-agent', 'lib', relCli),
      process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, relCli) : '',
      ...winNvm,
      '/usr/local/lib/' + relCli,
      '/opt/homebrew/lib/' + relCli,
      ...unixNvm,
    ].filter(Boolean),
  }
}

function findPiCli() {
  if (_piCache) return _piCache
  const { relCli, candidates } = buildPiBaseCandidatesSync()
  // PATH 兜底：where / which pi（兼容 Windows npm shim 与 macOS/Linux 符号链接）
  if (!candidates.some(p => fs.existsSync(p))) {
    for (const cmd of ['where', 'which']) {
      try {
        const lines = execFileSync(cmd, ['pi'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
          .trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean)
        for (const out of lines) {
          if (!fs.existsSync(out)) continue
          try {
            const real = fs.realpathSync(out)
            if (/\.(js|mjs|cjs)$/i.test(real) && fs.existsSync(real)) candidates.push(real)
          } catch (_) {}
          const shimDir = path.dirname(out)
          for (const candidate of [
            path.join(shimDir, relCli),
            path.join(shimDir, '..', 'lib', relCli),
          ]) {
            if (fs.existsSync(candidate)) candidates.push(candidate)
          }
        }
        if (candidates.some(p => fs.existsSync(p))) break
      } catch (_) {}
    }
  }
  const found = candidates.find(p => fs.existsSync(p))
  if (!found) {
    const err = new Error(`未找到 pi CLI。请安装：${PI_INSTALL_CMD}\n或设置环境变量 PIDECK_PI_CLI 指向 cli.js`)
    err.code = 'PI_MISSING'
    throw err
  }
  _piCache = found
  return found
}

function execWhereWhichAsync(cmd) {
  return new Promise(resolve => {
    execFile(cmd, ['pi'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([])
      resolve(String(stdout || '').trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean))
    })
  })
}

function findPiCliAsync() {
  if (_piCache) return Promise.resolve(_piCache)
  if (_findPiPromise) return _findPiPromise
  _findPiPromise = (async () => {
    if (!_overrides.piCliPath && !process.env.PIDECK_PI_CLI && _resolvedHint.piPath) {
      if (await existsAsync(_resolvedHint.piPath)) {
        _piCache = _resolvedHint.piPath
        return _piCache
      }
    }
    const { relCli, candidates } = await buildPiBaseCandidatesAsync()
    for (const p of candidates) {
      if (await existsAsync(p)) {
        _piCache = p
        return p
      }
    }
    for (const cmd of ['where', 'which']) {
      const lines = await execWhereWhichAsync(cmd)
      for (const out of lines) {
        if (!(await existsAsync(out))) continue
        try {
          const real = await fsp.realpath(out)
          if (/\.(js|mjs|cjs)$/i.test(real) && await existsAsync(real)) {
            _piCache = real
            return real
          }
        } catch (_) {}
        const shimDir = path.dirname(out)
        for (const candidate of [
          path.join(shimDir, relCli),
          path.join(shimDir, '..', 'lib', relCli),
        ]) {
          if (await existsAsync(candidate)) {
            _piCache = candidate
            return candidate
          }
        }
      }
    }
    const err = new Error(`未找到 pi CLI。请安装：${PI_INSTALL_CMD}\n或设置环境变量 PIDECK_PI_CLI 指向 cli.js`)
    err.code = 'PI_MISSING'
    throw err
  })().finally(() => { _findPiPromise = null })
  return _findPiPromise
}

function resolvePi() {
  const node = findNode()
  const cli = findPiCli()
  return { node, cli }
}

async function resolvePiAsync() {
  const [node, cli] = await Promise.all([findNodeAsync(), findPiCliAsync()])
  return { node, cli }
}

// ---------- pi 事件 → 统一回调映射 ----------
// 三个调用方（preload JSON 模式、rpc-engine、dev-server）共用，避免逻辑漂移
// 返回 true 表示 agent_settled（调用方负责结束本次运行）
function mapPiEvent(rec, handlers) {
  const h = handlers || {}
  if (rec.type === 'message_update') {
    if (rec.usage && h.onUsage) h.onUsage(rec.usage)
    const e = rec.assistantMessageEvent
    if (e && e.type === 'text_delta') { if (h.onText) h.onText(e.delta || '', e.contentIndex) }
    else if (e && e.type === 'thinking_delta') { if (h.onThinking) h.onThinking(e.delta || '', e.contentIndex) }
    return false
  }
  if (rec.type === 'tool_execution_start') {
    if (h.onTool) h.onTool('start', rec.toolName, rec.args, rec.toolCallId)
    return false
  }
  if (rec.type === 'tool_execution_end') {
    if (h.onTool) h.onTool('end', rec.toolName, rec.result, rec.toolCallId)
    return false
  }
  if (rec.type === 'agent_start' || rec.type === 'turn_start') {
    if (h.onEvent) h.onEvent(rec)
    return false
  }
  if (rec.type === 'agent_settled') return true
  return false
}

// ---------- JSONL 流解析（跨 chunk UTF-8 安全） ----------
function makeLineBuffer() {
  return { value: '', decoder: new StringDecoder('utf8') }
}
function pushChunk(buf, chunk, onRecord) {
  buf.value += buf.decoder.write(chunk)
  let nl
  while ((nl = buf.value.indexOf('\n')) !== -1) {
    let line = buf.value.slice(0, nl)
    buf.value = buf.value.slice(nl + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch (_) { continue }
    onRecord(rec)
  }
}

// ---------- 非 JSONL 场景的解码流（stderr / dev 请求体等，跨 chunk UTF-8 安全） ----------
// 注意必须把原始 Buffer 交给 StringDecoder：先 toString 会把不完整字节序列损坏成替换符
function makeTextStream() {
  const dec = new StringDecoder('utf8')
  return { push: chunk => dec.write(chunk), end: () => dec.end() }
}

// ---------- 目录/路径 ----------
function validateCwd(p) {
  return !!(p && fs.existsSync(p) && fs.statSync(p).isDirectory())
}
// 默认工作区：~/MyPiDeck（首次使用时自动创建）
function defaultWorkspace() {
  const dir = path.join(os.homedir(), 'MyPiDeck')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
  return dir
}
// 纯计算生效目录（无 mkdir 副作用），供 UI 展示用
function resolveCwd(p) {
  return (p && validateCwd(p)) ? p : path.join(os.homedir(), 'MyPiDeck')
}
function effectiveCwd(p) {
  const dir = resolveCwd(p)
  // 只有兜底到默认工作区时才落盘创建；有效入参目录必然已存在
  if (!fs.existsSync(dir)) defaultWorkspace()
  return dir
}

// pi 配置目录：与 pi 的 getAgentDir() 保持一致，可用 PI_CODING_AGENT_DIR 覆盖
function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
}

// ---------- 技能扫描 ----------
function parseSkillMdText(file, text) {
  try {
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text)
    if (!fm) return null
    const get = key => {
      const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm[1])
      return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : ''
    }
    const name = get('name')
    let description = get('description')
    if (description === '>' || description === '|') {
      const fold = description
      const idx = fm[1].indexOf('description:')
      const rest = fm[1].slice(idx).split('\n').slice(1)
      const lines = []
      for (const ln of rest) {
        if (!/^\s+/.test(ln) || /^\s+\w+:/.test(ln)) break
        lines.push(ln.trim())
      }
      description = lines.join(fold === '>' ? ' ' : '\n')
    }
    if (!name || !description) return null
    return { name, description, dir: path.dirname(file) }
  } catch (_) { return null }
}

function parseSkillMd(file) {
  try {
    return parseSkillMdText(file, fs.readFileSync(file, 'utf8'))
  } catch (_) { return null }
}

async function parseSkillMdAsync(file) {
  try {
    return parseSkillMdText(file, await fsp.readFile(file, 'utf8'))
  } catch (_) { return null }
}

function scanSkillsDir(dir, out, seen, visited) {
  if (!dir) return
  if (!visited) visited = new Set()
  // 技能目录多为符号链接：按真实路径记 visited，防止链接成环导致无限递归
  let real = dir
  try { real = fs.realpathSync(dir) } catch (_) {}
  if (visited.has(real)) return
  visited.add(real)
  try { if (!fs.statSync(dir).isDirectory()) return } catch (_) { return }
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
  const direct = parseSkillMd(path.join(dir, 'SKILL.md'))
  if (direct && !seen.has(direct.name)) { out.push(direct); seen.add(direct.name) }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory() || e.isSymbolicLink()) scanSkillsDir(path.join(dir, e.name), out, seen, visited)
  }
}

async function scanSkillsDirAsync(dir, out, seen, visited) {
  if (!dir) return
  if (!visited) visited = new Set()
  let real = dir
  try { real = await fsp.realpath(dir) } catch (_) {}
  if (visited.has(real)) return
  visited.add(real)
  try { if (!(await fsp.stat(dir)).isDirectory()) return } catch (_) { return }
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch (_) { return }
  const direct = await parseSkillMdAsync(path.join(dir, 'SKILL.md'))
  if (direct && !seen.has(direct.name)) { out.push(direct); seen.add(direct.name) }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory() || e.isSymbolicLink()) await scanSkillsDirAsync(path.join(dir, e.name), out, seen, visited)
  }
}

function skillRoots(cwd) {
  const roots = [
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(agentDir(), 'skills'),
  ]
  if (cwd) {
    roots.push(path.join(cwd, '.agents', 'skills'))
    roots.push(path.join(cwd, '.pi', 'skills'))
  }
  return roots
}

function listSkills(cwd) {
  const out = [], seen = new Set()
  for (const r of skillRoots(cwd)) scanSkillsDir(r, out, seen)
  return out
}

async function listSkillsAsync(cwd) {
  const out = [], seen = new Set()
  const visited = new Set()
  for (const r of skillRoots(cwd)) await scanSkillsDirAsync(r, out, seen, visited)
  return out
}

// ---------- 模型列表（带 TTL 缓存） ----------
let _modelsCache = null
let _modelsAt = 0
const MODELS_TTL = 60 * 1000
function parseModelsOutput(stdout) {
  const models = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim() || /^provider\s+model/i.test(line)) continue
    const parts = line.trim().split(/\s{2,}|\s+/)
    if (parts.length >= 2) models.push({ provider: parts[0], model: parts[1], display: `${parts[0]}/${parts[1]}` })
  }
  return models
}
function listModels(force) {
  if (!force && _modelsCache && Date.now() - _modelsAt < MODELS_TTL) return _modelsCache
  const { node, cli } = resolvePi()
  const out = execFileSync(node, [cli, '--list-models'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const models = parseModelsOutput(out)
  _modelsCache = models
  _modelsAt = Date.now()
  return models
}

// ---------- 工作区文件列表 ----------
function listFiles(cwd, query) {
  const root = effectiveCwd(cwd)
  const out = []
  const q = (query || '').toLowerCase()
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.venv', '__pycache__'])
  const visited = new Set()
  function walk(dir, depth, prefix) {
    if (depth > 3 || out.length >= 200) return
    let real = dir
    try { real = fs.realpathSync(dir) } catch (_) {}
    if (visited.has(real)) return
    visited.add(real)
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      const full = path.join(dir, e.name)
      let isDir = e.isDirectory()
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = fs.statSync(full).isDirectory() } catch (_) { continue }
      }
      if (q && !rel.toLowerCase().includes(q)) {
        if (isDir) walk(full, depth + 1, rel)
        continue
      }
      if (isDir) { out.push({ path: rel, dir: true }); walk(full, depth + 1, rel) }
      else out.push({ path: rel, dir: false })
    }
  }
  walk(root, 0, '')
  return out
}

async function listFilesAsync(cwd, query) {
  const root = effectiveCwd(cwd)
  const out = []
  const q = (query || '').toLowerCase()
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.venv', '__pycache__'])
  const visited = new Set()
  async function walk(dir, depth, prefix) {
    if (depth > 3 || out.length >= 200) return
    let real = dir
    try { real = await fsp.realpath(dir) } catch (_) {}
    if (visited.has(real)) return
    visited.add(real)
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      if (out.length >= 200) return
      if (e.name.startsWith('.') || skip.has(e.name)) continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      const full = path.join(dir, e.name)
      let isDir = e.isDirectory()
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = (await fsp.stat(full)).isDirectory() } catch (_) { continue }
      }
      if (q && !rel.toLowerCase().includes(q)) {
        if (isDir) await walk(full, depth + 1, rel)
        continue
      }
      if (isDir) { out.push({ path: rel, dir: true }); await walk(full, depth + 1, rel) }
      else out.push({ path: rel, dir: false })
    }
  }
  await walk(root, 0, '')
  return out
}

// ---------- 工具权限（精细档） ----------
// tool = {
//   list: ['read','grep',...],        内置工具白名单（空 = 无工具）
//   mcp: 'off' | 'all' | 'servers',   MCP 开关；servers 时配合 mcpServers
//   mcpServers: 'radius, github',     只暴露这些 server 的 MCP 工具
//   ext: bool,                        是否加载扩展（false = -ne）
//   skills: 'off' | 'all' | 'some',   技能；some 时配合 skillPaths
//   skillPaths: [],                   some 时显式 --skill <dir>
//   context: bool,                    项目规范 AGENTS.md
//   templates: bool,                  提示词模板
//   trust: bool,                      项目级 .pi 配置（--approve / --no-approve）
// }
const READ_TOOL_NAMES = ['read', 'grep', 'find', 'ls']
const RISK_TOOL_NAMES = ['edit', 'write', 'bash', 'powershell']
const TOOL_NAMES = [...READ_TOOL_NAMES, ...RISK_TOOL_NAMES]
const PRESET_LISTS = {
  text: [],
  read: [...READ_TOOL_NAMES],
  edit: [...READ_TOOL_NAMES, 'edit', 'write'],
  full: [...TOOL_NAMES],
}

// 规范化工具权限结构（缺失时默认最安全的只读档）
function normalizeTool(tool) {
  const t = (tool && typeof tool === 'object') ? tool : {}
  const list = Array.isArray(t.list) ? t.list.filter(n => TOOL_NAMES.includes(n)) : PRESET_LISTS.read.slice()
  return {
    list,
    mcp: t.mcp === 'all' || t.mcp === 'servers' ? t.mcp : 'off',
    mcpServers: typeof t.mcpServers === 'string' ? t.mcpServers : '',
    ext: !!t.ext,
    skills: t.skills === 'all' || t.skills === 'some' ? t.skills : 'off',
    skillPaths: Array.isArray(t.skillPaths) ? t.skillPaths.filter(Boolean) : [],
    context: !!t.context,
    templates: !!t.templates,
    trust: !!t.trust,
  }
}

// 精细结构 → pi argv
function buildPermArgs(tool) {
  const t = normalizeTool(tool)
  const args = []
  const servers = String(t.mcpServers || '').split(',').map(x => x.trim()).filter(Boolean)
  // "指定 server" 但没填名字时不能当成"全部"放行，按关闭处理
  const mcpOff = t.mcp === 'off' || (t.mcp === 'servers' && !servers.length)
  const list = t.list.slice()
  if (!list.length) {
    if (t.mcp === 'servers' && servers.length) {
      args.push('--tools', servers.map(x => 'mcp__' + x + '__*').join(','))
    } else {
      args.push('-nt')
    }
  } else {
    let allow = list.join(',')
    if (t.mcp === 'servers' && servers.length) allow += ',' + servers.map(x => 'mcp__' + x + '__*').join(',')
    args.push('--tools', allow)
  }
  if (mcpOff) args.push('--no-mcp')
  if (!t.ext) {
    args.push('-ne')
    // -ne 会连内置 MCP 扩展一起关掉；MCP 仍需保留时单独挂回来
    if (!mcpOff) args.push('-e', 'builtin:mcp')
  }
  if (t.skills === 'off') args.push('-ns')
  else if (t.skills === 'some') {
    args.push('-ns')
    for (const sp of t.skillPaths) args.push('--skill', sp)
  }
  if (!t.context) args.push('-nc')
  if (!t.templates) args.push('-np')
  // --approve / --no-approve 仅控制项目级 .pi 配置信任；默认传 --no-approve（不自动信任）
  if (t.trust === true) args.push('--approve')
  else args.push('--no-approve')
  return args
}

// 判断是否纯文本无工具（禁工具且无 MCP/扩展时需替换 system prompt）
function permFlags(toolOrOpts) {
  const src = (toolOrOpts && toolOrOpts.tool !== undefined) ? toolOrOpts.tool : toolOrOpts
  const t = normalizeTool(src)
  const servers = String(t.mcpServers || '').split(',').map(x => x.trim()).filter(Boolean)
  const mcpOff = t.mcp === 'off' || (t.mcp === 'servers' && !servers.length)
  return { noTools: !t.list.length && mcpOff && !t.ext }
}

function applyLeanSystemPrompt(opts) {
  const o = opts || {}
  return (permFlags(o.tool).noTools && !o.systemPrompt) ? { ...o, systemPrompt: LEAN_SYSTEM_PROMPT } : o
}

// ---------- spawn 参数构造（统一 argv 规则） ----------
function buildArgs(opts) {
  // 防御：-- 之前的选项值不能以 - 开头（否则被 pi 解析为选项）
  const safe = v => (v && !String(v).startsWith('-')) ? v : ''
  const args = [findPiCli(), '--mode', 'json']
  if (opts.sessionId && safe(opts.sessionId)) args.push('--session-id', safe(opts.sessionId))
  else args.push('--no-session')
  if (opts.model && safe(opts.model)) args.push('--model', safe(opts.model))
  if (opts.thinking && safe(opts.thinking)) args.push('--thinking', safe(opts.thinking))
  // 工具 / 资源 / 上下文：全部由精细档位决定
  args.push(...buildPermArgs(opts.tool))
  // 禁工具时必须替换 system prompt：否则 pi 仍自称 coding assistant 可执行命令，
  // 模型会输出原始工具调用标记（如 <||DSML||>）而非正常回答
  if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt)
  args.push('--')
  for (const f of (opts.files || [])) args.push(`@${f}`)
  args.push(opts.prompt || '')
  return args
}

// 精简分组的 system prompt：禁工具后必须替换，否则模型会输出工具调用标记
// 注意：不要在此列举具体标记名（会反向诱导模型复述）
const LEAN_SYSTEM_PROMPT = [
  '你是一个简洁的 AI 助手，直接回答用户的问题。',
  '你没有工具，无法读取文件、执行命令、访问网络或修改代码。',
  '不要输出任何工具调用格式、函数调用块或模拟命令执行的内容。',
  '只用自然语言回答；信息不足时基于上下文推断，或直接说明不知道。',
].join('\n')

// 读取 pi 实际生效的默认模型与思考强度（用于 UI 显示"默认=什么"）
// 通过一次性 RPC get_state 获取，不污染会话
function getDefaults(cwd) {
  return new Promise(resolve => {
    let node, cli
    try { ({ node, cli } = resolvePi()) } catch (e) { return resolve({ error: String(e.message || e) }) }
    const child = spawn(node, [cli, '--mode', 'rpc', '--no-session'], {
      cwd: effectiveCwd(cwd), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const buf = makeLineBuffer()
    let done = false
    let timeout = null
    const finish = data => {
      if (done) return
      done = true
      if (timeout) clearTimeout(timeout)
      try { child.stdin.end() } catch (_) {}
      setTimeout(() => { try { child.kill() } catch (_) {} }, 500)
      resolve(data)
    }
    child.stdout.on('data', chunk => {
      pushChunk(buf, chunk, rec => {
        if (rec.type === 'response' && rec.command === 'get_state' && rec.success !== false) {
          const d = rec.data || {}
          finish({
            modelId: d.model && d.model.id || '',
            modelName: d.model && d.model.name || '',
            thinkingLevel: d.thinkingLevel || '',
          })
        }
      })
    })
    child.stderr.on('data', () => {})
    child.on('error', e => finish({ error: String(e.message || e) }))
    child.on('exit', () => { if (!done) finish({ error: 'pi 进程退出' }) })
    try { child.stdin.write(JSON.stringify({ id: 'def1', type: 'get_state' }) + '\n') } catch (_) {}
    timeout = setTimeout(() => { if (!done) finish({ error: '获取默认配置超时' }) }, 20000)
  })
}

// 删除 pi 侧会话文件：~/.pi/agent/sessions/<cwd编码>/<时间戳>_<sessionId>.jsonl
// 仅接受 pideck- 前缀的合法 id，避免误删其他会话；root 仅供测试注入
function findPiSession(sessionId, root) {
  const id = String(sessionId || '')
  if (!/^pideck-[a-z0-9]{4,40}$/i.test(id)) return ''
  root = root || path.join(agentDir(), 'sessions')
  if (!fs.existsSync(root)) return ''
  const suffix = `_${id}.jsonl`
  let dirs = []
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()) }
  catch (_) { return '' }
  for (const d of dirs) {
    const dir = path.join(root, d.name)
    let files = []
    try { files = fs.readdirSync(dir) } catch (_) { continue }
    for (const f of files) {
      if (!f.endsWith(suffix)) continue
      const target = path.join(dir, f)
      if (!target.startsWith(root + path.sep)) continue
      return target
    }
  }
  return ''
}
function hasPiSession(sessionId, root) { return !!findPiSession(sessionId, root) }

function deletePiSession(sessionId, root) {
  const id = String(sessionId || '')
  if (!/^pideck-[a-z0-9]{4,40}$/i.test(id)) return { ok: false, removed: 0, error: 'sessionId 格式不合法' }
  root = root || path.join(agentDir(), 'sessions')
  if (!fs.existsSync(root)) return { ok: true, removed: 0 }
  const suffix = `_${id}.jsonl`
  let removed = 0
  let dirs = []
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()) }
  catch (_) { return { ok: true, removed: 0 } }
  for (const d of dirs) {
    const dir = path.join(root, d.name)
    let files = []
    try { files = fs.readdirSync(dir) } catch (_) { continue }
    for (const f of files) {
      // 精确后缀匹配，且必须落在 sessions 子目录内
      if (!f.endsWith(suffix)) continue
      const target = path.join(dir, f)
      if (!target.startsWith(root + path.sep)) continue
      try { fs.unlinkSync(target); removed++ } catch (_) {}
    }
  }
  return { ok: true, removed }
}

// 环境诊断：Node/pi 可用性、配置目录与关键文件状态
// 安全：auth.json 只报存在性与大小，绝不读取内容
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return null }
}
async function readJsonSafeAsync(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch (_) { return null }
}
const ENV_CONFIG_FILES = [
  ['settings.json', '偏好与默认模型'],
  ['models.json', '模型与端点'],
  ['auth.json', 'API 凭证'],
  ['mcp.json', 'MCP 服务'],
  ['AGENTS.md', '全局指令'],
]
function getEnv(deps) {
  const probeNode = (deps && deps.findNode) || findNode
  const probePi = (deps && deps.findPiCli) || findPiCli
  const env = {
    ok: false, errorCode: '', error: '',
    nodePath: '', nodeVersion: '', piPath: '', piVersion: '',
    agentDir: agentDir(),
    configs: [], defaultModel: '', defaultProvider: '', defaultThinking: '',
  }
  let nodeErr = null
  let piErr = null
  try {
    env.nodePath = probeNode()
    if (!deps && _nodeCache === env.nodePath && _nodeVersionCache) {
      env.nodeVersion = _nodeVersionCache
    } else {
      try {
        const v = execFileSync(env.nodePath, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()
        env.nodeVersion = v
      } catch (_) {}
    }
  } catch (e) {
    nodeErr = e
  }
  try {
    env.piPath = probePi()
    try {
      // cli 位于 .../pi-coding-agent/dist/bundle/cli.js → 向上找 package.json
      let d = path.dirname(env.piPath)
      for (let i = 0; i < 5; i++) {
        const pkg = path.join(d, 'package.json')
        if (fs.existsSync(pkg)) {
          const p = readJsonSafe(pkg)
          if (p && p.version) { env.piVersion = p.version; break }
        }
        const parent = path.dirname(d)
        if (parent === d) break
        d = parent
      }
    } catch (_) {}
  } catch (e) {
    piErr = e
  }
  if (!nodeErr && !piErr) {
    env.ok = true
  } else {
    const firstErr = nodeErr || piErr
    env.errorCode = firstErr.code || ''
    env.error = String(firstErr.message || firstErr)
  }
  // 配置文件状态（不含密钥内容）
  for (const [name, label] of ENV_CONFIG_FILES) {
    const f = path.join(env.agentDir, name)
    let exists = false, size = 0
    try { const st = fs.statSync(f); exists = st.isFile(); size = st.size } catch (_) {}
    env.configs.push({ name, label, path: f, exists, size })
  }
  // 默认模型/思考（读 settings.json，非机密）
  const settings = readJsonSafe(path.join(env.agentDir, 'settings.json'))
  if (settings) {
    env.defaultModel = settings.defaultModel || ''
    env.defaultProvider = settings.defaultProvider || ''
    env.defaultThinking = settings.defaultThinkingLevel || ''
  }
  return env
}

async function getEnvAsync(deps) {
  const probeNode = (deps && deps.findNodeAsync) || findNodeAsync
  const probePi = (deps && deps.findPiCliAsync) || findPiCliAsync
  const dir = agentDir()
  const env = {
    ok: false, errorCode: '', error: '',
    nodePath: '', nodeVersion: '', piPath: '', piVersion: '',
    agentDir: dir,
    configs: [], defaultModel: '', defaultProvider: '', defaultThinking: '',
  }
  const [nodeRes, piRes, configs, settings] = await Promise.all([
    Promise.resolve().then(() => probeNode()).then(p => ({ ok: true, value: p })).catch(e => ({ ok: false, error: e })),
    Promise.resolve().then(() => probePi()).then(p => ({ ok: true, value: p })).catch(e => ({ ok: false, error: e })),
    Promise.all(ENV_CONFIG_FILES.map(async ([name, label]) => {
      const f = path.join(dir, name)
      let exists = false, size = 0
      try { const st = await fsp.stat(f); exists = st.isFile(); size = st.size } catch (_) {}
      return { name, label, path: f, exists, size }
    })),
    readJsonSafeAsync(path.join(dir, 'settings.json')),
  ])

  let nodeErr = null
  let piErr = null
  if (nodeRes.ok) {
    env.nodePath = nodeRes.value
    if (!deps && _nodeCache === env.nodePath && _nodeVersionCache) {
      env.nodeVersion = _nodeVersionCache
    } else {
      const v = await nodeMajorAsync(env.nodePath)
      if (v) env.nodeVersion = v.raw
    }
  } else {
    nodeErr = nodeRes.error
  }

  if (piRes.ok) {
    env.piPath = piRes.value
    try {
      let d = path.dirname(env.piPath)
      for (let i = 0; i < 5; i++) {
        const pkg = path.join(d, 'package.json')
        if (await existsAsync(pkg)) {
          const p = await readJsonSafeAsync(pkg)
          if (p && p.version) { env.piVersion = p.version; break }
        }
        const parent = path.dirname(d)
        if (parent === d) break
        d = parent
      }
    } catch (_) {}
  } else {
    piErr = piRes.error
  }

  if (!nodeErr && !piErr) {
    env.ok = true
  } else {
    const firstErr = nodeErr || piErr
    env.errorCode = (firstErr && firstErr.code) || ''
    env.error = String((firstErr && firstErr.message) || firstErr)
  }

  env.configs = configs
  if (settings) {
    env.defaultModel = settings.defaultModel || ''
    env.defaultProvider = settings.defaultProvider || ''
    env.defaultThinking = settings.defaultThinkingLevel || ''
  }
  return env
}

// 探测全局/项目级 AGENTS.md 是否存在及体积（用于 UI 展示"会带入什么"）
function detectContextFiles(cwd) {
  const names = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']
  const found = []
  const dirs = [agentDir()]
  let d = cwd ? effectiveCwd(cwd) : null
  const chain = []
  while (d) {
    chain.push(d)
    const parent = path.dirname(d)
    if (parent === d) break
    d = parent
  }
  for (const dir of [...dirs, ...chain]) {
    for (const n of names) {
      const f = path.join(dir, n)
      try {
        if (fs.existsSync(f) && fs.statSync(f).isFile()) {
          const size = fs.statSync(f).size
          found.push({ path: f, size, global: dir === agentDir() })
          break
        }
      } catch (_) {}
    }
  }
  return found
}

module.exports = {
  PI_INSTALL_CMD,
  READ_TOOL_NAMES, RISK_TOOL_NAMES, TOOL_NAMES, PRESET_LISTS,
  resolvePi, resolvePiAsync, findNodeAsync, findPiCliAsync, resetPiCache, setPathOverrides, seedResolvedPaths,
  makeLineBuffer, pushChunk, makeTextStream, validateCwd, effectiveCwd, resolveCwd, defaultWorkspace,
  parseSkillMd, scanSkillsDir, listSkills, listSkillsAsync, parseModelsOutput, listModels, listFiles, listFilesAsync, buildArgs, buildPermArgs, normalizeTool, permFlags, applyLeanSystemPrompt, detectContextFiles, LEAN_SYSTEM_PROMPT, getDefaults, findPiSession, hasPiSession, deletePiSession, getEnv, getEnvAsync, mapPiEvent, agentDir,
  os, path, fs,
}
