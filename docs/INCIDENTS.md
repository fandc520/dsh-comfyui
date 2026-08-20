# 事故记录：会话日志注入消息缺 id 导致历史加载失败

日期：2026-08-20

## 现象

重启 web server 后，某个历史会话**无法加载**（整个会话报废）。检修发现两类问题，根因都在本插件：

### 问题一（启动失败，本仓库已排除）

检修报告：插件读 `ctx.tools` 却未声明 `export const inject = ['tools']`，cordis 拒绝 → profile 起不来。

**核查结论：本仓库（src 与 lib 构建产物）均已有 `export const inject = ['tools']`（src/index.ts:37），不存在该问题**——检修侧可能基于旧版本判断。规则本身成立并需遵守：**任何通过 `ctx.<服务名>` 访问的 cordis 服务必须出现在 `inject` 声明里**，否则 cordis 抛 `cannot get property "<name>" without inject` 且报错点在 boot 期、远离肇事代码。

### 问题二（真实事故：会话日志损坏）

`echoCompletion()`（src/tools.ts）在后台生成完成时通过 `agent.inject()` 向会话注入一条通知消息，早期实现传的是**裸对象字面量**：

```ts
owner.inject({ role: 'user', content: [...], source: {...} })   // 缺 id
```

而 host 的 `agent.inject()` 契约要求**已具名消息**（`Message` 形状）：host 内部一律走 `createUserMessage()`（`@deepseek-ai/dsh-llm`），该 helper 补 `id: crypto.randomUUID()` 和 `role: 'user'`。插件绕过 helper 后，一条**没有 id 的 message 事件被写入会话日志**；加载时 `assertMessageEventShape`（packages/core/session/src/index.ts:301）全量校验撞上它，**整个会话拒绝加载**。

证据：坏事件自带署名 `"source":{"kind":"plugin","plugin":"comfyui","form":"notice",...}`，正文就是 `echoCompletion` 里硬编码的中文通知文本；全日志 2238 条 message 事件仅此 1 条缺 id。

## 修复

1. **代码**（已修，src/tools.ts echoCompletion）：注入消息补全 `id: crypto.randomUUID()`（与 host helper 格式一致）+ `role: 'user'` + `content` + `source` 完整形状。修复处带 CONTRACT 注释。
2. **数据**（检修侧重写）：损坏的会话日志已重写修复。

## 检测结果（2026-08-20，本插件全量复检）

- **代码层**：全仓 grep 确认唯一的消息注入点是 `echoCompletion`，已带 `id`；`inject = ['tools']` 在 src 与 lib 均存在。
- **数据层**：按帧解压（`node:zlib` zstdDecompressSync，逐帧扫描 `scanZstdFrames` 逻辑）全部 3 个会话日志：
  - session-208c847a…：575 帧 / 860 行 / missingId=0
  - session-4f7331fb…：30998 帧 / 42584 行 / missingId=0
  - session-c10ba985…：9431 帧 / 12754 行 / missingId=0
- **构建**：typecheck + build 全绿。

## 教训（必须遵守）

- **任何写入会话日志 / 模型上下文的消息都必须符合 host 的 `Message` 契约**：`id`（非空字符串，UUID）+ `role` + `content` + `source` 四者齐全。能用 host 的 `createUserMessage()` 就用，不能就按同形状手工构造（含 `id`）。
- 这类错误**编译期零提示**、运行期才暴露，且报错点离肇事点很远（一个炸在 boot，一个炸在几天后的历史加载）——看起来都像 harness 本身坏了。插件侧必须主动守契约。
- 会话日志是 append-only 的持久化数据：**一条坏事件 = 整个会话报废**（校验失败拒绝加载），且修复要动已持久化文件（需停进程、备份、重压），代价极高。宁可注入失败也不写坏数据（`echoCompletion` 已用 try/catch 包裹，best-effort）。
- 新增任何"向会话/模型注入内容"的代码路径后，必须用本检测脚本（`scripts/analyze-sessions.mjs`）复检会话日志。
