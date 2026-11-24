// 全局共享常量与纯工具函数（避免在各组件与 composable 间重复定义）
export const PI_INSTALL_CMD = 'npm i -g @earendil-works/pi-coding-agent'

export const THINKING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const THINKING_LABELS = {
  off: '不思考',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
}

export const TARGET_LANGS = ['', '中英互译', '英文', '中文', '日文', '韩文', '法文', '德文', '西班牙文', '俄文']

export const TOOL_META = [
  { id: 'read', label: 'read', note: '读取文件内容' },
  { id: 'grep', label: 'grep', note: '按内容搜索文件' },
  { id: 'find', label: 'find', note: '按名称找路径' },
  { id: 'ls', label: 'ls', note: '列目录' },
  { id: 'edit', label: 'edit', note: '按片段修改文件', risk: true },
  { id: 'write', label: 'write', note: '新建或覆盖文件', risk: true },
  { id: 'bash', label: 'bash', note: '执行 shell 命令', risk: true },
  { id: 'powershell', label: 'pwsh', note: '执行 PowerShell（仅 Windows）', risk: true },
]

const RISK_TOOL_SET = new Set(['edit', 'write', 'bash', 'powershell'])

export function riskKeysOf(tool) {
  const t = tool || {}
  const keys = new Set()
  for (const n of (t.list || [])) {
    if (RISK_TOOL_SET.has(n)) keys.add(n)
  }
  if (t.trust) keys.add('trust')
  return keys
}

export function isRiskyTool(tool) {
  return riskKeysOf(tool).size > 0
}

export function hasExecRisk(tool) {
  const t = tool || {}
  return (t.list || []).some(n => n === 'bash' || n === 'powershell') || !!t.trust
}

export function activeRiskSummary(tool) {
  const t = tool || {}
  const list = Array.isArray(t.list) ? t.list : []
  const items = []
  if (list.some(n => n === 'edit' || n === 'write')) items.push('修改文件（edit/write）')
  if (list.some(n => n === 'bash' || n === 'powershell')) items.push('执行命令（bash/powershell）')
  if (t.trust) items.push('信任项目级 .pi 配置（--approve）')
  return items.join('、')
}

export function editRiskReasons(tool) {
  const t = tool || {}
  const out = []
  const list = t.list || []
  if (list.some(n => n === 'edit' || n === 'write')) out.push('可改文件')
  if (list.some(n => n === 'bash' || n === 'powershell')) out.push('可执行命令')
  if (t.mcp === 'all') out.push('MCP 全部（不受白名单约束）')
  if (t.mcp === 'servers') {
    out.push(String(t.mcpServers || '').trim() ? 'MCP 指定（不受白名单约束）' : 'MCP 未填 server，按关闭处理')
  }
  if (t.ext) out.push('扩展可能自带工具')
  if (t.trust) out.push('信任项目级 .pi 配置（将加载项目扩展/MCP）')
  return out.length ? out : ['不暴露任何工具']
}

export function hasAdvancedOptions(tool) {
  const t = tool || {}
  return (t.mcp && t.mcp !== 'off') ||
    (t.skills && t.skills !== 'off' && t.skills !== 'all') ||
    !!t.ext ||
    !!t.context ||
    !!t.templates ||
    !!t.trust
}

export function toolSummary(t) {
  if (!t) return ''
  const bits = []
  bits.push((t.list || []).length ? (t.list || []).join(', ') : '无工具')
  bits.push(t.mcp === 'off' ? 'MCP 关' : t.mcp === 'all' ? 'MCP 全部' : 'MCP ' + (t.mcpServers || '未指定'))
  if (t.ext) bits.push('扩展开')
  if (t.skills === 'off') bits.push('技能关')
  else if (t.skills === 'some') bits.push('技能 ' + (t.skillNames || []).length + ' 个')
  if (t.context) bits.push('项目规范')
  if (t.trust) bits.push('项目配置')
  return bits.join(' · ')
}

export function ctxLabel(c) {
  return c && c.global ? '全局' : '项目'
}

export function fmtSize(n) {
  return n < 1024 ? n + 'B' : (n / 1024).toFixed(1) + 'KB'
}
