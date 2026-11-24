# PiDeck 项目级开发规范（uTools 插件工程）

> 本文档结合 [uTools 官方开发文档](https://www.u-tools.cn/docs/)、项目内已安装的官方 Skills（`.agents/skills/utools-plugin-dev` 与 `.agents/skills/utools-plugin-selfcheck`）、`utools-api-types`（v8.0.0）以及 PiDeck 架构约定编写，作为本仓库开发、重构与提审自检的强制规范。

---

## 1. 项目定位、运行环境与目录结构

### 1.1 uTools Runtime 约束

- uTools 插件运行于官方管理的 **uTools Runtime**（Electron `34.5.8` / Chromium `132` / Node.js `20.19.1`），不以开发机本机 Node/浏览器版本推断插件宿主能力。
- 主界面运行在 `BrowserView` 中，默认挂载在 uTools 搜索框主窗口，也可被用户分离为独立窗口（`detach`）。
- 底层能力调用严格遵循官方文档与 `utools-api-types` 签名，禁止编造或推测未文档化的 uTools API、参数或行为。

### 1.2 项目目录职责

```text
PiDeck/
├─ public/
│  ├─ plugin.json          # uTools 插件清单（构建复制到 dist/）
│  ├─ preload.js           # 渲染层 ↔ Node/uTools 桥接层（保持明文、最小化）
│  └─ logo.png             # 原创插件图标（256×256 RGBA PNG）
├─ shared/                 # Preload 与 dev-server 共用 Node 模块（明文 .cjs）
│  ├─ pi-core.cjs          # pi CLI 定位、JSONL 解析、权限参数拼装、文件/技能扫描
│  ├─ rpc-engine.cjs       # pi --mode rpc 长驻进程池与会话隔离
│  ├─ runner.cjs           # 进程调度、审计包装、异步模型列表与终端登录脚本
│  ├─ audit.cjs            # 本地脱敏操作审计（getPluginLocalDataPath()/audit 按天 JSONL）
│  ├─ config.cjs           # ~/.pi/agent/{settings,models}.json 读写（密钥不回传渲染层）
│  └─ local-store.cjs      # 本地临时缓存、本机配置/状态、临时图片落盘/清理、安全校验
├─ src/                    # Vue 3 + Vite 前端界面层
│  ├─ App.vue              # 主面板协调层、对话调度、高风险首次发送确认
│  ├─ constants.js         # 全局共享常量与风险判定纯函数
│  ├─ storage.js           # 存储分级封装（dbStorage 仅存用户数据；缓存走本地目录）
│  ├─ groups.js            # 分组与工具权限模型
│  ├─ sessions.js          # 会话分 key 存储 + 索引维护与损坏重建
│  ├─ format.js            # 先转义后渲染的轻量 Markdown → HTML
│  ├─ dev-bridge.js        # 无 uTools 时的浏览器预览 mock 桥（与 preload 对齐）
│  ├─ components/          # UI 组件（Sidebar/TopRail/StatusReadout/Composer/TurnList/HistoryDrawer/SettingsModal+4Tab/EnvBanner/Icon）
│  └─ composables/         # 组合式状态（usePiEnv / usePrefs / useToast / useConfirm / useSessionFilter）
├─ tests/                  # Vitest 单元测试
├─ .agents/skills/         # 项目级 AI 开发与审核自检 Skills
│  ├─ utools-plugin-dev/
│  └─ utools-plugin-selfcheck/
├─ dev-server-plugin.mjs   # dev-only Vite 中间件（/__pideck/api/*，仅放行本机 Origin/Host）
├─ vite.config.mjs         # 生产构建（IIFE + 复制 shared/*.cjs + 剥离 development + HTML 兼容改写）
└─ dist/                   # 最终打包提交到 uTools 的产物目录（不纳入 Git）
```

### 1.3 已安装的项目级 Skills

- **开发规范查询**：`.agents/skills/utools-plugin-dev/SKILL.md`（含 `references/development/*.md` 与 `references/api-reference/*.md`）。新增或修改 uTools API 调用前，应先查阅对应参考文档。
- **提审前静态自检**：`.agents/skills/utools-plugin-selfcheck/SKILL.md`。每次打包 `dist/` 准备提交前，必须按该 skill 对 `dist/` 执行一次只读静态自检。

---

## 2. `plugin.json` 与入口配置规范

### 2.1 基础字段

- `main`：必填，相对于 `plugin.json` 的 `.html` 相对路径（`"index.html"`）。生产包严禁指向远程 URL。
- `logo`：必填，相对于 `plugin.json` 的图标路径（`"logo.png"`）。**严禁使用 uTools 默认 101/010 图标**（SHA-256 `c4a8ac6e06310f40e2512d44f5eace46376351f769ac689519a8ff486c18fe62`）或 Vite/Vue/Electron 默认占位图；必须使用代表本插件的原创 PNG（推荐 256×256 RGBA）。
- `preload`：相对于 `plugin.json` 的预加载脚本路径（`"preload.js"`）。
- `pluginSetting`：可选，`single`（默认 `true`）、`height`（默认 `544`，可由 `utools.setExpandHeight()` 动态调整）。
- `development`：若调试期配置了 `development.main`，生产构建（`vite.config.mjs`）会自动剥离 `dist/plugin.json` 中的 `development` 字段。

### 2.2 `features` 与 `cmds` 规范

- `features` 至少包含 1 个有效功能，且至少包含 1 条功能指令；每个 `feature` 保持独立职责与唯一 `code`。
- **功能指令（字符串）**：
  - 每个 `feature` 最多配置 5 个功能指令（超出部分会被 uTools 忽略）。
  - 长度 1~80 字符（推荐 ≤ 20 字符），禁止控制字符、操作系统保留字符（`\ / : * ? " < > |`）以及纯 Emoji/空白。
  - 中文指令无需手动配拼音或首字母，uTools 自动支持拼音/首字母检索。
- **匹配指令（对象）**：支持 `regex`、`over`、`img`、`files`、`window` 五类：
  - `regex`：**禁止**使用可匹配任意内容的宽泛正则（如 `/\.*/`、`/(.)+/`、`/[\\s\\S]*/`），会被 uTools 忽略且审核不通过；注意 JSON 中的反斜杠需双重转义。
  - `over`：需合理设置 `minLength` / `maxLength`（`maxLength` 上限按需节制），必要时配 `exclude`。
  - `files`：`extensions` 与 `match` 最多二选一，指定 `fileType`（`"file"` 或 `"directory"`）和合理的 `maxLength`。
  - `window`：`match.app` 为必填应用名数组，`match.title` 为可选正则。
- **一致性原则**：`features` 与可选 `tools`（需与 `utools.registerTool()` 名称和 `inputSchema` 一致）的声明必须与实际代码实现严格一致，不得声明未实现能力。

---

## 3. Preload 架构与安全边界规范

### 3.1 审核红线（绝对禁止）

1. **明文可读**：`preload.js` 及其 `require()` 的所有本地模块（如 `shared/*.cjs`）**严禁编译、打包、单行压缩或混淆**（包括 `_0x` 混淆、字符串整体编码、bytenode `.jsc` 等）。必须保持源码逐行可读、结构清晰。
2. **原生二进制禁止**：发行包中**严禁包含无法核对安全性的原生二进制**（`.exe`、`.dll`、`.so`、`.dylib`、`.node`，含 `node_modules/*/prebuilds/**`）。
3. **第三方依赖完整性**：若 `preload.js` 引入第三方 npm 包，需在同级维护 `"type": "commonjs"` 的依赖并随包完整提交 `node_modules`（PiDeck 当前 `preload.js` 与 `shared/*.cjs` 仅依赖 Node.js 内置模块，零外部 npm 运行时依赖）。
4. **禁止过宽能力暴露**：严禁将 `fs`、`child_process`、`os` 或通用的“任意路径读写 / 任意命令执行 / 任意 URL 请求 / 页面可自行写入白名单”方法直接挂到 `window`。

### 3.2 职责收敛与接口契约

- `preload.js` 遵循 CommonJS 规范，**只负责**三件事：
  1. 早期生命周期监听（如 `onPluginEnter` 事件排队防丢失）。
  2. 将业务逻辑模块（`shared/*.cjs`）封装为**单一命名空间** `window.piBridge` 暴露给渲染层（最小暴露原则，避免污染 `window`）。
  3. 对跨进程入参执行白名单与边界校验。
- 非必要业务逻辑（如缓存策略、配置文件读写、图片落盘清理、路径/URL 校验）沉淀到 `shared/local-store.cjs` 等独立模块，保持 `preload.js` 精简可读。
- **降级桥与 dev 桥对齐**：`preload.js` 的 `!core` 降级分支与 `src/dev-bridge.js` 暴露的 `window.piBridge` 方法签名和返回值结构必须与正常分支完全一致，避免渲染层取到 `undefined` 报错。

### 3.3 PiDeck 安全守卫红线

1. **外链打开（`openExternal`）**：
   - 前端（`usePiEnv.js`、`dev-bridge.js`）与 `preload.js` 双端校验：必须通过 `new URL(url)` 解析，**仅放行 `http:` 与 `https:` 协议**，拒绝 `file:`、`javascript:`、`cmd:`、`ms-msdt:` 等其它协议。
   - `preload.js` 中**仅调用 `utools.shellOpenExternal(safeUrl)`** 并用 `Promise.resolve(...).catch(() => {})` 兜底异步异常，禁止回退到 `shellOpenPath`；前端被拒后禁止再回退 `window.open`。
2. **本地路径定位/打开（`openPath`）**：
   - 渲染层**绝对不能**直接或间接写入允许打开的白名单根目录（严禁在 `run()` / `prewarmRpc()` 中记录渲染层传入的 `cwd`）。`preload.js` 仅信任 Node 侧固定目录及用户原生选择目录：`agentDir()`（`~/.pi/agent`）、`audit.dir()`（`getPluginLocalDataPath()/audit`）、默认工作区（`~/MyPiDeck`），以及通过原生系统对话框 `pickFolder()`（`utools.showOpenDialog`）由用户亲自选取的有效工作区目录。
   - 使用 `shared/local-store.cjs` 的 `resolveSafeOpenTarget()` 对目标与根目录均做 `fs.realpathSync()` 解析（防 `..` 穿越、兄弟前缀碰撞如 `C:\foo` vs `C:\foobar` 以及符号链接逃逸）。
   - **文件夹**调用 `Promise.resolve(utools.shellOpenPath(res.path)).catch(() => {})`；**文件**仅调用 `utools.shellShowItemInFolder(res.path)`（绝不对文件调 `shellOpenPath`，杜绝诱导执行本地可执行文件）。
3. **凭证与参数安全**：
   - `shared/config.cjs` 仅向渲染层回传 `hasKey` / `keyKind`，绝不回传 `apiKey` 原文。
   - `shared/pi-core.cjs` 拼装 CLI 参数时，选项值禁止以 `-` 开头，所有用户输入置于 `--` 之后。
4. **高风险工具最小默认权限与确认**：
   - 默认分组均为「纯文本」或「只读」，`tool.trust` 默认为 `false`（默认传 `--no-approve`，不自动批准项目级 `.pi` 配置）。
   - 分组设置页新增开启 `edit`/`write`/`bash`/`powershell` 或 `trust` 时需两步确认，并在 UI 标红提示；会话首次触发含高风险权限的发送前，须在输入区上方弹出确认条让用户确认生效权限与工作区目录。

---

## 4. 数据存储分级与同步规范（核心红线）

依据 `references/development/storage.md` 与审核规范，不同生命周期的数据**必须**严格分级存放：

| 数据类别 | 存储机制 / API | 生命周期 | 账号云同步 | PiDeck 示例 |
| --- | --- | --- | --- | --- |
| **用户数据** | `utools.db` / `utools.dbStorage` | 长期 | **是** | 分组配置（`pideck.groups.v1`）、激活分组、用户偏好、会话索引与消息（`pideck.session.<id>`） |
| **应用本地数据** | `utools.getPluginLocalDataPath()`（降级 `~/.pideck/`） | 长期（本机） | **否** | 操作审计 JSONL（`audit/`）、本地引擎与路径覆盖配置（`config.json`）、高频草稿（`state.json`：`pideck.drafts.v1`）、粘贴/发送的本地图片（`images/`，30 天 / 200 MB 上限且随会话清理） |
| **临时 / 可重建缓存** | `utools.getPluginTempPath()`（降级 `os.tmpdir()` / 浏览器 `localStorage`） | 运行期 / 短期 | **否** | 模型列表缓存（`models`）、技能列表缓存（`skills`）、默认配置缓存（`defaults`）、终端登录/安装临时脚本 |
| **用户导出文件** | `utools.showSaveDialog()` / `utools.getPath('downloads')` | 用户管理 | **否** | 会话 Markdown 导出、操作记录导出 |

### 强制规则

1. **严禁向 `utools.db` / `utools.dbStorage` 写入非用户数据**：禁止写入缓存、日志、高频草稿/临时标记、搜索索引、临时数据、Base64 大图片、操作记录或下载文件。
2. **IPC 序列化契约**：向 `utools.dbStorage.setItem` 写入时必须先 `JSON.stringify`，避免 Vue Reactive Proxy 经过 Electron IPC 克隆失败；读取时兼容旧对象与 JSON 字符串。
3. **单文档上限与拆分**：`utools.db` 单文档最大 **1 MB**，更新已有文档需携带最新 `_rev`；集合型数据（如历史会话）必须按单条分 key 存储并维护轻量索引（参考 `src/sessions.js`），写入前通过 `fitSessionBudget()` 控制在 850 KB 以内，避免超限失败与同步冲突。
4. **本地与临时目录边界**：`getPluginLocalDataPath()` 在卸载后仍可能保留，需自行做版本兼容与空间清理；`getPluginTempPath()` 在插件退出或 uTools 退出时会被系统清理，不得存重要持久数据。

---

## 5. uTools 生命周期与常用原生 API 速查（v8）

### 5.1 生命周期与防丢事件

- **`utools.onPluginReady(cb)`**：插件首次加载完成时触发（支持返回 Promise，Runtime 会等待其完成再进入插件）。
- **`utools.onPluginEnter(action)`**：每次进入插件触发，参数 `{ code, type, payload, from, option }`。
  - **关键约定**：由于 Vue 挂载晚于 `preload.js` 执行，`preload.js` 必须在顶层尽早注册 `onPluginEnter`，将事件推入 `window.__pideckEnterQueue` 并派发 `pideck:enter`，渲染层 `onMounted` 后补放队列。
  - 区分 `action.type`：`type === 'text'` 时 `payload` 是触发词本身（如 `"pi"`）；仅 `over` / `regex` 时 `payload` 是用户选中/输入的文本；`img` 为 Base64 Data URL；`files` 为 `MatchFile[]`。
- **`utools.onPluginOut(isKill)`**：插件隐藏到后台（`isKill === false`）或彻底退出进程（`isKill === true`）时触发。`isKill === false` 时立即保存草稿并在非运行态清理空闲长驻子进程；`isKill === true` 时须强制取消运行中任务并停止所有常驻 RPC 子进程，避免遗留孤儿进程。
- **`utools.onPluginDetach()`**：用户分离插件为独立窗口时触发。
- **`utools.onDbPull(docs)`**：云同步数据拉取到本机时触发。

### 5.2 常用系统、窗口与扩展能力

- **窗口控制**：`getWindowType()`、`hideMainWindow()`、`showMainWindow()`、`setExpandHeight(height)`、`setSubInput(...)`、`outPlugin(isKill)`、`createBrowserWindow(...)`（仅独立面板/悬浮窗等特殊场景使用，常规界面留在主 `BrowserView`）。
- **系统与对话框**：`showOpenDialog()`、`showSaveDialog()`、`showNotification()`、`getPath(name)`、`getPluginLocalDataPath()`、`getPluginTempPath()`、`isDarkColors()`、`isWindows()`/`isMacOS()`/`isLinux()`、`getNativeId()`、`getUser()`。
- **剪贴板合规**：仅允许在**用户主动触发动作**（如粘贴事件、点击按钮）时读取剪贴板或调用 `getCopiedFiles()` / `copyText()`；**严禁后台定时器持续监听或轮询剪贴板**。
- **v8 生态能力**（按需查阅对应 `references/api-reference/*.md`）：动态功能（`setFeature`）、定时任务（`requestSchedule` + `onScheduleTrigger`）、搜索框推送（`onMainPush`）、`utools.ai` / `registerTool`、`utools.ubrowser`、`utools.sharp`、`utools.runFFmpeg`。

---

## 6. 前端工程、构建兼容与 Dev 调试规范

1. **禁止远程代码与动态执行**：严禁在 HTML 中引入外部 `<script src="https://...">`、动态 `import(externalUrl)`、以及使用 `eval()` / `new Function()` 执行不可信或远程代码；静态资源全部打包进 `dist/` 本地加载。
2. **`file://` 与 CSP 兼容（`vite.config.mjs`）**：
   - `base: './'`，`cssCodeSplit: false`，`rolldownOptions.output.format: 'iife'`，`modulePreload: false`。
   - 构建后钩子必须：剥离 `<script>` 的 `type="module"`/`crossorigin` 并移至 `</body>` 前（外链保持，不内联以通过 CSP `script-src 'self'`）；剥离 CSS `<link>` 的 `crossorigin`；复制 `shared/*.cjs` 到 `dist/shared/`；剥离 `dist/plugin.json` 的 `development` 段。
3. **首屏性能与渲染安全**：
   - 首屏输入层（T0）仅做同步必要状态初始化，目标 `<100ms` 可输入；模型/技能/环境诊断/默认配置在挂载后异步刷新。
   - 长消息列表分页挂载（`PAGE_SIZE = 60`）。
   - Markdown 渲染（`src/format.js`）先转义 `& < >` 再生成标签，链接仅匹配 `https?://` 且禁止属性注入。
4. **Dev 预览环境安全**：`dev-server-plugin.mjs` 仅在 `apply: 'serve'` 生效，且必须校验 `Origin` 与 `Host` 仅允许 `localhost` / `127.0.0.1` / `[::1]`。

---

## 7. 测试与提审自检流程

### 7.1 本地验证命令

```bash
npm test       # Vitest 单元测试（须 100% 通过）
npm run build  # 构建生产包 dist/（须无报错）
```

### 7.2 提交审核前自检清单（对应 `utools-plugin-selfcheck`）

每次发布新版本前，必须以 **`dist/` 目录**（而非源码根目录）为对象完成以下逐项核验：

- [ ] **图标原创性**：`dist/logo.png` 为原创设计，SHA-256 ≠ `c4a8ac6e06310f40e2512d44f5eace46376351f769ac689519a8ff486c18fe62`，非框架默认图。
- [ ] **同步库纯净度**：检索 `dist/` 中 `utools.db` / `utools.dbStorage` 调用，确认仅存分组/会话/偏好等用户数据，**无**缓存、日志、临时数据或大二进制。
- [ ] **Preload 明文与最小暴露**：`dist/preload.js` 与 `dist/shared/*.cjs` 均未压缩/混淆，无 `.jsc`；未向 `window` 暴露 `fs`/`child_process` 或任意路径/命令/URL 通道。
- [ ] **安全边界**：`openExternal` 仅放行 `http:`/`https:` 且仅调 `shellOpenExternal`；`openPath` 经白名单根目录 + `realpathSync` 校验且文件仅调 `shellShowItemInFolder`；高风险工具权限默认关闭且有显式确认。
- [ ] **无远程脚本与剪贴板轮询**：`dist/index.html` 与 `dist/assets/*.js` 无远程 `<script>`、`eval`/`new Function` 或后台剪贴板轮询。
- [ ] **产物洁净度**：`dist/` 中无 `.git`、`.vscode`、`.idea`、`.agents`、`tests/`、`*.map`、`.exe`/`.dll`/`.so`/`.dylib`/`.node` 等残留或未核验二进制，`dist/plugin.json` 不含 `development` 字段且 `main` 指向本地 `index.html`。
- [ ] **描述与能力一致**：`plugin.json`、`README.md` 与商店介绍/截图与插件实际功能一致，无未实现声明或夸大描述。
