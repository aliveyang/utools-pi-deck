// 轻提示与剪贴板
import { ref } from 'vue'

export function useToast() {
  const toast = ref('')
  let timer = null

  function showToast(msg) {
    toast.value = msg
    clearTimeout(timer)
    timer = setTimeout(() => { toast.value = '' }, 2200)
  }

  function copyText(text) {
    const str = String(text ?? '')
    const done = () => showToast('已复制')
    try {
      if (window.utools && typeof window.utools.copyText === 'function' && window.utools.copyText(str)) {
        done()
        return
      }
    } catch (_) {}
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(str).then(done).catch(() => fallbackCopy(str, done))
    } else fallbackCopy(str, done)
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy'); done() } catch (_) { showToast('复制失败') }
    document.body.removeChild(ta)
  }

  return { toast, showToast, copyText }
}
