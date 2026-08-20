/**
 * The dsh-comfyui companion skill: canvas analysis and graph→API extraction
 * rules for the model, registered through `ctx.skills.register` (runtime
 * skill, rank 250 — user/project skills can override it).
 */

export const COMFYUI_SKILL = {
  name: 'dsh-comfyui-workflows',
  source: 'runtime',
  description:
    'ComfyUI 工作流管理：区分“图工作流”（ComfyUI 端保存的画布，衍生主题）与“API 工作流”（可执行，运行主题），分析画布中的多个独立流程（连通分量），以及图→API 提取的规则与面板操作引导。处理 comfyui_workflow 或用户要求运行 ComfyUI 端保存的工作流时加载。',
  whenToUse:
    '用户要求运行/管理 ComfyUI 中保存的工作流，或 comfyui_workflow list 显示未提取的图工作流时；需要判断一个画布是否包含多个独立流程、或解释为何某个工作流无法直接运行时。',
  content: `# dsh-comfyui 工作流管理

本插件把 ComfyUI 工作流分成两个主题：

- **图工作流（衍生主题）**：用户在 ComfyUI 画布上保存的 UI 图（nodes/links/widgets），是"源"。不能直接运行。一个图可能包含**多个互相独立的流程**。
- **API 工作流（运行主题）**：可执行的 API 格式 prompt，是"运行单元"。从图里**提取（extract）**出来，或用户直接粘贴导入。运行必须用 API 工作流。

comfyui_workflow 的 \`action: list\` 会同时返回：插件库中的 API 工作流（\`workflows\`）和 ComfyUI 端保存的图工作流（\`comfyuiWorkflows\`，带 \`extracted\` 与 \`derived\` 派生列表）。

## 画布分析规则（判断一个图是不是"多个工作流"）

1. **groups（视觉分组）只是矩形**，title + bounding box，没有任何执行语义。不要把它当工作流边界。
2. **Fast Groups Bypasser (rgthree) 的激活状态不序列化**，但被 bypass 的组里的节点 \`mode: 4\` 是可靠信号——转换/提取时这些节点**自动跳过**（即保存时未激活的区块不会进入任何运行工作流）。
3. **可执行单元 = 连通分量**（按 links 连通的激活节点集合）。悬空单节点（Markdown、Fast Groups Bypasser、未连接的 Primitive 等 UI-only/未使用节点）自动忽略。
4. 判定：
   - **1 个连通分量** → 一个完整工作流（多个组只是它的功能块），直接提取即可。
   - **多个连通分量** → 画布上躺着多个独立流程（用户可能只是放一起测试）。**不要自作主张**，把选择权交给用户（面板提取选项）：整体（合成一个，运行时全部执行）/ 按分量提取（推荐，每个独立流程一个运行工作流）/ 只拆主流程（最大分量，通常是当前测试区块）。面板的提取选项会先展示分析报告（各分量的节点数、所在组）。
5. 用户说"跑我在 ComfyUI 里保存的 X"时：若 list 显示该图 \`extracted: false\`，**先告诉用户需要到面板里"提取"它**（说明可选择整体/按分量/主流程），不要尝试用图本身运行；若已提取，用 \`derived\` 里的 libraryId 运行。

## 图 → API 提取的技术规则

- **节点 id 引用必须是字符串**：\`[String(节点id), 输出槽位]\`。服务器按字符串键做字典查找（execution.py validate_inputs），数字引用会 KeyError。
- **widget 顺序取图节点自身 \`inputs\` 数组**（含 \`widget.name\` 的条目按数组序），而不是 object_info 顺序：它包含动态子 widget（如 TextGenerate 的 sampling_mode.temperature）且**被链接的 widget 仍占据 widgets_values 位置**。object_info 只用于在 INT 输入后插入 \`control_after_generate\`。
- **对象型 widgets_values**（如 VHS_VideoCombine）按名取值，跳过内部状态（\`videopreview\` 等带 \`hidden\` 的对象）。
- **Reroute 与 bypass（mode 4）节点直通**：输出跟随其第一条有连线的输入。
- **未注册的 UI-only 节点**：若是 \`Primitive*\` 内联其第一个 widget 值；有输出被使用且非 Primitive → 报错。
- **输出槽位越界**（保存图里 SaveImage 声称 2 个输出但服务端只有 1 个）→ 断开该引用并给警告。
- **必需输入缺失**（required 里没有、且非 lazy/template 类型）→ 明确报错（源图本身断线），不产出"能转但跑不起来"的工作流。\`COMFY_AUTOGROW_V3\`/带 \`template\`/带 \`lazy\` 的输入豁免。
- 提取的每个运行工作流都会先被 \`POST /prompt\` 校验（nodeErrors 必须为空）才算成功。

## 可调参数（运行传参）

- 每个运行工作流带一组**可调参数**：提取时自动识别 提示词（文本输入）、分辨率（EmptyLatentImage 宽高）、步数（KSampler.steps）、种子（KSampler.seed，默认每次随机）、时长（duration/length/frames）、宽高比（aspect_ratio）、加载节点（LoadImage/LoadVideo/LoadAudio 的图片/视频/音频文件，值填服务器上的文件名，用户在面板可拖拽上传）。识别是**通用规则**（对象信息里的 upload 标记/文件列表），不针对具体节点；像 MiniMaxH3 综合加载（media_state JSON）这类通用规则识别不到的输入，让用户在面板"高级参数"里手动添加——值若形如媒体 JSON 数组，会自动拆成 \`media_1/media_2/...\` 参考位（值填子目录文件名，空字符串 = 移除该参考位）。cfg/denoise 与模型选择不在其中，保持工作流原样。用户可在面板"编辑工作流"里改默认值/随机开关，或添加高级参数（任意节点输入）。
- \`action: list\` 输出每个工作流的 \`parameters\` 字段就是结构化参数清单（\`name\` 是英文参数名、\`label\` 是中文含义、\`default\` 是默认值、\`random\` 表示是否每次随机、\`options\` 是下拉选项列表、\`upload\` 表示加载节点上传类型），用之前先看它。带 \`options\` 的参数必须从选项里取值（加载节点可从文件列表选，也可提示用户拖拽上传新文件）。
- 运行时可传 \`parameters\` 覆盖：\`{"prompt": "新提示词", "seed": 42, "width": 1024}\`。显式传值优先于默认；seed 类参数不传时按工作流设置随机（每次不同）。**参数名必须用清单里的英文 \`name\`**（prompt/seed/width/height/steps/duration/aspect_ratio），不要自造；带 \`options\` 的参数传值必须落在选项内，否则会报错。\`aspect_ratio\` 这类联动参数：只传它时 \`size\` 会自动跟随新比例的默认尺寸（如 9:16 → 768×1376），也可显式传 \`size\` 覆盖。

## 加载区与上传（给用户）

- 工作流库页面（运行主题）**最底部**有一个"**加载区**"（类似 ComfyUI 的 LoadImage 节点）：大图显示当前选中的图像，点击打开选择窗口——顶部"全部 / 已导入 / 已生成"导航条 + 右侧粘贴/点击上传区，下面是瀑布流图像列表。
- **已导入** = ComfyUI input 目录里的文件；**已生成** = 之前工作流产出的图像（output）；**全部** = 两者合并。
- 粘贴/上传新图 → 自动上传 → 列表刷新出现该图；点击任意图像 → 选定并关闭窗口，加载区大图更新为该图（像素尺寸在**上传时**自动记录并显示在大图下方；历史旧图若无记录则不显示尺寸、也不参与尺寸匹配）。
- **默认源图**：加载区选中的图像会成为图生图的**默认源图**——你 run 含 \`image\`（LoadImage）参数的工作流时，如果**没显式传 image**，插件自动用加载区选中的文件名（显式传 \`image\` 则优先）。聊天消息里出现 \`[已上传图片: 文件名]\` 标记同理：文件已由"贴图"按钮上传到 ComfyUI 的 input 目录，直接可用；文件名带 \`subfolder/\` 前缀的按原样传。
- **尺寸自动匹配**：面板上传/加载时插件会记录图片像素尺寸。图生图 run 时如果**没显式传 width/height**，插件自动用源图分辨率作为输出尺寸（显式传值优先）。加载区大图下方会显示选中图的尺寸（如 \`1024×768\`）。
- **命名与去重**：上传文件按内容哈希命名（\`原名_短哈希.ext\`，如 \`image_3f9a2b1c0d.png\`），同一张图重复上传会直接复用已有文件（不会产生 \`image(1).png\` 之类的重复文件）。
- 选中"已生成"的图后，插件会自动把它从 output 复制到 input 目录（同名），保证加载节点可用。

## 运行工作流的正确流程（省 token）

1. **list 了解**：\`comfyui_workflow list\` 看每个工作流的名称、描述、**标签**（图生图/文生图/文生视频/图生视频/参考生视频/文生音频/参考生音频等，可自定义）和 \`parameters\` 参数清单（含含义 label 和默认值），挑出符合当前场景的工作流。面板上可点标签筛选工作流列表。
2. **参数决策**：只依据清单里的参数（键名用英文名），选择/覆盖适合的值——**不需要查看工作流内部结构**。
3. **run 直接调用**：\`comfyui_workflow run { id, parameters: {...} }\`。插件直接从库里取该工作流的 JSON 提交给 ComfyUI，你**只传参数覆盖值，绝不自己输出或复制完整工作流 JSON**（那会浪费大量 token）。
   - **视频/音频工作流一律 \`mode: "async"\`**：生成要几分钟，sync 会等待超时中断（报 generation aborted）。async 立即返回 job id，**启动后不要阻塞等待**（不要对返回的 job 用 wait: true 卡住），继续做其他事，后台任务完成时系统会通知你，到时再用 job_output（不 wait）收集结果和媒体回显。
   - 图片生成可 sync（通常 <1 分钟）；若不确定输出类型，也用 async。
- \`action: get\` 只在**诊断/检查**工作流内容时使用（它会输出完整 JSON、占用大量 token），它**不是运行路径**。

## 面板操作引导（转告用户）

- 面板"ComfyUI 端保存"分区列出每个图工作流：未提取显示"未提取"，已提取显示派生出的运行工作流列表。
- 点**提取**：单分量直接拆；多分量弹出选项（分析报告 + 整体/按分量/主流程）。也可点**查看**看节点清单和 JSON。
- 用户也可以不经过图，直接在插件库"新建工作流"粘贴 API JSON（或选择 .json 文件）作为运行工作流导入。
`,
}
