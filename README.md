# PiDeck

uTools 内的 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 快速对话面板：`Alt+空格` 唤起即问，纯文本对话 / 翻译 / 带工具的智能体三个默认分组，支持图片、文件、技能（`/`）、工作区文件引用（`@`）。底层始终是本机 pi CLI，不自建服务、不经过第三方中转。

## 前置条件

| 依赖 | 要求 | 说明 |
|---|---|---|
| uTools | 任意近期版本 | 插件宿主 |
| Node.js | **≥ 22.19** | pi CLI 的运行时要求 |
| pi CLI | `npm i -g @earendil-works/pi-coding-agent` | 安装后在 pi 里完成模型/凭证配置（`~/.pi/agent`） |

默认模型与凭证不经过 PiDeck 配置，一切以 pi 侧为准；插件只透传 `--model` / `--thinking` 覆盖项。

## 安装到 uTools

1. 构建产物：`npm run build` → 生成自包含的 `dist/`（内联 JS/CSS + `shared/*.cjs` + `preload.js`）。
2. uTools → 设置 → 开发者 → 新建插件，选择项目目录（读取 `public/plugin.json`，正式使用加载 `dist/`）。

## 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `PIDECK_NODE` | 指定用于 spawn pi 的 node 可执行文件路径（默认多路径探测） |
| `PIDECK_PI_CLI` | 指定 pi 的 `cli.js` 路径（默认 npm 全局/pnpm/PATH 探测） |

若插件装在 uTools 内找不到 Node/pi（GUI 应用常不带 shell 的 PATH），设置这两个系统环境变量后重启 uTools。

## 运行引擎（设置 → 对话默认）

| 引擎 | 行为 | 会话语义 |
|---|---|---|
| 单次调用（默认） | 每条消息 spawn 一次 `pi --mode json --session-id` | 上下文由 pi 落盘（`~/.pi/agent/sessions`），可跨次续接 |
| 长驻预热（RPC） | 打开插件后台预热 `pi --mode rpc` 长驻进程，发送零冷启动；未就绪/失败自动回退单次调用 | 上下文仅存进程内存：切换会话时自动重置，进程被回收（10 分钟空闲 / 超出 3 个 / 关窗）后**不续接** |

RPC 的会话隔离：同一长驻进程在多个 PiDeck 会话间切换时会先重置进程内对话（实测验证），不会互相串上下文；但历史轮次不落盘，进程回收后从新开始。需要可靠的跨次记忆请用单次调用。

## 工具权限

每个分组独立配置四档预设（纯文本 / 只读 / 可编辑 / 完整）+ 细粒度勾选（内置工具白名单、MCP 三态、扩展、技能、AGENTS.md 规范、项目级 `.pi` 信任）。写入与执行类工具（`edit`/`write`/`bash`/`powershell`）在 UI 中有显著风险标识。MCP 与扩展不受内置白名单约束，组合后的真实后果会显示在"工具影响"一行。

## 开发

```bash
npm install
npm run dev       # 浏览器预览：vite + /__pideck/api 本地代理（真实调用 pi CLI，仅 localhost）
npm run build     # 产出 dist/
npm test          # vitest 单测（纯函数：权限拼参 / Markdown 转义 / 会话迁移 / JSONL 解析等）
```

浏览器预览无需 uTools：`src/dev-bridge.js` 注入 mock `piBridge`，走 `dev-server-plugin.mjs` 提供的本地 API（只校验 localhost Origin/Host，请勿暴露到公网）。

## 目录结构

```
├─ public/plugin.json     uTools 插件描述（入口/关键字/图片/文件指令）
├─ public/preload.js      渲染层 ↔ Node 桥（piBridge），核心逻辑在 shared
├─ shared/pi-core.cjs     pi 定位、JSONL 解析、权限拼参、扫描、诊断（三调用方共用）
├─ shared/rpc-engine.cjs  RPC 长驻引擎（按 cwd+配置 维护进程，new_session 会话隔离）
├─ dev-server-plugin.mjs  dev-only vite 中间件：/__pideck/api/*（SSE 流式）
├─ src/App.vue            主界面（双布局、设置、发送/取消/收口）
├─ src/components/        TurnList（消息流）、Icon（图标系统）
├─ src/composables/       usePiEnv（环境/模型/技能）、usePrefs（偏好）、useToast
├─ src/sessions.js        会话持久化（单会话分 key + 索引，旧数据自动迁移/重建）
├─ src/groups.js          分组与工具权限数据模型
├─ src/format.js          轻量 Markdown → HTML（先转义再生成标签，防 XSS）
└─ src/storage.js         dbStorage/localStorage 统一存储契约（存字符串避 IPC clone）
```
