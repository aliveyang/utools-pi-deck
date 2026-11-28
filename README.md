# PiDeck

uTools 内的 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 快速对话面板：`Alt+空格` 唤起即问，纯文本对话 / 翻译 / 带工具的智能体三个默认分组，支持图片、文件、技能（`/`）、工作区文件引用（`@`）。设置里提供模型与 API Key 的图形化配置，以及本地操作记录。运行前需本机安装 **Node.js ≥ 22.19** 并自行安装 `pi` CLI；对话内容与附件会由本机 `pi` CLI 直接发送到用户配置的模型服务商，插件不自建服务、不经过第三方中转。

## 前置条件

| 依赖 | 要求 | 说明 |
|---|---|---|
| uTools | 任意近期版本 | 插件宿主 |
| Node.js | **≥ 22.19** | pi CLI 的运行时要求 |
| pi CLI | `npm i -g @earendil-works/pi-coding-agent` | 安装后可运行 `pi` 完成登录，或直接在插件「设置 → 环境与模型」里粘贴 API Key |

默认模型与凭证保存在 pi 标准的 `~/.pi/agent/{settings,models}.json`，可在终端 `pi` 或插件「设置 → 环境与模型」中配置；各分组可按需单独覆盖 `--model` / `--thinking`。

## 安装到 uTools

1. 构建产物：`npm run build` → 生成自包含的 `dist/`（外链 IIFE JS + 单文件 CSS + `shared/*.cjs` + `preload.js`）。
2. uTools → 设置 → 开发者 → 新建插件，选择 `dist/plugin.json`（运行 `npm run build` 后加载 `dist/`；浏览器热重载预览请运行 `npm run dev`）。

## 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `PIDECK_NODE` | 指定用于 spawn pi 的 node 可执行文件路径（默认多路径探测） |
| `PIDECK_PI_CLI` | 指定 pi 的 `cli.js` 路径（默认 npm 全局/pnpm/PATH 探测） |

若插件装在 uTools 内找不到 Node/pi（GUI 应用常不带 shell 的 PATH），设置这两个系统环境变量后重启 uTools。

## 模型配置（不碰终端）

设置 → **环境与模型**：

1. 选择服务商：DeepSeek / 阿里云百炼 / 硅基流动 / 智谱 GLM / 月之暗面 Kimi / OpenAI / Anthropic / Gemini / OpenRouter / 本地 Ollama / 自定义端点（可保存多个自定义网关与中转站）
2. 粘贴 API Key（本地 Ollama 可留空）；订阅型服务商可点「终端登录」；未装 pi CLI 时可点「终端一键安装」或手动指定 Node/pi 路径
3. 点「刷新模型」从可用模型或推荐列表里选择默认模型（也可手填模型 ID），保存即生效

保存只修改 `models.json` 的目标 provider 与 `settings.json` 的 `defaultProvider` / `defaultModel` / 思考强度，写前自动备份原文件（保留最近 5 份）。密钥以明文保存在本机 `models.json`，不会上传；也可手动改用环境变量或 `$ENV` 插值。保存后会重启长驻 RPC 进程，新配置从下一条消息生效。

环境横幅与首屏空态引导会在「Node/pi 未就绪或缺少可用模型凭证」时展示三步准备向导，支持一键终端安装、手动指定路径与直达配置。

## 运行引擎（设置 → 对话默认 → 响应模式）

| 模式 | 行为 | 会话语义 |
|---|---|---|
| 标准模式（默认） | 每条消息 spawn 一次 `pi --mode json --session-id` | 上下文由 pi 落盘（`~/.pi/agent/sessions`），可跨次续接 |
| 极速模式（后台预热） | 打开插件后台预热 `pi --mode rpc` 长驻进程，发送零冷启动；未就绪/失败自动回退标准模式 | 上下文仅存进程内存：切换会话时自动重置，进程被回收（5 分钟空闲 / 超出 3 个 / 彻底退出）后**不续接** |

RPC 的会话隔离：同一长驻进程在多个 PiDeck 会话间切换时会先重置进程内对话（实测验证），不会互相串上下文；但历史轮次不落盘，进程回收后从新开始。需要可靠的跨次记忆请用单次调用。

**历史会话续接**：RPC 进程内没有磁盘会话的上下文。打开历史会话继续对话时，插件会自动改用单次调用：若该会话曾由单次调用落盘，模型能续接；若历史来自 RPC（未落盘），会提示「本条作为新上下文开始」。新建会话在同一 RPC 进程内的连续对话仍走长驻预热。

## 工具权限

每个分组独立配置四档预设（纯文本 / 只读 / 可编辑 / 完整）+ 细粒度勾选（内置工具白名单、MCP 三态、扩展、技能、AGENTS.md 规范、项目级 `.pi` 信任）。写入与执行类工具（`edit`/`write`/`bash`/`powershell`）及项目级 `.pi` 信任（`--approve`）在 UI 中有显著风险标识：分组新增开启高风险权限需两步确认，且每个会话首次执行含高风险权限的发送前会在输入区上方弹出确认条。MCP 与扩展不受内置白名单约束，组合后的真实后果会显示在"工具影响"一行。

## 操作记录、数据流向与数据存储

- **数据流向**：对话输入、上下文与附带图片/文件仅由本机 `pi` CLI 直接发送给用户自行配置的模型服务商接口（或本地 Ollama），插件不上传、不经过第三方中转服务器。
- **操作记录（审计日志）**：由运行调度器在本机记录工具调用、权限摘要与对话汇总（自动脱敏并截断参数/结果，不记录对话全文、完整文件内容与密钥）。日志保存在 uTools 插件本地数据目录（`utools.getPluginLocalDataPath()/audit`，无 uTools 环境时回退 `~/.pideck/audit/`，按天 JSONL，保留 30 天，单片 20MB 自动分片），支持「只看风险」、导出 Markdown、清空记录。
- **存储分级**：分组配置、会话历史与用户偏好存入 `utools.dbStorage`（支持账号云同步）；输入草稿（低频防抖及切换/退出落盘）、本地引擎配置、已授权工作区与粘贴图片（30 天 / 200 MB 自动淘汰）保存在插件本地数据目录；模型/技能/默认配置缓存保存在插件临时目录（`utools.getPluginTempPath()`），不占用云同步空间。

「设置 → 对话默认」底部提供「清空所有对话」，会同时删除 pi 侧会话文件，需要两步确认。删除单条会话与删除分组也都改成了两步确认。

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
├─ public/preload.js      渲染层 ↔ Node/uTools 薄桥接层（piBridge）
├─ public/logo.png        原创插件图标（256×256 RGBA PNG）
├─ shared/pi-core.cjs     pi 多路径探测（含 nvm/fnm/volta/scoop）、JSONL 解析、权限拼装、扫描、诊断
├─ shared/rpc-engine.cjs  RPC 长驻引擎（按 cwd+配置 维护进程，new_session 会话隔离）
├─ shared/runner.cjs      进程调度、审计包装、异步模型列表与终端安装/登录逻辑
├─ shared/local-store.cjs 本地缓存、本机配置/状态、临时图片落盘/清理、外链与路径安全校验
├─ shared/audit.cjs       操作记录（本地 JSONL、脱敏、按天分片、30 天保留）
├─ shared/config.cjs      pi 配置读写（主流国内/海外/本地预设、多自定义端点、备份、apiKey 不落渲染层）
├─ dev-server-plugin.mjs  dev-only vite 中间件：/__pideck/api/*（复用 runner.cjs 提供 SSE 流式）
├─ AGENTS.md              项目级 uTools 插件开发规范与提审自检标准
├─ .agents/skills/        官方 uTools 开发规范与提交前自检 Skills
├─ src/App.vue            主界面协调层（双布局调度、发送/重新生成/取消、高风险确认）
├─ src/constants.js       共享常量与风险判定纯函数
├─ src/components/        Sidebar / TopRail / StatusReadout / Composer / TurnList / HistoryDrawer / SettingsModal(+4个子Tab) / EnvBanner / Icon
├─ src/composables/       usePiEnv / usePrefs / useToast / useConfirm / useSessionFilter
├─ src/sessions.js        会话持久化（单会话分 key + 索引、体积预算裁剪、索引损坏自动重建）
├─ src/groups.js          分组与工具权限数据模型（翻译默认中英互译）
├─ src/format.js          轻量 Markdown → HTML（先转义再生成标签，代码块带显式复制按钮）
└─ src/storage.js         存储分级契约（dbStorage 仅存用户数据；本地状态/缓存分离）
```
