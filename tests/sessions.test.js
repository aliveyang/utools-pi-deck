import { describe, it, expect, beforeEach } from 'vitest'
import { write, remove } from '../src/storage.js'
import {
  listSessions, getSession, createSession, updateSession, deleteSession,
  titleFromText, exportMarkdown, fitSessionBudget,
} from '../src/sessions.js'

const IDX_KEY = 'pideck.sessions.idx'
const ITEM_PREFIX = 'pideck.session.'

beforeEach(() => {
  remove(IDX_KEY)
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith(ITEM_PREFIX)) remove(k)
  }
})

describe('会话 CRUD 与索引', () => {
  it('创建 → 读取 → 更新 → 列表 → 删除', () => {
    const s = createSession('chat', { model: 'm1' })
    expect(s.piSessionId).toMatch(/^pideck-/)
    expect(getSession(s.id).config.model).toBe('m1')

    updateSession(s.id, { title: '新标题' })
    const fresh = getSession(s.id)
    expect(fresh.title).toBe('新标题')
    expect(fresh.updatedAt).toBeGreaterThanOrEqual(s.createdAt)

    const listed = listSessions('chat')
    expect(listed.find(e => e.id === s.id)).toBeTruthy()
    expect(listed[0].messages).toBeUndefined()

    deleteSession(s.id)
    expect(getSession(s.id)).toBeNull()
    expect(listSessions('chat').find(e => e.id === s.id)).toBeUndefined()
  })

  it('listSessions 按分组过滤并按 updatedAt 倒序', () => {
    const a = createSession('g1', {})
    const b = createSession('g2', {})
    createSession('g1', {})
    updateSession(a.id, { title: 'a' })
    expect(listSessions('g1').map(s => s.id)).toEqual([a.id, expect.any(String)])
    expect(listSessions('g2').map(s => s.id)).toEqual([b.id])
  })
})

describe('索引重建', () => {
  it('索引被清空后：从单会话 key 重建，不丢会话', () => {
    const a = createSession('chat', {})
    const b = createSession('agent', {})
    remove(IDX_KEY)
    const list = listSessions()
    expect(list.map(s => s.id).sort()).toEqual([a.id, b.id].sort())
    expect(list[0].messages).toBeUndefined()
  })

  it('索引损坏（非数组）→ 同样触发重建', () => {
    const a = createSession('chat', {})
    write(IDX_KEY, 'garbage')
    expect(listSessions().map(s => s.id)).toContain(a.id)
  })

  it('空索引 [] 直接返回空数组，不重复触发扫描重建', () => {
    write(IDX_KEY, [])
    write(ITEM_PREFIX + 'orphan-1', { id: 'orphan-1', groupId: 'chat', title: '孤立', messages: [] })
    expect(listSessions()).toEqual([])
  })
})

describe('辅助函数', () => {
  it('titleFromText：截断 24 字并加省略号', () => {
    expect(titleFromText('短标题')).toBe('短标题')
    expect(titleFromText('x'.repeat(30))).toBe('x'.repeat(24) + '…')
    expect(titleFromText('  \n ')).toBe('新对话')
  })

  it('exportMarkdown：用户/AI 分节、图片计数、非图片附件、错误行', () => {
    const md = exportMarkdown({
      title: '测试',
      messages: [
        { role: 'user', text: '问题', imageCount: 2, fileNames: ['a.md', 'b.pdf'] },
        { role: 'assistant', text: '回答' },
        { role: 'assistant', text: '', error: '超时' },
      ],
    })
    expect(md).toContain('# 测试')
    expect(md).toContain('## 用户')
    expect(md).toContain('> 2 张图片')
    expect(md).toContain('> 附件：a.md、b.pdf')
    expect(md).toContain('## Pi')
    expect(md).toContain('回答')
    expect(md).toContain('> 错误：超时')
  })

  it('fitSessionBudget：超大工具结果与思考文本优先被裁剪，超限时丢弃最旧消息以守住 1MB 上限', () => {
    const bigSession = {
      id: 's-big',
      messages: [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'ok1', thinking: 't'.repeat(2000), tools: [{ name: 'read', result: 'r'.repeat(4000) }] },
        { role: 'user', text: 'latest' },
        { role: 'assistant', text: 'x'.repeat(2000) },
      ],
    }
    const fitted = fitSessionBudget(bigSession, 3000)
    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(3000)
    expect(fitted.messages.at(-1).text).toBe('x'.repeat(2000))
  })
})
