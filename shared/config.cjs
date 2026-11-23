// pi 配置读写：settings.json（默认模型/思考）+ models.json（provider 与 apiKey）
// 安全约束：只回传 hasKey / keyKind，绝不把 apiKey 原文交给渲染层；写前备份、原子写
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const defaultCore = require('./pi-core.cjs')

const SETTINGS_FILE = 'settings.json'
const MODELS_FILE = 'models.json'
const API_VALUES = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const BACKUP_KEEP = 5

// 内置 provider：只写 apiKey，模型目录由 pi 自带
const PROVIDER_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', builtin: true, env: 'DEEPSEEK_API_KEY', site: 'https://platform.deepseek.com/api_keys', note: '国内直连，价格低' },
  { id: 'openai', name: 'OpenAI', builtin: true, env: 'OPENAI_API_KEY', site: 'https://platform.openai.com/api-keys', note: '' },
  { id: 'anthropic', name: 'Anthropic Claude', builtin: true, env: 'ANTHROPIC_API_KEY', site: 'https://console.anthropic.com/settings/keys', note: '订阅用户建议用终端登录', oauth: true },
  { id: 'google', name: 'Google Gemini', builtin: true, env: 'GEMINI_API_KEY', site: 'https://aistudio.google.com/apikey', note: '' },
  { id: 'openrouter', name: 'OpenRouter', builtin: true, env: 'OPENROUTER_API_KEY', site: 'https://openrouter.ai/keys', note: '一个 Key 可用多家模型' },
  { id: 'custom', name: '自定义端点', builtin: false, env: '', site: '', note: '中转站 / Ollama / LM Studio' },
]

function agentDirDefault() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
}

function readJson(file, fallback) {
  const r = readJsonResult(file)
  return r.data == null ? fallback : r.data
}

// 与 pi 对齐：支持 BOM 与 JSONC 注释（pi 用 strip-json-comments 解析）
function stripJsonComments(text) {
  const s = String(text).replace(/^\uFEFF/, '')
  let out = ''
  let inStr = false, esc = false, line = false, block = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1]
    if (line) { if (c === '\n') { line = false; out += c } continue }
    if (block) { if (c === '*' && n === '/') { block = false; i++ } continue }
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && n === '/') { line = true; i++; continue }
    if (c === '/' && n === '*') { block = true; i++; continue }
    out += c
  }
  return out
}

// 解析结果区分“文件不存在”和“内容损坏”：后者绝不能被当成空配置覆盖写回
function readJsonResult(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false, data: null, error: '' }
    return { exists: true, data: null, error: String((e && e.message) || e) }
  }
  try {
    return { exists: true, data: JSON.parse(stripJsonComments(text)), error: '' }
  } catch (e) {
    return { exists: true, data: null, error: 'JSON 解析失败：' + String((e && e.message) || e) }
  }
}

function keyKind(value) {
  if (typeof value !== 'string' || !value) return 'none'
  if (value.startsWith('!')) return 'command'
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return 'env'
  return 'literal'
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.pideck-tmp-${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const text = JSON.stringify(data, null, 2) + '\n'
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 })
    try {
      fs.renameSync(tmp, file)
    } catch (_) {
      fs.writeFileSync(file, text, { mode: 0o600 })
    }
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (_) {}
  }
  // 配置文件可能含密钥，尽量收紧权限（Windows 上 chmod 影响有限但不报错）
  try { fs.chmodSync(file, 0o600) } catch (_) {}
}

function pruneBackups(file) {
  try {
    const dir = path.dirname(file)
    const prefix = path.basename(file) + '.pideck-bak-'
    const list = fs.readdirSync(dir).filter(n => n.startsWith(prefix)).sort().reverse()
    for (const n of list.slice(BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(dir, n)) } catch (_) {}
    }
  } catch (_) {}
}

function backupFile(file, now) {
  try {
    if (!fs.existsSync(file)) return ''
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    const dest = `${file}.pideck-bak-${stamp}`
    fs.copyFileSync(file, dest)
    try { fs.chmodSync(dest, 0o600) } catch (_) {}
    pruneBackups(file)
    return dest
  } catch (_) { return '' }
}

function createConfig(options) {
  const opts = options || {}
  const agentDir = opts.agentDir || agentDirDefault()
  const now = opts.now || Date.now
  const resolvePi = opts.resolvePi || defaultCore.resolvePi
  const settingsPath = path.join(agentDir, SETTINGS_FILE)
  const modelsPath = path.join(agentDir, MODELS_FILE)

  function getState() {
    const settingsR = readJsonResult(settingsPath)
    const modelsR = readJsonResult(modelsPath)
    const settings = (settingsR.data && typeof settingsR.data === 'object') ? settingsR.data : {}
    const models = (modelsR.data && typeof modelsR.data === 'object') ? modelsR.data : {}
    const saved = (models.providers && typeof models.providers === 'object') ? models.providers : {}
    const providers = []
    const seen = new Set()
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === 'custom') continue
      seen.add(preset.id)
      const cur = saved[preset.id] || {}
      providers.push({
        id: preset.id,
        name: cur.name || preset.name,
        builtin: true,
        preset: true,
        hasKey: keyKind(cur.apiKey) !== 'none',
        keyKind: keyKind(cur.apiKey),
        baseUrl: cur.baseUrl || '',
        api: cur.api || '',
        models: Array.isArray(cur.models) ? cur.models.map(m => m && m.id).filter(Boolean) : [],
        site: preset.site,
        env: preset.env,
        envSet: !!(preset.env && process.env[preset.env]),
        note: preset.note || '',
        oauth: !!preset.oauth,
      })
    }
    for (const [id, cur] of Object.entries(saved)) {
      if (seen.has(id) || !cur || typeof cur !== 'object') continue
      providers.push({
        id,
        name: cur.name || id,
        builtin: false,
        preset: false,
        hasKey: keyKind(cur.apiKey) !== 'none',
        keyKind: keyKind(cur.apiKey),
        baseUrl: cur.baseUrl || '',
        api: cur.api || '',
        models: Array.isArray(cur.models) ? cur.models.map(m => m && m.id).filter(Boolean) : [],
        site: '',
        env: '',
        envSet: false,
        note: '',
        oauth: false,
      })
    }
    return {
      agentDir,
      settingsPath,
      modelsPath,
      defaultProvider: settings.defaultProvider || '',
      defaultModel: settings.defaultModel || '',
      defaultThinkingLevel: settings.defaultThinkingLevel || '',
      configured: !!(settings.defaultProvider && settings.defaultModel),
      parseError: modelsR.error || settingsR.error,
      modelsParseError: modelsR.error,
      settingsParseError: settingsR.error,
      providers,
      presets: PROVIDER_PRESETS.map(p => ({ ...p })),
      apiValues: API_VALUES.slice(),
    }
  }

  function save(input) {
    const req = input || {}
    const provider = String(req.provider || '').trim()
    if (!PROVIDER_ID_RE.test(provider)) return { ok: false, error: 'provider 名称不合法' }
    const preset = PROVIDER_PRESETS.find(p => p.id === provider)
    const isBuiltin = !!(preset && preset.builtin)
    const apiKey = typeof req.apiKey === 'string' ? req.apiKey.trim() : ''
    const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl.trim() : ''
    const api = typeof req.api === 'string' ? req.api.trim() : ''
    const modelId = typeof req.modelId === 'string' ? req.modelId.trim() : ''
    const modelName = typeof req.modelName === 'string' ? req.modelName.trim() : ''
    const displayName = typeof req.name === 'string' ? req.name.trim() : ''
    const thinking = typeof req.thinking === 'string' ? req.thinking.trim() : ''

    if (!isBuiltin) {
      if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: '自定义端点需要 http(s) 开头的 Base URL' }
      if (!API_VALUES.includes(api)) return { ok: false, error: 'API 类型不在支持范围内' }
      if (!provider) return { ok: false, error: '缺少 provider 名称' }
    }

    const modelsR = readJsonResult(modelsPath)
    if (modelsR.error) return { ok: false, error: 'models.json 解析失败，已保留原文件：' + modelsR.error }
    const models = (modelsR.data && typeof modelsR.data === 'object') ? modelsR.data : {}
    if (!models.providers || typeof models.providers !== 'object') models.providers = {}
    const cur = (models.providers[provider] && typeof models.providers[provider] === 'object')
      ? { ...models.providers[provider] } : {}

    if (isBuiltin) {
      if (apiKey) cur.apiKey = apiKey
      if (!cur.name) cur.name = preset.name
    } else {
      cur.name = displayName || modelName || cur.name || provider
      cur.baseUrl = baseUrl
      cur.api = api
      if (apiKey) cur.apiKey = apiKey
      const list = Array.isArray(cur.models) ? cur.models.slice() : []
      if (modelId && !list.some(m => m && m.id === modelId)) {
        list.push({ id: modelId, name: modelName || modelId })
      }
      cur.models = list
    }
    models.providers[provider] = cur

    // 不强制要求 apiKey：pi 也可能通过 auth.json（登录）或环境变量提供凭证
    const warnings = []
    if (isBuiltin && !apiKey && keyKind(cur.apiKey) === 'none' && !(preset.env && process.env[preset.env])) {
      warnings.push('未填写 API Key；如果已在 pi 中登录或配置了环境变量，可以忽略')
    }

    const settingsR = readJsonResult(settingsPath)
    if (settingsR.error) return { ok: false, error: 'settings.json 解析失败，已保留原文件：' + settingsR.error }
    const settings = (settingsR.data && typeof settingsR.data === 'object') ? settingsR.data : {}
    const nextSettings = { ...settings }
    let defaultSet = false
    if (req.setDefault) {
      if (!modelId) return { ok: false, error: '请选择或填写默认模型 ID' }
      nextSettings.defaultProvider = provider
      nextSettings.defaultModel = modelId
      if (thinking) nextSettings.defaultThinkingLevel = thinking
      defaultSet = true
    }

    const settingsBak = backupFile(settingsPath, now)
    const modelsBak = backupFile(modelsPath, now)
    try {
      writeJsonAtomic(modelsPath, models)
      if (defaultSet) writeJsonAtomic(settingsPath, nextSettings)
    } catch (e) {
      // settings 写失败时回滚 models，避免半提交
      try { if (modelsBak) fs.copyFileSync(modelsBak, modelsPath) } catch (_) {}
      return { ok: false, error: '写入配置失败：' + String(e.message || e) }
    }
    return {
      ok: true,
      provider,
      modelId: modelId || '',
      defaultSet,
      warnings,
      backups: [settingsBak, modelsBak].filter(Boolean),
      // 回读一次，确认写入结果；不回传密钥
      state: { ok: true, ...getState() },
    }
  }

  // 清除 models.json 里的 apiKey（保留 provider 与模型定义）
  function removeKey(provider) {
    const id = String(provider || '').trim()
    if (!PROVIDER_ID_RE.test(id)) return { ok: false, error: 'provider 名称不合法' }
    const models = readJson(modelsPath, {}) || {}
    const p = models.providers && models.providers[id]
    if (!p || typeof p !== 'object') return { ok: true, removed: false }
    if (!('apiKey' in p)) return { ok: true, removed: false }
    backupFile(modelsPath, now)
    delete p.apiKey
    try { writeJsonAtomic(modelsPath, models) } catch (e) {
      return { ok: false, error: '写入失败：' + String(e.message || e) }
    }
    return { ok: true, removed: true }
  }

  // 凭证就绪检测：不刷新 OAuth、不输出凭证
  function authCheck(provider) {
    const id = String(provider || '').trim()
    if (!PROVIDER_ID_RE.test(id)) return Promise.resolve({ status: 'invalid', error: 'provider 名称不合法' })
    return new Promise(resolve => {
      let node, cli
      try { ({ node, cli } = resolvePi()) } catch (e) {
        return resolve({ status: 'unavailable', error: String(e.message || e) })
      }
      execFile(node, [cli, 'auth', 'check', '--provider', id, '--no-refresh', '--json'], {
        windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024,
      }, (err, stdout) => {
        const text = String(stdout || '').trim()
        if (text) {
          try {
            const data = JSON.parse(text)
            const status = data && (data.status || data.state)
            if (status) return resolve({ status, provider: id, reason: data.reason || '' })
          } catch (_) {}
        }
        resolve({ status: err ? 'invalid' : 'unknown', provider: id, error: err ? '检测失败' : '' })
      })
    })
  }

  // 供终端登录使用：返回用绝对路径拼好的命令，避免 GUI 环境 PATH 缺失
  function loginCommand(provider) {
    const id = String(provider || '').trim()
    if (!PROVIDER_ID_RE.test(id)) return ''
    let node, cli
    try { ({ node, cli } = resolvePi()) } catch (_) { return `pi auth login ${id}` }
    return `"${node}" "${cli}" auth login ${id}`
  }

  return {
    agentDir, settingsPath, modelsPath,
    getState, save, removeKey, authCheck, loginCommand,
    // 测试注入
    _setNow: fn => { if (fn) now = fn },
  }
}

const defaultConfig = createConfig()

module.exports = {
  ...defaultConfig,
  createConfig,
  PROVIDER_PRESETS,
  API_VALUES,
  keyKind,
  writeJsonAtomic,
  backupFile,
}
