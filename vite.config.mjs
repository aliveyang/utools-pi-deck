import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { piDevApi } from './dev-server-plugin.mjs'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))

// 构建后处理：复制 core 到 dist/shared；剥离生产 plugin.json 的 development 段
function copyCore() {
  return {
    name: 'pideck-copy-core',
    apply: 'build',
    closeBundle() {
      const outDir = resolve(ROOT, 'dist', 'shared')
      mkdirSync(outDir, { recursive: true })
      copyFileSync(resolve(ROOT, 'shared', 'pi-core.cjs'), resolve(outDir, 'pi-core.cjs'))
      copyFileSync(resolve(ROOT, 'shared', 'rpc-engine.cjs'), resolve(outDir, 'rpc-engine.cjs'))
      // 生产包去掉开发态入口
      const pjPath = resolve(ROOT, 'dist', 'plugin.json')
      try {
        const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
        if (pj.development) { delete pj.development; writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n') }
      } catch (_) {}

      // 关键：改写 index.html 以兼容 uTools（file:// + 可能存在的 CSP）
      // 1) 去掉 type="module"/crossorigin —— file:// 下 ES module 被 CORS 拦截
      // 2) 保持外链脚本（不内联）—— 规避 CSP script-src 'self' 对内联脚本的阻止
      // 3) 脚本移到 body 末尾 —— 普通 script 非 defer，需 #app 已解析
      const htmlPath = resolve(ROOT, 'dist', 'index.html')
      let html = readFileSync(htmlPath, 'utf8')
      const jsMatch = /<script[^>]*src="([^"]+\.js)"[^>]*><\/script>/.exec(html)
      const cssMatch = /<link[^>]*href="([^"]+\.css)"[^>]*>/.exec(html)
      if (jsMatch) {
        const src = jsMatch[1]
        html = html.replace(jsMatch[0], '')
        html = html.replace('</body>', () => `  <script src="${src}"></script>\n  </body>`)
      } else {
        console.warn('[pideck-copy-core] 未在 dist/index.html 匹配到脚本标签，跳过改写（请检查 Vite 输出格式是否变化）')
      }
      if (cssMatch) {
        const href = cssMatch[1]
        // 等价重写：实际作用是剥掉 Vite 默认加的 crossorigin 属性（file:// 下可能被拦）
        html = html.replace(cssMatch[0], () => `<link rel="stylesheet" href="${href}">`)
      }
      // 兜底占位：Vue 挂载会覆盖；若一直显示说明脚本未执行（便于诊断）
      html = html.replace('<div id="app"></div>',
        '<div id="app"><div id="boot-hint" style="padding:24px;font:13px/1.6 -apple-system,Segoe UI,sans-serif;color:#8b949e">正在加载 PiDeck…<br>若长时间停留此页，说明脚本未执行。</div></div>')
      writeFileSync(htmlPath, html)
    },
  }
}

export default defineConfig({
  plugins: [vue(), piDevApi(), copyCore()],
  base: './',
  build: {
    modulePreload: false,   // 避免 polyfill 内联的 <script> 字符串破坏内联
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    rolldownOptions: {
      output: {
        format: 'iife',
      },
    },
  },
})
