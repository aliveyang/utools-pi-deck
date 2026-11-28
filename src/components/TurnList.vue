<script setup>
// 对话流：两套布局共用同一份渲染，外层风格通过 variant（console | classic）控制
import { PI_INSTALL_CMD } from '../constants.js'
import Icon from './Icon.vue'
import TurnItem from './TurnItem.vue'

defineProps({
  variant: { type: String, default: 'console' },   // console | classic
  sessionId: { type: String, default: '' },
  visible: { type: Array, default: () => [] },
  total: { type: Number, default: 0 },
  hiddenCount: { type: Number, default: 0 },
  pageSize: { type: Number, default: 60 },
  running: { type: Boolean, default: false },
  runPhase: { type: String, default: '' },
  usage: { type: String, default: '' },
  error: { type: String, default: '' },
  emptyDesc: { type: String, default: '' },
  chips: { type: Array, default: () => [] },
  sendKeyChip: { type: String, default: 'Ctrl+↵' },
  onboardingState: { type: String, default: '' }, // '' | 'need-node' | 'need-pi' | 'need-model'
  envInfo: { type: Object, default: null },
})
const emit = defineEmits(['earlier', 'chip', 'copy', 'link', 'preview', 'regenerate', 'installPi', 'openConfig', 'recheckEnv'])
</script>

<template>
  <div class="thread" :class="'v-' + variant">
    <!-- 空态：未就绪时显示三步上手引导卡；就绪后显示快捷示例 -->
    <div v-if="!total" class="empty">
      <span class="empty-mark">π</span>
      <template v-if="onboardingState">
        <div class="onboard-card">
          <div class="onboard-title">3 步完成准备，即可开始对话</div>
          <div class="onboard-step" :class="{ done: onboardingState !== 'need-node' }">
            <span class="step-badge"><Icon v-if="onboardingState !== 'need-node'" name="check" :size="11" /><template v-else>1</template></span>
            <div class="step-main">
              <div class="step-head">安装 Node.js ≥ 22.19</div>
              <div v-if="onboardingState === 'need-node'" class="step-actions">
                <button class="mini-btn" @click="emit('link', 'https://nodejs.org')">前往官网下载</button>
                <button class="mini-btn" @click="emit('openConfig')">手动指定 Node 路径</button>
                <button class="mini-btn" @click="emit('recheckEnv')">重新检测</button>
              </div>
              <div v-else class="step-sub">已检测到 {{ (envInfo && envInfo.nodeVersion) || 'Node.js' }}</div>
            </div>
          </div>

          <div class="onboard-step" :class="{ done: onboardingState === 'need-model' }">
            <span class="step-badge"><Icon v-if="onboardingState === 'need-model'" name="check" :size="11" /><template v-else>2</template></span>
            <div class="step-main">
              <div class="step-head">安装 pi CLI 工具</div>
              <div v-if="onboardingState === 'need-pi'" class="step-actions">
                <button class="mini-btn accent-btn" @click="emit('installPi')"><Icon name="terminal" :size="12" />终端一键安装</button>
                <button class="mini-btn" @click="emit('copy', PI_INSTALL_CMD)">复制命令</button>
                <button class="mini-btn" @click="emit('openConfig')">手动指定路径</button>
                <button class="mini-btn" @click="emit('recheckEnv')">重新检测</button>
              </div>
              <div v-else-if="onboardingState === 'need-model'" class="step-sub">已安装 pi CLI</div>
            </div>
          </div>

          <div class="onboard-step">
            <span class="step-badge">3</span>
            <div class="step-main">
              <div class="step-head">选择一个模型并配置 API Key（支持 DeepSeek / 百炼 / Ollama 等）</div>
              <div class="step-actions">
                <button class="mini-btn accent-btn" @click="emit('openConfig')">打开模型配置向导</button>
              </div>
            </div>
          </div>
        </div>
      </template>
      <template v-else>
        <p class="empty-desc">{{ emptyDesc }}</p>
        <div class="empty-chips">
          <button v-for="c in chips" :key="c" class="chip" @click="emit('chip', c)">{{ c }}</button>
        </div>
        <div class="empty-keys">
          <kbd>/</kbd><span>技能</span>
          <kbd>@</kbd><span>文件</span>
          <kbd>{{ sendKeyChip }}</kbd><span>发送</span>
        </div>
      </template>
    </div>

    <button v-if="hiddenCount" class="load-earlier" @click="emit('earlier')">
      加载更早的 {{ Math.min(pageSize, hiddenCount) }} 条（还有 {{ hiddenCount }} 条）
    </button>

    <TurnItem
      v-for="(m, i) in visible"
      :key="`${sessionId || 'new'}:${hiddenCount + i}`"
      :msg="m"
      :variant="variant"
      :running="running"
      :is-last="hiddenCount + i === total - 1"
      :run-phase="runPhase"
      @copy="emit('copy', $event)"
      @link="emit('link', $event)"
      @preview="emit('preview', $event)"
      @regenerate="emit('regenerate')"
    />

    <div v-if="usage" class="usage">{{ usage }}</div>
    <div v-if="error" class="error-box">{{ error }}</div>
  </div>
</template>

<style scoped>
.thread { max-width: var(--measure); margin: 0 auto; min-height: 100%; display: flex; flex-direction: column; }
.thread.v-classic { max-width: 880px; }

.thread :deep(.turn) { display: grid; grid-template-columns: 20px minmax(0, 1fr); column-gap: 12px; margin-bottom: 20px; }
.thread.v-classic :deep(.turn) { grid-template-columns: 24px minmax(0, 1fr); column-gap: 10px; margin-bottom: 18px; }
.thread.v-classic :deep(.turn.user) { display: flex; justify-content: flex-end; }
.thread.v-classic :deep(.turn.user .turn-gutter) { display: none; }
.thread.v-classic :deep(.turn.user .turn-body) {
  max-width: 82%; background: var(--bubble); border: 1px solid var(--line);
  border-radius: 12px 12px 4px 12px; padding: 8px 12px;
}
.thread.v-classic :deep(.turn.user .turn-text) { font-size: 12.5px; line-height: 1.6; }

.thread :deep(.turn-gutter) { font-size: 14px; line-height: 1.55; color: var(--accent); font-weight: 500; user-select: none; }
.thread :deep(.turn-gutter.gutter-ai) { color: var(--ink-3); display: flex; justify-content: flex-start; padding-top: 5px; }
.thread.v-classic :deep(.turn-gutter.gutter-ai) {
  width: 24px; height: 24px; border-radius: 7px; background: var(--accent-soft);
  color: var(--accent); border: 1px solid var(--accent-soft);
  display: flex; align-items: center; justify-content: center; padding-top: 0;
}
.thread :deep(.turn-body) { min-width: 0; position: relative; }

.thread :deep(.turn-text) { font-size: 13.5px; line-height: 1.72; color: var(--ink); word-break: break-word; }
.thread.v-classic :deep(.turn-text) { font-size: 13px; }
.thread :deep(.turn-text strong) { font-weight: 500; }
.thread :deep(.turn-text h1), .thread :deep(.turn-text h2), .thread :deep(.turn-text h3) { font-size: 13.5px; font-weight: 500; margin: 14px 0 6px; }
.thread :deep(.turn-text ul), .thread :deep(.turn-text ol) { margin: 6px 0; padding-left: 20px; }
.thread :deep(.turn-text li) { margin: 3px 0; }
.thread :deep(.turn-text code) {
  background: var(--surface); border-radius: 4px; padding: 1px 4px; font-size: 12px;
  border: 1px solid var(--line);
}
.thread :deep(.turn-text .code-block) { position: relative; margin: 10px 0; }
.thread :deep(.turn-text pre) {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 11px 12px; margin: 0; overflow-x: auto; font-size: 12px; line-height: 1.6;
}
.thread.v-classic :deep(.turn-text pre) { font-size: 11.5px; }
.thread :deep(.turn-text pre code) { background: none; border: 0; padding: 0; font-size: inherit; }
.thread :deep(.turn-text .code-copy-btn) {
  position: absolute; top: 6px; right: 8px; z-index: 1;
  font-size: 10.5px; color: var(--ink-2); background: var(--raised);
  border: 1px solid var(--line-2); border-radius: 4px; padding: 2px 7px;
  opacity: 0; transition: opacity .12s var(--ease), color .12s var(--ease), border-color .12s var(--ease);
}
.thread :deep(.turn-text .code-block:hover .code-copy-btn),
.thread :deep(.turn-text .code-copy-btn:focus-visible) { opacity: 1; }
.thread :deep(.turn-text .code-copy-btn:hover) { color: var(--accent); border-color: var(--accent); }
.thread :deep(.turn-text .md-link) { color: var(--accent); text-decoration: none; }
.thread :deep(.turn-text .md-link:hover) { text-decoration: underline; }

.thread :deep(.pills) { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px -1px; }
.thread.v-classic :deep(.pills) { margin-left: 0; }
.thread :deep(.pill) {
  height: 22px; padding: 0 9px; border-radius: 11px; background: var(--surface);
  display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ink-2);
  transition: background .14s var(--ease), color .14s var(--ease);
}
.thread :deep(.pill:hover) { background: var(--surface-2); color: var(--ink); }
.thread :deep(.pill-chev) { transition: transform .16s var(--ease); transform: rotate(-90deg); }
.thread :deep(.pill.open .pill-chev) { transform: rotate(0deg); }
.thread :deep(.pill-live) { color: var(--accent); }
.thread :deep(.fold-body) {
  background: var(--surface); border-radius: var(--r-sm); padding: 9px 11px; margin: 0 0 10px;
  font-size: 12px; line-height: 1.65; color: var(--ink-2); white-space: pre-wrap; word-break: break-word;
}
.thread :deep(.think-body) { max-height: 200px; overflow-y: auto; font-size: 11.5px; }
.thread :deep(.tool-item + .tool-item) { margin-top: 2px; }
.thread :deep(.tool-line) {
  display: flex; align-items: center; justify-content: space-between; width: 100%;
  padding: 3px 0; font-size: 11.5px; color: var(--ink-2); text-align: left;
}
.thread :deep(.tool-line:hover) { color: var(--accent); }
.thread :deep(.tool-name) { font-family: var(--mono); }
.thread :deep(.tool-chev) { color: var(--ink-3); transition: transform .16s var(--ease); }
.thread :deep(.tool-chev.open) { transform: rotate(90deg); }
.thread :deep(.tool-detail) {
  background: var(--paper); border: 1px solid var(--line); border-radius: 5px; padding: 8px;
  margin: 4px 0 0; font-size: 11px; line-height: 1.55; color: var(--ink-2);
  white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow-y: auto;
}

.thread :deep(.typing) { font-size: 12px; color: var(--ink-3); padding: 2px 0; display: inline-flex; align-items: center; gap: 7px; }
.thread :deep(.typing-dot) {
  width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none;
  animation: typing-pulse 1.2s ease-in-out infinite;
}
@keyframes typing-pulse { 0%, 100% { opacity: .35; transform: scale(.88) } 50% { opacity: 1; transform: scale(1) } }
.thread :deep(.aborted) { font-size: 11.5px; color: var(--ink-3); margin-top: 6px; }
.thread :deep(.turn-error) { font-size: 12px; color: var(--danger); margin-top: 8px; white-space: pre-wrap; }
.thread :deep(.turn-actions) { display: flex; align-items: center; gap: 6px; height: 20px; margin-top: 6px; opacity: 0; transition: opacity .14s var(--ease); }
.thread :deep(.turn:hover .turn-actions), .thread :deep(.turn-actions:focus-within) { opacity: 1; }
.thread :deep(.action-btn) {
  display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ink-3);
  padding: 2px 6px; border-radius: 4px;
}
.thread :deep(.action-btn:hover) { background: var(--surface-2); color: var(--ink-2); }
.thread :deep(.image-tag) { font-size: 11px; color: var(--ink-3); margin-bottom: 4px; }
.thread :deep(.msg-images) { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 6px; }
.thread :deep(.msg-images img) {
  width: 72px; height: 72px; object-fit: cover; cursor: zoom-in;
  border: 1px solid var(--line-2); border-radius: 6px;
}
.thread :deep(.img-missing) {
  width: 72px; height: 72px; border: 1px dashed var(--line-2); border-radius: 6px;
  background: var(--surface); color: var(--ink-3); font-size: 10.5px; line-height: 1.3;
  display: flex; align-items: center; justify-content: center; text-align: center; padding: 6px;
  user-select: none;
}
.thread :deep(.msg-files) { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 6px; }
.thread :deep(.file-chip) {
  display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line-2);
  border-radius: 13px; padding: 2px 8px; font-size: 11px; color: var(--ink-2); max-width: 180px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.usage { text-align: right; font-size: 10.5px; color: var(--ink-3); padding: 2px 0 6px; }
.error-box {
  background: var(--danger-soft); color: var(--danger); border-radius: 5px;
  padding: 8px 10px; font-size: 12px; white-space: pre-wrap;
}
.load-earlier {
  align-self: center; font-size: 11.5px; color: var(--ink-3); padding: 4px 10px;
  border-radius: 10px; margin-bottom: 14px;
}
.load-earlier:hover { background: var(--surface); color: var(--ink-2); }

/* 空态与三步引导卡 */
.empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding-bottom: 24px; }
.empty-mark {
  width: 30px; height: 30px; border-radius: 9px; background: var(--accent); color: var(--on-accent);
  display: flex; align-items: center; justify-content: center; margin-bottom: 12px;
  font-size: 16px; font-weight: 500; line-height: 1; padding-bottom: 1px;
}
.empty-desc { margin: 0 0 18px; font-size: 12px; color: var(--ink-2); }
.empty-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 480px; }
.chip {
  height: 26px; padding: 0 11px; border-radius: 13px; border: 1px solid var(--line-2);
  font-size: 11.5px; color: var(--ink-2);
  transition: border-color .14s var(--ease), color .14s var(--ease), background .14s var(--ease);
}
.chip:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.empty-keys { display: flex; align-items: center; gap: 6px; margin-top: 20px; font-size: 11px; color: var(--ink-3); }
.empty-keys kbd {
  font-size: 10.5px; color: var(--ink-2); background: var(--surface);
  border: 1px solid var(--line-2); border-radius: 4px; padding: 1px 5px; line-height: 15px;
}
.empty-keys span + kbd { margin-left: 8px; }

.onboard-card {
  width: min(440px, 100%); background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
}
.onboard-title { font-size: 12.5px; font-weight: 500; color: var(--ink); }
.onboard-step {
  display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px;
  border-radius: var(--r-sm); background: var(--paper); border: 1px solid var(--line);
}
.onboard-step.done { border-color: var(--ok-line); background: var(--ok-soft); }
.step-badge {
  width: 20px; height: 20px; border-radius: 50%; background: var(--surface-2); color: var(--ink-2);
  display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 500; flex: none;
}
.onboard-step.done .step-badge { background: var(--accent); color: var(--on-accent); }
.step-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.step-head { font-size: 12px; font-weight: 500; color: var(--ink); }
.step-sub { font-size: 11px; color: var(--accent); }
.step-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.accent-btn { background: var(--accent-soft); color: var(--accent); font-weight: 500; }

@media (max-width: 720px) {
  .thread.v-classic { max-width: none; }
}
@media (max-width: 560px) {
  .empty-chips { max-width: 300px; }
}
</style>
