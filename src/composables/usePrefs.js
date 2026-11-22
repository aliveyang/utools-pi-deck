// 用户偏好：默认工作目录、发送键、界面布局、展示辅助
import { ref } from 'vue'
import { read, write } from '../storage.js'

const SEND_KEY = 'pideck.sendKey.v1'
const DEFAULT_CWD_KEY = 'pideck.defaultCwd.v1'
const LAYOUT_KEY = 'pideck.layout.v1'

export function usePrefs({ showToast, onCwdChange }) {
  // 全局默认工作目录：分组 cwd 留空时优先用它
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
    // 展示用纯计算路径（resolveCwd），避免仅渲染就触发默认工作区 ~/MyPiDeck 落盘创建
    if (window.piBridge.resolveCwd) return window.piBridge.resolveCwd(dir)
    return window.piBridge.effectiveCwd ? window.piBridge.effectiveCwd(dir) : (dir || '~')
  }

  // 两套界面：console = 顶栏 + 转录式；classic = 左侧栏 + 气泡
  // 默认沿用用户熟悉的经典布局
  const layout = ref(read(LAYOUT_KEY, 'classic') === 'console' ? 'console' : 'classic')
  function setLayout(next) {
    const v = next === 'console' ? 'console' : 'classic'
    if (v === layout.value) return
    layout.value = v
    write(LAYOUT_KEY, v)
    showToast(v === 'console' ? '已切换到控制台布局' : '已切换到经典布局')
  }
  function toggleLayout() { setLayout(layout.value === 'console' ? 'classic' : 'console') }

  function fmtSize(n) {
    return n < 1024 ? n + 'B' : (n / 1024).toFixed(1) + 'KB'
  }

  return {
    defaultCwd, setDefaultCwd, commitDefaultCwd, pickDefaultCwd,
    sendKeyMode, setSendKeyMode, displayCwd, fmtSize,
    layout, setLayout, toggleLayout,
  }
}
