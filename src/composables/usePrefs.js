// 用户偏好：默认工作目录、发送键、界面布局
import { ref } from 'vue'
import { loadPrefsBundle, savePrefsPatch } from '../storage.js'

export function usePrefs({ showToast, onCwdChange, initialPrefs }) {
  const basePrefs = initialPrefs || loadPrefsBundle().prefs
  const defaultCwd = ref(basePrefs.defaultCwd || '')
  const cwdDisplayCache = new Map()

  function clearCwdDisplayCache() {
    cwdDisplayCache.clear()
  }

  function setDefaultCwd(dir) {
    defaultCwd.value = dir || ''
    clearCwdDisplayCache()
    savePrefsPatch({ defaultCwd: defaultCwd.value })
    if (onCwdChange) onCwdChange()
  }
  function commitDefaultCwd(dir) {
    const d = (dir || '').trim()
    if (d && window.piBridge && window.piBridge.validateCwd && !window.piBridge.validateCwd(d)) {
      showToast('目录不存在，已保留输入但未生效')
    }
    setDefaultCwd(d)
  }
  function pickDefaultCwd() {
    if (!window.piBridge || !window.piBridge.pickFolder) return showToast('当前环境不支持选择文件夹')
    const dir = window.piBridge.pickFolder()
    if (dir) { setDefaultCwd(dir); showToast('默认目录已设置') }
  }

  // 'enter' = Enter 发送 / Shift+Enter 换行；'ctrl' = Ctrl/Cmd+Enter 发送
  const sendKeyMode = ref(basePrefs.sendKey === 'enter' ? 'enter' : 'ctrl')
  function setSendKeyMode(mode) {
    sendKeyMode.value = mode
    savePrefsPatch({ sendKey: mode })
    showToast(mode === 'enter' ? '改为 Enter 发送（Shift+Enter 换行）' : '改为 Ctrl/Cmd+Enter 发送')
  }

  // 纯字符串拼接计算展示用目录：不在首帧渲染期触发同步 fs.existsSync / fs.statSync
  function displayCwd(cwd) {
    const dir = (cwd || defaultCwd.value || '').trim()
    const cacheKey = `${cwd || ''}|${defaultCwd.value || ''}`
    if (cwdDisplayCache.has(cacheKey)) return cwdDisplayCache.get(cacheKey)
    let resolved
    if (dir) {
      resolved = dir
    } else {
      const home = (window.piBridge && window.piBridge.homedir) ? (window.piBridge.homedir() || '') : ''
      if (home) {
        const sep = home.includes('\\') ? '\\' : '/'
        resolved = home.replace(/[\\/]+$/, '') + sep + 'MyPiDeck'
      } else {
        resolved = '~'
      }
    }
    if (cwdDisplayCache.size > 32) cwdDisplayCache.clear()
    cwdDisplayCache.set(cacheKey, resolved)
    return resolved
  }

  const layout = ref(basePrefs.layout === 'console' ? 'console' : 'classic')
  function setLayout(next) {
    const v = next === 'console' ? 'console' : 'classic'
    if (v === layout.value) return
    layout.value = v
    savePrefsPatch({ layout: v })
    showToast(v === 'console' ? '已切换到控制台布局' : '已切换到经典布局')
  }

  return {
    defaultCwd, setDefaultCwd, commitDefaultCwd, pickDefaultCwd,
    sendKeyMode, setSendKeyMode, displayCwd, clearCwdDisplayCache,
    layout, setLayout,
  }
}
