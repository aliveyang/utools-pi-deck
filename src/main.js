import { createApp } from 'vue'
import './main.css'
import App from './App.vue'

// dev 预览模式（无 uTools）注入 mock piBridge，使浏览器能真实调用 pi CLI
if (import.meta.env.DEV && !window.utools && !window.piBridge) {
  await import('./dev-bridge.js')
}

// 无 preload 的环境（dev mock）也保证进入事件走同一条缓存通道
if (window.utools && !window.__pideckEnterQueue) {
  window.__pideckEnterQueue = []
  window.utools.onPluginEnter(action => {
    window.__pideckEnterQueue.push(action)
    window.dispatchEvent(new CustomEvent('pideck:enter', { detail: action }))
  })
}

const perfNow = () => (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now()
const perf = window.__pideckPerf = window.__pideckPerf || {}
perf.scriptStart = perfNow()

const app = createApp(App)
// 全局错误兜底：避免渲染异常导致纯白屏，至少把错误显示出来
app.config.errorHandler = (err, _vm, info) => {
  console.error('[PiDeck]', info, err)
  const el = document.getElementById('app')
  if (el && !el.querySelector('.app')) {
    el.innerHTML = `<div style="padding:20px;font:13px/1.6 -apple-system,Segoe UI,sans-serif;color:#b42318">
      <b>PiDeck 渲染出错</b><br><pre style="white-space:pre-wrap;color:#57606a">${String((err && err.stack) || err).replace(/</g, '&lt;')}</pre></div>`
  }
}
window.addEventListener('unhandledrejection', e => console.error('[PiDeck] unhandled:', e.reason))
app.mount('#app')
perf.mounted = perfNow()
perf.mountMs = Number((perf.mounted - perf.scriptStart).toFixed(2))
