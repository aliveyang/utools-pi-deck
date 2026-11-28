// 会话持久化：按会话分 key 存储，避免全量读写放大
// - pideck.session.<id>   单个会话（含 messages）
// - pideck.sessions.idx   索引数组（仅轻量字段，用于列表）
import { read, write, remove } from './storage.js'

const IDX_KEY = 'pideck.sessions.idx'
const ITEM_PREFIX = 'pideck.session.'
const MAX_SESSION_BYTES = 850 * 1024   // 留足余量，避免触发 utools.db 单文档 1 MB 上限
const TEXT_ENCODER = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

function jsonByteLength(obj) {
  const s = JSON.stringify(obj)
  if (TEXT_ENCODER) return TEXT_ENCODER.encode(s).length
  return s.length * 2
}

// 超过体积预算时逐级裁剪旧工具结果/思考文本/最早消息，防止单文档超过 1 MB 写入失败
export function fitSessionBudget(session, maxBytes = MAX_SESSION_BYTES) {
  if (!session || typeof session !== 'object') return session
  let bytes = jsonByteLength(session)
  if (bytes <= maxBytes) return session
  const out = {
    ...session,
    messages: (session.messages || []).map(m => ({
      ...m,
      tools: Array.isArray(m.tools) ? m.tools.map(t => ({ ...t })) : m.tools,
    })),
  }
  const TRIM_MARK = '…（超出同步存储上限已裁剪）'
  // 先按估算差值批量裁剪工具结果与思考文本，减少反复全量 JSON.stringify 开销
  let savedEst = 0
  const needTrim = bytes - maxBytes
  for (const m of out.messages) {
    if (savedEst >= needTrim) {
      bytes = jsonByteLength(out)
      if (bytes <= maxBytes) return out
    }
    if (Array.isArray(m.tools)) {
      for (const t of m.tools) {
        if (t && t.result != null && t.result !== TRIM_MARK) {
          const oldLen = typeof t.result === 'string' ? t.result.length : JSON.stringify(t.result).length
          t.result = TRIM_MARK
          savedEst += Math.max(0, oldLen - TRIM_MARK.length)
          if (savedEst >= needTrim && jsonByteLength(out) <= maxBytes) return out
        }
        if (t && t.args != null && t.args !== TRIM_MARK) {
          const argsLen = typeof t.args === 'string' ? t.args.length : JSON.stringify(t.args).length
          if (argsLen > 1000) {
            t.args = TRIM_MARK
            savedEst += Math.max(0, argsLen - TRIM_MARK.length)
            if (savedEst >= needTrim && jsonByteLength(out) <= maxBytes) return out
          }
        }
      }
    }
    if (typeof m.thinking === 'string' && m.thinking.length > 200) {
      const oldLen = m.thinking.length
      m.thinking = TRIM_MARK
      savedEst += Math.max(0, oldLen - TRIM_MARK.length)
      if (savedEst >= needTrim && jsonByteLength(out) <= maxBytes) return out
    }
  }
  while (out.messages.length > 1 && jsonByteLength(out) > maxBytes) {
    out.messages.shift()
  }
  // 兜底：若仅剩最后 1 条消息仍超过 maxBytes，则清理残留工具参数/思考后再二分截断正文
  if (out.messages.length === 1 && jsonByteLength(out) > maxBytes) {
    const last = out.messages[0]
    if (Array.isArray(last.tools)) {
      for (const t of last.tools) {
        if (t && t.result != null && t.result !== TRIM_MARK) t.result = TRIM_MARK
        if (t && t.args != null && t.args !== TRIM_MARK) t.args = TRIM_MARK
      }
    }
    if (typeof last.thinking === 'string' && last.thinking.length > 0 && jsonByteLength(out) > maxBytes) {
      last.thinking = TRIM_MARK
    }
    if (typeof last.text === 'string' && last.text.length > 0 && jsonByteLength(out) > maxBytes) {
      const origText = last.text
      let lo = 0, hi = origText.length, best = ''
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        last.text = (mid > 0 ? origText.slice(0, mid) : '') + TRIM_MARK
        if (jsonByteLength(out) <= maxBytes) {
          best = last.text
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      last.text = best || TRIM_MARK
    }
  }
  return out
}

function itemKey(id) { return ITEM_PREFIX + id }

function stripMessages(s) {
  return {
    id: s.id, groupId: s.groupId, config: s.config || {}, title: s.title || '新对话',
    piSessionId: s.piSessionId || '', usage: s.usage || null,
    createdAt: s.createdAt || 0, updatedAt: s.updatedAt || 0,
  }
}

// 枚举存储后端里所有单会话 key（索引丢失时用于重建）
function listItemIds() {
  const ids = []
  try {
    const db = window.utools && window.utools.db
    if (db && typeof db.allDocs === 'function') {
      for (const d of (db.allDocs(ITEM_PREFIX) || [])) {
        const k = d && (d._id || d.id)
        if (typeof k === 'string' && k.startsWith(ITEM_PREFIX)) ids.push(k.slice(ITEM_PREFIX.length))
      }
      return ids
    }
  } catch (_) {}
  try {
    if (typeof localStorage !== 'undefined') {
      return Object.keys(localStorage)
        .filter(k => k.startsWith(ITEM_PREFIX))
        .map(k => k.slice(ITEM_PREFIX.length))
    }
  } catch (_) {}
  return ids
}

// 索引损坏/丢失但单会话仍在时，从 item key 重建，避免会话"集体消失"
// 空库时也写回 []，防止每次冷启动都重复触发 allDocs 全库扫描
function rebuildIndex() {
  const idx = []
  for (const id of listItemIds()) {
    const s = read(itemKey(id), null)
    if (s && s.id) idx.push(stripMessages(s))
  }
  writeIndex(idx)
  return idx
}

function readIndex() {
  const arr = read(IDX_KEY, null)
  if (Array.isArray(arr)) return arr
  return rebuildIndex()
}
function writeIndex(idx) { write(IDX_KEY, idx) }

function upsertIndex(entry) {
  const idx = readIndex()
  const i = idx.findIndex(e => e.id === entry.id)
  if (i >= 0) idx[i] = { ...idx[i], ...entry }
  else idx.push(entry)
  writeIndex(idx)
}

export function listSessions(groupId) {
  const list = readIndex().map(e => ({ ...e }))
  const filtered = groupId ? list.filter(s => s.groupId === groupId) : list
  return filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export function getSession(id) {
  const s = read(itemKey(id), null)
  return (s && s.id) ? s : null
}

export function createSession(groupId, config) {
  const id = 's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const session = {
    id,
    groupId,
    config: config ? { ...config } : {},
    title: '新对话',
    piSessionId: 'pideck-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    messages: [],
    usage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  write(itemKey(id), fitSessionBudget(session))
  upsertIndex(stripMessages(session))
  return session
}

export function updateSession(id, patch) {
  const cur = getSession(id)
  if (!cur) return null
  const next = fitSessionBudget({ ...cur, ...patch, updatedAt: Date.now() })
  write(itemKey(id), next)
  upsertIndex({
    id,
    updatedAt: next.updatedAt,
    title: next.title,
    usage: next.usage,
    config: next.config,
    piSessionId: next.piSessionId,
  })
  return next
}

export function deleteSession(id) {
  const cur = getSession(id)
  remove(itemKey(id))
  writeIndex(readIndex().filter(e => e.id !== id))
  return cur
}

export function collectSessionImagePaths(session) {
  if (!session || !Array.isArray(session.messages)) return []
  const paths = []
  for (const m of session.messages) {
    if (!m || !Array.isArray(m.imagePaths)) continue
    for (const p of m.imagePaths) {
      if (typeof p === 'string' && p.trim()) paths.push(p)
    }
  }
  return paths
}

export function clearAllSessions() {
  const idx = readIndex()
  for (const e of idx) remove(itemKey(e.id))
  writeIndex([])
  return idx
}

export function titleFromText(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, 24) + (clean.length > 24 ? '…' : '') : '新对话'
}

export function relTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  const now = new Date(), t = new Date(ts)
  if (now.toDateString() === t.toDateString()) return `${Math.floor(diff / 3600000)} 小时前`
  const y = new Date(now.getTime() - 86400000)
  if (y.toDateString() === t.toDateString()) return '昨天'
  return `${t.getMonth() + 1} 月 ${t.getDate()} 日`
}

export function exportMarkdown(session) {
  if (!session) return ''
  const lines = [`# ${session.title}`, '']
  for (const m of (session.messages || [])) {
    if (m.role === 'user') {
      lines.push('## 用户', '', m.text || '(图片)', '')
      if (m.imageCount) lines.push(`> ${m.imageCount} 张图片`, '')
      else if (m.images && m.images.length) lines.push(`> ${m.images.length} 张图片`, '')
      if (m.fileNames && m.fileNames.length) lines.push(`> 附件：${m.fileNames.join('、')}`, '')
    } else {
      lines.push('## Pi', '')
      if (m.text) lines.push(m.text, '')
      if (m.error) lines.push(`> 错误：${m.error}`, '')
    }
  }
  return lines.join('\n')
}
