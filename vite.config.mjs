import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { piDevApi } from './dev-server-plugin.mjs'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))

// 构建后处理：复制 core 到 dist/shared；剥离生产 plugin.json 的 development 段
function copyCore() {
  return {
    name: 'pideck-copy-core',
    apply: 'build',
    closeBundle() {
      const sharedDir = resolve(ROOT, 'shared')
      const outDir = resolve(ROOT, 'dist', 'shared')
      mkdirSync(outDir, { recursive: true })
      for (const name of readdirSync(sharedDir)) {
        if (name.endsWith('.cjs')) copyFileSync(resolve(sharedDir, name), resolve(outDir, name))
      }
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
      // 首帧零闪烁背景与极简骨架：不依赖任何内联脚本（兼容 CSP script-src 'self'），Vue 挂载后立即接管
      const bootCss = [
        '<style id="pideck-boot-style">',
        'html,body,#app{margin:0;height:100%;background:#fbfaf7;color:#14161a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
        '@media(prefers-color-scheme:dark){html,body,#app{background:#101215;color:#e6e7e9}}',
        '.boot-shell{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}',
        '.boot-mark{width:30px;height:30px;border-radius:9px;background:#1b6a5d;color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:500}',
        '@media(prefers-color-scheme:dark){.boot-mark{background:#57c4ac;color:#0b1a17}}',
        '.boot-tip{font-size:12px;color:#8b949e;opacity:0;animation:pideck-boot-tip .25s ease 2.5s forwards}',
        '@keyframes pideck-boot-tip{to{opacity:1}}',
        '</style>',
      ].join('')
      html = html.replace('</head>', () => `  ${bootCss}\n  </head>`)
      html = html.replace('<div id="app"></div>',
        '<div id="app"><div id="boot-hint" class="boot-shell"><span class="boot-mark">π</span><span class="boot-tip">正在加载 PiDeck… 若长时间停留此页，说明脚本未执行。</span></div></div>')
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
