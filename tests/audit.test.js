import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAudit, redactString } from '../shared/audit.cjs'

let root

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pideck-audit-'))
})
afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch (_) {}
})

describe('audit', () => {
  it('写入后倒序读出，并附带人话摘要', () => {
    let t = Date.UTC(2026, 10, 23, 1, 0, 0)
    const a = createAudit({ root, now: () => t })
    a.record({ type: 'tool', groupName: '智能体', tool: { name: 'bash', args: { command: 'ls' } } })
    t += 1000
    a.record({ type: 'run', groupName: '智能体', usage: { totalTokens: 10 } })

    const rows = a.tail(10)
    expect(rows).toHaveLength(2)
    expect(rows[0].type).toBe('run')
    expect(rows[1].summary).toContain('执行命令')
  })

  it('脱敏 JSON 引号键、Bearer、JWT 与常见前缀', () => {
    const json = redactString('{"apiKey": "fake-json-key", "access_token": "fake-access-token"}')
    expect(json).not.toContain('fake-json-key')
    expect(json).not.toContain('fake-access-token')

    const bearer = redactString('Authorization: Bearer fake-bearer-token-123456')
    expect(bearer).not.toContain('fake-bearer-token-123456')

    const sk = redactString('x sk-fakefakefake123456')
    expect(sk).not.toContain('sk-fakefakefake123456')
    expect(sk).toContain('***')

    const jwt = redactString('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.fake-signature-123456')
    expect(jwt).not.toContain('fake-signature-123456')
    expect(redactString('正常文本 abc')).toBe('正常文本 abc')
  })

  it('截断超长字段', () => {
    const a = createAudit({ root, now: () => Date.UTC(2026, 10, 23) })
    a.record({ type: 'tool', tool: { name: 'bash', args: 'x'.repeat(5000) } })
    const rows = a.tail(1)
    expect(rows[0].tool.args.length).toBeLessThan(1000)
    expect(rows[0].tool.args).toContain('已截断')
  })

  it('超过单片上限时自动分片，仍能按顺序读回', () => {
    const a = createAudit({ root, maxFileBytes: 200, now: () => Date.UTC(2026, 10, 23) })
    for (let i = 0; i < 10; i++) a.record({ type: 'run', groupName: 'g' + i })
    expect(fs.readdirSync(root).length).toBeGreaterThan(1)
    const rows = a.tail(20)
    expect(rows).toHaveLength(10)
    expect(rows[0].groupName).toBe('g9')
  })

  it('按保留期清理过期文件', () => {
    let t = Date.UTC(2026, 9, 1)
    const a = createAudit({ root, now: () => t, retentionDays: 1 })
    a.record({ type: 'run' })
    t = Date.UTC(2026, 9, 3)
    a.record({ type: 'run' })
    expect(fs.readdirSync(root)).toHaveLength(1)
  })

  it('clear 返回删除结果并清空记录文件', () => {
    const a = createAudit({ root, now: () => Date.UTC(2026, 10, 23) })
    a.record({ type: 'run' })
    a.record({ type: 'tool', tool: { name: 'edit', args: 'a.txt' } })
    const r = a.clear()
    expect(r.removed).toBeGreaterThan(0)
    expect(fs.readdirSync(root)).toHaveLength(0)
    expect(a.tail(10)).toHaveLength(0)
  })

  it('导出 Markdown 含表头与摘要', () => {
    const a = createAudit({ root, now: () => Date.UTC(2026, 10, 23, 8, 30) })
    a.record({ type: 'tool', groupName: '智能体', tool: { name: 'write', args: 'a.txt' } })
    const md = a.exportMd(30)
    expect(md).toContain('# PiDeck 操作记录')
    expect(md).toContain('| 时间 | 分组 | 类型 | 内容 |')
    expect(md).toContain('修改文件')
  })
})
