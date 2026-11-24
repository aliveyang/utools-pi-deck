<script setup>
// 状态读数与快捷切换栏（经典布局顶条 & 控制台布局输入底栏共用）
import { computed } from 'vue'
import { PRESET_LABEL, presetOf } from '../groups.js'
import { THINKING_LEVELS, THINKING_LABELS, TARGET_LANGS, hasExecRisk, toolSummary } from '../constants.js'

const props = defineProps({
  variant: { type: String, default: 'composer' }, // composer | header
  group: { type: Object, required: true },
  models: { type: Array, default: () => [] },
  defaults: { type: Object, default: () => ({}) },
  cwdLabel: { type: String, default: '~' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update-group', 'pick-cwd', 'open-group-settings'])

const permLabel = computed(() => PRESET_LABEL[presetOf(props.group && props.group.tool)] || '自定义')
const risky = computed(() => hasExecRisk(props.group && props.group.tool))
const permTitle = computed(() => `${toolSummary(props.group && props.group.tool)}（点击修改分组权限）`)

const defaultModelText = computed(() => {
  const raw = (props.defaults && (props.defaults.modelName || props.defaults.modelId)) || ''
  return raw ? `默认 (${String(raw).split('·')[0].trim()})` : '默认模型'
})

const defaultThinkText = computed(() => {
  const lv = (props.defaults || {}).thinkingLevel
  return lv ? `默认 (${THINKING_LABELS[lv] || lv})` : '默认思考'
})

const showLang = computed(() => props.group && (props.group.kind === 'translate' || !!props.group.targetLang))

function onSelect(field, e) {
  emit('update-group', { [field]: e.target.value })
}
</script>

<template>
  <div class="readout" :class="'v-' + variant">
    <button
      type="button" class="ro-btn ro-perm" :class="{ risky }" :title="permTitle"
      :disabled="disabled" @click="emit('open-group-settings')"
    >{{ permLabel }}</button>

    <template v-if="showLang">
      <span class="ro-sep"></span>
      <select
        class="ro-select" :value="group.targetLang || ''" :disabled="disabled"
        title="快速切换目标语言" @change="onSelect('targetLang', $event)"
      >
        <option v-for="l in TARGET_LANGS" :key="l" :value="l">{{ l || '不限语言' }}</option>
      </select>
    </template>

    <span class="ro-sep"></span>
    <select
      class="ro-select ro-model" :value="group.model || ''" :disabled="disabled"
      title="快速切换本分组模型" @change="onSelect('model', $event)"
    >
      <option value="">{{ defaultModelText }}</option>
      <option v-if="group.model && !models.some(m => m.display === group.model)" :value="group.model">{{ group.model }}</option>
      <option v-for="m in models" :key="m.display" :value="m.display">{{ m.display }}</option>
    </select>

    <span class="ro-sep"></span>
    <select
      class="ro-select" :value="group.thinking || ''" :disabled="disabled"
      title="快速切换思考强度" @change="onSelect('thinking', $event)"
    >
      <option v-for="lv in THINKING_LEVELS" :key="lv" :value="lv">
        {{ lv ? (THINKING_LABELS[lv] || lv) : defaultThinkText }}
      </option>
    </select>

    <span class="ro-sep ro-path-sep"></span>
    <button
      type="button" class="ro-btn ro-path" :disabled="disabled"
      :title="`工作目录：${cwdLabel}（点击快速切换）`" @click="emit('pick-cwd')"
    >{{ cwdLabel }}</button>
  </div>
</template>

<style scoped>
.readout { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 11px; color: var(--ink-3); }
.ro-sep { width: 1px; height: 10px; background: var(--line-2); flex: none; }
.ro-btn, .ro-select {
  border: 0; background: transparent; color: var(--ink-2); font-size: 11px;
  padding: 2px 5px; border-radius: 4px; max-width: 155px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.ro-btn:hover:not(:disabled), .ro-select:hover:not(:disabled) {
  background: var(--surface); color: var(--ink);
}
.ro-btn:disabled, .ro-select:disabled { opacity: .55; cursor: default; }
.ro-select { cursor: pointer; outline: 0; max-width: 165px; }
.ro-select option { background: var(--paper); color: var(--ink); }
.ro-model, .ro-path { font-family: var(--mono); }
.ro-path { color: var(--ink-3); max-width: 185px; }
.ro-perm.risky { color: var(--danger); }

@media (max-width: 720px) {
  .ro-path, .ro-path-sep { display: none; }
}
@media (max-width: 560px) {
  .ro-btn, .ro-select { max-width: 110px; }
}
</style>
