# 开发与维护文档（dsh-comfyui）

> 本文档记录插件当前的版本状态、开发进度与日常维护方法（git 与 npm 发布流程）。给开发者/维护者看，不是用户文档。

## 当前版本

| 项 | 值 |
| --- | --- |
| 最新发布版 | `0.3.0-beta.2`（npm tag: `beta`） |
| 稳定基线 | `v0.2.0`（功能基线，见下方时间线） |
| npm 包 | `dsh-comfyui` → https://www.npmjs.com/package/dsh-comfyui |
| GitHub | `fandc520/dsh-comfyui`（分支 `master`） |
| 安装（测试版） | `dsh plugin --profile web add dsh-comfyui@beta` |
| 安装（正式版，发布后） | `dsh plugin --profile web add dsh-comfyui` |

## 开发进度时间线

| 日期 | 版本 | 内容 |
| --- | --- | --- |
| 2026-08-20 | v0.2.0（git `0593d48`） | 功能基线：图工作流提取、API 工作流库、参数识别（自动 + 高级）、加载区（默认源图 / 分辨率自动匹配 / 哈希去重）、工作流标签（7 预设 + 自定义 + 筛选）、队列中心、中英双语 UI、配套 skill |
| 2026-08-20 | 0.3.0-beta.0（git `9bdd6ef`） | 首次 npm 发布（`npm publish --tag beta`）；git 仓库初始化 + GitHub 首次推送（`0593d48`、`9bdd6ef`） |
| 2026-08-20 | 0.3.0-beta.1（git `d0215e9`） | README 重做：`README.md` 纯中文（默认首页）+ `README.en.md` 纯英文，互有语言切换链接；生成横屏 logo（`logo.png`，ComfyUI 文生图 1536×640）；首页布局（logo + 徽章行） |
| 2026-08-20 | 0.3.0-beta.2（git `3be617f`） | 修复 npm 发布白名单：`images/`（界面截图）此前漏在 `files` 之外导致 npm 页面裂图，加入后随包发布；界面截图按功能小节分散进 README（panel / loadarea / settings） |

**备注**：
- v0.2.0 是 git 初始提交时的版本号，npm 上从未发布过 0.2.x——npm 首版即 0.3.0-beta.0。
- beta 版本的语义：0.3 是下一个稳定版本的开发周期，功能收敛后发 `0.3.0` 正式版。

## 维护方法

### 0. 环境与验证

```sh
npm run typecheck   # host + client 类型检查
npm run build       # tsc（host lib/）+ tsdown（client bundle）
npm pack --dry-run  # 检查发布内容（必须跑，见"发布前检查"）
```

**改动生效规则（重要）**：
- `src/*.ts`（除 `client/` 外，即 host 侧：store/routes/tools/params/skill 等）→ 需**重启 DSH** 才生效。
- `src/client/*`（浏览器端：panel/styles/i18n/settings 等）→ **刷新页面**即可。
- skill 内容（`src/skill.ts`）编译进 `lib/skill.js`，属 host 侧，重启 DSH 后 Agent 才读到新版。

### 1. git 日常流程

```sh
git add -A
git commit -m "<描述>"
git push          # origin 为 SSH（git@github.com:fandc520/dsh-comfyui.git）
```

- 本机 git 身份为仓库级占位：`fandc <fandc@users.noreply.github.com>`（`git config user.name/email`，仅本仓库生效），可改成真实身份。
- `.gitignore` 忽略 `node_modules/ lib/ client/ *.tsbuildinfo`——构建产物不进库，clone 后需 `npm install && npm run build`。
- 网络注意：HTTPS 直连 GitHub 在本机曾报 schannel SSL 失败；SSH（ed25519 key）可用，remote 已配置为 SSH URL。若 HTTPS push 失败改用 SSH。

### 2. npm 发布

**认证**：发布需要 npm 账号权限。账号启用了 2FA，CLI 发布需：
- Granular Access Token（**Read and write** + **All packages** + **bypass 2FA**），或
- 一次性 OTP（`npm publish --otp <code>`）。

**发测试版**（当前流程）：

```sh
# 1) 版本号 +1（如 0.3.0-beta.2 → 0.3.0-beta.3）
#    改 package.json 的 version 字段
git add package.json && git commit -m "bump to X.Y.Z-beta.N"

# 2) 发布（带 beta tag，用户需装 @beta 才拿到）
npm publish --tag beta "--//registry.npmjs.org/:_authToken=<token>"
```

**发正式版**（功能收敛后）：

```sh
# 版本号改为 0.3.0（去掉 -beta.N）
npm publish            # 不带 --tag，自动打 latest
```

**发布前检查（血泪教训）**：
- `npm pack --dry-run` 看文件清单——**README 里引用的每个相对路径资源必须都在 `files` 白名单里**（`logo.png`、`images/` 目录），否则 npm 页面裂图。上次 `images/` 漏加导致 beta.1 截图 404，beta.2 修复。
- npm 页面只渲染包根目录的 `README.md`（现在是纯中文版）；`README.en.md` 随包但不渲染在 npm 页。
- 发布后验证：`npm view dsh-comfyui@beta version`；资源文件用 unpkg 检查（有几分钟 CDN 延迟）：`curl -I https://unpkg.com/dsh-comfyui@<ver>/logo.png`。
- 已发布的版本不可覆盖，只能升号重发。

### 3. 数据文件（运行时）

默认位于 `$DSH_HOME/data/dsh-comfyui/`（Windows 实测：`C:\Users\<user>\.dsh\data\dsh-comfyui\`）：

| 文件 | 内容 |
| --- | --- |
| `workflows.json` | 工作流库（API 工作流 + 参数 + 标签） |
| `assets.json` | 资产索引（生成结果） |
| `current-image.json` | 加载区当前选中图 |
| `media-sizes.json` | 上传图片像素尺寸（分辨率自动匹配用） |
| `media-hashes.json` | 上传哈希 → 文件名（去重用） |
| `tracked.json` | 插件提交的任务跟踪 |

这些文件可手工修正（如手动补一条尺寸记录），但注意格式与 store 读写一致。

### 4. 常见维护场景

- **改了个 bug**：改码 → typecheck+build → commit+push → 按生效规则（host 重启 / 客户端刷新）验证 → 视情况发新 beta。
- **新功能落地**：同上，并在 `src/skill.ts` 补充 Agent 所需说明（如新参数、新交互），更新 README（功能 + 截图 + Roadmap），更新本文档时间线。
- **模型/工作流侧变化**（如 ComfyUI 更新、新 Lora）：一般无需改插件；参数识别是通用规则，识别不到的在面板"高级参数"手动暴露。
- **发正式版前的核对**：beta 版本全部功能验证 → 版本号去 beta → `npm publish` → 更新 README 安装说明（去掉 `@beta`）→ 更新本文档。

## License

MIT
