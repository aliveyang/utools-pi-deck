<script setup>
// 设置模态框外壳：4 个子 Tab（对话默认 / 分组 / 环境与模型 / 操作记录）
import { ref, nextTick } from 'vue'
import Icon from './Icon.vue'
import SettingsGeneralTab from './SettingsGeneralTab.vue'
import SettingsGroupsTab from './SettingsGroupsTab.vue'
import SettingsModelTab from './SettingsModelTab.vue'
import SettingsAuditTab from './SettingsAuditTab.vue'

defineProps({
  groups: { type: Array, default: () => [] },
  models: { type: Array, default: () => [] },
  skills: { type: Array, default: () => [] },
  defaults: { type: Object, default: () => ({}) },
  envInfo: { type: Object, default: null },
  engine: { type: String, default: 'json' },
  rpcStatus: { type: String, default: '' },
  layout: { type: String, default: 'classic' },
  defaultCwd: { type: String, default: '' },
  sendKeyMode: { type: String, default: 'ctrl' },
  isMac: { type: Boolean, default: false },
  displayCwd: { type: Function, required: true },
  workspaceAuthRev: { type: Number, default: 0 },
})

const emit = defineEmits([
  'close', 'setLayout', 'setEngine', 'setDefaultCwd', 'pickDefaultCwd', 'setSendKeyMode',
  'saveGroup', 'deleteGroup', 'refreshModels', 'openPath', 'recheckEnv', 'installPi',
  'clearAllSessions', 'configSaved', 'notify', 'copyCmd', 'openLink', 'workspaceAuthorized',
])

const SETTINGS_TABS = [
  { id: 'general', label: '对话默认' },
  { id: 'groups', label: '分组' },
  { id: 'diag', label: '环境与模型' },
  { id: 'audit', label: '操作记录' },
]

const settingsTab = ref('general')
const editingGroup = ref(null)
const groupsTabEl = ref(null)

function switchTab(id) {
  settingsTab.value = id
  editingGroup.value = null
}

function openTab(id, opts) {
  settingsTab.value = id
  editingGroup.value = null
  if (id === 'groups' && opts && opts.editGroupId) {
    nextTick(() => {
      groupsTabEl.value && groupsTabEl.value.openGroupById(opts.editGroupId)
    })
  }
}

function handleEsc() {
  if (settingsTab.value === 'groups' && editingGroup.value) {
    groupsTabEl.value && groupsTabEl.value.clearEditing()
    return true
  }
  return false
}

defineExpose({ handleEsc, openTab })
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal" :class="{ wide: settingsTab === 'groups' && !editingGroup }">
      <div class="modal-head">
        <button v-if="editingGroup" class="back-btn" @click="groupsTabEl && groupsTabEl.clearEditing()" title="返回分组列表"><Icon name="back" :size="13" /></button>
        <strong>{{ editingGroup ? '编辑分组 · ' + (editingGroup.name || '未命名') : '设置' }}</strong>
        <span class="spacer"></span>
        <button class="icon-btn" @click="emit('close')" title="关闭"><Icon name="close" :size="13" /></button>
      </div>

      <div v-if="!editingGroup" class="tabs">
        <button
          v-for="t in SETTINGS_TABS" :key="t.id" class="tab sub"
          :class="{ active: settingsTab === t.id }" @click="switchTab(t.id)"
        >{{ t.label }}</button>
      </div>

      <SettingsGeneralTab
        v-if="settingsTab === 'general'"
        :layout="layout"
        :engine="engine"
        :rpc-status="rpcStatus"
        :default-cwd="defaultCwd"
        :send-key-mode="sendKeyMode"
        :is-mac="isMac"
        :display-cwd="displayCwd"
        :workspace-auth-rev="workspaceAuthRev"
        @set-layout="emit('setLayout', $event)"
        @set-engine="emit('setEngine', $event)"
        @set-default-cwd="emit('setDefaultCwd', $event)"
        @pick-default-cwd="emit('pickDefaultCwd')"
        @set-send-key-mode="emit('setSendKeyMode', $event)"
        @clear-all-sessions="emit('clearAllSessions')"
      />

      <SettingsGroupsTab
        v-else-if="settingsTab === 'groups'"
        ref="groupsTabEl"
        :groups="groups"
        :models="models"
        :skills="skills"
        :defaults="defaults"
        :default-cwd="defaultCwd"
        :display-cwd="displayCwd"
        :workspace-auth-rev="workspaceAuthRev"
        @editing-change="editingGroup = $event"
        @save-group="emit('saveGroup', $event)"
        @delete-group="emit('deleteGroup', $event)"
        @refresh-models="emit('refreshModels')"
        @workspace-authorized="emit('workspaceAuthorized')"
      />

      <SettingsModelTab
        v-else-if="settingsTab === 'diag'"
        :env-info="envInfo"
        @config-saved="emit('configSaved')"
        @notify="emit('notify', $event)"
        @copy-cmd="emit('copyCmd', $event)"
        @open-link="emit('openLink', $event)"
        @open-path="emit('openPath', $event)"
        @recheck-env="emit('recheckEnv')"
        @install-pi="emit('installPi')"
      />

      <SettingsAuditTab
        v-else
        @notify="emit('notify', $event)"
        @open-path="emit('openPath', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed; inset: 0; z-index: 10; background: rgba(20, 22, 26, .28);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: min(520px, 94vw); max-height: 88vh; overflow-y: auto;
  background: var(--paper); border: 1px solid var(--line); border-radius: 10px;
  padding: 0 18px 16px;
}
.modal.wide { width: min(560px, 94vw); }
.modal-head {
  position: sticky; top: 0; z-index: 1; background: var(--paper);
  display: flex; align-items: center; gap: 8px; padding: 12px 0 10px;
  border-bottom: 1px solid var(--line); margin-bottom: 14px;
}
.modal-head strong { font-size: 13px; font-weight: 500; }
.back-btn {
  width: 24px; height: 24px; border-radius: 5px; color: var(--ink-2);
  display: flex; align-items: center; justify-content: center; flex: none;
}
.back-btn:hover { background: var(--surface-2); color: var(--ink); }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin: 0 -6px 14px; padding: 0 6px; }
.tab.sub { height: 32px; padding: 0 10px; font-size: 12px; }
.tab.sub.active::after { left: 10px; right: 10px; bottom: -1px; }
</style>
