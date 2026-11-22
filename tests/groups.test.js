import { describe, it, expect } from 'vitest'
import { TOOL_PRESETS, PRESET_LABEL, presetOf, migrateGroups, DEFAULT_GROUPS, loadGroups, saveGroups } from '../src/groups.js'

describe('presetOf 反推预设名', () => {
  it('四个预设各归其位', () => {
    expect(presetOf(TOOL_PRESETS.text)).toBe('text')
    expect(presetOf(TOOL_PRESETS.read)).toBe('read')
    expect(presetOf(TOOL_PRESETS.edit)).toBe('edit')
    expect(presetOf(TOOL_PRESETS.full)).toBe('full')
  })

  it('任一字段偏离即自定义', () => {
    expect(presetOf({ ...TOOL_PRESETS.read, list: ['read'] })).toBe('custom')
    expect(presetOf({ ...TOOL_PRESETS.read, mcp: 'all' })).toBe('custom')
    expect(presetOf({ ...TOOL_PRESETS.read, trust: true })).toBe('custom')
    expect(presetOf(null)).toBe('read')   // 缺省视为 read
  })
})

describe('migrateGroups 旧数据迁移', () => {
  it('补 kind/lean/tool；无 perm 老数据智能体降级为只读', () => {
    const out = migrateGroups([{ id: 'agent', name: '智能体', prompt: '', thinking: '' }])
    expect(out[0].kind).toBe('agent')
    expect(out[0].tool.list).toEqual(TOOL_PRESETS.read.list)
    expect(out[0].tool.mcp).toBe('off')
    expect(out[0].tool.ext).toBe(false)
  })

  it('perm=text 老数据映射为纯文本档', () => {
    const out = migrateGroups([{ id: 'chat', perm: 'text', lean: {} }])
    expect(out[0].kind).toBe('chat')
    expect(out[0].tool.list).toEqual([])
    expect(out[0].lean.noTools).toBe(true)
  })

  it('老数据缺智能体分组 → 自动追加', () => {
    const out = migrateGroups([{ id: 'chat', kind: 'chat', lean: {} }])
    expect(out.some(g => g.kind === 'agent')).toBe(true)
  })

  it('尊重用户已配置的 lean，不覆盖', () => {
    const out = migrateGroups([{ id: 'chat', kind: 'chat', lean: { noSkills: true, noMcp: true, noContextFiles: true, noTools: false } }])
    expect(out[0].lean.noTools).toBe(false)
  })

  it('翻译组 thinking 空时补 off', () => {
    const out = migrateGroups([{ id: 'translate', kind: 'translate', lean: {}, thinking: '' }])
    expect(out[0].thinking).toBe('off')
  })
})

describe('DEFAULT_GROUPS 默认三分组', () => {
  it('chat/translate 纯文本，agent 只读', () => {
    const byId = Object.fromEntries(DEFAULT_GROUPS.map(g => [g.id, g]))
    expect(byId.chat.tool.list).toEqual([])
    expect(byId.translate.tool.list).toEqual([])
    expect(byId.translate.targetLang).toBe('英文')
    expect(byId.agent.tool.list).toEqual(TOOL_PRESETS.read.list)
  })
})

describe('loadGroups/saveGroups 持久化往返', () => {
  it('首次加载写默认；保存后重载一致', () => {
    const first = loadGroups()
    expect(first.length).toBeGreaterThanOrEqual(3)
    const renamed = first.map(g => (g.id === 'chat' ? { ...g, name: '改名' } : g))
    saveGroups(renamed)
    expect(loadGroups().find(g => g.id === 'chat').name).toBe('改名')
  })
})

describe('PRESET_LABEL', () => {
  it('含自定义标签', () => {
    expect(PRESET_LABEL.custom).toBe('自定义')
  })
})
