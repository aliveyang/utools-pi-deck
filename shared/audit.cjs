// 操作审计：本地 append-only JSONL，按天分片，脱敏后写入
// 约束：记录失败绝不影响主流程；不记录对话全文、文件内容与密钥
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DEFAULT_ROOT = path.join(os.homedir(), '.pideck', 'audit')
const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_FIELD = 800
const CLEAN_INTERVAL = 6 * 3600 * 1000
const TAIL_READ_BYTES = 4 * 1024 * 1024

const FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/

// 常见密钥形态：Bearer/JWT、键值对（允许 JSON 引号键）、sk-、GitHub、Slack、Google
const REDACT_PATTERNS = [
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, repl: 'Bearer ***' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, repl: '***' },
  {
    re: /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie)["']?\s*[:=]\s*["']?)([^\s"',;}\]]{4,})/gi,
    repl: (m, prefix) => prefix + '***',
  },
  { re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, repl: '***' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}\b/g, repl: '***' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, repl: '***' },
  { re: /\bAIza[A-Za-z0-9_-]{20,}\b/g, repl: '***' },
]

function redactString(s) {
  let out = s
  for (const p of REDACT_PATTERNS) out = out.replace(p.re, p.repl || '***')
  return out
}

function truncate(s) {
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + '…（已截断）' : s
}

function redact(value, depth) {
  const d = depth || 0
  if (d > 4) return '[depth]'
  if (typeof value === 'string') return truncate(redactString(value))
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, d + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      // 键名本身命中敏感词时直接打码，避免值以嵌套对象形式绕过正则
      out[k] = /(api[_-]?key|token|secret|password|passwd|authorization|cookie)/i.test(k) && typeof v === 'string'
        ? '***' : redact(v, d + 1)
    }
    return out
  }
  return String(value)
}

function pad(n) { return String(n).padStart(2, '0') }
function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function fmtTime(ts) {
  const d = new Date(ts)
  return `${dayKey(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function oneLine(v) {
  if (v == null) return ''
  let s
  try { s = typeof v === 'string' ? v : JSON.stringify(v) } catch (_) { s = String(v) }
  return String(s).replace(/\s+/g, ' ').trim()
}

// 工具调用的"人话"摘要，供 UI 直接展示
function describe(rec) {
  const t = rec && rec.tool
  if (rec.type === 'tool' && t) {
    const name = t.name || 'tool'
    if (name === 'edit' || name === 'write') return `修改文件 ${oneLine(t.args).slice(0, 120)}`
    if (name === 'bash' || name === 'powershell') return `执行命令 ${oneLine(t.args).slice(0, 120)}`
    if (name === 'read' || name === 'grep' || name === 'find' || name === 'ls') return `读取 ${name} ${oneLine(t.args).slice(0, 80)}`
    return `调用 ${name}`
  }
  if (rec.type === 'run') {
    const bits = ['完成一轮对话']
    if (rec.aborted) bits.push('（已停止）')
    if (rec.error) bits.push('（出错）')
    if (rec.usage && rec.usage.totalTokens) bits.push(`${rec.usage.totalTokens} tokens`)
    return bits.join('')
  }
  if (rec.type === 'perm') return `权限变更：${rec.perm || '未记录'}`
  if (rec.type === 'data') return rec.action === 'clear-sessions' ? '清空所有对话' : `数据操作：${rec.action || ''}`
  if (rec.type === 'config') return `模型配置：${rec.provider || ''}`
  return rec.type || '记录'
}

function parseFile(name) {
  const m = FILE_RE.exec(name)
  if (!m) return null
  return { date: m[1], part: m[2] ? Number(m[2]) : 0 }
}

function fileOrder(a, b) {
  const pa = parseFile(a), pb = parseFile(b)
  if (!pa || !pb) return a.localeCompare(b)
  if (pa.date !== pb.date) return pa.date < pb.date ? -1 : 1
  return pa.part - pb.part
}

function createAudit(options) {
  const opts = options || {}
  const root = opts.root || DEFAULT_ROOT
  let now = opts.now || Date.now
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  let lastCleanup = 0

  function listFiles() {
    try {
      return fs.readdirSync(root).filter(n => FILE_RE.test(n)).sort(fileOrder)
    } catch (_) { return [] }
  }

  function cleanup() {
    const cutoff = dayKey(now() - retentionDays * 86400000)
    for (const f of listFiles()) {
      const info = parseFile(f)
      if (info && info.date < cutoff) {
        try { fs.unlinkSync(path.join(root, f)) } catch (_) {}
      }
    }
  }

  function pickFile(base) {
    for (let i = 0; i < 100; i++) {
      const name = i === 0 ? `${base}.jsonl` : `${base}.${i}.jsonl`
      const p = path.join(root, name)
      let size = 0
      try { size = fs.statSync(p).size } catch (_) {}
      if (size < maxFileBytes) return p
    }
    return null
  }

  function record(entry) {
    try {
      const ts = now()
      const rec = redact({ ...entry, ts })
      const line = JSON.stringify(rec) + '\n'
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
      const file = pickFile(dayKey(ts))
      if (!file) return false
      fs.appendFileSync(file, line, { mode: 0o600 })
      if (ts - lastCleanup > CLEAN_INTERVAL) { lastCleanup = ts; cleanup() }
      return true
    } catch (_) { return false }
  }

  function readTailLines(file) {
    try {
      const st = fs.statSync(file)
      const start = Math.max(0, st.size - TAIL_READ_BYTES)
      const fd = fs.openSync(file, 'r')
      try {
        const buf = Buffer.alloc(st.size - start)
        fs.readSync(fd, buf, 0, buf.length, start)
        let text = buf.toString('utf8')
        if (start > 0) {
          const nl = text.indexOf('\n')
          text = nl >= 0 ? text.slice(nl + 1) : ''
        }
        return text.split(/\r?\n/).filter(Boolean)
      } finally { fs.closeSync(fd) }
    } catch (_) { return [] }
  }

  function tail(limit) {
    const max = Math.max(1, Math.min(5000, limit || 200))
    const files = listFiles().reverse()
    const out = []
    for (const f of files) {
      const lines = readTailLines(path.join(root, f))
      for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
        try {
          const rec = JSON.parse(lines[i])
          if (rec && typeof rec === 'object') out.push({ ...rec, summary: describe(rec) })
        } catch (_) {}
      }
      if (out.length >= max) break
    }
    return out
  }

  function exportMd(days) {
    const span = Math.max(1, Math.min(365, days || retentionDays))
    const since = now() - span * 86400000
    const rows = tail(5000).filter(r => (r.ts || 0) >= since)
    const lines = [
      `# PiDeck 操作记录（最近 ${span} 天）`,
      '',
      '> 仅保存在本机；不包含对话全文、文件内容与密钥。',
      '',
      '| 时间 | 分组 | 类型 | 内容 |',
      '|---|---|---|---|',
    ]
    for (const r of rows) {
      const kind = r.type === 'tool' ? (r.tool && r.tool.name) || 'tool' : r.type || ''
      lines.push(`| ${fmtTime(r.ts)} | ${esc(r.groupName || '')} | ${esc(kind)} | ${esc(r.summary || '')} |`)
    }
    return lines.join('\n')
  }

  function clear() {
    let removed = 0, failed = 0
    for (const f of listFiles()) {
      try { fs.unlinkSync(path.join(root, f)); removed++ } catch (_) { failed++ }
    }
    return { removed, failed }
  }

  function setNow(fn) { now = fn || Date.now }

  return { record, tail, exportMd, clear, dir: () => root, cleanup, setNow }
}

function esc(v) { return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ') }

const defaultAudit = createAudit()

module.exports = {
  ...defaultAudit,
  createAudit,
  describe,
  redactString,
  redact,
  dayKey,
  fmtTime,
  DEFAULT_ROOT,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_MAX_FILE_BYTES,
}
