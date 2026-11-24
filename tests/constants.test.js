import { describe, it, expect } from 'vitest'
import {
  isRiskyTool, hasExecRisk, riskKeysOf, activeRiskSummary,
  editRiskReasons, hasAdvancedOptions, toolSummary, fmtSize,
} from '../src/constants.js'

describe('constants 共享纯函数', () => {
  it('正确识别风险工具与执行权限', () => {
    expect(isRiskyTool({ list: ['read', 'grep'] })).toBe(false)
    expect(isRiskyTool({ list: ['read', 'edit'] })).toBe(true)
    expect(isRiskyTool({ list: [], trust: true })).toBe(true)
    expect(hasExecRisk({ list: ['edit'] })).toBe(false)
    expect(hasExecRisk({ list: ['bash'] })).toBe(true)
    expect([...riskKeysOf({ list: ['read', 'write', 'bash'], trust: true })]).toEqual(['write', 'bash', 'trust'])
  })

  it('activeRiskSummary 与 editRiskReasons 准确生成提示文案', () => {
    expect(activeRiskSummary({ list: ['edit', 'powershell'], trust: true }))
      .toBe('修改文件（edit/write）、执行命令（bash/powershell）、信任项目级 .pi 配置（--approve）')
    expect(editRiskReasons({ list: [] })).toEqual(['不暴露任何工具'])
    expect(editRiskReasons({ list: [], mcp: 'all' })).toEqual(['MCP 全部（不受白名单约束）'])
  })

  it('hasAdvancedOptions 与 toolSummary 准确判断', () => {
    expect(hasAdvancedOptions({ list: ['read'], mcp: 'off', skills: 'all', ext: false, context: false, templates: false, trust: false })).toBe(false)
    expect(hasAdvancedOptions({ list: ['read'], mcp: 'all' })).toBe(true)
    expect(toolSummary({ list: ['read'], mcp: 'off', skills: 'off' })).toBe('read · MCP 关 · 技能关')
    expect(fmtSize(512)).toBe('512B')
    expect(fmtSize(2048)).toBe('2.0KB')
  })
})
