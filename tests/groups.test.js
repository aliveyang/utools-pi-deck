import { describe, it, expect } from 'vitest'
import { TOOL_PRESETS, PRESET_LABEL, presetOf, normalizeGroup, DEFAULT_GROUPS, loadGroups, saveGroups } from '../src/groups.js'

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
    expect(presetOf(null)).toBe('read')
  })
})

describe('normalizeGroup 分组规范化', () => {
  it('补齐缺失基础字段且默认使用安全最小权限', () => {
    const g1 = normalizeGroup({ id: 'agent', name: '智能体' })
    expect(g1.kind).toBe('agent')
    expect(g1.tool.list).toEqual(TOOL_PRESETS.read.list)
    expect(g1.tool.mcp).toBe('off')
    expect(g1.tool.ext).toBe(false)

    const g2 = normalizeGroup({ id: 'chat', name: '对话' })
    expect(g2.kind).toBe('chat')
    expect(g2.tool.list).toEqual([])
  })

  it('过滤非法工具名与非法 mcp 值', () => {
    const g = normalizeGroup({ id: 'g1', tool: { list: ['read', 'rm-rf'], mcp: 'invalid', skills: 'bad' } })
    expect(g.tool.list).toEqual(['read'])
    expect(g.tool.mcp).toBe('off')
    expect(g.tool.skills).toBe('off')
  })
})

describe('DEFAULT_GROUPS 默认三分组', () => {
  it('chat/translate 纯文本且默认中英互译，agent 只读', () => {
    const byId = Object.fromEntries(DEFAULT_GROUPS.map(g => [g.id, g]))
    expect(byId.chat.tool.list).toEqual([])
    expect(byId.translate.tool.list).toEqual([])
    expect(byId.translate.targetLang).toBe('中英互译')
    expect(byId.translate.thinking).toBe('off')
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
