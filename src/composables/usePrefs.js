// 用户偏好：默认工作目录、发送键、界面布局
import { ref } from 'vue'
import { read, write } from '../storage.js'

const SEND_KEY = 'pideck.sendKey.v1'
const DEFAULT_CWD_KEY = 'pideck.defaultCwd.v1'
const LAYOUT_KEY = 'pideck.layout.v1'

export function usePrefs({ showToast, onCwdChange }) {
  const defaultCwd = ref(read(DEFAULT_CWD_KEY, '') || '')

  function setDefaultCwd(dir) {
    defaultCwd.value = dir || ''
    write(DEFAULT_CWD_KEY, defaultCwd.value)
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
  const sendKeyMode = ref(read(SEND_KEY, 'ctrl'))
  function setSendKeyMode(mode) {
    sendKeyMode.value = mode
    write(SEND_KEY, mode)
    showToast(mode === 'enter' ? '改为 Enter 发送（Shift+Enter 换行）' : '改为 Ctrl/Cmd+Enter 发送')
  }

  function displayCwd(cwd) {
    const dir = cwd || defaultCwd.value
    if (!window.piBridge) return dir || '~'
    if (window.piBridge.resolveCwd) return window.piBridge.resolveCwd(dir)
    return window.piBridge.effectiveCwd ? window.piBridge.effectiveCwd(dir) : (dir || '~')
  }

  const layout = ref(read(LAYOUT_KEY, 'classic') === 'console' ? 'console' : 'classic')
  function setLayout(next) {
    const v = next === 'console' ? 'console' : 'classic'
    if (v === layout.value) return
    layout.value = v
    write(LAYOUT_KEY, v)
    showToast(v === 'console' ? '已切换到控制台布局' : '已切换到经典布局')
  }

  return {
    defaultCwd, setDefaultCwd, commitDefaultCwd, pickDefaultCwd,
    sendKeyMode, setSendKeyMode, displayCwd,
    layout, setLayout,
  }
}
