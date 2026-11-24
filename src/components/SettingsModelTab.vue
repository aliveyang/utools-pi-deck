<script setup>
// 设置 -> 环境与模型（多服务商预设、多自定义端点、终端一键安装、手动指定 Node/pi 路径）
import { ref, computed, onMounted } from 'vue'
import { THINKING_LEVELS, THINKING_LABELS, fmtSize } from '../constants.js'
import Icon from './Icon.vue'

defineProps({
  envInfo: { type: Object, default: null },
})

const emit = defineEmits(['configSaved', 'notify', 'copyCmd', 'openLink', 'openPath', 'recheckEnv', 'installPi'])

const cfg = ref(null)
const cfgProvider = ref('')
const cfgCustomId = ref('')
const cfgCustomName = ref('')
const cfgKey = ref('')
const cfgBaseUrl = ref('')
const cfgApi = ref('openai-completions')
const cfgModelId = ref('')
const cfgThinking = ref('')
const cfgModels = ref([])
const cfgBusy = ref(false)
const cfgMsg = ref('')
const cfgAuth = ref(null)

// 手动路径覆盖（免改系统环境变量重启）
const showPathConfig = ref(false)
const nodeOverride = ref('')
const piCliOverride = ref('')

const cfgAllProviders = computed(() => {
  const st = cfg.value
  if (!st || !st.ok) return []
  const presets = (st.presets || []).map(p => ({ ...p, preset: !p.isCustomTemplate }))
  const extra = (st.providers || [])
    .filter(p => !p.preset && p.id !== 'custom')
    .map(p => ({
      id: p.id, name: p.name || p.id, builtin: false, preset: false,
      baseUrl: p.baseUrl || '', api: p.api || 'openai-completions',
      env: '', site: '', note: '已保存的自定义端点', oauth: false,
    }))
  const templateIdx = presets.findIndex(p => p.isCustomTemplate)
  if (templateIdx >= 0) {
    const tpl = presets[templateIdx]
    return [...presets.slice(0, templateIdx), ...extra, tpl]
  }
  return [...presets, ...extra]
})

const cfgPreset = computed(() => cfgAllProviders.value.find(p => p.id === cfgProvider.value) || null)
const cfgIsCustomTemplate = computed(() => !!(cfgPreset.value && cfgPreset.value.isCustomTemplate))
const cfgIsBuiltin = computed(() => !!(cfgPreset.value && cfgPreset.value.builtin))
const cfgNeedsEndpoint = computed(() => !cfgIsBuiltin.value)
const cfgProviderInfo = computed(() => ((cfg.value && cfg.value.providers) || []).find(p => p.id === cfgProvider.value) || null)

// 合并 pi --list-models 发现的模型与预设推荐模型（方便兼容接口即选即用）
const mergedModels = computed(() => {
  const seen = new Set()
  const out = []
  for (const m of cfgModels.value) {
    if (m && m.model && !seen.has(m.model)) { seen.add(m.model); out.push(m.model) }
  }
  const info = cfgProviderInfo.value
  for (const id of ((info && info.models) || [])) {
    if (id && !seen.has(id)) { seen.add(id); out.push(id) }
  }
  for (const id of ((info && info.suggestedModels) || [])) {
    if (id && !seen.has(id)) { seen.add(id); out.push(id) }
  }
  return out
})

function loadPathOverrides() {
  if (!window.piBridge || !window.piBridge.getConfig) return
  try {
    const c = window.piBridge.getConfig() || {}
    nodeOverride.value = c.nodePath || ''
    piCliOverride.value = c.piCliPath || ''
    if (nodeOverride.value || piCliOverride.value) showPathConfig.value = true
  } catch (_) {}
}

function loadCfg() {
  loadPathOverrides()
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
    syncProviderFields()
    loadCfgModels()
  } catch (e) {
    cfg.value = { ok: false, error: String(e.message || e) }
  }
}

function syncProviderFields() {
  const info = cfgProviderInfo.value
  const preset = cfgPreset.value
  if (cfgIsCustomTemplate.value) {
    cfgCustomId.value = ''
    cfgCustomName.value = ''
    cfgBaseUrl.value = ''
    cfgApi.value = 'openai-completions'
    return
  }
  cfgBaseUrl.value = (info && info.baseUrl) || (preset && preset.baseUrl) || ''
  cfgApi.value = (info && info.api) || (preset && preset.api) || 'openai-completions'
}

async function loadCfgModels() {
  if (!window.piBridge || !window.piBridge.listModelsAsync) return
  const requestedId = cfgIsCustomTemplate.value ? cfgCustomId.value.trim() : cfgProvider.value
  try {
    const all = await window.piBridge.listModelsAsync()
    const currentId = cfgIsCustomTemplate.value ? cfgCustomId.value.trim() : cfgProvider.value
    if (requestedId !== currentId) return
    cfgModels.value = currentId ? (all || []).filter(m => m.provider === currentId) : []
    if (!cfgModelId.value && !cfgIsCustomTemplate.value && mergedModels.value.length) {
      cfgModelId.value = mergedModels.value[0]
    }
  } catch (_) {
    const currentId = cfgIsCustomTemplate.value ? cfgCustomId.value.trim() : cfgProvider.value
    if (requestedId === currentId) cfgModels.value = []
  }
}

function selectProvider(id) {
  cfgProvider.value = id
  cfgModels.value = []
  cfgKey.value = ''
  cfgAuth.value = null
  cfgMsg.value = ''
  cfgModelId.value = ''
  syncProviderFields()
  if (!cfgIsCustomTemplate.value && mergedModels.value.length) {
    cfgModelId.value = mergedModels.value[0]
  }
  loadCfgModels()
}

async function saveCfg() {
  if (!window.piBridge || !window.piBridge.configSave) return
  const targetProvider = cfgIsCustomTemplate.value ? cfgCustomId.value.trim() : cfgProvider.value
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(targetProvider) || targetProvider === 'custom') {
    cfgMsg.value = '请填写合法的服务商标识（字母、数字、横线或下划线，如 my-relay）'
    return
  }
  const modelId = (cfgModelId.value || '').trim()
  if (!modelId) { cfgMsg.value = '请先选择或填写默认模型 ID'; return }
  cfgBusy.value = true
  cfgMsg.value = ''
  try {
    const r = await window.piBridge.configSave({
      provider: targetProvider,
      name: cfgIsCustomTemplate.value
        ? (cfgCustomName.value.trim() || targetProvider)
        : ((cfgProviderInfo.value && cfgProviderInfo.value.name) || (cfgPreset.value && cfgPreset.value.name)),
      apiKey: cfgKey.value,
      baseUrl: cfgNeedsEndpoint.value ? cfgBaseUrl.value : '',
      api: cfgNeedsEndpoint.value ? cfgApi.value : '',
      modelId,
      modelName: modelId,
      thinking: cfgThinking.value,
      setDefault: true,
    })
    if (!r || !r.ok) { cfgMsg.value = (r && r.error) || '保存失败'; return }
    cfgKey.value = ''
    cfg.value = r.state || window.piBridge.configState()
    if (cfgIsCustomTemplate.value) cfgProvider.value = targetProvider
    cfgMsg.value = `已保存，默认模型：${targetProvider} / ${modelId}`
    if (r.warnings && r.warnings.length) cfgMsg.value += `（提示：${r.warnings.join('；')}）`
    emit('configSaved')
    emit('notify', '模型配置已保存，下一条消息生效')
    cfgAuth.value = await window.piBridge.configAuthCheck(targetProvider)
  } catch (e) {
    cfgMsg.value = String(e.message || e)
  } finally {
    cfgBusy.value = false
  }
}

async function checkCfgAuth() {
  if (!window.piBridge || !window.piBridge.configAuthCheck) return
  const targetId = cfgIsCustomTemplate.value ? cfgCustomId.value.trim() : cfgProvider.value
  if (!targetId) return
  cfgAuth.value = { status: 'checking' }
  try { cfgAuth.value = await window.piBridge.configAuthCheck(targetId) }
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
  if (!provider || !cfgIsBuiltin.value) return
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

function browseExec(kind) {
  if (!window.piBridge || !window.piBridge.pickExecutable) return
  const picked = window.piBridge.pickExecutable(kind)
  if (!picked) return
  if (kind === 'node') nodeOverride.value = picked
  else piCliOverride.value = picked
}

function applyPathOverrides() {
  if (!window.piBridge || !window.piBridge.setConfig) return
  window.piBridge.setConfig({
    nodePath: nodeOverride.value.trim(),
    piCliPath: piCliOverride.value.trim(),
  })
  emit('recheckEnv')
}

function clearKeyDraft() {
  cfgKey.value = ''
}

onMounted(loadCfg)
defineExpose({ loadCfg, clearKeyDraft })
</script>

<template>
  <div class="pane">
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

      <template v-if="cfgIsCustomTemplate">
        <div class="cwd-row">
          <input v-model="cfgCustomId" class="mini-input" placeholder="端点标识（英文/数字，如 my-relay）" />
          <input v-model="cfgCustomName" class="mini-input" placeholder="显示名称（如 公司网关）" />
        </div>
      </template>

      <div class="field-label">2. {{ cfgNeedsEndpoint ? '填写密钥与端点' : '粘贴 API Key' }}</div>
      <input
        v-model="cfgKey" class="mini-input" type="password" autocomplete="off"
        :placeholder="cfgProviderInfo && cfgProviderInfo.hasKey ? '已保存（留空保持不变）'
          : (cfgProviderInfo && cfgProviderInfo.optionalKey ? '本机 Ollama 可留空'
          : (cfgProviderInfo && cfgProviderInfo.envSet ? '检测到环境变量，可留空' : '粘贴 API Key'))"
      />
      <span v-if="cfgProviderInfo && cfgProviderInfo.envSet" class="hint">已检测到环境变量 {{ cfgProviderInfo.env }}（留空即可使用它）</span>
      <span v-else-if="cfgProviderInfo && !cfgProviderInfo.hasKey && cfgIsBuiltin" class="hint">如果已经在 pi 里登录过该服务商，这里可以留空。</span>
      <span v-if="cfgPreset && cfgPreset.site" class="hint">
        官网/Key：<a href="#" class="env-link" @click.prevent="emit('openLink', cfgPreset.site)">{{ cfgPreset.site }}</a>
      </span>

      <template v-if="cfgNeedsEndpoint">
        <input v-model="cfgBaseUrl" class="mini-input" placeholder="Base URL，如 https://api.example.com/v1" />
        <select v-model="cfgApi" class="mini-select">
          <option v-for="a in cfg.apiValues" :key="a" :value="a">{{ a }}</option>
        </select>
      </template>

      <div class="field-label">3. 选择默认模型</div>
      <template v-if="mergedModels.length">
        <select v-model="cfgModelId" class="mini-select">
          <option value="">请选择推荐/可用模型</option>
          <option v-for="m in mergedModels" :key="m" :value="m">{{ m }}</option>
          <option v-if="cfgModelId && !mergedModels.includes(cfgModelId)" :value="cfgModelId">{{ cfgModelId }}</option>
        </select>
      </template>
      <input v-model="cfgModelId" class="mini-input" placeholder="或直接输入任意模型 ID，如 deepseek-chat" />

      <div class="cwd-row">
        <select v-model="cfgThinking" class="mini-select">
          <option v-for="lv in THINKING_LEVELS" :key="lv" :value="lv">{{ lv ? (THINKING_LABELS[lv] || lv) : '思考：保持默认' }}</option>
        </select>
        <button class="mini-btn" @click="loadCfgModels"><Icon name="refresh" :size="12" />刷新模型</button>
      </div>

      <div class="cfg-actions">
        <button class="primary-btn" :disabled="cfgBusy" @click="saveCfg">{{ cfgBusy ? '保存中…' : '保存并设为默认' }}</button>
        <button class="mini-btn" @click="checkCfgAuth">检测凭证</button>
        <button v-if="cfgIsBuiltin" class="mini-btn" @click="terminalLogin">终端登录</button>
        <button v-if="cfgProviderInfo && cfgProviderInfo.hasKey && !cfgIsCustomTemplate" class="mini-btn" @click="removeCfgKey">清除密钥</button>
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
    <div v-else class="env-warn">
      未检测到可用的 Pi 环境。
      <button v-if="envInfo && envInfo.nodePath" class="mini-btn" @click="emit('installPi')"><Icon name="terminal" :size="12" />终端一键安装 pi</button>
    </div>

    <button type="button" class="adv-toggle" @click="showPathConfig = !showPathConfig">
      <Icon :name="showPathConfig ? 'chevronDown' : 'chevron'" :size="12" />
      <span>手动指定 Node / pi 路径（免改环境变量重启）</span>
    </button>
    <div v-if="showPathConfig" class="path-box">
      <div class="cwd-row">
        <input v-model="nodeOverride" class="mini-input" placeholder="Node 可执行文件路径（留空自动探测）" />
        <button class="mini-btn" @click="browseExec('node')">浏览</button>
      </div>
      <div class="cwd-row">
        <input v-model="piCliOverride" class="mini-input" placeholder="pi cli.js 路径（留空自动探测）" />
        <button class="mini-btn" @click="browseExec('pi')">浏览</button>
      </div>
      <div class="env-actions">
        <button class="mini-btn" @click="applyPathOverrides">应用并重新检测</button>
      </div>
    </div>

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
</template>

<style scoped>
.pane { display: flex; flex-direction: column; gap: 9px; }
.field-label { font-size: 11px; color: var(--ink-3); margin-top: 6px; }
.field-label:first-child { margin-top: 0; }
.cfg-status {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  background: var(--surface); border-radius: var(--r-sm);
}
.cfg-status-text { display: flex; flex-direction: column; gap: 1px; }
.cfg-status-text strong { font-size: 12px; font-weight: 500; }
.env-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }
.env-dot.warn { background: var(--warn-ink); }
.env-dot.ok { background: var(--accent); }
.form-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.form-chips .choice { flex: 0 1 auto; padding: 0 10px; }
.mini-select {
  width: 100%; border: 1px solid var(--line-2); border-radius: 5px; padding: 5px 8px;
  font-size: 11.5px; background: var(--raised); color: var(--ink); outline: 0;
}
.mini-select:focus { border-color: var(--accent); }
.cwd-row .mini-select { flex: 1; width: auto; }
.cfg-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.env-link { color: var(--accent); text-decoration: underline; }
.env-grid { display: flex; flex-direction: column; gap: 4px; }
.env-row { display: flex; gap: 8px; font-size: 12px; align-items: baseline; }
.env-row > span:first-child { color: var(--ink-2); min-width: 64px; flex: none; }
.env-row code { color: var(--ink); font-size: 11px; word-break: break-all; }
.env-row code.path { color: var(--ink-2); }
.env-warn { font-size: 12px; color: var(--danger); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.adv-toggle { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--ink-2); padding: 4px 0; text-align: left; }
.adv-toggle:hover { color: var(--ink); }
.path-box { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); }
.env-configs { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.env-config-row { display: flex; align-items: center; gap: 6px; padding: 5px 8px; font-size: 11px; border-top: 1px solid var(--line); }
.env-config-row:first-child { border-top: 0; }
.env-config-name { font-family: var(--mono); color: var(--ink); min-width: 88px; }
.env-config-label { color: var(--ink-3); }
.env-config-state.on { color: var(--ink-2); }
.env-config-state.off { color: var(--ink-3); }
.env-actions { display: flex; gap: 6px; flex-wrap: wrap; }
</style>
