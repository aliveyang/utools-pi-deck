import { describe, it, expect } from 'vitest'

const { toolSummary, isRiskTool, createRunner } = await import('../shared/runner.cjs')

describe('runner 审计与工具判定', () => {
  it('isRiskTool 将只读之外的工具视为风险工具', () => {
    expect(isRiskTool('read')).toBe(false)
    expect(isRiskTool('grep')).toBe(false)
    expect(isRiskTool('find')).toBe(false)
    expect(isRiskTool('ls')).toBe(false)
    expect(isRiskTool('edit')).toBe(true)
    expect(isRiskTool('write')).toBe(true)
    expect(isRiskTool('bash')).toBe(true)
    expect(isRiskTool('mcp__fs__write')).toBe(true)
  })

  it('toolSummary 准确汇总内置工具、MCP、扩展与项目配置状态', () => {
    expect(toolSummary(null)).toBe('无工具')
    expect(toolSummary({
      list: ['read', 'bash'],
      mcp: 'servers',
      mcpServers: 'github',
      ext: true,
      skills: 'some',
      skillPaths: ['/a', '/b'],
      context: true,
      trust: true,
    })).toBe('read,bash · MCP github · 扩展开 · 技能 2 个 · 项目规范 · 项目配置')
  })

  it('wrapHandlers 记录工具与汇总审计且终态回调幂等', () => {
    const entries = []
    let doneCount = 0
    const runner = createRunner({
      auditRecord: e => { entries.push(e); return true },
    })
    const wrapped = runner.wrapHandlers(
      { groupId: 'agent', groupName: '智能体', cwd: '/ws', promptPreview: 'hi', tool: { list: ['read', 'bash'], mcp: 'off' } },
      { onDone: () => { doneCount++ } },
      { engine: 'json' },
    )
    wrapped.onTool('start', 'bash', { cmd: 'ls' }, 't1')
    wrapped.onTool('end', 'bash', 'ok', 't1')
    wrapped.onUsage({ totalTokens: 42 })
    wrapped.onDone({ aborted: false })
    wrapped.onDone({ aborted: false })

    expect(doneCount).toBe(1)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ type: 'tool', risk: true, engine: 'json' })
    expect(entries[1]).toMatchObject({ type: 'run', engine: 'json', usage: { totalTokens: 42 }, aborted: false })
  })
})
