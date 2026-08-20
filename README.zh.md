# dsh-comfyui

> 版本 0.2.0 —— 本阶段确认的功能范围见 [Roadmap 与设计边界](#roadmap-与设计边界v02)。

DeepSeek Harness (DH) 的 ComfyUI 集成插件：让 Agent 直接调用你的 ComfyUI 服务器生成和处理图像、视频——提交工作流、使用内置模板、在对话里直接看到生成结果，并通过右侧停靠的 UI 面板管理一切。

## 功能

- **Agent 工具**
  - `comfyui_run` —— 提交 ComfyUI API 格式的工作流，或选用内置模板，返回生成的媒体。两种模式：`sync`（等待并返回媒体）与 `async`（后台任务，用 `job_output` 收集结果——视频生成强烈建议）。
  - `comfyui_object_info` —— 列出你的 ComfyUI 服务器支持的节点定义，让 Agent 能当场构造合法的工作流。
  - `comfyui_workflow` —— 列出并运行插件库中的可运行工作流。`action: list` 还会报告你在 ComfyUI 端保存的图工作流以及每个是否已**提取**出可运行执行流；未提取的会明确标注，Agent 会先转告你在面板里点"提取"。
- **UI 面板**（右侧停靠；从侧边栏轨道打开）——三个页签：
  - **工作流** —— 插件库（可运行的 API 工作流）：新建 / 编辑 / 运行 / 删除，支持"导入文件"直接加载 API 格式 `.json`。"ComfyUI 端保存"分区自动检测你在 ComfyUI 里保存的图工作流，显示每个已提取出的执行流，并提供**提取**：画布上往往躺着多个独立流程，可整体提取 / 按分量提取 / 只提取主流程。工作流可用**标签**分类（见下）。
  - **资产** —— 插件生成的所有结果，最新在前，带详情视图和下载链接。
  - **队列** —— 基于 ComfyUI 统一任务 API（`/api/jobs`）的任务中心：实时队列**和**历史里所有任务按五态展示（待生成 / 生成中 / 已完成 / 失败 / 已取消），可按状态筛选；插件提交的任务带进度条（进度来自 ComfyUI WS 的 progress 事件），终态任务带预览缩略图、失败原因与耗时；支持操作：删除、中断、重跑、清空队列/历史、释放内存。插件提交的任务标注工作流名。
- **加载区** —— 仿 ComfyUI LoadImage 节点的图像加载器，位于工作流页顶部：
  - 当前源图以大图展示；点击打开加载窗口：上方导航条（全部 / 已导入 / 已生成）、类型筛选、右侧粘贴/上传区、下方瀑布流网格展示 ComfyUI `input` 目录全部图片 + 插件生成的全部结果。点击图像即选定并关闭窗口，成为当前源图。
  - 当前源图即**默认输入图**：任何含图片类参数（未显式指定）的工作流运行都会自动使用它——无需指定文件名。
  - **分辨率自动匹配**：上传时记录像素尺寸；运行时不传 `width`/`height` 则自动用源图实际分辨率。
  - **哈希命名 + 去重**：上传重命名为 `原名_短哈希.ext`（SHA-256 前 10 位十六进制）；重复上传相同文件直接复用已有文件名，不产生重复存储。上传后列表实时刷新。
  - 选中**已生成**的图时会自动从输出目录复制到 `input`，图像加载节点即可使用。
- **工作流标签** —— 用预设分类（图生图 / 文生图 / 文生视频 / 图生视频 / 参考生视频 / 文生音频 / 参考生音频）+ 自定义标签给可运行工作流分类。标签在编辑工作流时勾选/添加，显示在卡片右上角，列表顶部有带计数的标签筛选条。
- **内置模板** —— `txt2img`（SDXL 文生图）、`img2img`（SDXL 图生图）、`video`（Wan 2.1 文生视频，需要 ComfyUI-WanVideoWrapper）。模板节点 id 写在工具描述里，Agent 会覆盖正确的输入。
- **媒体代理** —— 生成文件经同源路由（`/comfyui/media`）转发，浏览器不直接接触 ComfyUI：没有 CORS、没有混合内容、页面里不出现 API Key，远程 ComfyUI 部署也可直接使用。
- **工具卡片** —— 结果在对话里渲染成媒体墙（图片/视频带下载链接），后台任务也有状态提示。
- **设置页** —— DH 设置里新增 "ComfyUI" 分区：改服务器地址、API Key 环境变量名、数据目录、资产上限、测试连接，并可切换插件界面语言（中文 / English——存于浏览器，作用于整个插件 UI），无需改动 `cordis.yml`。
- **配套 skill** —— 通过 `ctx.skills.register` 注册的运行时 skill（`dsh-comfyui-workflows`）：让 Agent 掌握图工作流 vs 执行流的概念、画布分析规则（连通分量、绕过组、悬空节点）、何时该询问你提取方式，以及图→API 提取的技术规则。

### 图工作流 vs 可运行工作流（提取执行流）

ComfyUI 分两层：

- **图工作流（衍生主题）** —— 你在 ComfyUI 里保存的 UI 图（nodes/links/widgets），是"源"，不能直接运行。一个画布常常是**同时测试多个独立流程的试验台**；视觉 `groups` 只是矩形，真正可执行单元是**连通分量**（按连线连通，排除绕过与悬空节点）。
- **可运行工作流（运行主题）** —— API 格式的 prompt，真正的执行单元。从图里**提取**出来（1 图 → N 个执行流），或直接粘贴/导入 API `.json`。

**提取**流程会先分析画布（各分量的节点数与所在组、绕过/悬空计数），然后让你选择：

- **整体提取** —— 所有分量合成一个执行流（运行时全部执行）。
- **按分量提取**（推荐）—— 每个独立流程一个执行流。
- **只提取主流程** —— 只取最大分量（通常是当前测试区块）。

提取严格对照实时 `/object_info`：重排 Reroute/bypass 直通、映射 widget 值（含动态子 widget 与 `control_after_generate`）、内联 Primitive、丢弃失效的输出槽位引用并警告、跳过无输出节点的分量、必需输入缺失时明确报错——每个提取出的执行流都会先经 `POST /prompt` 校验（`node_errors` 为空）才入库。

### 可调参数

每个可运行工作流带一组**可调参数**（`parameters`），让同一流程按需生成不同结果：

- **自动识别（保守集）**：提取时自动提取 提示词（文本输入节点）、分辨率（`EmptyLatentImage` 宽高）、采样步数（`KSampler.steps`）、种子（`KSampler.seed`，默认**每次运行随机**）。采样相关（cfg/denoise）与模型选择不暴露，保持工作流原样。
- **高级参数**：面板"编辑工作流"里可手动暴露任意节点的任意输入为参数（选节点 → 选输入 → 命名），并调整每个参数的名称、显示名、默认值、是否随机。
- **Agent 感知**：参数清单自动写入工作流的"参数说明"（`inputs` 字段），`comfyui_workflow` 工具的 `action: list` 会展示；`action: run` 接受 `parameters: {"prompt": "...", "seed": 42}` 覆盖——显式传值优先于随机/默认，未传参数用默认值。
- **加载区联动**：未显式指定的图片类参数自动填入加载区当前源图；未传的 `width`/`height` 自动匹配该图记录的像素尺寸。显式传值始终优先，Agent 仍可覆盖两者。

## 环境要求

- DeepSeek Harness（web profile）—— 本插件面向 `web` profile（`@deepseek-ai/dsh-web-app` ≥ 0.1.0-rc.6）。
- 一个运行中的 [ComfyUI](https://github.com/comfystack/ComfyUI) 服务器（默认 `http://127.0.0.1:8188`）。
- 使用 `video` 模板需要 [ComfyUI-WanVideoWrapper](https://github.com/kijai/ComfyUI-WanVideoWrapper) 自定义节点和 Wan 2.1 模型文件。

## 安装

```sh
dsh plugin --profile web add dsh-comfyui
```

然后重启 Web 服务（Host 端行在启动时挂载）。侧边栏轨道出现面板入口，设置页出现 "ComfyUI" 分区，Agent 立即获得 `comfyui_run`、`comfyui_object_info`、`comfyui_workflow` 与 `dsh-comfyui-workflows` skill。

### API Key（远程服务器）

远程 ComfyUI 若位于需要鉴权的代理之后，通过凭据存储或 `apiKeyEnv` 指定的环境变量（默认 `COMFYUI_API_KEY`）提供密钥。密钥在 Host 端按请求解析，绝不发给浏览器。

## 使用

直接告诉 Agent，例如：

- "用 ComfyUI 画一张红猫的图"
- "把这幅图转成赛博朋克风格"（img2img，需要输入图片文件名）
- "把加载区这张动漫图转成真人照片，分辨率跟原图一致"（加载区源图 + 分辨率自动匹配）
- "生成一段 5 秒的短视频：日落下的城市"（video，需要 Wan 插件）
- "用我之前在 ComfyUI 里保存的 Krea-Afterlight 跑一下" —— Agent 会列出服务器端的图工作流；如果你指的那个还没提取，它会先转告你去面板里点**提取**（画布可能含多个独立流程，可选整体/按分量/主流程）。

Agent 会选用模板，或用 `comfyui_object_info` 探查你的服务器，或用 `comfyui_workflow` 运行插件库里已保存的执行流。

### 配置

插件读取 `cordis.yml` 中的 `comfyui` 段（或通过设置页修改）：

```yaml
# cordis.yml
- id: comfyui
  name: dsh-comfyui
  config:
    baseUrl: http://127.0.0.1:8188
    apiKeyEnv: COMFYUI_API_KEY
    timeoutMs: 180000
    maxMediaItems: 12
    dataDir: ''
    maxAssets: 200
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI HTTP 服务器地址 |
| `apiKeyEnv` | `COMFYUI_API_KEY` | 可选 API Key 的环境变量/凭据名 |
| `connectTimeoutMs` | `10000` | 单次请求连接/读取超时 |
| `timeoutMs` | `180000` | 同步生成的等待预算（视频请调大） |
| `pollIntervalMs` | `1000` | 等待完成时的历史轮询间隔 |
| `maxMediaItems` | `12` | 每个工作流最多返回的媒体条数 |
| `maxMediaBytes` | `67108864` | 媒体代理单文件流式传输上限（字节） |
| `dataDir` | *（DSH 数据目录）* | 工作流库与资产索引存放位置（默认 `$DSH_HOME/data/dsh-comfyui`） |
| `maxAssets` | `200` | 资产索引最多保留的条数 |

## Roadmap 与设计边界（v0.2）

本阶段确认的范围决策：

- **图生视频 / 参考生视频 / 音视频变体**不是插件侧功能：它们与图生图共用同一个上传节点，任何这类工作流（提取或导入）开箱即用。缺的是工作流本身，不是插件代码。
- **不做前端参数预设/收藏**。高级定制在工作流编辑里完成（修改参数默认值，或把任意节点输入添加为高级参数）。保持唯一事实来源。
- **模型强度类参数**（如 `ref_boost`）走高级参数机制：暴露节点输入、标注作用，Agent 即可按次调节。
- **规划中**：运行参数自动回写——运行成功后把本次使用的参数值保存为该工作流的新默认值，下次打开就是上一次会话用的值，而不是作者初始值。

## 安全

- 工具只会连接**配置好的** `baseUrl` —— Agent 无法指定任意目标（SSRF 遏制）。
- API Key 只存在于 Host（凭据存储/环境变量），按请求解析；`/comfyui/config` 只回传 `hasApiKey`。
- 媒体有大小上限；配置写入要求同源请求。
- 从 ComfyUI 提取的执行流会先校验（非空 `class_type`、对象型 inputs、服务器 `node_errors` 为空）再入库。
- 无 Web 服务器的 headless profile 只保留工具，路由静默跳过。

## 架构

一个 npm 包、双端实现，遵循 DH 插件约定：

- `src/index.ts` —— Host 入口：`inject: ['tools']`；注册工具与配套 skill（`ctx.skills.register`，可选服务），并把路由与媒体代理挂到 `webServer` 子 fiber（`ctx.inject`）上，避免并发 settle 导致挂载被静默跳过。
- `src/comfyui.ts` —— 精简的 ComfyUI HTTP 客户端（排队、轮询历史、object_info、system_stats、interrupt、view 下载、userdata 列表/读取）。
- `src/analyze.ts` —— 画布分析：激活节点的连通分量、组归属、悬空/孤立节点、绕过计数。
- `src/convert.ts` —— 图 → API 提取：重排连线（Reroute / bypass 直通）、按图自身输入顺序 + object_info 推导 widget 顺序（含 `control_after_generate` 与动态子 widget）、内联 Primitive 值、丢弃失效的输出槽位引用并警告、必需输入缺失时明确报错。
- `src/skill.ts` —— `dsh-comfyui-workflows` 配套 skill 正文。
- `src/params.ts` —— 参数应用：未指定的图片参数填入加载区源图、`width`/`height` 自动匹配源图记录尺寸、DynamicCombo 父子联动同步。
- `src/store.ts` —— 工作流库与资产索引落盘（`workflows.json` + `assets.json`），以及加载区记录（`current-image.json`、`media-sizes.json`、`media-hashes.json`）。
- `src/queue.ts` —— 追踪插件提交的 prompt，完成后移入资产索引（读时清扫，无定时器）。
- `src/tools.ts` —— 通过 `ctx.tools.register` 注册的 `ToolDefinition`；结果携带 `presentationMeta`，客户端卡片从会话日志渲染。
- `src/routes.ts` —— 面板用的同源 HTTP 路由（配置、工作流、ComfyUI 端图 + 分析/提取、资产、队列、运行、加载区、带哈希去重与尺寸记录的上传）。
- `src/client/` —— 浏览器端：`shell.overlay` 右侧停靠面板 + `sidebar.footer.action` 触发器、`tool.call.toolview` 卡片（key `comfyui_run`）、`settings.section` 设置页（id `comfyui`）。
- `cordis.patch.yml` —— `dsh.bundle.patch` 补丁层，把 `comfyui` 行插入 profile。

## 开发

```sh
pnpm install
npm run typecheck   # host + client
npm run build       # tsc（host lib/）+ tsdown（client bundle）
npm pack --dry-run  # 检查发布内容
```

本地测试：`dsh plugin --profile web add <本仓库路径>`（pnpm 链接目录），重启 Web 服务，改动后 `npm run build` 重新构建。

## License

MIT
