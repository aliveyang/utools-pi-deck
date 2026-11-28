<script setup>
// 单条消息渲染单元：隔离历史消息与流式末尾消息的响应式更新
import { ref, computed, watch } from 'vue'
import { formatText } from '../format.js'
import Icon from './Icon.vue'

const props = defineProps({
  msg: { type: Object, required: true },
  variant: { type: String, default: 'console' },
  running: { type: Boolean, default: false },
  isLast: { type: Boolean, default: false },
  runPhase: { type: String, default: '' },
})

const emit = defineEmits(['copy', 'link', 'preview', 'regenerate'])

const thinkManualOpen = ref(null)
const toolsOpen = ref(false)
const toolExpandedMap = ref({})
const brokenImageMap = ref({})

watch(() => props.msg, () => {
  thinkManualOpen.value = null
  toolsOpen.value = false
  toolExpandedMap.value = {}
  brokenImageMap.value = {}
})

const renderedHtml = computed(() => formatText((props.msg && props.msg.text) || ''))

const thinkOpen = computed(() => {
  if (thinkManualOpen.value !== null) return thinkManualOpen.value
  return props.running && props.isLast
})

function toggleThink() {
  thinkManualOpen.value = !thinkOpen.value
}
function toggleTools() {
  toolsOpen.value = !toolsOpen.value
}
function toolExpanded(t, k) {
  return !!toolExpandedMap.value[t.id || k]
}
function toggleTool(t, k) {
  const key = t.id || k
  toolExpandedMap.value[key] = !toolExpandedMap.value[key]
}

function imageSrc(p) {
  if (!p) return ''
  if (/^(data:|https?:|file:)/.test(p)) return p
  const clean = String(p).replace(/\\/g, '/').replace(/^\/+/, '')
  return 'file:///' + encodeURI(clean).replace(/#/g, '%23').replace(/\?/g, '%3F')
}
function isImageBroken(pi) { return !!brokenImageMap.value[pi] }
function markImageBroken(pi) { brokenImageMap.value[pi] = true }

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
  <div class="turn" :class="msg.role">
    <template v-if="msg.role === 'user'">
      <div class="turn-gutter">›</div>
      <div class="turn-body">
        <div v-if="msg.imageCount" class="image-tag">{{ msg.imageCount }} 张图片</div>
        <div v-if="msg.imagePaths && msg.imagePaths.length" class="msg-images">
          <template v-for="(p, pi) in msg.imagePaths" :key="pi">
            <div v-if="isImageBroken(pi)" class="img-missing" title="原图已清理或仅保存在发送设备">
              <span>图片不可用</span>
            </div>
            <img v-else :src="imageSrc(p)" alt="图片" title="点击放大" @click="emit('preview', imageSrc(p))" @error="markImageBroken(pi)" />
          </template>
        </div>
        <div v-if="msg.fileNames && msg.fileNames.length" class="msg-files">
          <span v-for="(fn, fi) in msg.fileNames" :key="fi" class="file-chip">{{ fn }}</span>
        </div>
        <div class="turn-text" v-html="renderedHtml" @click="onTextClick"></div>
      </div>
    </template>
    <template v-else>
      <div class="turn-gutter gutter-ai"><Icon name="pi" :size="variant === 'classic' ? 13 : 11" :stroke="variant === 'classic' ? 1.8 : 1.9" /></div>
      <div class="turn-body">
        <div v-if="msg.thinking || (msg.tools && msg.tools.length)" class="pills">
          <button v-if="msg.thinking" class="pill" :class="{ open: thinkOpen }" @click="toggleThink">
            <Icon name="chevronDown" :size="10" class="pill-chev" />
            <span>思考</span>
            <span v-if="running && isLast" class="pill-live">进行中</span>
          </button>
          <button v-if="msg.tools && msg.tools.length" class="pill" :class="{ open: toolsOpen }" @click="toggleTools">
            <Icon name="chevronDown" :size="10" class="pill-chev" />
            <span>{{ toolPillText(msg) }}</span>
          </button>
        </div>
        <div v-if="msg.thinking && thinkOpen" class="fold-body think-body">{{ msg.thinking }}</div>
        <div v-if="msg.tools && msg.tools.length && toolsOpen" class="fold-body">
          <div v-for="(t, k) in msg.tools" :key="t.id || k" class="tool-item">
            <button class="tool-line" @click="toggleTool(t, k)">
              <span class="tool-name">{{ t.name }}</span>
              <Icon name="chevron" :size="11" class="tool-chev" :class="{ open: toolExpanded(t, k) }" />
            </button>
            <pre v-if="toolExpanded(t, k)" class="tool-detail">{{ t.result ? fmtArgs(t.args) + '\n→ ' + fmtArgs(t.result) : fmtArgs(t.args) }}</pre>
          </div>
        </div>
        <div v-if="msg.text" class="turn-text" v-html="renderedHtml" @click="onTextClick"></div>
        <div v-if="running && isLast && !msg.text" class="typing"><span class="typing-dot"></span><span>{{ typingText() }}</span></div>
        <div v-if="msg.aborted" class="aborted">已停止</div>
        <div v-if="msg.error" class="turn-error">{{ msg.error }}</div>
        <div v-if="!running && (msg.text || msg.error || msg.aborted)" class="turn-actions">
          <button v-if="msg.text" class="action-btn" @click="emit('copy', msg.text)"><Icon name="copy" :size="11" />复制</button>
          <button v-if="isLast" class="action-btn" @click="emit('regenerate')"><Icon name="retry" :size="11" />重新生成</button>
        </div>
      </div>
    </template>
  </div>
</template>
