<script setup>
// 对话流：两套布局共用同一份渲染，只有外层排版由 .layout-* 决定
import { ref, watch } from 'vue'
import { formatText } from '../format.js'
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
})
const emit = defineEmits(['earlier', 'chip', 'copy', 'link', 'preview'])

// 本地折叠状态映射（不直接修改 props，避免将 UI 展开态写入持久化数据）
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

// Markdown 渲染缓存：流式输出时仅重新渲染当前变化的消息
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
// 未手动操作时，最后一条在生成中自动展开
function thinkOpen(i) {
  const k = msgKey(i)
  if (k in thinkOpenMap.value) return thinkOpenMap.value[k]
  return props.running && isLast(i)
}
function toggleThink(i) {
  const k = msgKey(i)
  thinkOpenMap.value[k] = !thinkOpen(i)
}
function toolsOpen(i) {
  return !!toolsOpenMap.value[msgKey(i)]
}
function toggleTools(i) {
  const k = msgKey(i)
  toolsOpenMap.value[k] = !toolsOpenMap.value[k]
}
function toolExpanded(i, t, k) {
  const key = `${msgKey(i)}:${t.id || k}`
  return !!toolExpandedMap.value[key]
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
  const pre = e.target && e.target.closest && e.target.closest('pre')
  if (pre) { emit('copy', pre.innerText); return }
  const a = e.target && e.target.closest && e.target.closest('a.md-link')
  if (!a) return
  e.preventDefault()
  emit('link', a.getAttribute('href'))
}
const typingText = () => props.runPhase === 'spawning' ? '正在启动引擎…'
  : props.runPhase === 'connecting' ? '正在连接模型…' : '正在思考…'
</script>

<template>
  <div class="thread">
    <!-- 空态 -->
    <div v-if="!total" class="empty">
      <span class="empty-mark">π</span>
      <p class="empty-desc">{{ emptyDesc }}</p>
      <div class="empty-chips">
        <button v-for="c in chips" :key="c" class="chip" @click="emit('chip', c)">{{ c }}</button>
      </div>
      <div class="empty-keys">
        <kbd>/</kbd><span>技能</span>
        <kbd>@</kbd><span>文件</span>
        <kbd>{{ sendKeyChip }}</kbd><span>发送</span>
      </div>
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
          <div v-if="running && isLast(i) && !m.text" class="typing">{{ typingText() }}</div>
          <div v-if="m.aborted" class="aborted">已停止</div>
          <div v-if="m.error" class="turn-error">{{ m.error }}</div>
          <div v-if="m.text && !running" class="turn-actions">
            <button class="copy-btn" @click="emit('copy', m.text)"><Icon name="copy" :size="11" />复制</button>
          </div>
        </div>
      </template>
    </div>

    <div v-if="usage" class="usage">{{ usage }}</div>
    <div v-if="error" class="error-box">{{ error }}</div>
  </div>
</template>
