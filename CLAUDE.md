# CLAUDE.md

本文件为 Claude Code 在本仓库工作时的向导：项目结构、模块职责、开发命令与必须遵守的契约。

## 项目概览

`dsh-comfyui` 是 **DeepSeek Harness (DSH / cordis) 的 ComfyUI 插件**：让 Agent 通过工具直接驱动 ComfyUI 生成、处理图像与视频，并在浏览器端提供工作流库 / 资产 / 队列面板、对话内媒体卡片和设置页。

- 包名 `dsh-comfyui`，ESM（`"type": "module"`），Node ≥ 22.19，MIT。
- 入口：host 侧 `lib/index.js`（由 `src/*.ts` 经 tsc 编译）；浏览器侧 `client/client.js`（由 `src/client/*` 经 tsdown 打包）。
- peer 依赖：`@deepseek-ai/cordis`（必需）、`@deepseek-ai/dsh-settings`（可选，设置页持久化）。运行时依赖只有 `@deepseek-ai/schemastery`。
- `cordis.patch.yml` 把插件以 `id: comfyui` 插入 profile 层栈；`package.json` 的 `dsh` 字段声明 bundle patch 与 client 平台/注入。

## 常用命令

```sh
npm run typecheck    # host + client 双 tsconfig 类型检查（不产物）
npm run build        # build:host (tsc → lib/) && build:client (tsdown → client/client.js)
npm run build:host   # 仅 host
npm run build:client # 仅客户端 bundle
npm pack --dry-run   # 发布前必查：README 引用的资源都要在 files 白名单里
node scripts/test-store-params.mjs   # 离线自测：参数保存/重载（需先 build）
```

**改动生效规则**：`src/*.ts`（host：tools/routes/store/params/skill…）改完要 **重启 DSH**；`src/client/*` 改完 **刷新页面** 即可。skill 文本编译进 `lib/skill.js`，属 host 侧。

构建产物 `lib/`、`client/` 不入库（见 `.gitignore`），clone 后需 `npm install && npm run build`。

## 架构

插件分两半，通过同源 HTTP 路由通信，浏览器 **从不** 直连 ComfyUI（无 CORS、无混合内容、密钥不下发）：

```
Agent ──tools──┐
               ├─→ ComfyUIRuntime（src/index.ts 组装的能力对象）
浏览器 ─routes─┘        │
                        ├─ ComfyUIClient (comfyui.ts) ──HTTP/WS──→ ComfyUI 服务器
                        ├─ ComfyUIStore  (store.ts)   ──JSON 文件─→ $DSH_HOME/data/dsh-comfyui/
                        ├─ QueueTracker  (queue.ts)
                        └─ ProgressTracker (progress.ts, WebSocket)
浏览器 ←媒体─ /comfyui/media 同源代理 (proxy.ts)
```

`ComfyUIRuntime`（定义在 `src/tools.ts`，实例化在 `src/index.ts`）是唯一的能力面：工具层和路由层都只依赖它，不各自持有 client/store。新增功能优先加 runtime 方法，而不是在 routes/tools 里直接 new client。

### 两个"工作流主题"（贯穿全项目的核心概念）

- **图工作流（衍生主题）**：ComfyUI 端保存的画布 UI 图（nodes/links/widgets），是"源"，**不能直接运行**；一张画布可能含多个互相独立的流程。
- **API 工作流（运行主题）**：API 格式 prompt（node id → `{ class_type, inputs }`），是"运行单元"，由图 **提取（extract）** 而来或用户直接粘贴导入。

提取路径：`analyzeGraph`（连通分量分析）→ 用户在面板选 整体 / 按分量 / 主流程 → `convertGraphToApi`（图→API）→ `analyzeWorkflowParameters`（识别可调参数）→ `store.saveWorkflow`。

## host 侧模块（`src/`）

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 插件入口：解析配置、组装 `ComfyUIRuntime`、注册设置节 / 工具 / skill / 路由 / 媒体代理，全部挂在 fiber 上随插件卸载。`export const inject = ['tools']`。 |
| `config.ts` | schemastery 配置 schema（同时供 cordis.yml 入口配置和 `comfyui:` 设置节使用）+ 同形状的 TS 类型。`outputDir` 只走 cordis.yml，留空时删除资产会自行推断 ComfyUI 输出目录。 |
| `comfyui.ts` | ComfyUI HTTP 客户端：queuePrompt / history / queue / jobs / userdata / object_info / view / upload / interrupt 等，加上 `collectMedia`、`mediaProxyUrl`、`waitForCompletion`。上传有两个入口：`uploadFile` 转发浏览器原样的 multipart，`uploadMedia` 用 FormData 包好字节再传（`/upload/image` 只吃 multipart，裸 body 会 400）。模块级 `CLIENT_ID` 让排队与 WS 进度同源。 |
| `store.ts` | 持久化：工作流库、资产索引、加载区加载位（`LoadSlot[]`，`null` = 空位，兼容旧的单图格式）、媒体尺寸、上传哈希、任务跟踪，均为 dataDir 下的 JSON 文件。 |
| `queue.ts` | `QueueTracker`：记住本插件提交过的 prompt，`sweep()` 在读取（queue/assets 路由）时把完成的运行归档进资产索引；无后台定时器。 |
| `progress.ts` | `ProgressTracker`：连 ComfyUI `/ws` 收 `progress` 事件，best-effort（远端鉴权代理下可能无进度），断线重连直到 dispose。 |
| `analyze.ts` | 画布分析：groups 无执行语义，可执行单元 = 激活节点的连通分量，忽略 bypass(mode 4) 与悬空 UI 节点。 |
| `convert.ts` | 图 → API 转换：链接变 `[String(nodeId), slot]`，widgets_values 按图节点自身 `inputs` 顺序对齐，Reroute/bypass 直通，无法表达的节点报错。 |
| `params.ts` | 可调参数：自动识别（提示词/分辨率/步数/种子/时长/宽高比/加载节点）+ 用户高级参数；`numberSpecOf` 从 object_info 读数字输入的声明类型（INT/FLOAT + min/max/step），存进参数的 `numberKind`；`applyWorkflowParameters` 在运行时写回工作流（int 四舍五入、bool 归一化 `"true"`/`0` 这类写法、连线输入与加载参数不被空默认值覆盖、未传值的加载参数按加载位顺序取用）。 |
| `templates.ts` | 内置 API 模板：`txt2img`、`img2img`（核心节点）、`video`（Wan 2.1，需 ComfyUI-WanVideoWrapper）。 |
| `tools.ts` | 模型侧工具定义与注册 + `ComfyUIRuntime` 接口 + 后台任务/结果回显。 |
| `routes.ts` | 浏览器侧同源 HTTP 路由（面板与设置页的全部数据来源），写操作强制同源。 |
| `proxy.ts` | `/comfyui/media` 媒体代理：主路径按 `file`+`subfolder`+`type` 直取（不依赖 history），旧的 prompt/node/index 链接先查 history，查不到再回落到资产索引里的文件引用。 |
| `http.ts` | 路由小工具：`sendJson` / `readJsonBody` / `readRawBody` / `sameOrigin` / `errorMessage`。 |
| `host-hint.ts` | 记住浏览器实际访问用的 origin（Host/Referer），让生成的媒体 URL 对远端浏览器可达；回环 origin 不覆盖已知外部 origin；`detectLanOrigin` 作兜底。 |
| `skill.ts` | 配套 skill `dsh-comfyui-workflows`（runtime，rank 250）：两个主题的区分、画布分析规则、图→API 技术规则、参数与加载区说明、省 token 的运行流程。 |

### Agent 工具（`registerComfyUITools`）

| 工具 | 作用 |
| --- | --- |
| `comfyui_run` | 提交 `workflow`（API 格式）或 `template`（txt2img / img2img / video），`inputs` 按节点 id 覆盖输入；`mode: sync`（默认，返回媒体）/ `async`（返回 job id，用 `job_output` 收结果）。 |
| `comfyui_object_info` | 列出服务器支持的节点定义，可用 `filter` 按类名子串收窄。 |
| `comfyui_workflow` | `action: list` 列出库里可运行工作流（参数清单含 `numberKind` 整数/小数标注）+ ComfyUI 端图工作流（含 `extracted` / `derived`）+ `loadArea`（加载位数量与已放入的素材，Agent 据此知道用户加载了什么）；`action: run` 按 id 运行并传 `parameters` 覆盖；`action: get` 仅供诊断（输出完整 JSON，很费 token）。 |

### 浏览器路由（全部挂在 `webServer` 子 fiber 上）

`/comfyui/` 前缀，写操作要求同源：

- 配置与探活：`ping`(GET)、`config`(GET 读脱敏 / POST 写)、`test`(POST 连接探测)
- 工作流库：`workflows`(GET/POST)、`workflows/recognize`(POST)、`workflows/input-options`(POST)、`workflows/delete`(POST)、`workflows/run`(POST)
- ComfyUI 端图工作流：`comfy-workflows`(GET)、`comfy-workflows/analyze`(GET)、`comfy-workflows/extract`(POST)
- 加载区与媒体：`loadarea`(GET，返回全部加载位)、`current-image`(POST，动作 `pick` / `addSlot` / `clear` / `removeSlot`)、`upload`(POST)、`media-size`(POST)、`media-lookup`(POST)、`media-hash`(POST)、`media`(GET/HEAD，见 `proxy.ts`)
- 资产与队列：`assets`(GET)、`assets/delete`(POST，删记录 + 删输出文件)、`queue`(GET)、`jobs`(GET)、`jobs/media`(GET)、`jobs/actions`(POST)

## 客户端模块（`src/client/`，React + slots）

`index.ts` 通过 `ctx.slots.inject` 注册四处贡献：

| 槽位 | 内容 |
| --- | --- |
| `tool.call.toolview`（keys `comfyui_run` / `comfyui_workflow`） | `card.tsx`：对话内媒体墙卡片（生成中状态 / 结果 / 点击放大） |
| `settings.section`（id `comfyui`） | `settings.tsx`：设置页，读写 `/comfyui/config`，`/comfyui/test` 探测，含 zh/en 界面语言切换 |
| `shell.overlay`（id `comfyui.panel`） | `panel.tsx`：浮动面板，三个页签 **工作流 / 资产 / 队列**，可拖拽缩放，几何信息存 localStorage；工作流页底部是多加载位的加载区，资产页卡片带删除确认框 |
| `conversation.session.header.actions`（id `comfyui`） | `trigger.tsx`：会话头部按钮，开关面板 |

配套：`panel-store.ts`（面板开关/页签的模块级 store + `useSyncExternalStore`）、`api.ts`（同源 fetch 封装）、`lightbox.tsx`（共享灯箱）、`i18n.ts`（zh/en 词典，语言存 localStorage，不跟随 host locale）、`styles.ts`（一次性注入样式，颜色取 host 主题 token `--dsw-alias-*`）。

客户端 bundle 由 `tsdown.config.mjs` 产出：CJS + `window.__ModuleLoader__.load({ id, factory })` banner/footer；`PLATFORM_EXTERNALS` 里的模块（react、cordis、dsh-client-ui-*）**必须保持 external**，其余全部内联。

## 运行时数据文件

默认 `$DSH_HOME/data/dsh-comfyui/`（未设则 `~/.dsh/data/dsh-comfyui/`），可用配置 `dataDir` 覆盖：

`workflows.json`（工作流库）、`assets.json`（资产索引）、`current-image.json`（加载区加载位列表，`null` = 空位）、`media-sizes.json`（上传图像素尺寸）、`media-hashes.json`（内容哈希 → 文件名，去重）、`tracked.json`（本插件提交的任务）。

## 必须遵守的契约（踩过坑）

1. **服务注入**：任何通过 `ctx.<服务名>` 访问的 cordis 服务都必须出现在 `export const inject` 里，否则 cordis 在 boot 期抛 `cannot get property "<name>" without inject`，报错点远离肇事代码。可选服务（`webServer` / `settings` / `credentials` / `skills`）**不要**进 `inject`，改用 `ctx.get(...)` 或 `ctx.inject([...], cb)` 子 fiber，让插件在无该服务的 headless 宿主上优雅降级。
2. **注入会话的消息必须符合 host 的 `Message` 契约**：`id`（UUID 非空）+ `role` + `content` + `source` 四者齐全。缺 `id` 会写坏 append-only 会话日志，加载时 `assertMessageEventShape` 让 **整个会话报废**。见 `docs/INCIDENTS.md`；相关代码在 `src/tools.ts` 的 `echoCompletion`（带 CONTRACT 注释）。新增任何"向会话/模型注入内容"的路径后，用 `scripts/analyze-sessions.mjs` 复检会话日志。
3. **API 工作流的节点引用必须是字符串**：`[String(nodeId), slot]`，服务端按字符串键字典查找，数字会 KeyError。
4. **生命周期**：所有注册（工具、路由、代理、样式、WS）都要走 `ctx.effect` / 子 fiber 并返回 disposer，随插件卸载干净收回；不要留裸定时器（`queue.sweep` 就是为此改成"读时清扫"）。
5. **视频/音频工作流一律 `mode: "async"`**：同步等待会超时中断。
6. **不要把完整工作流 JSON 输出到回复里**：运行走 `comfyui_workflow run { id, parameters }`，`action: get` 只用于诊断。
7. **媒体 URL 必须按文件寻址**（`file` + `subfolder` + `type`），不要依赖 ComfyUI 的 `/history`：history 是内存态，ComfyUI 重启或用户点"清空历史"就没了，按 prompt/node/index 生成的链接会全部 404，面板显示"源文件已被 ComfyUI 清理"，而文件其实还在 output 目录。`collectMedia` 走 `mediaProxyUrl`，历史记录里的旧链接由 `/comfyui/assets`、`/comfyui/loadarea` 的 `healAssetUrls` 与代理的资产索引回落救回。
8. **参数写回要区分"没传"和"传了空值"**：`applyWorkflowParameters` 默认会把 `default` 写回节点输入，所以空默认值（`default: ''`）在未显式传值时必须跳过两类参数——暴露在**连线输入**上的高级参数（面板已不再提供这类输入，但库里可能有历史参数，写回会冲掉连线）和**加载参数**（否则清空节点的文件名，运行直接失败）。例外是 `upload: 'media'` 参考位，那里空值的语义就是"移除该位"。
9. **加载节点的输入键要从 object_info 读**（`loaderInputKey` 找带 `*_upload` 标记的输入），不要写死：`LoadImage` 是 `image`，`LoadVideo` 是 **`file`**，`LoadAudio` 是 `audio`——写死 `video` 会让整类媒体在加载区里凭空消失。文件类型按扩展名判定（同一个 `.mp4` 会同时出现在 LoadVideo 与 LoadAudio 的候选列表里）。
10. **删除资产只能自己动文件系统**：ComfyUI 全服务端唯一的 DELETE 路由是 `/userdata/{file}`（用户目录），0.32 的 `DELETE /api/assets/{uuid}` 需 `--enable-assets` 且源码里 `delete_content_if_orphan=False`——只软删数据库引用，**文件保留**。所以 `assets/delete` 路由用 `resolveOutputDir`（配置 `outputDir` 优先，否则从记录里的 `fullpath` 反推）+ `unlink`；务必保留那道 `relative()` 路径穿越检查，`subfolder` 是 ComfyUI 给的、不可信。输出目录不可达时降级为只删索引记录。
11. **加载区是一组加载位而不是一张图**：`store.loadSlots()` 返回 `Array<CurrentImage | null>`（`null` = 用户加过但还没放素材的空位），已放入的按顺序填进未显式传值的加载参数（同类型匹配）。加载位数量与内容通过 `comfyui_workflow action: list` 的 `loadArea` 字段暴露给 Agent，别让模型去猜或反复问用户。

## 辅助脚本（`scripts/`，不随 npm 包发布）

| 脚本 | 用途 |
| --- | --- |
| `analyze-sessions.mjs` | 只读扫描会话日志（zstd 逐帧解压），找缺 `id` 的 message 事件——新增任何"向会话注入消息"的路径后必须跑 |
| `inspect-tool-meta.mjs` | 按 promptId 查会话日志里的 tool-result meta，排查媒体回显 |
| `test-store-params.mjs` | 离线自测：参数经 store 保存 → 重载 → 编辑后仍保留（需先 `npm run build`，它导入 `lib/store.js`） |
| `run-cg-portrait.mjs` / `run-16x9.mjs` | 真机冒烟：打同源路由（默认 `http://127.0.0.1:3080`）跑一次带自定义 prompt 的工作流，需 DSH + ComfyUI 都在运行 |

## 代码风格约定

- ESM + NodeNext：host 侧相对导入**必须带 `.js` 后缀**（`./store.js`）。客户端侧由打包器解析，现有代码 `.ts` / `.tsx`（`allowImportingTsExtensions`）与 `.js` 后缀混用（如 `./lightbox.js`），两种都能构建，改动时跟随所在文件的写法即可。
- `strict` + `noUncheckedIndexedAccess` 全开：索引访问结果按 `T | undefined` 处理；判空一律显式 `=== undefined` / `!== undefined`，不用真值判断（现有代码通篇如此）。
- 每个文件顶部有一段块注释说明该模块"为什么存在"，新增文件保持同样风格；关键取舍（如为什么不用 WS 拿结果、为什么 sweep 放在读路径）就地写进注释。
- 客户端不用 JSX 语法而是 `createElement as h` 调用，样式集中在 `styles.ts` 的单个 CSS 字符串里，颜色只用 host 主题变量 `--dsw-alias-*`。
- 面向用户/Agent 的文案是中文（skill、面板、错误提示），代码注释与标识符是英文。

## 相关文档

| 文件 | 内容 |
| --- | --- |
| `README.md` / `README.en.md` | 用户文档（中 / 英，npm 首页渲染 `README.md`）。改功能时同步更新两份的功能列表与截图。 |
| `DEVELOPMENT.md` | 维护者笔记：版本状态、时间线、辅助脚本、git / npm 发布流程、运行时数据文件。**本地文件，不入版本库**。 |
| `docs/INCIDENTS.md` | 事故复盘：注入消息缺 `id` 写坏会话日志导致整个会话无法加载。 |
| `AWESOME.md` | 上架 awesome-dsh-plugin / dshmarket 的材料与核对清单。 |

改动时的同步义务：**改功能** → 两份 README + `src/skill.ts`；**改结构 / 新增模块、路由、工具或契约** → 本文件；**发版** → `DEVELOPMENT.md` 的版本表与时间线。
