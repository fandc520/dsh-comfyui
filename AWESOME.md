# awesome-dsh-plugin 上架材料

本文档是 dsh-comfyui 上架到 [awesome-dsh-plugin](https://awesome-dsh-plugin.com)（进而自动进入 dshmarket 市场）的准备材料。发布 npm 包并创建 GitHub 仓库后，把下面的条目按站点格式提交即可。

## 建议条目（英文）

```markdown
- [dsh-comfyui](https://github.com/fandc520/dsh-comfyui) — Let the DeepSeek Harness agent smartly drive a local or remote ComfyUI to generate anything: agent tools (`comfyui_run`, `comfyui_object_info`, `comfyui_workflow`, `comfyui_skill`), workflow/asset/queue panel with graph extract (whole/per component/main flow), load-area media loader, per-workflow skill packs, SDXL & Wan 2.1 templates, a companion skill and a same-origin media proxy. `dsh plugin --profile web add dsh-comfyui` (web) / `dsh plugin --profile desktop add dsh-comfyui` (desktop)
```

## 建议条目（中文，如站点支持）

```markdown
- [dsh-comfyui](https://github.com/fandc520/dsh-comfyui) — 让 DeepSeek Harness 的 Agent 智能驱动本地或远程 ComfyUI 生成任何内容：Agent 工具（`comfyui_run` / `comfyui_object_info` / `comfyui_workflow` / `comfyui_skill`）、工作流/资产/队列面板（图工作流提取：整体/按分量/主流程）、加载区媒体加载器、工作流技能包挂载、SDXL / Wan 2.1 模板、配套 skill 与同源媒体代理。`dsh plugin --profile web add dsh-comfyui`（web）/ `dsh plugin --profile desktop add dsh-comfyui`（desktop）
```

## 发布前核对清单

- [x] `npm publish` 前确认 `npm pack --dry-run` 内容：`lib/`、`client/client.js`、`cordis.patch.yml`、双 README、LICENSE、package.json
- [x] 创建 GitHub 仓库（公开），把 `D:\dsh-comfyui` 推上去（`lib/`、`client/`、`node_modules/` 已在 `.gitignore`）——已完成：`fandc520/dsh-comfyui`（SSH：`git@github.com:fandc520/dsh-comfyui.git`）
- [x] 把仓库 URL 填进 package.json 的 `repository` 字段（已完成，`git+https://github.com/fandc520/dsh-comfyui.git`）
- [ ] 按 awesome-dsh-plugin 仓库的贡献规范提交条目（通常是在其列表文件加一行 + PR）
- [ ] 合并后 dshmarket 会在约一天内自动收录
- [ ] 真实环境冒烟：启动 ComfyUI（默认 127.0.0.1:8188），在面板里对 ComfyUI 端保存的图点"提取"（验证多分量图的分量拆分）并运行提取出的执行流；再让 Agent 跑一次 txt2img，检查媒体卡片渲染与下载；视频模板需要 ComfyUI-WanVideoWrapper

## dshmarket 收录说明

dshmarket 以 awesome-dsh-plugin 列表为数据源自动收录社区插件（约一天内同步）。插件包本身需要满足：

- `dsh.bundle.patch` 指向一个插入行的 `cordis.patch.yml`（已完成）
- `dsh.client.platform: 'web'` + 客户端 bundle 命名与行 id 一致（已完成）
- 可选 peer `@deepseek-ai/dsh-settings`（设置页用，已完成）
