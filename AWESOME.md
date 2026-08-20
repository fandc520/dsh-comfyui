# awesome-dsh-plugin 上架材料

本文档是 dsh-comfyui 上架到 [awesome-dsh-plugin](https://awesome-dsh-plugin.com)（进而自动进入 dshmarket 市场）的准备材料。发布 npm 包并创建 GitHub 仓库后，把下面的条目按站点格式提交即可。

## 建议条目（英文）

```markdown
- [dsh-comfyui](https://github.com/<你的用户名>/dsh-comfyui) — Drive ComfyUI from DeepSeek Harness: agent tools (`comfyui_run`, `comfyui_object_info`, `comfyui_workflow`), a right-docked panel with a runnable-workflow library, ComfyUI-side graph auto-detect & extract (整体/按分量/主流程, canvas component analysis), asset preview, live queue, SDXL & Wan 2.1 templates, a companion skill, same-origin media proxy, in-chat media card and a settings page. `dsh plugin --profile web add dsh-comfyui`
```

## 建议条目（中文，如站点支持）

```markdown
- [dsh-comfyui](https://github.com/<你的用户名>/dsh-comfyui) — 让 DeepSeek Harness 的 Agent 直接驱动 ComfyUI：`comfyui_run` / `comfyui_object_info` / `comfyui_workflow` 工具、右侧停靠面板（可运行工作流库、ComfyUI 端图工作流自动检测与提取（整体/按分量/主流程，画布分量分析）、资产预览、实时队列）、SDXL / Wan 2.1 模板、配套 skill、同源媒体代理、对话内媒体卡片与设置页。`dsh plugin --profile web add dsh-comfyui`
```

## 发布前核对清单

- [ ] `npm publish` 前确认 `npm pack --dry-run` 内容：`lib/`、`client/client.js`、`cordis.patch.yml`、双 README、LICENSE、package.json
- [ ] 创建 GitHub 仓库（公开），把 `D:\dsh-comfyui` 推上去（建议先 `git init` + 首次提交，`lib/`、`client/`、`node_modules/` 已在 `.gitignore`）
- [ ] 把仓库 URL 填进 package.json 的 `repository` 字段
- [ ] 按 awesome-dsh-plugin 仓库的贡献规范提交条目（通常是在其列表文件加一行 + PR）
- [ ] 合并后 dshmarket 会在约一天内自动收录
- [ ] 真实环境冒烟：启动 ComfyUI（默认 127.0.0.1:8188），在面板里对 ComfyUI 端保存的图点"提取"（验证多分量图的分量拆分）并运行提取出的执行流；再让 Agent 跑一次 txt2img，检查媒体卡片渲染与下载；视频模板需要 ComfyUI-WanVideoWrapper

## dshmarket 收录说明

dshmarket 以 awesome-dsh-plugin 列表为数据源自动收录社区插件（约一天内同步）。插件包本身需要满足：

- `dsh.bundle.patch` 指向一个插入行的 `cordis.patch.yml`（已完成）
- `dsh.client.platform: 'web'` + 客户端 bundle 命名与行 id 一致（已完成）
- 可选 peer `@deepseek-ai/dsh-settings`（设置页用，已完成）
