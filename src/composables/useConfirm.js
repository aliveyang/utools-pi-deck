// 两步确认状态机（替代各组件内重复的 4s timeout 确认样板代码）
import { ref, onUnmounted } from 'vue'

export function useConfirm(timeoutMs = 4000) {
  const pendingKey = ref('')
  let timer = null

  function reset() {
    pendingKey.value = ''
    clearTimeout(timer)
    timer = null
  }

  function isConfirming(key = '__default__') {
    return pendingKey.value === String(key)
  }

  function confirm(keyOrFn, maybeFn) {
    const hasKey = typeof keyOrFn !== 'function'
    const key = hasKey ? String(keyOrFn || '__default__') : '__default__'
    const onConfirmed = hasKey ? maybeFn : keyOrFn
    if (pendingKey.value === key) {
      reset()
      if (typeof onConfirmed === 'function') onConfirmed()
      return true
    }
    pendingKey.value = key
    clearTimeout(timer)
    timer = setTimeout(() => { pendingKey.value = '' }, timeoutMs)
    return false
  }

  onUnmounted(reset)

  return { pendingKey, isConfirming, confirm, reset }
}
