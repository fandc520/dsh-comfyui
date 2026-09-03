# dsh-comfyui 0.4.0 发布决策（已执行）

**时间**: 2026-09-02 02:00 附近
**状态**: 代码与清单已改完，待用户自行 npm publish

## 背景

用户担忧 0.1.2 API 迁移版插件推送给老宿主（0.1.1-rc.2）用户会导致 dsh 整体启动失败（fail-loud，不隔离插件）。诊断确认双向不兼容后，用户拍板：上安全栏 + 明确版本范围 + 去 beta。

## 已执行改动（D:\dsh-comfyui，均未提交）

1. `package.json` 删除 `peerDependenciesMeta` 中 dsh-settings 的 `optional: true` → peer 必选。**这是关键一步**：dshmarket 兼容预检（compatibility.ts）对 optional peer 一律降级为非风险不报警，摘掉后老宿主上安装会触发 `soft-incompatible` 风险横幅 + 一键回滚。
2. `package.json` peer 范围 `@deepseek-ai/dsh-settings: ^0.1.2-alpha.4`（保留 alpha 标签，覆盖未来 0.1.x 正式版）。
3. 版本 `0.3.0-beta.6` → `0.4.0`（用户说"0.40"，按 semver 惯例落为 0.4.0，已告知可改字面 0.40.0）。
4. README.md / README.en.md 徽章下各加一行显式要求：≥ 0.1.2-alpha.4，老 dsh 留 0.3.x 线。
5. `pnpm typecheck` 双 tsconfig 通过；发布走 `npm publish`（prepack 自动 build）。

## 发布纪律

- 0.3.x 老线留在 npm 不撤，供老宿主用户。
- 不 force 越过 dshmarket 发布龄冷却（RELEASE_TOO_FRESH），让灰度窗口自然过滤。
- 不做双版本兼容 shim（宿主 0.1.x 预发布不承诺兼容，版本配对是生态约定）。
