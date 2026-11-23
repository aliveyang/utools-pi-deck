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
])

const SETTINGS_TABS = [
  { id: 'general', label: '对话默认' },
  { id: 'groups', label: '分组' },
  { id: 'diag', label: '诊断' },
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

function handleEsc() {
  if (editing.value) { editing.value = null; return true }
  return false
}
defineExpose({ handleEsc })
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
          <button v-if="groups.length > 1" class="danger-link" @click="emit('deleteGroup', editing)"><Icon name="trash" :size="12" />删除这个分组</button>
          <span class="spacer"></span>
          <button class="mini-btn" @click="editing = null">取消</button>
          <button class="primary-btn" @click="saveGroup">保存</button>
        </div>
      </div>

      <template v-else>
        <div class="tabs">
          <button
            v-for="t in SETTINGS_TABS" :key="t.id" class="tab sub"
            :class="{ active: settingsTab === t.id }" @click="settingsTab = t.id"
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

        <div v-else class="pane">
          <div v-if="envInfo && envInfo.ok" class="env-grid">
            <div class="env-row"><span>Node</span><code>{{ envInfo.nodeVersion || '—' }}</code></div>
            <div class="env-row"><span>pi CLI</span><code>{{ envInfo.piVersion ? 'v' + envInfo.piVersion : '—' }}</code></div>
            <div class="env-row"><span>默认模型</span><code>{{ envInfo.defaultModel || '—' }}</code></div>
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
            <button class="mini-btn" @click="emit('recheckEnv')"><Icon name="refresh" :size="12" />重新检测</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
