# dsh-comfyui

[English](README.en.md) | **中文**

<p align="center">
  <img src="logo.png" width="480" alt="dsh-comfyui logo" />
</p>

<h1 align="center">dsh-comfyui</h1>

<p align="center">让 DeepSeek Harness 的 Agent 智能驱动本地或远程 ComfyUI 生成任何内容。附带工作流、资产管理面板与技能包管理挂载。配套 skill 与同源媒体代理。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-comfyui"><img src="https://img.shields.io/npm/v/dsh-comfyui" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/dsh-comfyui"><img src="https://img.shields.io/npm/dm/dsh-comfyui" alt="npm downloads" /></a>
  <img src="https://img.shields.io/npm/l/dsh-comfyui" alt="license" />
</p>

> **版本配对（选对 dsh 版本再装，否则 dshmarket 会报风险提示）**：
>
> | dsh-comfyui | 配对的 DeepSeek Harness | 说明 |
> | --- | --- | --- |
> | **0.4.0（最新，`latest` tag）** | **≥ 0.1.2** | 0.4.0 起使用新版 settings 服务 API |
> | **0.3.x（beta 线，`beta` tag）** | **0.1.1** | 老版本 dsh 请留在 0.3.x 线 |
>
> 安装：`dsh plugin --profile web add dsh-comfyui`（装最新 0.4.0）/ `dsh plugin --profile web add dsh-comfyui@beta`（老宿主装 0.3.x）。

## 功能

### Agent 工具

Agent 直接驱动 ComfyUI，无需手动操作画布：

- `comfyui_run` —— 提交 API 格式工作流或内置模板（txt2img / img2img / video），返回生成媒体；`mode: "sync"` 等待结果，`mode: "async"` 后台任务（视频生成强烈建议）。
- `comfyui_object_info` —— 列出服务器支持的节点定义，让 Agent 现场构造合法工作流。
- `comfyui_workflow` —— 管理插件工作流库：`list`（含服务器地址、本机 ComfyUI 目录、加载区素材、每个工作流的参数清单）、`run`（按 id 运行 + 参数覆盖）、`skill`（按需读取某工作流的技能包）、`refresh`（重算参数快照）。
- `comfyui_skill` —— 读写工作流技能包（`list` / `read` / `write` / `append` / `mkdir` / `rename` / `delete` / `enable` / `require`），Agent 可把踩坑经验写回技能包，跨会话复用。

### UI 面板

右侧停靠面板，三个页签：

- **工作流** —— 可运行工作流库（新建 / 编辑 / 运行 / 删除 / 导入 `.json`，标签分类 + 下拉筛选）；自动检测 ComfyUI 端保存的图工作流，支持**提取**为可运行工作流（画布含多个独立流程时可选整体 / 按分量 / 主流程）。
- **资产** —— 所有生成结果，预览、下载、悬停可删除（同步清理 ComfyUI 输出目录里的文件）。
- **队列** —— 实时队列 + 历史任务五态展示，支持删除 / 中断 / 重跑 / 清空 / 释放内存，插件提交的任务带进度条与预览。

<p align="center"><img src="images/panel.png" width="70%" alt="插件主面板：工作流 / 资产 / 队列" title="插件主面板：工作流 / 资产 / 队列" /></p>

### 加载区（媒体加载器）

工作流页顶部的媒体加载器，仿 ComfyUI LoadImage 节点：图片 / 视频 / 音频可视化选择（可就地试听）、粘贴上传、多加载位。已放入的素材按顺序自动填进工作流里未显式指定的加载参数——**Agent 不需要猜文件名**；未传 `width`/`height` 时自动匹配源图分辨率。上传按内容哈希去重命名。

`comfyui_workflow list` 的 `loadArea` 字段会把加载位数与内容暴露给 Agent。

### 工作流技能包（给 Agent 的说明书）

参数清单只能告诉 Agent"有哪些旋钮"，说不出"这个工作流适合什么、哪一步会翻车"。复杂工作流可以挂一个**技能包**（面板工作流卡片上点「技能包」按钮启用）：

```
<数据目录>/skills/<工作流>/
  SKILL.md          # 主文档：适用场景 / 关键参数 / 注意事项
  references/       # 参考文档：风格合集、排错记录
  assets/           # 参考图等素材（可在面板预览）
```

- **按需三级披露，不占常驻上下文**：`comfyui_workflow list` 只有一行摘要 → 选中工作流后 `action: skill` 取正文 → 正文点名某份参考文档时才读那一篇。几十个工作流各带整套文档，平时对话成本也只是一行摘要。
- **面板编辑**：左栏文件列表 + 右栏编辑器，支持导入（按扩展名自动分目录）、自定义子目录、图片预览、把整个技能包目录挪到别的盘或同步盘（设置页 `技能包目录`）。
- **Agent 也能写**：`comfyui_skill` 工具让 Agent 查看/编写技能包——踩到坑就 `append` 进 SKILL.md，下次（换个会话也一样）直接复用经验。
- **运行前必读**：可勾选「运行前必读」，勾上后 Agent 本会话没读过该技能包就调 `run` 会被拒绝并提示先读。

### 媒体代理与设置

生成文件经同源路由（`/comfyui/media`）按文件名转发，不依赖 ComfyUI 内存态历史——重启或清空历史后旧结果照样能打开。浏览器不直接接触 ComfyUI：无 CORS、无混合内容、API Key 不下发。

DH 设置页新增 "ComfyUI" 分区：服务器地址、API Key 环境变量名、本机 ComfyUI 目录、媒体访问地址、测试连接、界面语言切换，改完即生效，无需改 `cordis.yml`。

## 安装

```sh
# web profile
dsh plugin --profile web add dsh-comfyui
# desktop profile
dsh plugin --profile desktop add dsh-comfyui
```

重启应用后：侧边栏出现面板入口，设置页出现 "ComfyUI" 分区，Agent 立即获得全部工具与配套 skill。

## 使用

直接告诉 Agent，例如：

- "用 ComfyUI 画一张红猫的图"
- "把这幅图转成赛博朋克风格"
- "把加载区这张动漫图转成真人照片，分辨率跟原图一致"
- "生成一段 5 秒的短视频：日落下的城市"
- "用我之前在 ComfyUI 里保存的 Krea-Afterlight 跑一下"（若该图还没提取，Agent 会转告你先去面板点**提取**）

远程 ComfyUI 若位于需鉴权的代理之后，通过凭据存储或 `apiKeyEnv` 指定的环境变量（默认 `COMFYUI_API_KEY`）提供密钥，绝不发给浏览器。

## 配置

`cordis.yml` 的 `comfyui` 段（多数可在设置页改）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI 服务器地址 |
| `apiKeyEnv` | `COMFYUI_API_KEY` | 可选 API Key 的环境变量 / 凭据名 |
| `dataDir` | *（DSH 数据目录）* | 工作流库与资产索引存放位置 |
| `comfyuiDirs` | `[]` | 本机 ComfyUI 安装目录列表（可多条），Agent 据此定位 models、自定义节点、TTS 音色库 |
| `outputDir` | `''`（自动推断） | ComfyUI 输出目录（删除资产时定位文件用） |
| `mediaHost` | `''`（自动检测） | 生成媒体的外网访问基址 |
| `skillsDir` | `''`（默认 `dataDir/skills`） | 技能包根目录（绝对路径，可放同步盘 / 版本库） |

## 环境要求

- DeepSeek Harness（`web` / `desktop` profile）
- 一个运行中的 [ComfyUI](https://github.com/comfystack/ComfyUI) 服务器（默认 `http://127.0.0.1:8188`）
- `video` 模板需要 [ComfyUI-WanVideoWrapper](https://github.com/kijai/ComfyUI-WanVideoWrapper) 与 Wan 2.1 模型

## License

MIT