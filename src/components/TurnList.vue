<script setup>
// 对话流：两套布局共用同一份渲染，外层风格通过 variant（console | classic）控制
import { ref, watch } from 'vue'
import { formatText } from '../format.js'
import { PI_INSTALL_CMD } from '../constants.js'
import Icon from './Icon.vue'

const props = defineProps({
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

const thinkOpenMap = ref({})
const toolsOpenMap = ref({})
const toolExpandedMap = ref({})

watch([() => props.sessionId, () => props.total === 0], ([id, isEmpty], [oldId]) => {
  if (isEmpty || id !== oldId) {
    thinkOpenMap.value = {}
    toolsOpenMap.value = {}
    toolExpandedMap.value = {}
  }
})

const htmlCache = new WeakMap()
function renderText(m) {
  const text = (m && m.text) || ''
  if (!m || typeof m !== 'object') return formatText(text)
  const hit = htmlCache.get(m)
  if (hit && hit.text === text) return hit.html
  const html = formatText(text)
  htmlCache.set(m, { text, html })
  return html
}

function imageSrc(p) {
  if (!p) return ''
  if (/^(data:|https?:|file:)/.test(p)) return p
  const clean = String(p).replace(/\\/g, '/').replace(/^\/+/, '')
  return 'file:///' + encodeURI(clean).replace(/#/g, '%23').replace(/\?/g, '%3F')
}
function hideBroken(e) { e.target.style.display = 'none' }

function msgKey(i) { return props.hiddenCount + i }
function isLast(i) { return props.hiddenCount + i === props.total - 1 }
function thinkOpen(i) {
  const k = msgKey(i)
  if (k in thinkOpenMap.value) return thinkOpenMap.value[k]
  return props.running && isLast(i)
}
function toggleThink(i) {
  const k = msgKey(i)
  thinkOpenMap.value[k] = !thinkOpen(i)
}
function toolsOpen(i) { return !!toolsOpenMap.value[msgKey(i)] }
function toggleTools(i) {
  const k = msgKey(i)
  toolsOpenMap.value[k] = !toolsOpenMap.value[k]
}
function toolExpanded(i, t, k) {
  return !!toolExpandedMap.value[`${msgKey(i)}:${t.id || k}`]
}
function toggleTool(i, t, k) {
  const key = `${msgKey(i)}:${t.id || k}`
  toolExpandedMap.value[key] = !toolExpandedMap.value[key]
}

function toolPillText(m) {
  const list = m.tools || []
  if (!list.length) return ''
  const uniq = [...new Set(list.map(t => t.name))]
  if (uniq.length === 1) return `${uniq[0]} ×${list.length}`
  return `${list.length} 个操作`
}
function fmtArgs(v) {
  try { return JSON.stringify(v, null, 2) } catch (_) { return String(v) }
}
function onTextClick(e) {
  const copyBtn = e.target && e.target.closest && e.target.closest('.code-copy-btn')
  if (copyBtn) {
    const codeEl = copyBtn.parentElement && copyBtn.parentElement.querySelector('pre code')
    if (codeEl) emit('copy', codeEl.innerText)
    return
  }
  const a = e.target && e.target.closest && e.target.closest('a.md-link')
  if (!a) return
  e.preventDefault()
  emit('link', a.getAttribute('href'))
}
const typingText = () => props.runPhase === 'spawning' ? '正在启动引擎…'
  : props.runPhase === 'connecting' ? '正在连接模型…' : '正在思考…'
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

    <div v-for="(m, i) in visible" :key="hiddenCount + i" class="turn" :class="m.role">
      <template v-if="m.role === 'user'">
        <div class="turn-gutter">›</div>
        <div class="turn-body">
          <div v-if="m.imageCount" class="image-tag">{{ m.imageCount }} 张图片</div>
          <div v-if="m.imagePaths && m.imagePaths.length" class="msg-images">
            <img v-for="(p, pi) in m.imagePaths" :key="pi" :src="imageSrc(p)" alt="图片" title="点击放大" @click="emit('preview', imageSrc(p))" @error="hideBroken" />
          </div>
          <div v-if="m.fileNames && m.fileNames.length" class="msg-files">
            <span v-for="(fn, fi) in m.fileNames" :key="fi" class="file-chip">{{ fn }}</span>
          </div>
          <div class="turn-text" v-html="renderText(m)"></div>
        </div>
      </template>
      <template v-else>
        <div class="turn-gutter gutter-ai"><Icon name="pi" :size="variant === 'classic' ? 13 : 11" :stroke="variant === 'classic' ? 1.8 : 1.9" /></div>
        <div class="turn-body">
          <div v-if="m.thinking || (m.tools && m.tools.length)" class="pills">
            <button v-if="m.thinking" class="pill" :class="{ open: thinkOpen(i) }" @click="toggleThink(i)">
              <Icon name="chevronDown" :size="10" class="pill-chev" />
              <span>思考</span>
              <span v-if="running && isLast(i)" class="pill-live">进行中</span>
            </button>
            <button v-if="m.tools && m.tools.length" class="pill" :class="{ open: toolsOpen(i) }" @click="toggleTools(i)">
              <Icon name="chevronDown" :size="10" class="pill-chev" />
              <span>{{ toolPillText(m) }}</span>
            </button>
          </div>
          <div v-if="m.thinking && thinkOpen(i)" class="fold-body think-body">{{ m.thinking }}</div>
          <div v-if="m.tools && m.tools.length && toolsOpen(i)" class="fold-body">
            <div v-for="(t, k) in m.tools" :key="t.id || k" class="tool-item">
              <button class="tool-line" @click="toggleTool(i, t, k)">
                <span class="tool-name">{{ t.name }}</span>
                <Icon name="chevron" :size="11" class="tool-chev" :class="{ open: toolExpanded(i, t, k) }" />
              </button>
              <pre v-if="toolExpanded(i, t, k)" class="tool-detail">{{ t.result ? fmtArgs(t.args) + '\n→ ' + fmtArgs(t.result) : fmtArgs(t.args) }}</pre>
            </div>
          </div>
          <div v-if="m.text" class="turn-text" v-html="renderText(m)" @click="onTextClick"></div>
          <div v-if="running && isLast(i) && !m.text" class="typing"><span class="typing-dot"></span><span>{{ typingText() }}</span></div>
          <div v-if="m.aborted" class="aborted">已停止</div>
          <div v-if="m.error" class="turn-error">{{ m.error }}</div>
          <div v-if="!running && (m.text || m.error || m.aborted)" class="turn-actions">
            <button v-if="m.text" class="action-btn" @click="emit('copy', m.text)"><Icon name="copy" :size="11" />复制</button>
            <button v-if="isLast(i)" class="action-btn" @click="emit('regenerate')"><Icon name="retry" :size="11" />重新生成</button>
          </div>
        </div>
      </template>
    </div>

    <div v-if="usage" class="usage">{{ usage }}</div>
    <div v-if="error" class="error-box">{{ error }}</div>
  </div>
</template>

<style scoped>
.thread { max-width: var(--measure); margin: 0 auto; min-height: 100%; display: flex; flex-direction: column; }
.thread.v-classic { max-width: 880px; }

.turn { display: grid; grid-template-columns: 20px minmax(0, 1fr); column-gap: 12px; margin-bottom: 20px; }
.thread.v-classic .turn { grid-template-columns: 24px minmax(0, 1fr); column-gap: 10px; margin-bottom: 18px; }
.thread.v-classic .turn.user { display: flex; justify-content: flex-end; }
.thread.v-classic .turn.user .turn-gutter { display: none; }
.thread.v-classic .turn.user .turn-body {
  max-width: 82%; background: var(--bubble); border: 1px solid var(--line);
  border-radius: 12px 12px 4px 12px; padding: 8px 12px;
}
.thread.v-classic .turn.user .turn-text { font-size: 12.5px; line-height: 1.6; }

.turn-gutter { font-size: 14px; line-height: 1.55; color: var(--accent); font-weight: 500; user-select: none; }
.turn-gutter.gutter-ai { color: var(--ink-3); display: flex; justify-content: flex-start; padding-top: 5px; }
.thread.v-classic .turn-gutter.gutter-ai {
  width: 24px; height: 24px; border-radius: 7px; background: var(--accent-soft);
  color: var(--accent); border: 1px solid var(--accent-soft);
  display: flex; align-items: center; justify-content: center; padding-top: 0;
}
.turn-body { min-width: 0; position: relative; }

.turn-text { font-size: 13.5px; line-height: 1.72; color: var(--ink); word-break: break-word; }
.thread.v-classic .turn-text { font-size: 13px; }
.turn-text :deep(strong) { font-weight: 500; }
.turn-text :deep(h1), .turn-text :deep(h2), .turn-text :deep(h3) { font-size: 13.5px; font-weight: 500; margin: 14px 0 6px; }
.turn-text :deep(ul), .turn-text :deep(ol) { margin: 6px 0; padding-left: 20px; }
.turn-text :deep(li) { margin: 3px 0; }
.turn-text :deep(code) {
  background: var(--surface); border-radius: 4px; padding: 1px 4px; font-size: 12px;
  border: 1px solid var(--line);
}
.turn-text :deep(.code-block) { position: relative; margin: 10px 0; }
.turn-text :deep(pre) {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 11px 12px; margin: 0; overflow-x: auto; font-size: 12px; line-height: 1.6;
}
.thread.v-classic .turn-text :deep(pre) { font-size: 11.5px; }
.turn-text :deep(pre code) { background: none; border: 0; padding: 0; font-size: inherit; }
.turn-text :deep(.code-copy-btn) {
  position: absolute; top: 6px; right: 8px; z-index: 1;
  font-size: 10.5px; color: var(--ink-2); background: var(--raised);
  border: 1px solid var(--line-2); border-radius: 4px; padding: 2px 7px;
  opacity: 0; transition: opacity .12s var(--ease), color .12s var(--ease), border-color .12s var(--ease);
}
.turn-text :deep(.code-block:hover .code-copy-btn),
.turn-text :deep(.code-copy-btn:focus-visible) { opacity: 1; }
.turn-text :deep(.code-copy-btn:hover) { color: var(--accent); border-color: var(--accent); }
.turn-text :deep(.md-link) { color: var(--accent); text-decoration: none; }
.turn-text :deep(.md-link:hover) { text-decoration: underline; }

.pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px -1px; }
.thread.v-classic .pills { margin-left: 0; }
.pill {
  height: 22px; padding: 0 9px; border-radius: 11px; background: var(--surface);
  display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ink-2);
  transition: background .14s var(--ease), color .14s var(--ease);
}
.pill:hover { background: var(--surface-2); color: var(--ink); }
.pill-chev { transition: transform .16s var(--ease); transform: rotate(-90deg); }
.pill.open .pill-chev { transform: rotate(0deg); }
.pill-live { color: var(--accent); }
.fold-body {
  background: var(--surface); border-radius: var(--r-sm); padding: 9px 11px; margin: 0 0 10px;
  font-size: 12px; line-height: 1.65; color: var(--ink-2); white-space: pre-wrap; word-break: break-word;
}
.think-body { max-height: 200px; overflow-y: auto; font-size: 11.5px; }
.tool-item + .tool-item { margin-top: 2px; }
.tool-line {
  display: flex; align-items: center; justify-content: space-between; width: 100%;
  padding: 3px 0; font-size: 11.5px; color: var(--ink-2); text-align: left;
}
.tool-line:hover { color: var(--accent); }
.tool-name { font-family: var(--mono); }
.tool-chev { color: var(--ink-3); transition: transform .16s var(--ease); }
.tool-chev.open { transform: rotate(90deg); }
.tool-detail {
  background: var(--paper); border: 1px solid var(--line); border-radius: 5px; padding: 8px;
  margin: 4px 0 0; font-size: 11px; line-height: 1.55; color: var(--ink-2);
  white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow-y: auto;
}

.typing { font-size: 12px; color: var(--ink-3); padding: 2px 0; display: inline-flex; align-items: center; gap: 7px; }
.typing-dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none;
  animation: typing-pulse 1.2s ease-in-out infinite;
}
@keyframes typing-pulse { 0%, 100% { opacity: .35; transform: scale(.88) } 50% { opacity: 1; transform: scale(1) } }
.aborted { font-size: 11.5px; color: var(--ink-3); margin-top: 6px; }
.turn-error { font-size: 12px; color: var(--danger); margin-top: 8px; white-space: pre-wrap; }
.turn-actions { display: flex; align-items: center; gap: 6px; height: 20px; margin-top: 6px; opacity: 0; transition: opacity .14s var(--ease); }
.turn:hover .turn-actions, .turn-actions:focus-within { opacity: 1; }
.action-btn {
  display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ink-3);
  padding: 2px 6px; border-radius: 4px;
}
.action-btn:hover { background: var(--surface-2); color: var(--ink-2); }
.image-tag { font-size: 11px; color: var(--ink-3); margin-bottom: 4px; }
.msg-images { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 6px; }
.msg-images img {
  width: 72px; height: 72px; object-fit: cover; cursor: zoom-in;
  border: 1px solid var(--line-2); border-radius: 6px;
}
.msg-files { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 6px; }
.file-chip {
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
