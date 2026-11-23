<script setup>
import { ref, computed, watch } from 'vue'
import { newGroup, PRESET_LIST, PRESET_LABEL, TOOL_PRESETS, TOOL_NAMES, presetOf } from '../groups.js'
import Icon from './Icon.vue'

const props = defineProps({
  show: { type: Boolean, default: false },
  groups: { type: Array, default: () => [] },
  models: { type: Array, default: () => [] },
  skills: { type: Array, default: () => [] },
  defaults: { type: Object, default: () => ({}) },
  envInfo: { type: Object, default: null },
  engine: { type: String, default: 'json' },
  layout: { type: String, default: 'classic' },
  defaultCwd: { type: String, default: '' },
  sendKeyMode: { type: String, default: 'ctrl' },
  isMac: { type: Boolean, default: false },
  displayCwd: { type: Function, required: true },
  fmtSize: { type: Function, required: true },
})

const emit = defineEmits([
  'close', 'setLayout', 'setEngine', 'commitDefaultCwd', 'setDefaultCwd', 'pickDefaultCwd', 'setSendKeyMode',
  'saveGroup', 'deleteGroup', 'refreshModels', 'openPath', 'recheckEnv',
  'clearAllSessions', 'configSaved', 'notify', 'copyCmd', 'openLink',
])

const SETTINGS_TABS = [
  { id: 'general', label: '对话默认' },
  { id: 'groups', label: '分组' },
  { id: 'diag', label: '环境与模型' },
  { id: 'audit', label: '操作记录' },
]
const TARGET_LANGS = ['', '英文', '中文', '日文', '韩文', '法文', '德文', '西班牙文', '俄文']
const THINKING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const THINKING_LABELS = {
  off: '不思考', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高',
}
const TOOL_META = [
  { id: 'read', label: 'read', note: '读取文件内容' },
  { id: 'grep', label: 'grep', note: '按内容搜索文件' },
  { id: 'find', label: 'find', note: '按名称找路径' },
  { id: 'ls', label: 'ls', note: '列目录' },
  { id: 'edit', label: 'edit', note: '按片段修改文件', risk: true },
  { id: 'write', label: 'write', note: '新建或覆盖文件', risk: true },
  { id: 'bash', label: 'bash', note: '执行 shell 命令', risk: true },
  { id: 'powershell', label: 'pwsh', note: '执行 PowerShell（仅 Windows）', risk: true },
]

const settingsTab = ref('general')
const editing = ref(null)
const editContextFiles = ref([])
const editSkills = ref([])

watch(() => props.show, val => {
  if (val) {
    editing.value = null
    settingsTab.value = 'general'
  } else {
    editing.value = null
    // 关闭时清掉未提交的密钥与确认态，避免下次打开残留
    cfgKey.value = ''
    confirmClearAll.value = false
    auditConfirmClear.value = false
    clearTimeout(confirmClearTimer)
    clearTimeout(auditClearTimer)
  }
})

// 分组编辑时按当前编辑分组的工作目录实时扫描规范与技能（不再误用 activeGroup）
function refreshEditEnv() {
  if (!editing.value) return
  const cwd = editing.value.cwd || props.defaultCwd || ''
  try {
    editContextFiles.value = (window.piBridge && window.piBridge.detectContextFiles)
      ? (window.piBridge.detectContextFiles(cwd) || [])
      : []
  } catch (_) { editContextFiles.value = [] }
  try {
    editSkills.value = (window.piBridge && window.piBridge.listSkills)
      ? (window.piBridge.listSkills(cwd) || [])
      : props.skills
  } catch (_) { editSkills.value = props.skills }
}

watch(
  [() => editing.value && editing.value.id, () => editing.value && editing.value.cwd, () => props.defaultCwd],
  () => { if (editing.value) refreshEditEnv() },
)

function defaultModelLabel() {
  const d = props.defaults || {}
  const raw = d.modelName || d.modelId
  if (!raw) return '默认（继承 pi 设置）'
  const name = String(raw).split('·')[0].trim()
  return `默认（${name}）`
}
function defaultThinkingLabel() {
  const lv = (props.defaults || {}).thinkingLevel
  if (!lv) return '默认（继承 pi 设置）'
  return `默认（${THINKING_LABELS[lv] || lv}）`
}
function thinkingLabel(lv) {
  if (!lv) return defaultThinkingLabel()
  return THINKING_LABELS[lv] ? `${THINKING_LABELS[lv]}（${lv}）` : lv
}
function ctxLabel(c) { return c.global ? '全局' : '项目' }

function editGroup(g) {
  const base = g.tool || TOOL_PRESETS.read
  editing.value = {
    ...g,
    lean: { noContextFiles: false, noSkills: false, noMcp: false, noTools: false, ...(g.lean || {}) },
    tool: {
      ...base,
      list: (base.list || []).slice(),
      mcpServers: base.mcpServers || '',
      skillNames: (base.skillNames || []).slice(),
    },
  }
  refreshEditEnv()
}
function addGroup() {
  editing.value = newGroup()
  refreshEditEnv()
}
function saveGroup() {
  const e = editing.value
  if (!e || !e.name.trim()) return
  const tool = {
    ...(e.tool || TOOL_PRESETS.read),
    list: ((e.tool && e.tool.list) || []).slice(),
    skillNames: ((e.tool && e.tool.skillNames) || []).slice(),
  }
  const next = {
    ...e, tool,
    lean: {
      ...(e.lean || {}),
      noTools: tool.list.length === 0,
      noMcp: tool.mcp === 'off',
      noSkills: tool.skills === 'off',
      noContextFiles: !tool.context,
      noPromptTemplates: !tool.templates,
    },
  }
  emit('saveGroup', next)
  editing.value = null
}
// 分组删除两步确认（会连带删除该分组会话）
const confirmDeleteGroup = ref(false)
let confirmDeleteTimer = null
watch(editing, () => {
  confirmDeleteGroup.value = false
  clearTimeout(confirmDeleteTimer)
})
function requestDeleteGroup() {
  if (!editing.value) return
  if (!confirmDeleteGroup.value) {
    confirmDeleteGroup.value = true
    confirmDeleteTimer = setTimeout(() => { confirmDeleteGroup.value = false }, 4000)
    return
  }
  confirmDeleteGroup.value = false
  clearTimeout(confirmDeleteTimer)
  emit('deleteGroup', editing.value)
}

function pickCwd() {
  if (!window.piBridge || !window.piBridge.pickFolder) return
  const dir = window.piBridge.pickFolder()
  if (dir && editing.value) editing.value.cwd = dir
}

const editTool = computed(() => (editing.value && editing.value.tool) || TOOL_PRESETS.read)
const editPreset = computed(() => presetOf(editing.value && editing.value.tool))
function applyPreset(id) {
  const e = editing.value
  if (!e) return
  const preset = TOOL_PRESETS[id]
  e.tool = {
    ...preset, list: preset.list.slice(), mcpServers: '', skillNames: [], trust: false,
  }
}
function hasTool(id) { return (editTool.value.list || []).includes(id) }
function toggleTool(id) {
  const t = editing.value && editing.value.tool
  if (!t) return
  const list = (t.list || []).slice()
  const i = list.indexOf(id)
  if (i >= 0) list.splice(i, 1)
  else list.push(id)
  t.list = list.sort((a, b) => TOOL_NAMES.indexOf(a) - TOOL_NAMES.indexOf(b))
}
function hasSkill(name) { return (editTool.value.skillNames || []).includes(name) }
function toggleSkill(name) {
  const t = editing.value && editing.value.tool
  if (!t) return
  const names = (t.skillNames || []).slice()
  const i = names.indexOf(name)
  if (i >= 0) names.splice(i, 1)
  else names.push(name)
  t.skillNames = names
}
// 组合后的真实后果：白名单之外 MCP / 扩展仍可能带工具，即使内置工具为空也须提示
const editRisk = computed(() => {
  const t = editing.value && editing.value.tool
  if (!t) return []
  const out = []
  const list = t.list || []
  if (list.some(n => n === 'edit' || n === 'write')) out.push('可改文件')
  if (list.some(n => n === 'bash' || n === 'powershell')) out.push('可执行命令')
  if (t.mcp === 'all') out.push('MCP 全部（不受白名单约束）')
  if (t.mcp === 'servers') {
    out.push(String(t.mcpServers || '').trim() ? 'MCP 指定（不受白名单约束）' : 'MCP 未填 server，按关闭处理')
  }
  if (t.ext) out.push('扩展可能自带工具')
  if (!out.length) return ['不暴露任何工具']
  return out
})
const editHasExec = computed(() => {
  const t = editing.value && editing.value.tool
  if (!t) return false
  return (t.list || []).some(n => n === 'bash' || n === 'powershell')
})

function groupSummary(g) {
  const parts = []
  if (g.kind === 'translate' && g.targetLang) parts.push(`译为${g.targetLang}`)
  parts.push(PRESET_LABEL[presetOf(g.tool)] || '自定义')
  const tl = (g.tool && g.tool.list) || []
  if (tl.length && tl.length < TOOL_NAMES.length) parts.push(tl.length + ' 个工具')
  if (g.tool && g.tool.mcp && g.tool.mcp !== 'off') parts.push('MCP 开')
  parts.push(g.model ? String(g.model).split('/').pop() : '默认模型')
  if (g.thinking) parts.push(THINKING_LABELS[g.thinking] || g.thinking)
  parts.push(props.displayCwd(g.cwd))
  return parts
}

// ---------- 环境与模型配置 ----------
const cfg = ref(null)
const cfgProvider = ref('')
const cfgKey = ref('')
const cfgBaseUrl = ref('')
const cfgApi = ref('openai-completions')
const cfgModelId = ref('')
const cfgThinking = ref('')
const cfgModels = ref([])
const cfgBusy = ref(false)
const cfgMsg = ref('')
const cfgAuth = ref(null)
// 预设 + models.json 里已有的非预设 provider（如中转站/本地网关），避免用户只能选预设
const cfgAllProviders = computed(() => {
  const st = cfg.value
  if (!st || !st.ok) return []
  const presets = (st.presets || []).map(p => ({ ...p, preset: true }))
  const extra = (st.providers || [])
    .filter(p => !p.preset && p.id !== 'custom')
    .map(p => ({ id: p.id, name: p.name || p.id, builtin: false, preset: false, env: '', site: '', note: '已存在的自定义端点', oauth: false }))
  return [...presets, ...extra]
})
const cfgPreset = computed(() => cfgAllProviders.value.find(p => p.id === cfgProvider.value) || null)
const cfgIsCustom = computed(() => !!(cfgPreset.value && !cfgPreset.value.builtin))
const cfgProviderInfo = computed(() => ((cfg.value && cfg.value.providers) || []).find(p => p.id === cfgProvider.value) || null)

function loadCfg() {
  if (!window.piBridge || !window.piBridge.configState) {
    cfg.value = { ok: false, error: '当前环境不支持配置（需在 uTools 中运行）' }
    return
  }
  try {
    cfg.value = window.piBridge.configState()
    if (!cfg.value || !cfg.value.ok) return
    const cur = cfg.value.defaultProvider || ''
    const needInit = !cfgProvider.value || !cfgAllProviders.value.some(p => p.id === cfgProvider.value)
    if (needInit) {
      cfgProvider.value = cfgAllProviders.value.some(p => p.id === cur)
        ? cur : ((cfgAllProviders.value[0] && cfgAllProviders.value[0].id) || 'deepseek')
      cfgThinking.value = cfg.value.defaultThinkingLevel || ''
      if (cur === cfgProvider.value && cfg.value.defaultModel) cfgModelId.value = cfg.value.defaultModel
    }
    const info = cfgProviderInfo.value
    cfgBaseUrl.value = (info && info.baseUrl) || ''
    cfgApi.value = (info && info.api) || 'openai-completions'
    loadCfgModels()
  } catch (e) {
    cfg.value = { ok: false, error: String(e.message || e) }
  }
}

async function loadCfgModels() {
  if (!window.piBridge || !window.piBridge.listModelsAsync) return
  try {
    const all = await window.piBridge.listModelsAsync()
    cfgModels.value = (all || []).filter(m => m.provider === cfgProvider.value)
  } catch (_) { cfgModels.value = [] }
}

function selectProvider(id) {
  cfgProvider.value = id
  cfgKey.value = ''
  cfgAuth.value = null
  cfgMsg.value = ''
  cfgModelId.value = ''
  const info = cfgProviderInfo.value
  cfgBaseUrl.value = (info && info.baseUrl) || ''
  cfgApi.value = (info && info.api) || 'openai-completions'
  loadCfgModels()
}

async function saveCfg() {
  if (!window.piBridge || !window.piBridge.configSave) return
  const modelId = (cfgModelId.value || '').trim()
  if (!modelId) { cfgMsg.value = '请先选择或填写默认模型 ID'; return }
  cfgBusy.value = true
  cfgMsg.value = ''
  try {
    const r = await window.piBridge.configSave({
      provider: cfgProvider.value,
      name: (cfgProviderInfo.value && cfgProviderInfo.value.name)
        || (cfgIsCustom.value ? '自定义端点' : (cfgPreset.value && cfgPreset.value.name)),
      apiKey: cfgKey.value,
      baseUrl: cfgIsCustom.value ? cfgBaseUrl.value : '',
      api: cfgIsCustom.value ? cfgApi.value : '',
      modelId,
      modelName: modelId,
      thinking: cfgThinking.value,
      setDefault: true,
    })
    if (!r || !r.ok) { cfgMsg.value = (r && r.error) || '保存失败'; return }
    cfgKey.value = ''
    cfg.value = r.state || window.piBridge.configState()
    cfgMsg.value = `已保存，默认模型：${cfgProvider.value} / ${modelId}`
    if (r.warnings && r.warnings.length) cfgMsg.value += `（提示：${r.warnings.join('；')}）`
    emit('configSaved')
    emit('notify', '模型配置已保存，下一条消息生效')
    cfgAuth.value = await window.piBridge.configAuthCheck(cfgProvider.value)
  } catch (e) {
    cfgMsg.value = String(e.message || e)
  } finally {
    cfgBusy.value = false
  }
}

async function checkCfgAuth() {
  if (!window.piBridge || !window.piBridge.configAuthCheck) return
  cfgAuth.value = { status: 'checking' }
  try { cfgAuth.value = await window.piBridge.configAuthCheck(cfgProvider.value) }
  catch (_) { cfgAuth.value = { status: 'invalid' } }
}

function authLabel(status) {
  if (!status) return ''
  if (status === 'checking') return '检测中…'
  if (status === 'ready') return '凭证可用'
  if (status === 'not_ready') return '还没有可用凭证'
  if (status === 'invalid') return '凭证无效或检测失败'
  if (status === 'unavailable') return '无法检测（Pi 未就绪）'
  return status
}

function terminalLogin() {
  const provider = cfgProvider.value
  if (!provider || cfgIsCustom.value) return
  const cmd = (window.piBridge && window.piBridge.configLoginCommand && window.piBridge.configLoginCommand(provider))
    || ('pi auth login ' + provider)
  emit('copyCmd', cmd)
  const ok = window.piBridge && window.piBridge.openTerminalForProvider && window.piBridge.openTerminalForProvider(provider)
  emit('notify', ok ? '已打开终端并复制命令，粘贴后回车' : '已复制登录命令，请在终端中运行')
}

async function removeCfgKey() {
  if (!window.piBridge || !window.piBridge.configRemoveKey) return
  const r = await window.piBridge.configRemoveKey(cfgProvider.value)
  if (r && r.ok) {
    emit('notify', r.removed ? '已清除该服务商的密钥' : '该服务商没有保存密钥')
    cfg.value = window.piBridge.configState()
  } else {
    emit('notify', (r && r.error) || '清除失败')
  }
}

// ---------- 数据清理 ----------
const confirmClearAll = ref(false)
let confirmClearTimer = null
function requestClearAll() {
  if (!confirmClearAll.value) {
    confirmClearAll.value = true
    confirmClearTimer = setTimeout(() => { confirmClearAll.value = false }, 4000)
    return
  }
  confirmClearAll.value = false
  clearTimeout(confirmClearTimer)
  emit('clearAllSessions')
}

// ---------- 操作记录 ----------
const auditRows = ref([])
const auditRiskOnly = ref(false)
const auditConfirmClear = ref(false)
let auditClearTimer = null

function loadAudit() {
  try {
    auditRows.value = (window.piBridge && window.piBridge.auditTail) ? (window.piBridge.auditTail(200) || []) : []
  } catch (_) { auditRows.value = [] }
}
const auditVisible = computed(() =>
  auditRiskOnly.value
    ? auditRows.value.filter(r => r.risk || r.type === 'perm' || r.type === 'data')
    : auditRows.value)
const auditStats = computed(() => {
  let writes = 0, execs = 0
  for (const r of auditRows.value) {
    if (r.type !== 'tool' || !r.tool) continue
    if (r.tool.name === 'edit' || r.tool.name === 'write') writes++
    if (r.tool.name === 'bash' || r.tool.name === 'powershell') execs++
  }
  return { writes, execs }
})
function fmtAuditTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function auditKind(r) {
  if (r.type === 'tool') return (r.tool && r.tool.name) || 'tool'
  if (r.type === 'run') return '对话'
  if (r.type === 'perm') return '权限'
  if (r.type === 'data') return '数据'
  if (r.type === 'config') return '配置'
  return r.type || ''
}
function isAuditRisk(r) {
  return !!(r.risk || r.type === 'perm' || r.type === 'data')
}
function exportAudit() {
  if (!window.piBridge || !window.piBridge.auditExport) return
  const md = window.piBridge.auditExport(30)
  const r = window.piBridge.saveTextFile && window.piBridge.saveTextFile('PiDeck-操作记录.md', md)
  if (r && r.ok) emit('notify', '已导出：' + r.path)
  else if (r && r.canceled) return
  else emit('notify', '导出失败')
}
function openAuditDir() {
  const dir = window.piBridge && window.piBridge.auditDir && window.piBridge.auditDir()
  if (dir) emit('openPath', dir)
  else emit('notify', '当前环境无法打开记录目录')
}
function clearAudit() {
  if (!auditConfirmClear.value) {
    auditConfirmClear.value = true
    auditClearTimer = setTimeout(() => { auditConfirmClear.value = false }, 4000)
    return
  }
  auditConfirmClear.value = false
  clearTimeout(auditClearTimer)
  const r = window.piBridge && window.piBridge.auditClear ? window.piBridge.auditClear() : null
  loadAudit()
  if (r && r.failed) emit('notify', `清空完成，${r.failed} 个文件未能删除`)
  else emit('notify', '操作记录已清空')
}

function switchTab(id) {
  settingsTab.value = id
  if (id === 'diag') loadCfg()
  if (id === 'audit') loadAudit()
}
function openTab(id) { switchTab(id) }

function handleEsc() {
  if (editing.value) { editing.value = null; return true }
  return false
}
defineExpose({ handleEsc, openTab })
</script>

<template>
  <div v-if="show" class="modal-mask" @click.self="emit('close')">
    <div class="modal" :class="{ wide: settingsTab === 'groups' && !editing }">
      <div class="modal-head">
        <button v-if="editing" class="back-btn" @click="editing = null" title="返回分组列表"><Icon name="back" :size="13" /></button>
        <strong>{{ editing ? '编辑分组 · ' + (editing.name || '未命名') : '设置' }}</strong>
        <span class="spacer"></span>
        <button class="icon-btn" @click="emit('close')" title="关闭"><Icon name="close" :size="13" /></button>
      </div>

      <!-- 分组编辑 -->
      <div v-if="editing" class="group-form">
        <label><span>分组名称</span><input v-model="editing.name" type="text" placeholder="如：代码审查" /></label>
        <label><span>提示词（作为每次对话前缀）</span><textarea v-model="editing.prompt" rows="4" placeholder="定义该分组的角色、语气、输出格式…"></textarea></label>
        <div class="form-grid">
          <label>
            <span>模型
              <button class="refresh-link" @click="emit('refreshModels')"><Icon name="refresh" :size="11" />刷新</button>
            </span>
            <select v-model="editing.model">
              <option value="">{{ defaultModelLabel() }}</option>
              <option v-if="editing.model && !models.some(m => m.display === editing.model)" :value="editing.model">{{ editing.model }}</option>
              <option v-for="m in models" :key="m.display" :value="m.display">{{ m.display }}</option>
            </select>
            <span v-if="!models.length" class="hint">未获取到模型列表（Pi 未就绪或未配置模型）</span>
          </label>
          <label><span>思考强度</span>
            <select v-model="editing.thinking">
              <option v-for="lv in THINKING_LEVELS" :key="lv" :value="lv">{{ thinkingLabel(lv) }}</option>
            </select>
          </label>
          <label><span>目标语言（翻译类分组用）</span>
            <select v-model="editing.targetLang">
              <option v-for="l in TARGET_LANGS" :key="l" :value="l">{{ l || '不指定' }}</option>
            </select>
          </label>
        </div>
        <label>
          <span>工作文件夹（留空则用全局默认）</span>
          <div class="cwd-row">
            <input v-model="editing.cwd" type="text" :placeholder="`留空 = ${displayCwd('')}`" />
            <button class="mini-btn" @click="pickCwd">选择</button>
          </div>
          <span class="hint accent">当前生效：{{ displayCwd(editing.cwd) }}{{ editing.cwd ? '' : '（默认值）' }}</span>
        </label>
        <div class="perm-section">
          <div class="lean-title">工具权限</div>
          <div class="perm-row">
            <button
              v-for="p in PRESET_LIST" :key="p.id" class="choice"
              :class="{ on: editPreset === p.id, risk: p.id === 'full' && editPreset === 'full' }"
              @click="applyPreset(p.id)"
            >{{ p.label }}</button>
            <span v-if="editPreset === 'custom'" class="choice on custom">自定义</span>
          </div>

          <div class="tool-label">读与搜索</div>
          <div class="tool-chips">
            <label
              v-for="t in TOOL_META.filter(x => !x.risk)" :key="t.id"
              class="tool-chip" :class="{ on: hasTool(t.id) }" :title="t.note"
            >
              <input type="checkbox" :checked="hasTool(t.id)" @change="toggleTool(t.id)" />
              <span>{{ t.label }}</span>
            </label>
          </div>

          <div class="tool-label">写入与执行 <small>勾选后可以改动磁盘或运行命令</small></div>
          <div class="tool-chips">
            <label
              v-for="t in TOOL_META.filter(x => x.risk)" :key="t.id"
              class="tool-chip risk" :class="{ on: hasTool(t.id) }" :title="t.note"
            >
              <input type="checkbox" :checked="hasTool(t.id)" @change="toggleTool(t.id)" />
              <span>{{ t.label }}</span>
            </label>
          </div>

          <span class="hint" :class="{ warn: editHasExec }">工具影响：{{ editRisk.join('、') }}</span>
        </div>

        <div class="ctx-section">
          <div class="lean-title">资源与上下文</div>

          <div class="seg-row">
            <span class="seg-name">MCP</span>
            <div class="seg">
              <button :class="{ on: editTool.mcp === 'off' }" @click="editTool.mcp = 'off'">关</button>
              <button :class="{ on: editTool.mcp === 'all' }" @click="editTool.mcp = 'all'">全部</button>
              <button :class="{ on: editTool.mcp === 'servers' }" @click="editTool.mcp = 'servers'">指定</button>
            </div>
          </div>
          <input
            v-if="editTool.mcp === 'servers'" v-model="editTool.mcpServers" class="mini-input"
            placeholder="server 名，逗号分隔，如 radius, github"
          />

          <div class="seg-row">
            <span class="seg-name">技能</span>
            <div class="seg">
              <button :class="{ on: editTool.skills === 'off' }" @click="editTool.skills = 'off'">关</button>
              <button :class="{ on: editTool.skills === 'all' }" @click="editTool.skills = 'all'">全部</button>
              <button :class="{ on: editTool.skills === 'some' }" @click="editTool.skills = 'some'">指定</button>
            </div>
          </div>
          <div v-if="editTool.skills === 'some'" class="skill-pick">
            <label v-for="s in editSkills" :key="s.name" class="tool-chip" :class="{ on: hasSkill(s.name) }" :title="s.description">
              <input type="checkbox" :checked="hasSkill(s.name)" @change="toggleSkill(s.name)" />
              <span>{{ s.name }}</span>
            </label>
            <span v-if="!editSkills.length" class="hint">未检测到技能</span>
          </div>

          <label class="switch-row">
            <span class="switch-label">扩展<small>加载 ~/.pi 扩展；扩展可自带工具</small></span>
            <input class="switch" type="checkbox" :checked="editTool.ext" @change="editTool.ext = $event.target.checked" />
          </label>
          <label class="switch-row">
            <span class="switch-label">项目规范<small>注入 AGENTS.md / CLAUDE.md</small></span>
            <input class="switch" type="checkbox" :checked="editTool.context" @change="editTool.context = $event.target.checked" />
          </label>
          <label class="switch-row">
            <span class="switch-label">提示词模板<small>加载 prompt templates</small></span>
            <input class="switch" type="checkbox" :checked="editTool.templates" @change="editTool.templates = $event.target.checked" />
          </label>
          <label class="switch-row">
            <span class="switch-label">项目级 .pi 配置<small>项目扩展 / 项目 MCP / 项目技能</small></span>
            <input class="switch" type="checkbox" :checked="editTool.trust" @change="editTool.trust = $event.target.checked" />
          </label>
          <span class="hint">全局 ~/.pi 配置始终生效；项目级配置需要信任，非交互模式不会弹窗</span>
          <div v-if="editContextFiles.length" class="ctx-info">
            检测到规范文件：
            <div v-for="c in editContextFiles" :key="c.path" class="ctx-row">
              <span class="ctx-tag">{{ ctxLabel(c) }}</span>{{ c.path }} · {{ fmtSize(c.size) }}
            </div>
          </div>
          <div v-else class="ctx-info muted">未检测到 AGENTS.md / CLAUDE.md</div>
        </div>
        <div class="form-actions">
          <button v-if="groups.length > 1" class="danger-link" @click="requestDeleteGroup">
            <Icon name="trash" :size="12" />{{ confirmDeleteGroup ? '再点一次确认删除（含该分组会话）' : '删除这个分组' }}
          </button>
          <span class="spacer"></span>
          <button class="mini-btn" @click="editing = null">取消</button>
          <button class="primary-btn" @click="saveGroup">保存</button>
        </div>
      </div>

      <template v-else>
        <div class="tabs">
          <button
            v-for="t in SETTINGS_TABS" :key="t.id" class="tab sub"
            :class="{ active: settingsTab === t.id }" @click="switchTab(t.id)"
          >{{ t.label }}</button>
        </div>

        <div v-if="settingsTab === 'general'" class="pane">
          <div class="field-label">界面布局</div>
          <div class="engine-row">
            <button class="layout-opt" :class="{ on: layout === 'classic' }" @click="emit('setLayout', 'classic')">
              <span>经典<small>左侧栏 + 对话气泡</small></span>
            </button>
            <button class="layout-opt" :class="{ on: layout === 'console' }" @click="emit('setLayout', 'console')">
              <span>控制台<small>顶栏分组 + 转录式对话</small></span>
            </button>
          </div>
          <div class="field-label">运行引擎</div>
          <div class="engine-row">
            <label class="engine-opt">
              <input type="radio" name="engine" value="json" :checked="engine === 'json'" @change="emit('setEngine', 'json')" />
              <span>单次调用 <small>稳定，每次启动约 1.5s；上下文由 pi 落盘，可跨次续接</small></span>
            </label>
            <label class="engine-opt">
              <input type="radio" name="engine" value="rpc" :checked="engine === 'rpc'" @change="emit('setEngine', 'rpc')" />
              <span>长驻预热 <small>更快，打开即预热；上下文仅存内存，进程回收或切换会话后从新开始</small></span>
            </label>
          </div>
          <div class="field-label">默认工作目录</div>
          <div class="cwd-row">
            <input :value="defaultCwd" type="text" placeholder="留空 = MyPiDeck（用户主目录下）" @change="emit('commitDefaultCwd', $event.target.value)" />
            <button class="mini-btn" @click="emit('pickDefaultCwd')">选择</button>
            <button v-if="defaultCwd" class="mini-btn" @click="emit('setDefaultCwd', '')">清除</button>
          </div>
          <span class="hint accent">分组未单独设置时使用：{{ displayCwd('') }}</span>
          <div class="field-label">发送快捷键</div>
          <div class="engine-row">
            <button class="choice" :class="{ on: sendKeyMode === 'enter' }" @click="emit('setSendKeyMode', 'enter')">Enter 发送</button>
            <button class="choice" :class="{ on: sendKeyMode === 'ctrl' }" @click="emit('setSendKeyMode', 'ctrl')">{{ isMac ? 'Cmd' : 'Ctrl' }}+回车 发送</button>
          </div>
          <div class="field-label">数据</div>
          <button class="mini-btn danger" @click="requestClearAll">
            <Icon name="trash" :size="12" />{{ confirmClearAll ? '再点一次确认：清空所有对话' : '清空所有对话' }}
          </button>
          <span class="hint">同时删除 pi 侧的会话文件，无法撤销。</span>
        </div>

        <div v-else-if="settingsTab === 'groups'" class="pane">
          <button v-for="g in groups" :key="g.id" class="g-row" @click="editGroup(g)">
            <span class="g-name">{{ g.name }}</span>
            <span class="g-sum">
              <span v-for="(p, pi) in groupSummary(g)" :key="pi" class="sum-i">{{ p }}</span>
            </span>
            <Icon name="chevron" :size="12" class="g-chev" />
          </button>
          <button class="add-row" @click="addGroup"><Icon name="plus" :size="12" />新建分组</button>
        </div>

        <div v-else-if="settingsTab === 'diag'" class="pane">
          <div class="cfg-status">
            <span class="env-dot" :class="(cfg && cfg.defaultModel) ? 'ok' : 'warn'"></span>
            <div class="cfg-status-text">
              <strong>{{ !cfg ? '读取配置…' : (!cfg.ok ? '配置状态不可用' : (cfg.defaultModel ? '模型已配置' : '还没有默认模型')) }}</strong>
              <div class="hint">
                当前：{{ cfg && cfg.ok && cfg.defaultModel ? `${cfg.defaultProvider || '默认'} / ${cfg.defaultModel}` : '未设置' }}
                <template v-if="cfg && cfg.ok && cfg.defaultThinkingLevel"> · 思考 {{ cfg.defaultThinkingLevel }}</template>
              </div>
            </div>
            <span class="spacer"></span>
            <button class="mini-btn" @click="loadCfg"><Icon name="refresh" :size="12" />刷新</button>
          </div>

          <div v-if="cfg && cfg.parseError" class="env-warn">
            {{ cfg.parseError }}（已保留原文件，修复后重试；本次不会写入配置）
          </div>

          <template v-if="cfg && cfg.ok">
            <div class="field-label">1. 选择服务商</div>
            <div class="form-chips">
              <button
                v-for="p in cfgAllProviders" :key="p.id" class="choice"
                :class="{ on: cfgProvider === p.id }" @click="selectProvider(p.id)"
              >{{ p.name }}</button>
            </div>
            <span v-if="cfgPreset && cfgPreset.note" class="hint">{{ cfgPreset.note }}</span>

            <div class="field-label">2. {{ cfgIsCustom ? '填写端点与密钥' : '粘贴 API Key' }}</div>
            <input
              v-model="cfgKey" class="mini-input" type="password" autocomplete="off"
              :placeholder="cfgProviderInfo && cfgProviderInfo.hasKey ? '已保存（留空保持不变）' : (cfgProviderInfo && cfgProviderInfo.envSet ? '检测到环境变量，可留空' : '粘贴 API Key')"
            />
            <span v-if="cfgProviderInfo && cfgProviderInfo.envSet" class="hint">已检测到环境变量 {{ cfgProviderInfo.env }}（留空即可使用它）</span>
            <span v-else-if="cfgProviderInfo && !cfgProviderInfo.hasKey" class="hint">如果已经在 pi 里登录过该服务商，这里可以留空。</span>
            <span v-if="cfgPreset && cfgPreset.site" class="hint">
              获取 Key：<a href="#" class="env-link" @click.prevent="emit('openLink', cfgPreset.site)">{{ cfgPreset.site }}</a>
            </span>
            <template v-if="cfgIsCustom">
              <input v-model="cfgBaseUrl" class="mini-input" placeholder="Base URL，如 https://api.example.com/v1" />
              <select v-model="cfgApi" class="mini-select">
                <option v-for="a in cfg.apiValues" :key="a" :value="a">{{ a }}</option>
              </select>
            </template>

            <div class="field-label">3. 选择默认模型</div>
            <select v-if="cfgModels.length" v-model="cfgModelId" class="mini-select">
              <option value="">请选择模型</option>
              <option v-for="m in cfgModels" :key="m.model" :value="m.model">{{ m.model }}</option>
              <option v-if="cfgModelId && !cfgModels.some(m => m.model === cfgModelId)" :value="cfgModelId">{{ cfgModelId }}</option>
            </select>
            <input v-else v-model="cfgModelId" class="mini-input" placeholder="模型 ID，如 deepseek-chat" />
            <span class="hint">{{ cfgModels.length ? '列表来自 pi 当前可用的模型' : '还没有可用模型：先保存 Key，或直接手填模型 ID' }}</span>

            <div class="cwd-row">
              <select v-model="cfgThinking" class="mini-select">
                <option v-for="lv in THINKING_LEVELS" :key="lv" :value="lv">{{ lv ? (THINKING_LABELS[lv] || lv) : '思考：保持默认' }}</option>
              </select>
              <button class="mini-btn" @click="loadCfgModels"><Icon name="refresh" :size="12" />刷新模型</button>
            </div>

            <div class="cfg-actions">
              <button class="primary-btn" :disabled="cfgBusy" @click="saveCfg">{{ cfgBusy ? '保存中…' : '保存并设为默认' }}</button>
              <button class="mini-btn" @click="checkCfgAuth">检测凭证</button>
              <button v-if="cfgPreset && !cfgIsCustom" class="mini-btn" @click="terminalLogin">终端登录</button>
              <button v-if="cfgProviderInfo && cfgProviderInfo.hasKey && !cfgIsCustom" class="mini-btn" @click="removeCfgKey">清除密钥</button>
            </div>
            <span v-if="cfgMsg" class="hint accent">{{ cfgMsg }}</span>
            <span v-if="cfgAuth" class="hint" :class="{ warn: cfgAuth.status !== 'ready' }">凭证状态：{{ authLabel(cfgAuth.status) }}</span>
            <span class="hint">保存前会自动备份；密钥写入本机 models.json，不会上传。</span>
          </template>
          <div v-else-if="cfg && !cfg.ok" class="env-warn">{{ cfg.error || '配置模块不可用' }}</div>

          <div class="field-label">运行环境</div>
          <div v-if="envInfo && envInfo.ok" class="env-grid">
            <div class="env-row"><span>Node</span><code>{{ envInfo.nodeVersion || '—' }}</code></div>
            <div class="env-row"><span>pi CLI</span><code>{{ envInfo.piVersion ? 'v' + envInfo.piVersion : '—' }}</code></div>
            <div class="env-row"><span>默认思考</span><code>{{ envInfo.defaultThinking || '—' }}</code></div>
            <div class="env-row"><span>pi 路径</span><code class="path" :title="envInfo.piPath">{{ envInfo.piPath }}</code></div>
          </div>
          <div v-else class="env-warn">未检测到可用的 Pi 环境。点顶部提示按步骤安装。</div>
          <div class="env-configs">
            <div v-for="c in (envInfo && envInfo.configs) || []" :key="c.name" class="env-config-row">
              <span class="env-config-name">{{ c.name }}</span>
              <span class="env-config-label">{{ c.label }}</span>
              <span class="spacer"></span>
              <span class="env-config-state" :class="c.exists ? 'on' : 'off'">{{ c.exists ? fmtSize(c.size) : '未创建' }}</span>
              <button class="mini-btn icon-only" :disabled="!c.exists" @click="emit('openPath', c.path)" title="在文件管理器中定位"><Icon name="external" :size="12" /></button>
            </div>
          </div>
          <div class="env-actions">
            <button class="mini-btn" @click="emit('openPath', envInfo && envInfo.agentDir)"><Icon name="folder" :size="12" />打开配置目录</button>
            <button class="mini-btn" @click="emit('openPath', cfg && cfg.modelsPath)"><Icon name="external" :size="12" />打开 models.json</button>
            <button class="mini-btn" @click="emit('recheckEnv')"><Icon name="refresh" :size="12" />重新检测</button>
          </div>
        </div>

        <div v-else class="pane">
          <div class="audit-summary">
            <span>最近 {{ auditRows.length }} 条</span>
            <span class="audit-stat risk">{{ auditStats.writes }} 次改文件</span>
            <span class="audit-stat risk">{{ auditStats.execs }} 次执行命令</span>
            <span class="spacer"></span>
            <label class="audit-filter"><input type="checkbox" v-model="auditRiskOnly" />只看风险</label>
            <button class="mini-btn" @click="loadAudit"><Icon name="refresh" :size="12" />刷新</button>
          </div>
          <div v-if="!auditVisible.length" class="audit-empty">{{ auditRows.length ? '没有符合条件的记录' : '还没有操作记录' }}</div>
          <div v-else class="audit-list">
            <div v-for="(r, i) in auditVisible" :key="i" class="audit-row" :class="{ risk: isAuditRisk(r) }">
              <span class="audit-time">{{ fmtAuditTime(r.ts) }}</span>
              <span class="audit-kind">{{ auditKind(r) }}</span>
              <span class="audit-desc">{{ r.summary }}</span>
              <span class="audit-group">{{ r.groupName || '' }}</span>
            </div>
          </div>
          <div class="audit-actions">
            <button class="mini-btn" @click="openAuditDir"><Icon name="folder" :size="12" />打开记录目录</button>
            <button class="mini-btn" @click="exportAudit"><Icon name="download" :size="12" />导出 Markdown</button>
            <button class="mini-btn danger" @click="clearAudit">{{ auditConfirmClear ? '再点一次确认清空' : '清空记录' }}</button>
          </div>
          <span class="hint">只保存在本机，不上传；不记录对话全文、完整文件内容与密钥（工具参数/结果仅保留截断摘要）。仅保留最近 30 天。</span>
        </div>
      </template>
    </div>
  </div>
</template>
