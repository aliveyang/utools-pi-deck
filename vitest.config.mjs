import { defineConfig } from 'vitest/config'

// 独立于 vite.config.mjs：单测不加载 dev-server 插件，node 环境直跑纯函数
// 用 .mjs 后缀：package.json 无 "type":"module" 时避免 configLoader 警告
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: './tests/setup.js',
  },
})
