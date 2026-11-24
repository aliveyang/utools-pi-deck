import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createConfig } from '../shared/config.cjs'

let dir
let settingsPath
let modelsPath
let oldOpenaiKey

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pideck-config-'))
  settingsPath = path.join(dir, 'settings.json')
  modelsPath = path.join(dir, 'models.json')
  oldOpenaiKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
})
afterEach(() => {
  if (oldOpenaiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = oldOpenaiKey
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
})

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }

describe('config', () => {
  it('保存内置 provider 的 key 并设为默认，保留其他字段', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', lastChangelogVersion: '1.5.2' }))
    fs.writeFileSync(modelsPath, JSON.stringify({ providers: { magpie: { apiKey: 'local-key', models: [{ id: 'm1' }] } } }))
    const cfg = createConfig({ agentDir: dir, now: () => 1700000000000 })

    const r = cfg.save({ provider: 'deepseek', apiKey: 'fake-key-for-test', modelId: 'deepseek-chat', thinking: 'high', setDefault: true })
    expect(r.ok).toBe(true)

    const settings = readJson(settingsPath)
    expect(settings.defaultProvider).toBe('deepseek')
    expect(settings.defaultModel).toBe('deepseek-chat')
    expect(settings.defaultThinkingLevel).toBe('high')
    expect(settings.theme).toBe('dark')

    const models = readJson(modelsPath)
    expect(models.providers.magpie.apiKey).toBe('local-key')
    expect(models.providers.deepseek.apiKey).toBe('fake-key-for-test')
    expect(models.providers.deepseek.name).toBe('DeepSeek')

    // 返回值与状态都不能带出密钥原文
    expect(JSON.stringify(r)).not.toContain('fake-key-for-test')
    expect(JSON.stringify(cfg.getState())).not.toContain('fake-key-for-test')
  })

  it('apiKey 留空时保留已有 key', () => {
    fs.writeFileSync(modelsPath, JSON.stringify({ providers: { deepseek: { apiKey: 'old-key-value' } } }))
    const cfg = createConfig({ agentDir: dir })
    const r = cfg.save({ provider: 'deepseek', apiKey: '', modelId: 'deepseek-chat', setDefault: true })
    expect(r.ok).toBe(true)
    expect(readJson(modelsPath).providers.deepseek.apiKey).toBe('old-key-value')
  })

  it('内置 provider 没有 key 时给出警告但允许保存默认模型（兼容 auth.json/环境变量）', () => {
    const cfg = createConfig({ agentDir: dir })
    const r = cfg.save({ provider: 'openai', apiKey: '', modelId: 'gpt-x', setDefault: true })
    expect(r.ok).toBe(true)
    expect(r.warnings.join('')).toContain('API Key')
    expect(readJson(settingsPath).defaultProvider).toBe('openai')
  })

  it('支持 BOM 与 JSONC 注释，保存时保留其他 provider', () => {
    fs.writeFileSync(modelsPath, '\uFEFF{\n  // 用户手写注释\n  "providers": { "magpie": { "apiKey": "local-key" } }\n}')
    const cfg = createConfig({ agentDir: dir })
    const state = cfg.getState()
    expect(state.modelsParseError).toBe('')
    expect(state.providers.find(p => p.id === 'magpie').hasKey).toBe(true)
    const r = cfg.save({ provider: 'deepseek', apiKey: 'fake-key-for-test', modelId: 'deepseek-chat', setDefault: true })
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(modelsPath, 'utf8')).toContain('magpie')
  })

  it('配置解析失败时拒绝保存并原样保留文件', () => {
    const broken = '{ "providers": { '
    fs.writeFileSync(modelsPath, broken)
    const cfg = createConfig({ agentDir: dir })
    const r = cfg.save({ provider: 'deepseek', apiKey: 'fake-key-for-test', modelId: 'm', setDefault: true })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('解析失败')
    expect(fs.readFileSync(modelsPath, 'utf8')).toBe(broken)
    expect(fs.existsSync(settingsPath)).toBe(false)
  })

  it('自定义 provider 必须有 baseUrl 与合法 api', () => {
    const cfg = createConfig({ agentDir: dir })
    expect(cfg.save({ provider: 'my-proxy', modelId: 'm', api: 'openai-completions' }).ok).toBe(false)
    expect(cfg.save({ provider: 'my-proxy', baseUrl: 'https://x.test/v1', api: 'nope', modelId: 'm' }).ok).toBe(false)
  })

  it('自定义 provider 追加模型并写默认', () => {
    const cfg = createConfig({ agentDir: dir })
    const r = cfg.save({
      provider: 'my-proxy', baseUrl: 'https://x.test/v1', api: 'openai-completions',
      apiKey: 'fake-key-for-test', modelId: 'my-model', modelName: '自定义模型', setDefault: true,
    })
    expect(r.ok).toBe(true)
    const models = readJson(modelsPath)
    expect(models.providers['my-proxy'].baseUrl).toBe('https://x.test/v1')
    expect(models.providers['my-proxy'].api).toBe('openai-completions')
    expect(models.providers['my-proxy'].models).toEqual([{ id: 'my-model', name: '自定义模型' }])
    const settings = readJson(settingsPath)
    expect(settings.defaultProvider).toBe('my-proxy')
    expect(settings.defaultModel).toBe('my-model')
  })

  it('写前生成备份，且只保留最近 5 份', () => {
    fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }))
    fs.writeFileSync(settingsPath, JSON.stringify({}))
    let t = 1700000000000
    const cfg = createConfig({ agentDir: dir, now: () => t })
    for (let i = 0; i < 7; i++) {
      t += 1000
      cfg.save({ provider: 'deepseek', apiKey: 'k' + i + 'xxxxxx', modelId: 'deepseek-chat', setDefault: true })
    }
    const backups = fs.readdirSync(dir).filter(n => n.includes('.pideck-bak-'))
    expect(backups.length).toBeLessThanOrEqual(10) // settings + models 各最多 5 份
    expect(backups.length).toBeGreaterThan(5)
  })

  it('removeKey 只删 key，保留 provider 定义', () => {
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { 'my-proxy': { baseUrl: 'https://x.test/v1', api: 'openai-completions', apiKey: 'fake-key-for-test', models: [{ id: 'm' }] } },
    }))
    const cfg = createConfig({ agentDir: dir })
    const r = cfg.removeKey('my-proxy')
    expect(r.ok).toBe(true)
    const p = readJson(modelsPath).providers['my-proxy']
    expect(p.apiKey).toBeUndefined()
    expect(p.models).toEqual([{ id: 'm' }])
  })

  it('getState 用 keyKind 描述密钥来源而不回传值', () => {
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { deepseek: { apiKey: '$DEEPSEEK_API_KEY' }, openai: { apiKey: '!security find-generic-password' } },
    }))
    const cfg = createConfig({ agentDir: dir })
    const state = cfg.getState()
    const ds = state.providers.find(p => p.id === 'deepseek')
    const oa = state.providers.find(p => p.id === 'openai')
    expect(ds.keyKind).toBe('env')
    expect(ds.hasKey).toBe(true)
    expect(oa.keyKind).toBe('command')
    expect(JSON.stringify(state)).not.toContain('$DEEPSEEK_API_KEY')
  })

  it('非法 provider 名称与保留模板 custom 被拒绝', () => {
    const cfg = createConfig({ agentDir: dir })
    expect(cfg.save({ provider: '../evil', apiKey: 'x', modelId: 'm' }).ok).toBe(false)
    expect(cfg.save({ provider: 'custom', baseUrl: 'https://x.test/v1', api: 'openai-completions', modelId: 'm' }).ok).toBe(false)
    expect(cfg.removeKey('a b').ok).toBe(false)
  })

  it('包含国内预设与 Ollama；多自定义端点互不覆盖且 Ollama 可免填 apiKey', () => {
    const cfg = createConfig({ agentDir: dir })
    const st = cfg.getState()
    expect(st.providers.some(p => p.id === 'dashscope')).toBe(true)
    expect(st.providers.some(p => p.id === 'siliconflow')).toBe(true)
    expect(st.providers.some(p => p.id === 'zhipu')).toBe(true)
    expect(st.providers.some(p => p.id === 'moonshot')).toBe(true)
    const ollama = st.providers.find(p => p.id === 'ollama')
    expect(ollama.optionalKey).toBe(true)

    const rOllama = cfg.save({
      provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions',
      apiKey: '', modelId: 'qwen2.5:7b', setDefault: true,
    })
    expect(rOllama.ok).toBe(true)
    expect(readJson(modelsPath).providers.ollama.apiKey).toBe('ollama')

    const r1 = cfg.save({
      provider: 'relay-a', name: '中转A', baseUrl: 'https://a.test/v1', api: 'openai-completions',
      apiKey: 'ka-test', modelId: 'm1', setDefault: true,
    })
    const r2 = cfg.save({
      provider: 'relay-b', name: '中转B', baseUrl: 'https://b.test/v1', api: 'openai-completions',
      apiKey: 'kb-test', modelId: 'm2', setDefault: true,
    })
    expect(r1.ok && r2.ok).toBe(true)
    const savedProviders = readJson(modelsPath).providers
    expect(savedProviders['relay-a'].baseUrl).toBe('https://a.test/v1')
    expect(savedProviders['relay-b'].baseUrl).toBe('https://b.test/v1')
  })
})
