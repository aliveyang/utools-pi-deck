<script setup>
// 设置 -> 对话默认（界面布局、响应模式、默认工作目录、发送快捷键、清空对话）
import { computed } from 'vue'
import { useConfirm } from '../composables/useConfirm.js'
import Icon from './Icon.vue'

const props = defineProps({
  layout: { type: String, default: 'classic' },
  engine: { type: String, default: 'json' },
  rpcStatus: { type: String, default: '' },
  defaultCwd: { type: String, default: '' },
  sendKeyMode: { type: String, default: 'ctrl' },
  isMac: { type: Boolean, default: false },
  displayCwd: { type: Function, required: true },
  workspaceAuthRev: { type: Number, default: 0 },
})

const emit = defineEmits([
  'setLayout', 'setEngine', 'setDefaultCwd',
  'pickDefaultCwd', 'setSendKeyMode', 'clearAllSessions',
])

const { isConfirming, confirm } = useConfirm()

const defaultCwdApproved = computed(() => {
  void props.workspaceAuthRev
  if (!props.defaultCwd) return true
  if (!window.piBridge || typeof window.piBridge.isWorkspaceApproved !== 'function') return true
  return window.piBridge.isWorkspaceApproved(props.defaultCwd)
})

function rpcBadgeText(status) {
  if (status === 'ready') return '后台已预热'
  if (status === 'warming') return '正在预热…'
  if (status === 'failed') return '预热失败（自动回退标准模式）'
  return ''
}
</script>

<template>
  <div class="pane">
    <div class="field-label">界面布局</div>
    <div class="engine-row">
      <button class="layout-opt" :class="{ on: layout === 'classic' }" @click="emit('setLayout', 'classic')">
        <span>经典<small>左侧栏 + 对话气泡</small></span>
      </button>
      <button class="layout-opt" :class="{ on: layout === 'console' }" @click="emit('setLayout', 'console')">
        <span>控制台<small>顶栏分组 + 转录式对话</small></span>
      </button>
    </div>

    <div class="field-label">响应模式</div>
    <div class="engine-row">
      <label class="engine-opt">
        <input type="radio" name="engine" value="json" :checked="engine === 'json'" @change="emit('setEngine', 'json')" />
        <span>标准模式（默认）<small>稳定可靠，历史对话支持跨次续接，每次约 1.5s 启动</small></span>
      </label>
      <label class="engine-opt">
        <input type="radio" name="engine" value="rpc" :checked="engine === 'rpc'" @change="emit('setEngine', 'rpc')" />
        <span>
          极速模式
          <em v-if="engine === 'rpc' && rpcBadgeText(rpcStatus)" class="rpc-tag" :class="rpcStatus">{{ rpcBadgeText(rpcStatus) }}</em>
          <small>打开即预热几乎零等待；仅保持当前连续对话，退出或切换后从新开始</small>
        </span>
      </label>
    </div>

    <div class="field-label">默认工作目录</div>
    <div class="cwd-row">
      <input :value="defaultCwd" type="text" readonly placeholder="留空 = MyPiDeck（用户主目录下）" />
      <button class="mini-btn" @click="emit('pickDefaultCwd')">选择</button>
      <button v-if="defaultCwd" class="mini-btn" @click="emit('setDefaultCwd', '')">清除</button>
    </div>
    <span v-if="!defaultCwdApproved" class="hint warn">该目录尚未在本机授权（可能来自云同步或旧配置），请点击「选择」重新授权后再发送。</span>
    <span v-else class="hint accent">分组未单独设置时使用：{{ displayCwd('') }}</span>

    <div class="field-label">发送快捷键</div>
    <div class="engine-row">
      <button class="choice" :class="{ on: sendKeyMode === 'enter' }" @click="emit('setSendKeyMode', 'enter')">Enter 发送</button>
      <button class="choice" :class="{ on: sendKeyMode === 'ctrl' }" @click="emit('setSendKeyMode', 'ctrl')">{{ isMac ? 'Cmd' : 'Ctrl' }}+回车 发送</button>
    </div>

    <div class="field-label">数据</div>
    <button class="mini-btn danger" @click="confirm('clearAll', () => emit('clearAllSessions'))">
      <Icon name="trash" :size="12" />{{ isConfirming('clearAll') ? '再点一次确认：清空所有对话' : '清空所有对话' }}
    </button>
    <span class="hint">同时删除本机 pi 会话记录文件，无法撤销。</span>
  </div>
</template>

<style scoped>
.pane { display: flex; flex-direction: column; gap: 9px; }
.field-label { font-size: 11px; color: var(--ink-3); margin-top: 6px; }
.field-label:first-child { margin-top: 0; }
.engine-row { display: flex; gap: 8px; }
.engine-opt {
  flex: 1; display: flex; align-items: flex-start; gap: 6px; cursor: pointer;
  padding: 8px 9px; border-radius: var(--r-sm); background: var(--surface);
  transition: background .14s var(--ease), box-shadow .14s var(--ease);
}
.engine-opt:has(input:checked) { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.engine-opt span { font-size: 12px; color: var(--ink); }
.engine-opt small { display: block; font-size: 10.5px; color: var(--ink-3); margin-top: 2px; line-height: 1.4; }
.rpc-tag {
  font-style: normal; font-size: 10px; margin-left: 5px; padding: 0 5px; border-radius: 4px;
  background: var(--surface-2); color: var(--ink-2);
}
.rpc-tag.ready { background: var(--ok-soft); color: var(--accent); }
.rpc-tag.failed { background: var(--danger-soft); color: var(--danger); }
.layout-opt {
  flex: 1; text-align: left; padding: 8px 9px; border-radius: var(--r-sm); background: var(--surface);
  transition: background .14s var(--ease), box-shadow .14s var(--ease);
}
.layout-opt span { font-size: 12px; color: var(--ink); }
.layout-opt small { display: block; font-size: 10.5px; color: var(--ink-3); margin-top: 2px; }
.layout-opt:hover { background: var(--surface-2); }
.layout-opt.on { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
</style>
