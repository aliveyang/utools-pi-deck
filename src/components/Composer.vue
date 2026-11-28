<script setup>
// 输入区：高风险确认条、图片/文件附件（粘贴/拖拽/按钮选择）、/ 技能、@ 文件、快捷状态栏
import { ref, computed, nextTick } from 'vue'
import Icon from './Icon.vue'
import StatusReadout from './StatusReadout.vue'

const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i

const props = defineProps({
  variant: { type: String, default: 'classic' },
  modelValue: { type: String, default: '' },
  images: { type: Array, default: () => [] },
  attachedFiles: { type: Array, default: () => [] },
  skills: { type: Array, default: () => [] },
  files: { type: Array, default: () => [] },
  filesLoading: { type: Boolean, default: false },
  activeGroup: { type: Object, required: true },
  models: { type: Array, default: () => [] },
  defaults: { type: Object, default: () => ({}) },
  cwdLabel: { type: String, default: '~' },
  engine: { type: String, default: 'json' },
  rpcStatus: { type: String, default: '' },
  running: { type: Boolean, default: false },
  sendKeyMode: { type: String, default: 'ctrl' },
  isMac: { type: Boolean, default: false },
  pendingRiskConfirm: { type: Boolean, default: false },
  activeRiskSummary: { type: String, default: '' },
})

const emit = defineEmits([
  'update:modelValue', 'send', 'cancel', 'confirmRisk', 'cancelRisk',
  'readImageFile', 'removeImage', 'addFile', 'removeFile',
  'requestFiles', 'preview', 'toggleSendKey',
  'updateGroup', 'pickCwd', 'openGroupSettings', 'notify',
])

const inputEl = ref(null)
const fileInputEl = ref(null)
const dragDepth = ref(0)
const dragging = computed(() => dragDepth.value > 0)
const showSkillMenu = ref(false)
const skillFilter = ref('')
const showFileMenu = ref(false)
const fileFilter = ref('')
const menuIndex = ref(0)

const filteredSkills = computed(() => {
  const q = skillFilter.value.toLowerCase()
  return q ? props.skills.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) : props.skills
})
const filteredFiles = computed(() => {
  const q = fileFilter.value.toLowerCase()
  return q ? props.files.filter(f => f.path.toLowerCase().includes(q)).slice(0, 40) : props.files.slice(0, 40)
})
const menuItems = computed(() =>
  showSkillMenu.value ? filteredSkills.value : showFileMenu.value ? filteredFiles.value : [])

function focusInput(pos) {
  const apply = () => {
    const el = inputEl.value
    if (!el) return
    el.focus()
    if (typeof pos === 'number') el.selectionStart = el.selectionEnd = pos
  }
  apply()
  nextTick(apply)
}
function closeMenus() {
  showSkillMenu.value = false
  showFileMenu.value = false
}
function hasOpenMenu() {
  return showSkillMenu.value || showFileMenu.value
}
defineExpose({ focusInput, closeMenus, hasOpenMenu })

function moveMenu(delta) {
  const n = menuItems.value.length
  if (!n) return
  menuIndex.value = Math.min(n - 1, Math.max(0, menuIndex.value + delta))
  nextTick(() => {
    const el = document.querySelector('.suggest-item.active')
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  })
}

function insertToken(regex, marker, replacement) {
  const el = inputEl.value
  const v = props.modelValue || ''
  const caret = el ? el.selectionStart : v.length
  const before = v.slice(0, caret), after = v.slice(caret)
  const m = regex.exec(before)
  const start = m ? before.indexOf(marker, m.index) : caret
  const prefix = (m && /[\s(（]/.test(before[m.index])) ? before.slice(0, m.index + 1) : before.slice(0, start)
  emit('update:modelValue', `${prefix}${replacement}${after}`)
  closeMenus()
  skillFilter.value = ''
  fileFilter.value = ''
  focusInput((prefix + replacement).length)
}

function insertSkill(skill) {
  insertToken(/(?:^|[\s(（])\/[a-zA-Z0-9-]*$/, '/', `/skill:${skill.name} `)
}
function insertFile(f) {
  insertToken(/(?:^|[\s(（])@[^\s]*$/, '@', `@${f.path} `)
}

function onInput(e) {
  const val = e.target.value
  emit('update:modelValue', val)
  const before = val.slice(0, e.target.selectionStart)
  const skillM = /(?:^|[\s(（])\/([a-zA-Z0-9-]*)$/.exec(before)
  const fileM = /(?:^|[\s(（])@([^\s]*)$/.exec(before)
  if (skillM) {
    showSkillMenu.value = true; showFileMenu.value = false
    skillFilter.value = skillM[1]; menuIndex.value = 0
  } else if (fileM) {
    showFileMenu.value = true; showSkillMenu.value = false
    fileFilter.value = fileM[1]; menuIndex.value = 0
    if (!props.files.length) emit('requestFiles')
  } else {
    closeMenus()
  }
}

function onKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return
  if (showSkillMenu.value || showFileMenu.value) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveMenu(1); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveMenu(-1); return }
    if (e.key === 'Escape') { e.preventDefault(); closeMenus(); return }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      const item = menuItems.value[menuIndex.value]
      if (item) {
        e.preventDefault()
        if (showSkillMenu.value) insertSkill(item)
        else insertFile(item)
        return
      }
    }
  }
  const isCtrl = e.ctrlKey || e.metaKey
  if (props.sendKeyMode === 'enter') {
    if (e.key === 'Enter' && !e.shiftKey && !isCtrl) { e.preventDefault(); emit('send') }
  } else {
    if (e.key === 'Enter' && isCtrl) { e.preventDefault(); emit('send') }
  }
}

function onPaste(e) {
  const items = e.clipboardData && e.clipboardData.items
  if (!items) return
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const file = it.getAsFile()
      if (file) emit('readImageFile', file)
    }
  }
}

function handlePickedBrowserFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    if ((file.type && file.type.startsWith('image/')) || IMAGE_FILE_RE.test(file.name)) {
      emit('readImageFile', file)
    } else if (file.path) {
      emit('notify', '非图片文件需点击回形针按钮通过系统选择器授权，或使用 @ 引用工作区内文件')
    } else {
      emit('notify', '浏览器预览仅支持图片拖拽/粘贴；文件引用请用 @ 或在 uTools 中使用')
    }
  }
}

function onDragEnter() {
  dragDepth.value++
}
function onDragLeave() {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}
function onDrop(e) {
  dragDepth.value = 0
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    handlePickedBrowserFiles(e.dataTransfer.files)
  }
}

function pickAttachments() {
  if (window.piBridge && window.piBridge.pickFiles) {
    const picked = window.piBridge.pickFiles()
    if (Array.isArray(picked)) {
      for (const p of picked) emit('addFile', p)
      return
    }
  }
  if (fileInputEl.value) {
    fileInputEl.value.value = ''
    fileInputEl.value.click()
  }
}

function onBrowserFileChange(e) {
  handlePickedBrowserFiles(e.target.files)
}

const canSend = computed(() => !!(props.modelValue.trim() || props.images.length || props.attachedFiles.length))
</script>

<template>
  <div
    class="composer" :class="['v-' + variant, { dragging }]"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div v-if="pendingRiskConfirm" class="risk-confirm-bar">
      <div class="risk-confirm-text">
        <strong>当前分组启用了高风险权限</strong>：{{ activeRiskSummary }}；工作区：<code>{{ cwdLabel }}</code>
      </div>
      <div class="risk-confirm-actions">
        <button class="mini-btn" @click="emit('cancelRisk')">取消</button>
        <button class="mini-btn danger" @click="emit('confirmRisk')">确认执行</button>
      </div>
    </div>

    <div class="composer-inner">
      <div v-if="images.length || attachedFiles.length" class="attachments">
        <div v-for="(img, i) in images" :key="'i'+i" class="thumb">
          <img :src="img.dataUrl" alt="已粘贴图片" title="点击放大" @click="emit('preview', img.dataUrl)" />
          <button class="thumb-x" aria-label="移除图片" @click="emit('removeImage', i)"><Icon name="close" :size="10" :stroke="2" /></button>
        </div>
        <div v-for="(f, i) in attachedFiles" :key="'f'+i" class="file-chip">
          {{ f.split(/[\\/]/).pop() }}
          <button class="chip-x" aria-label="移除附件" @click="emit('removeFile', i)"><Icon name="close" :size="10" :stroke="2" /></button>
        </div>
      </div>

      <div v-if="showSkillMenu" class="suggest-menu">
        <div class="suggest-head">技能</div>
        <button
          v-for="(s, si) in filteredSkills" :key="s.name" class="suggest-item"
          :class="{ active: si === menuIndex }" @click="insertSkill(s)" @mouseenter="menuIndex = si"
        >
          <span class="suggest-name">/skill:{{ s.name }}</span>
          <span class="suggest-desc">{{ s.description }}</span>
        </button>
        <div v-if="!filteredSkills.length" class="suggest-empty">无匹配技能</div>
      </div>

      <div v-if="showFileMenu" class="suggest-menu">
        <div class="suggest-head">文件<span class="suggest-path">{{ cwdLabel }}</span></div>
        <button
          v-for="(f, fi) in filteredFiles" :key="f.path" class="suggest-item"
          :class="{ active: fi === menuIndex }" @click="insertFile(f)" @mouseenter="menuIndex = fi"
        >
          <span class="suggest-name">{{ f.dir ? '[目录] ' : '' }}{{ f.path }}</span>
        </button>
        <div v-if="!filteredFiles.length" class="suggest-empty">{{ filesLoading ? '正在扫描工作区文件…' : '无匹配文件' }}</div>
      </div>

      <div class="prompt-row">
        <span class="prompt-caret">›</span>
        <textarea
          ref="inputEl" :value="modelValue" class="input" rows="2"
          placeholder="给 pi 发消息，可粘贴/拖拽图片，/ 技能，@ 文件"
          @paste="onPaste" @input="onInput" @keydown="onKeydown"
        />
      </div>

      <div class="composer-bar">
        <input ref="fileInputEl" type="file" accept="image/*" multiple class="hidden-file" @change="onBrowserFileChange" />
        <button type="button" class="attach-btn" title="添加图片或文件" @click="pickAttachments">
          <Icon name="paperclip" :size="13" />
        </button>
        <StatusReadout
          v-if="variant === 'console'"
          variant="composer"
          :group="activeGroup"
          :models="models"
          :defaults="defaults"
          :cwd-label="cwdLabel"
          :engine="engine"
          :rpc-status="rpcStatus"
          :disabled="running"
          @update-group="emit('updateGroup', $event)"
          @pick-cwd="emit('pickCwd')"
          @open-group-settings="emit('openGroupSettings')"
        />
        <span class="spacer"></span>
        <button class="sendkey" @click="emit('toggleSendKey')" title="点击切换发送键">
          {{ sendKeyMode === 'enter' ? 'Enter 发送' : (isMac ? 'Cmd+回车 发送' : 'Ctrl+回车 发送') }}
        </button>
        <button v-if="running" class="send-btn stop" @click="emit('cancel')" title="停止"><Icon name="stop" :size="12" /></button>
        <button v-else class="send-btn" @click="emit('send')" :disabled="!canSend" title="发送"><Icon name="send" :size="14" :stroke="1.9" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer { flex: none; border-top: 1px solid var(--line); padding: 0 24px; transition: border-color .16s var(--ease), background .14s var(--ease); }
.composer:focus-within { border-top-color: var(--line-2); }
.composer.dragging { background: var(--accent-soft); }
.composer-inner { max-width: var(--measure); margin: 0 auto; padding: 13px 0 8px; position: relative; }
.prompt-row { display: grid; grid-template-columns: 20px minmax(0, 1fr); column-gap: 12px; align-items: start; }
.prompt-caret { font-size: 14px; line-height: 1.6; color: var(--accent); font-weight: 500; user-select: none; }
.input {
  width: 100%; border: 0; outline: 0; resize: none; background: transparent;
  font-size: 13.5px; line-height: 1.65; color: var(--ink); min-height: 44px; max-height: 150px; padding: 0;
}
.input::placeholder { color: var(--ink-3); }
.composer-bar { display: flex; align-items: center; gap: 6px; padding: 2px 0 0 28px; min-height: 26px; }
.hidden-file { display: none; }
.attach-btn {
  width: 24px; height: 24px; border-radius: 5px; color: var(--ink-3);
  display: flex; align-items: center; justify-content: center; flex: none;
}
.attach-btn:hover { background: var(--surface); color: var(--ink); }
.sendkey { font-size: 11px; color: var(--ink-3); padding: 2px 4px; border-radius: 4px; white-space: nowrap; }
.sendkey:hover { color: var(--ink-2); background: var(--surface); }
.send-btn {
  width: 26px; height: 26px; border-radius: 7px; background: var(--accent); color: var(--on-accent);
  display: flex; align-items: center; justify-content: center; flex: none;
  transition: background .15s var(--ease), transform .12s var(--ease);
}
.send-btn:hover:not(:disabled) { background: var(--accent-strong); }
.send-btn:active:not(:disabled) { transform: scale(.94); }
.send-btn:disabled { background: var(--surface-2); color: var(--ink-3); cursor: default; }
.send-btn.stop { background: var(--danger); color: var(--paper); }

.attachments { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; padding-left: 32px; }
.thumb { position: relative; width: 44px; height: 44px; border: 1px solid var(--line-2); border-radius: 6px; overflow: hidden; }
.thumb img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
.thumb-x {
  position: absolute; top: -3px; right: -3px; width: 15px; height: 15px; border-radius: 50%;
  background: var(--ink); color: var(--paper); display: flex; align-items: center; justify-content: center;
}
.file-chip {
  display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line-2);
  border-radius: 13px; padding: 3px 8px; font-size: 11px; color: var(--ink-2); max-width: 180px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chip-x {
  width: 14px; height: 14px; border-radius: 50%; color: var(--ink-3);
  display: inline-flex; align-items: center; justify-content: center; flex: none;
}
.chip-x:hover { color: var(--danger); }

.suggest-menu {
  position: absolute; left: 32px; right: 0; bottom: calc(100% - 4px); max-height: 232px; overflow-y: auto;
  background: var(--raised); border: 1px solid var(--line-2); border-radius: var(--r);
  z-index: 5; padding: 4px;
}
.suggest-head { padding: 4px 8px 6px; font-size: 10.5px; color: var(--ink-3); display: flex; align-items: baseline; gap: 8px; }
.suggest-path { font-family: var(--mono); font-size: 10px; color: var(--ink-3); opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.suggest-item { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; padding: 6px 8px; border-radius: 5px; }
.suggest-item.active, .suggest-item:hover { background: var(--surface); }
.suggest-item.active .suggest-name { color: var(--accent); }
.suggest-name { font-size: 12px; font-family: var(--mono); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.suggest-desc { font-size: 11px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.suggest-empty { padding: 10px; font-size: 11px; color: var(--ink-3); text-align: center; }

.risk-confirm-bar {
  max-width: var(--measure); margin: 8px auto 0; padding: 7px 10px;
  border-radius: var(--r-sm); border: 1px solid var(--warn-line); background: var(--warn-soft);
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  font-size: 11.5px; color: var(--warn-ink);
}
.risk-confirm-text { min-width: 0; line-height: 1.45; }
.risk-confirm-text code { font-size: 11px; color: var(--ink); word-break: break-all; }
.risk-confirm-actions { display: flex; gap: 6px; flex: none; }

/* 经典布局：盒式输入框 */
.composer.v-classic { padding: 10px 18px 14px; }
.composer.v-classic .risk-confirm-bar { max-width: none; margin: 0 0 8px; }
.composer.v-classic .composer-inner {
  max-width: none; padding: 9px 11px 7px; border: 1px solid var(--line-2);
  border-radius: 10px; background: var(--paper);
  transition: border-color .16s var(--ease), box-shadow .16s var(--ease);
}
.composer.v-classic .composer-inner:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.composer.v-classic .prompt-row { display: block; }
.composer.v-classic .prompt-caret { display: none; }
.composer.v-classic .input { font-size: 13px; min-height: 42px; }
.composer.v-classic .composer-bar { padding-left: 0; margin-top: 4px; }
.composer.v-classic .attachments { padding-left: 0; }
.composer.v-classic .suggest-menu { left: 0; bottom: calc(100% + 6px); }

@media (max-width: 720px) {
  .composer { padding: 0 16px; }
  .composer.v-classic { padding: 8px 14px 12px; }
  .suggest-menu { left: 0; }
  .attachments { padding-left: 0; }
  .composer-bar { padding-left: 0; }
}
@media (max-width: 560px) {
  .sendkey { display: none; }
}
</style>
