// 会话持久化：按会话分 key 存储，避免全量读写放大
// - pideck.session.<id>   单个会话（含 messages）
// - pideck.sessions.idx   索引数组（仅轻量字段，用于列表）
// 旧数据（pideck.sessions.v1 大数组）首次访问时自动迁移
import { read, write, remove } from './storage.js'

const IDX_KEY = 'pideck.sessions.idx'
const ITEM_PREFIX = 'pideck.session.'
const LEGACY_KEY = 'pideck.sessions.v1'

// 清理已废弃的 lastSession 记录（旧版本只写不读，升级后一次性移除）
try { remove('pideck.lastSession.v1') } catch (_) {}

function itemKey(id) { return ITEM_PREFIX + id }

function stripMessages(s) {
  return {
    id: s.id, groupId: s.groupId, config: s.config || {}, title: s.title || '新对话',
    piSessionId: s.piSessionId || '', usage: s.usage || null,
    createdAt: s.createdAt || 0, updatedAt: s.updatedAt || 0,
  }
}

// 旧数据迁移：大数组 → 每会话单独 key + 索引（只迁移一次）
function migrateLegacy() {
  const legacy = read(LEGACY_KEY, null)
  if (!Array.isArray(legacy) || !legacy.length) return []
  const idx = []
  for (const s of legacy) {
    if (!s || !s.id) continue
    try { write(itemKey(s.id), s) } catch (_) {}
    idx.push(stripMessages(s))
  }
  writeIndex(idx)
  remove(LEGACY_KEY)
  return idx
}

// 枚举存储后端里所有单会话 key（索引丢失时用于重建）
function listItemIds() {
  const ids = []
  try {
    const db = window.utools && window.utools.dbStorage
    if (db && typeof db.allDocs === 'function') {
      for (const d of (db.allDocs() || [])) {
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
function rebuildIndex() {
  const idx = []
  for (const id of listItemIds()) {
    const s = read(itemKey(id), null)
    if (s && s.id) idx.push(stripMessages(s))
  }
  if (idx.length) writeIndex(idx)
  return idx
}

function readIndex() {
  const arr = read(IDX_KEY, null)
  if (Array.isArray(arr) && arr.length) return arr
  const migrated = migrateLegacy()
  if (migrated.length) return migrated
  // 索引空/不可读：磁盘若还有会话则重建，避免会话"集体消失"
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
    // 创建时快照配置，续接会话用快照而非当前分组，避免配置漂移
    config: config ? { ...config } : {},
    title: '新对话',
    // pi session id：字母数字 . _ -，首尾必须为字母数字
    piSessionId: 'pideck-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    messages: [],
    usage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  write(itemKey(id), session)
  upsertIndex(stripMessages(session))
  return session
}

export function updateSession(id, patch) {
  const cur = getSession(id)
  if (!cur) return null
  const next = { ...cur, ...patch, updatedAt: Date.now() }
  write(itemKey(id), next)
  // 索引只同步影响列表展示的字段，不搬运 messages
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

// 返回被删除的会话（含 piSessionId），供调用方清理 pi 侧会话文件
export function deleteSession(id) {
  const cur = getSession(id)
  remove(itemKey(id))
  writeIndex(readIndex().filter(e => e.id !== id))
  return cur
}


export function titleFromText(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, 24) + (clean.length > 24 ? '…' : '') : '新对话'
}

export function exportMarkdown(session) {
  if (!session) return ''
  const lines = [`# ${session.title}`, '']
  for (const m of (session.messages || [])) {
    if (m.role === 'user') {
      lines.push('## 用户', '', m.text || '(图片)', '')
      if (m.imageCount) lines.push(`> ${m.imageCount} 张图片`, '')
      else if (m.images && m.images.length) lines.push(`> ${m.images.length} 张图片`, '')
    } else {
      lines.push('## Pi', '')
      if (m.text) lines.push(m.text, '')
      if (m.error) lines.push(`> 错误：${m.error}`, '')
    }
  }
  return lines.join('\n')
}
