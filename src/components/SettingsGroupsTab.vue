<script setup>
// 设置 -> 分组管理与编辑（无 lean 遗留，高级资源选项可折叠）
import { ref, computed, watch, onUnmounted } from 'vue'
import { newGroup, PRESET_LIST, PRESET_LABEL, TOOL_PRESETS, TOOL_NAMES, presetOf } from '../groups.js'
import {
  THINKING_LEVELS, THINKING_LABELS, TARGET_LANGS, TOOL_META,
  riskKeysOf, hasExecRisk, editRiskReasons, hasAdvancedOptions, ctxLabel, fmtSize,
} from '../constants.js'
import { useConfirm } from '../composables/useConfirm.js'
import Icon from './Icon.vue'

const props = defineProps({
  groups: { type: Array, default: () => [] },
  models: { type: Array, default: () => [] },
  skills: { type: Array, default: () => [] },
  defaults: { type: Object, default: () => ({}) },
  defaultCwd: { type: String, default: '' },
  displayCwd: { type: Function, required: true },
})

const emit = defineEmits(['saveGroup', 'deleteGroup', 'refreshModels', 'editingChange'])

const editing = ref(null)
const editOrigRiskKeys = ref(new Set())
const editContextFiles = ref([])
const editSkills = ref([])
const showAdvanced = ref(false)
const { isConfirming, confirm, reset } = useConfirm()

watch(editing, val => {
  reset()
  emit('editingChange', val)
})

let envReqSeq = 0
let envDebounceTimer = null

async function refreshEditEnv() {
  if (!editing.value) return
  const seq = ++envReqSeq
  const cwd = editing.value.cwd || props.defaultCwd || ''
  try {
    editContextFiles.value = (window.piBridge && window.piBridge.detectContextFiles)
      ? (window.piBridge.detectContextFiles(cwd) || []) : []
  } catch (_) { editContextFiles.value = [] }
  try {
    if (window.piBridge && window.piBridge.listSkillsAsync) {
      const list = await window.piBridge.listSkillsAsync(cwd)
      if (seq === envReqSeq) editSkills.value = list || []
    } else {
      editSkills.value = props.skills
    }
  } catch (_) {
    if (seq === envReqSeq) editSkills.value = props.skills
  }
}

function scheduleRefreshEditEnv() {
  clearTimeout(envDebounceTimer)
  envDebounceTimer = setTimeout(() => { refreshEditEnv() }, 250)
}

watch(
  [() => editing.value && editing.value.id, () => editing.value && editing.value.cwd, () => props.defaultCwd],
  ([id], [oldId]) => {
    if (!editing.value) return
    if (id !== oldId) {
      clearTimeout(envDebounceTimer)
      refreshEditEnv()
    } else {
      scheduleRefreshEditEnv()
    }
  },
)

onUnmounted(() => { clearTimeout(envDebounceTimer) })

function defaultModelLabel() {
  const d = props.defaults || {}
  const raw = d.modelName || d.modelId
  if (!raw) return '默认（继承 pi 设置）'
  return `默认（${String(raw).split('·')[0].trim()}）`
}
function thinkingLabel(lv) {
  if (!lv) {
    const def = (props.defaults || {}).thinkingLevel
    return def ? `默认（${THINKING_LABELS[def] || def}）` : '默认（继承 pi 设置）'
  }
  return THINKING_LABELS[lv] ? `${THINKING_LABELS[lv]}（${lv}）` : lv
}

function editGroup(g) {
  if (!g) return
  const base = g.tool || TOOL_PRESETS.read
  editOrigRiskKeys.value = riskKeysOf(base)
  editing.value = {
    ...g,
    tool: {
      ...base,
      list: (base.list || []).slice(),
      mcpServers: base.mcpServers || '',
      skillNames: (base.skillNames || []).slice(),
    },
  }
  showAdvanced.value = hasAdvancedOptions(editing.value.tool)
  refreshEditEnv()
}

function openGroupById(id) {
  const g = props.groups.find(x => x.id === id)
  if (g) editGroup(g)
}

function addGroup() {
  editOrigRiskKeys.value = new Set()
  editing.value = newGroup()
  showAdvanced.value = false
  refreshEditEnv()
}

function clearEditing() {
  editing.value = null
  reset()
}

function doSaveGroup() {
  const e = editing.value
  if (!e || !e.name.trim()) return
  const tool = {
    ...(e.tool || TOOL_PRESETS.read),
    list: ((e.tool && e.tool.list) || []).slice(),
    skillNames: ((e.tool && e.tool.skillNames) || []).slice(),
  }
  emit('saveGroup', { ...e, tool })
  editing.value = null
}

function saveGroup() {
  const e = editing.value
  if (!e || !e.name.trim()) return
  const nextKeys = riskKeysOf(e.tool)
  let addedRisk = false
  for (const k of nextKeys) {
    if (!editOrigRiskKeys.value.has(k)) { addedRisk = true; break }
  }
  if (addedRisk) {
    confirm('riskSave', doSaveGroup)
    return
  }
  doSaveGroup()
}

function requestDeleteGroup() {
  if (!editing.value) return
  confirm('delGroup', () => emit('deleteGroup', editing.value))
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
  e.tool = { ...preset, list: preset.list.slice(), mcpServers: '', skillNames: [], trust: false }
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

const editRisk = computed(() => editRiskReasons(editing.value && editing.value.tool))
const editHasExec = computed(() => hasExecRisk(editing.value && editing.value.tool))

const advActiveCount = computed(() => {
  const t = editTool.value
  let n = 0
  if (t.mcp && t.mcp !== 'off') n++
  if (t.skills === 'some') n++
  if (t.ext) n++
  if (t.context) n++
  if (t.templates) n++
  if (t.trust) n++
  return n
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

defineExpose({ openGroupById, clearEditing })
</script>

<template>
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
      <div class="section-title">工具权限</div>
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
      <button type="button" class="adv-toggle" @click="showAdvanced = !showAdvanced">
        <Icon :name="showAdvanced ? 'chevronDown' : 'chevron'" :size="12" />
        <span>高级选项（MCP / 技能 / 扩展 / 项目规范）</span>
        <span v-if="advActiveCount" class="adv-badge">已启用 {{ advActiveCount }} 项</span>
      </button>

      <template v-if="showAdvanced">
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
        <span v-if="editTool.trust" class="hint warn">已启用 --approve，将自动加载工作区内的项目扩展与 MCP，请仅对可信项目开启</span>
        <span v-else class="hint">全局 ~/.pi 配置始终生效；项目级配置默认不自动信任</span>
        <div v-if="editContextFiles.length" class="ctx-info">
          检测到规范文件：
          <div v-for="c in editContextFiles" :key="c.path" class="ctx-row">
            <span class="ctx-tag">{{ ctxLabel(c) }}</span>{{ c.path }} · {{ fmtSize(c.size) }}
          </div>
        </div>
        <div v-else class="ctx-info muted">未检测到 AGENTS.md / CLAUDE.md</div>
      </template>
    </div>

    <div class="form-actions">
      <button v-if="groups.length > 1" class="danger-link" @click="requestDeleteGroup">
        <Icon name="trash" :size="12" />{{ isConfirming('delGroup') ? '再点一次确认删除（含该分组会话）' : '删除这个分组' }}
      </button>
      <span class="spacer"></span>
      <button class="mini-btn" @click="clearEditing">取消</button>
      <button class="primary-btn" :class="{ danger: isConfirming('riskSave') }" @click="saveGroup">
        {{ isConfirming('riskSave') ? '再点一次确认启用高风险权限' : '保存' }}
      </button>
    </div>
  </div>

  <div v-else class="pane">
    <button v-for="g in groups" :key="g.id" class="g-row" @click="editGroup(g)">
      <span class="g-name">{{ g.name }}</span>
      <span class="g-sum">
        <span v-for="(p, pi) in groupSummary(g)" :key="pi" class="sum-i">{{ p }}</span>
      </span>
      <Icon name="chevron" :size="12" class="g-chev" />
    </button>
    <button class="add-row" @click="addGroup"><Icon name="plus" :size="12" />新建分组</button>
  </div>
</template>

<style scoped>
.pane { display: flex; flex-direction: column; gap: 9px; }
.g-row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px;
  width: 100%; text-align: left; padding: 9px 2px; border-bottom: 1px solid var(--line);
}
.g-row:hover { background: var(--surface); }
.g-name { font-size: 12.5px; color: var(--ink); font-weight: 500; }
.g-sum { display: flex; gap: 8px; min-width: 0; overflow: hidden; }
.sum-i {
  font-size: 10.5px; color: var(--ink-3); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; max-width: 150px; flex: none;
}
.sum-i + .sum-i { padding-left: 8px; border-left: 1px solid var(--line); }
.g-chev { color: var(--ink-3); }
.add-row {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  margin-top: 4px; padding: 8px; border-radius: var(--r-sm);
  font-size: 12px; color: var(--accent); background: var(--surface);
}
.add-row:hover { background: var(--accent-soft); }

.group-form { display: flex; flex-direction: column; gap: 11px; }
.group-form label { display: flex; flex-direction: column; gap: 4px; }
.group-form label > span { font-size: 11.5px; color: var(--ink-2); display: flex; align-items: center; gap: 6px; }
.group-form input[type="text"], .group-form textarea, .group-form select {
  border: 1px solid var(--line-2); border-radius: 5px; padding: 6px 8px; font-size: 12px;
  background: var(--raised); color: var(--ink);
}
.group-form input[type="text"]:focus, .group-form textarea:focus, .group-form select:focus {
  outline: 0; border-color: var(--accent);
}
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.form-grid label:first-child { grid-column: 1 / -1; }
.refresh-link { display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; color: var(--accent); margin-left: auto; }
.section-title { font-size: 11.5px; color: var(--ink-2); }

.perm-section { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--line); padding-top: 10px; }
.perm-row { display: flex; flex-wrap: wrap; gap: 6px; }
.perm-row .choice { flex: 1 1 84px; }
.choice.custom { cursor: default; background: var(--surface-2); color: var(--ink-2); }
.tool-label { display: flex; align-items: baseline; gap: 6px; font-size: 10.5px; color: var(--ink-3); margin-top: 2px; }
.tool-label small { font-size: 10px; color: var(--ink-3); }
.tool-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.group-form .tool-chip {
  position: relative; display: inline-flex; flex-direction: row; align-items: center; gap: 0;
  height: 24px; padding: 0 9px; border-radius: 5px; background: var(--surface);
  color: var(--ink-2); font-size: 11.5px; font-family: var(--mono);
  cursor: pointer; user-select: none;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.group-form .tool-chip:hover { background: var(--surface-2); color: var(--ink); }
.group-form .tool-chip.on { background: var(--accent-soft); color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.group-form .tool-chip.risk.on { background: var(--danger-soft); color: var(--danger); box-shadow: inset 0 0 0 1px var(--danger); }
.group-form .tool-chip input { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
.group-form .tool-chip:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
.skill-pick { display: flex; flex-wrap: wrap; gap: 6px; }

.ctx-section { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--line); padding-top: 10px; }
.adv-toggle {
  display: flex; align-items: center; gap: 6px; text-align: left; padding: 4px 0;
  font-size: 11.5px; color: var(--ink-2);
}
.adv-toggle:hover { color: var(--ink); }
.adv-badge {
  margin-left: auto; font-size: 10.5px; padding: 1px 6px; border-radius: 4px;
  background: var(--accent-soft); color: var(--accent);
}
.seg-row { display: flex; align-items: center; gap: 10px; }
.seg-name { font-size: 12px; color: var(--ink); min-width: 32px; }
.seg { display: flex; gap: 2px; background: var(--surface); border-radius: 6px; padding: 2px; }
.seg button { height: 22px; padding: 0 9px; border-radius: 4px; font-size: 11px; color: var(--ink-2); }
.seg button:hover { color: var(--ink); }
.seg button.on { background: var(--raised); color: var(--ink); box-shadow: 0 1px 2px rgba(0, 0, 0, .07); }
.group-form .switch-row {
  flex-direction: row; align-items: center; justify-content: space-between;
  gap: 12px; padding: 4px 0; cursor: pointer;
}
.group-form .switch-label { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; font-size: 12px; color: var(--ink); }
.switch-label small { font-size: 10.5px; color: var(--ink-3); }
.switch {
  appearance: none; -webkit-appearance: none; flex: none; margin: 0;
  width: 30px; height: 18px; border-radius: 9px; background: var(--surface-2);
  position: relative; cursor: pointer; transition: background .16s var(--ease);
}
.switch::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--raised); box-shadow: 0 1px 2px rgba(0, 0, 0, .18);
  transition: transform .16s var(--ease);
}
.switch:checked { background: var(--accent); }
.switch:checked::after { transform: translateX(12px); }

.ctx-info { font-size: 11px; color: var(--ink-2); background: var(--surface); border-radius: 4px; padding: 6px 8px; }
.ctx-info.muted { color: var(--ink-3); }
.ctx-row { margin-top: 3px; word-break: break-all; }
.ctx-tag {
  display: inline-block; background: var(--accent-soft); color: var(--accent);
  border-radius: 3px; padding: 0 4px; margin-right: 4px; font-size: 10px;
}

.group-form .form-actions {
  display: flex; align-items: center; gap: 8px;
  position: sticky; bottom: -16px; z-index: 1;
  margin: 2px -18px -16px; padding: 10px 18px;
  background: var(--paper); border-top: 1px solid var(--line);
}
.danger-link { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ink-3); padding: 3px 4px; border-radius: 4px; }
.danger-link:hover { color: var(--danger); background: var(--danger-soft); }

@media (max-width: 560px) {
  .form-grid { grid-template-columns: 1fr; }
}
</style>
