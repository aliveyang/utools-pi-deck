// pi 配置读写：settings.json（默认模型/思考）+ models.json（provider 与 apiKey）
// 安全约束：只回传 hasKey / keyKind，绝不把 apiKey 原文交给渲染层；写前备份、原子写
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const defaultCore = require('./pi-core.cjs')
const localStore = require('./local-store.cjs')

const SETTINGS_FILE = 'settings.json'
const MODELS_FILE = 'models.json'
const API_VALUES = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const FORBIDDEN_PROVIDER_IDS = new Set(['__proto__', 'constructor', 'prototype'])
function isValidProviderId(id) {
  return PROVIDER_ID_RE.test(id) && !FORBIDDEN_PROVIDER_IDS.has(id)
}
const BACKUP_KEEP = 5

// 内置与常用 OpenAI 兼容服务商预设（builtin: true 表示模型目录由 pi 自带）
const PROVIDER_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', builtin: true, env: 'DEEPSEEK_API_KEY', site: 'https://platform.deepseek.com/api_keys', note: '国内直连，价格低' },
  { id: 'dashscope', name: '阿里云百炼', builtin: false, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', env: 'DASHSCOPE_API_KEY', site: 'https://bailian.console.aliyun.com/', models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwq-plus'], note: '阿里云通义千问 OpenAI 兼容接口' },
  { id: 'siliconflow', name: '硅基流动', builtin: false, baseUrl: 'https://api.siliconflow.cn/v1', api: 'openai-completions', env: '', site: 'https://cloud.siliconflow.cn/account/ak', models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'], note: '国内高速聚合 DeepSeek / Qwen 等开源模型' },
  { id: 'zhipu', name: '智谱 GLM', builtin: false, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', env: '', site: 'https://open.bigmodel.cn/usercenter/apikeys', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'], note: '智谱清言开放平台' },
  { id: 'moonshot', name: '月之暗面 Kimi', builtin: false, baseUrl: 'https://api.moonshot.cn/v1', api: 'openai-completions', env: '', site: 'https://platform.moonshot.cn/console/api-keys', models: ['kimi-k2-0711-preview', 'moonshot-v1-8k', 'moonshot-v1-32k'], note: 'Kimi 开放平台' },
  { id: 'openai', name: 'OpenAI', builtin: true, env: 'OPENAI_API_KEY', site: 'https://platform.openai.com/api-keys', note: '' },
  { id: 'anthropic', name: 'Anthropic Claude', builtin: true, env: 'ANTHROPIC_API_KEY', site: 'https://console.anthropic.com/settings/keys', note: '订阅用户建议用终端登录', oauth: true },
  { id: 'google', name: 'Google Gemini', builtin: true, env: 'GEMINI_API_KEY', site: 'https://aistudio.google.com/apikey', note: '' },
  { id: 'openrouter', name: 'OpenRouter', builtin: true, env: 'OPENROUTER_API_KEY', site: 'https://openrouter.ai/keys', note: '一个 Key 可用多家模型' },
  { id: 'ollama', name: '本地 Ollama', builtin: false, optionalKey: true, baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions', env: '', site: 'https://ollama.com', models: ['qwen2.5:7b', 'deepseek-r1:8b', 'llama3.2'], note: '本机免费离线运行，无需真实 API Key' },
  { id: 'custom', name: '+ 自定义端点', builtin: false, isCustomTemplate: true, env: '', site: '', note: '中转站 / LM Studio / 企业网关，可自定义标识保存多个' },
]

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
  if (!localStore.writeJsonAtomic(file, data, { pretty: true, mode: 0o600 })) {
    throw new Error(`写入 ${path.basename(file)} 失败`)
  }
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

function quoteForShell(val, platform = process.platform) {
  const s = String(val || '')
  if (!s || /[\r\n\0]/.test(s)) return ''
  if (platform === 'win32') {
    if (s.includes('"')) return ''
    return `"${s}"`
  }
  return `'${s.replace(/'/g, "'\\''")}'`
}

function createConfig(options) {
  const opts = options || {}
  const agentDir = opts.agentDir || defaultCore.agentDir()
  const now = opts.now || Date.now
  const resolvePi = opts.resolvePi || defaultCore.resolvePi
  const resolvePiAsync = opts.resolvePiAsync
    || (opts.resolvePi ? () => Promise.resolve(opts.resolvePi()) : defaultCore.resolvePiAsync)
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
      if (preset.isCustomTemplate) continue
      seen.add(preset.id)
      const cur = saved[preset.id] || {}
      providers.push({
        id: preset.id,
        name: cur.name || preset.name,
        builtin: !!preset.builtin,
        preset: true,
        optionalKey: !!preset.optionalKey,
        hasKey: keyKind(cur.apiKey) !== 'none',
        keyKind: keyKind(cur.apiKey),
        baseUrl: cur.baseUrl || preset.baseUrl || '',
        api: cur.api || preset.api || 'openai-completions',
        models: Array.isArray(cur.models) ? cur.models.map(m => m && m.id).filter(Boolean) : [],
        suggestedModels: Array.isArray(preset.models) ? preset.models.slice() : [],
        site: preset.site || '',
        env: preset.env || '',
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
        optionalKey: false,
        hasKey: keyKind(cur.apiKey) !== 'none',
        keyKind: keyKind(cur.apiKey),
        baseUrl: cur.baseUrl || '',
        api: cur.api || 'openai-completions',
        models: Array.isArray(cur.models) ? cur.models.map(m => m && m.id).filter(Boolean) : [],
        suggestedModels: [],
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
    if (!isValidProviderId(provider) || provider === 'custom') {
      return { ok: false, error: 'provider 标识不合法（请使用字母、数字、横线或下划线）' }
    }
    const preset = PROVIDER_PRESETS.find(p => p.id === provider && !p.isCustomTemplate)
    const isBuiltin = !!(preset && preset.builtin)
    const apiKey = typeof req.apiKey === 'string' ? req.apiKey.trim() : ''
    if (apiKey.startsWith('!')) {
      return { ok: false, error: '安全限制：不支持在界面中保存以 ! 开头的命令型凭证，请直接填写 API Key 或环境变量名' }
    }
    const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl.trim() : ''
    const api = typeof req.api === 'string' ? req.api.trim() : ''
    const modelId = typeof req.modelId === 'string' ? req.modelId.trim() : ''
    const modelName = typeof req.modelName === 'string' ? req.modelName.trim() : ''
    const displayName = typeof req.name === 'string' ? req.name.trim() : ''
    const thinking = typeof req.thinking === 'string' ? req.thinking.trim() : ''

    if (!isBuiltin) {
      if (!localStore.isAllowedExternalUrl(baseUrl)) return { ok: false, error: '自定义端点需要合法的 http(s) Base URL' }
      if (!API_VALUES.includes(api)) return { ok: false, error: 'API 类型不在支持范围内' }
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
      cur.name = displayName || (preset && preset.name) || modelName || cur.name || provider
      cur.baseUrl = baseUrl
      cur.api = api
      if (apiKey) cur.apiKey = apiKey
      else if (preset && preset.optionalKey && keyKind(cur.apiKey) === 'none') cur.apiKey = provider
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

    const settingsBak = defaultSet ? backupFile(settingsPath, now) : ''
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
    if (!isValidProviderId(id)) return { ok: false, error: 'provider 名称不合法' }
    const modelsR = readJsonResult(modelsPath)
    if (modelsR.error) return { ok: false, error: 'models.json 解析失败，已保留原文件：' + modelsR.error }
    const models = (modelsR.data && typeof modelsR.data === 'object') ? modelsR.data : {}
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

  // 凭证就绪检测：不刷新 OAuth、不输出凭证（全异步解析，避免阻塞渲染进程）
  async function authCheck(provider) {
    const id = String(provider || '').trim()
    if (!isValidProviderId(id)) return { status: 'invalid', error: 'provider 名称不合法' }
    let node, cli
    try { ({ node, cli } = await resolvePiAsync()) } catch (e) {
      return { status: 'unavailable', error: String(e.message || e) }
    }
    return new Promise(resolve => {
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

  // 供终端登录使用：返回用绝对路径拼好的安全命令，避免 GUI 环境 PATH 缺失与元字符注入
  function loginCommand(provider) {
    const id = String(provider || '').trim()
    if (!isValidProviderId(id)) return ''
    let node, cli
    try { ({ node, cli } = resolvePi()) } catch (_) { return `pi auth login ${id}` }
    const qNode = quoteForShell(node)
    const qCli = quoteForShell(cli)
    if (!qNode || !qCli) return `pi auth login ${id}`
    return `${qNode} ${qCli} auth login ${id}`
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
  quoteForShell,
  isValidProviderId,
  keyKind,
  writeJsonAtomic,
}
