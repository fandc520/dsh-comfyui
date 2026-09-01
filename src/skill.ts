/**
 * The dsh-comfyui companion skill: canvas analysis and graph→API extraction
 * rules for the model, registered through `ctx.skills.register` (runtime
 * skill, rank 250 — user/project skills can override it).
 */

export const COMFYUI_SKILL = {
  name: 'dsh-comfyui-workflows',
  source: 'runtime',
  description:
    'ComfyUI 工作流管理：区分“图工作流”（ComfyUI 端保存的画布，衍生主题）与“API 工作流”（可执行，运行主题），分析画布中的多个独立流程（连通分量），以及图→API 提取的规则与面板操作引导。也包含本机环境（用户 ComfyUI 目录）与 TTS-Audio-Suite 音色库的快速查询/快照刷新方案。处理 comfyui_workflow、需要定位用户 ComfyUI 文件/音色库，或用户要求运行 ComfyUI 端保存的工作流时加载。',
  whenToUse:
    '用户要求运行/管理 ComfyUI 中保存的工作流，或 comfyui_workflow list 显示未提取的图工作流时；需要判断一个画布是否包含多个独立流程、或解释为何某个工作流无法直接运行时；需要查询 TTS-Audio-Suite 音色库、刷新已存工作流的音色参数快照、或定位用户本机 ComfyUI 目录时；或 comfyui_workflow list 里某个工作流带“技能包”标记、需要在运行前读取它时。',
  content: `# dsh-comfyui 工作流管理

本插件把 ComfyUI 工作流分成两个主题：

- **图工作流（衍生主题）**：用户在 ComfyUI 画布上保存的 UI 图（nodes/links/widgets），是"源"。不能直接运行。一个图可能包含**多个互相独立的流程**。
- **API 工作流（运行主题）**：可执行的 API 格式 prompt，是"运行单元"。从图里**提取（extract）**出来，或用户直接粘贴导入。运行必须用 API 工作流。

comfyui_workflow 的 \`action: list\` 会同时返回：插件库中的 API 工作流（\`workflows\`）和 ComfyUI 端保存的图工作流（\`comfyuiWorkflows\`，带 \`extracted\` 与 \`derived\` 派生列表）。

## 本机环境（先看这里，不要反复问用户）

- \`comfyui_workflow action: list\` 每次都会返回 \`env\` 字段：\`baseUrl\`（ComfyUI 服务器地址）与 \`comfyuiDirs\`（用户在设置页"ComfyUI 目录"配置的安装目录，可多个——目录映射/多实例/便携版）。**需要知道服务器地址，或要定位用户 ComfyUI 的文件（models、自定义节点、音色库、输出目录等都在这下面）时，先跑一次 list 读 env**。每次调用都取最新值，设置页改完立刻生效。
- \`comfyuiDirs\` 为空 = 未配置：先询问用户，或探测常见位置（\`C:\\ComfyUI\`、\`D:\\ComfyUI\`、ComfyUI 桌面版 \`...\\ComfyUI-Installs\\ComfyUI\\ComfyUI\`）。以下所有 \`{comfyuiDir}\` 都代指 env.comfyuiDirs 里的每个目录。

## TTS-Audio-Suite 音色库查询（先刷新快照，再查询；不用翻插件源码）

TTS-Audio-Suite（\`{comfyuiDir}/custom_nodes/tts_audio_suite\`）的"🎭 Character Voices"（类名 \`CharacterVoicesNode\`）节点用 \`voice_name\` 下拉选音色。音色相关的数据有**两份，都会过期**：TTS 自己的进程缓存（影响下拉与 object_info 的 COMBO），与 dsh-comfyui 存的工作流参数快照（\`~/.dsh/data/dsh-comfyui/workflows.json\` 里每个参数保存时拷贝的 \`options\` / \`numberKind\` / min/max/step，之后**不再自动更新**）。**正确流程：先刷新，再查询**——只查询不刷新，拿到的列表和快照可能不一致，新音色会被运行前校验拒绝。

**第 1 步：刷新**（新音色 / 节点定义变更后做一次）：

- **\`comfyui_workflow action: refresh { id: "<工作流id>" }\`**（一个 id 一个）一步做两件事：①强制 TTS-Audio-Suite 重扫音色库（\`?refresh=1\`，失效进程缓存，让 object_info 的 COMBO 用上新列表）②读最新 object_info，把该工作流所有参数的 options / numberKind / min/max/step 更新并**存回快照**。只动从 object_info 派生的字段：参数集合（含用户在面板手加的高级参数）与默认值原样保留。返回 \`changed\` 列出实际变了的参数名；无变化的不动。刷完 \`action: list\` 就能看到新选项。
- **其他插件/程序要刷新**：同源路由 \`POST /comfyui/workflows/refresh-params\`，body \`{ "id": "<工作流id>" }\`，返回 \`{ ok, parameters, changed }\`。设计音色成功后自动调一次即可，不需要重新保存工作流。
- 不刷新的后果：新音色的 key 不在旧 options 里，\`action: run\` 传它会被运行前校验拒绝（"parameter ... is not one of the allowed options"）——**这是快照过期，不是音色库没刷新**。\`voice_name\` 下拉不受影响（读取时实时查 object_info），面板里立刻能看到新音色。
- 注意区分：单独打 \`?refresh=1\`（或让用户在 ComfyUI 画布按 R）只重扫 **TTS 的进程缓存**，**不会**更新已存工作流的快照；要让快照跟上必须用 \`action: refresh\` / refresh-params 刷新对应工作流。

**第 2 步：查询**（刷新后拿当前列表 / 元数据 / 试听）：

1. **HTTP 查询（首选，ComfyUI 正在运行时）**——插件在 ComfyUI 服务器上挂了音色库接口，返回的就是下拉里的完整 key 列表（第一个是 \`"none"\`，表示"不用音色、直接传音频"）：
   - PowerShell：\`Invoke-RestMethod "{baseUrl}/api/tts-audio-suite/voice-library"\`
   - curl：\`curl -s "{baseUrl}/api/tts-audio-suite/voice-library"\`
   - \`{baseUrl}\` 换成 env.baseUrl。跳过第 1 步时也可以在 URL 末尾加 \`?refresh=1\` 强制 TTS 重扫（只影响 TTS 缓存，不动快照）。
   - 单条元数据：\`{baseUrl}/api/tts-audio-suite/voice-info?voice_name=<key>\`；试听音频：\`{baseUrl}/api/tts-audio-suite/voice-preview?voice_name=<key>\`。
2. **文件系统查询（要音色文件名/路径时）**——音色库目录（按优先级）：
   - \`{comfyuiDir}/models/voices\`（主力，新音色放这里）
   - \`{comfyuiDir}/models/TTS/voices\`
   - \`{comfyuiDir}/custom_nodes/tts_audio_suite/voices_examples/\`（插件自带示例）
   - \`{comfyuiDir}/extra_model_paths.yaml\` 里 \`voices:\` 映射的额外目录（ComfyUI 目录可以映射，这些目录都要算进去）。
   - 列举音色（PowerShell）：\`Get-ChildItem "{comfyuiDir}\\models\\voices" -Recurse -File | Where-Object { $_.Extension -match '\\.(wav|mp3|flac|ogg)$' }\`

**规则**：一个音色 = 音频文件（.wav/.mp3/.flac/.ogg/.m4a/.aac）+ 同名参考文本（\`同名.reference.txt\` 优先，其次 \`同名.txt\`，内容非空），**两者齐备**才会出现在 \`voice_name\` 下拉与 HTTP 接口里。下拉 key 是相对路径（如 \`voices_examples/xxx.wav\`、\`TTS/voices/xxx.wav\`、\`subdir/voice.wav\`），填工作流参数时直接用这个 key，不要自造。新增音色：把音频 + 同名 txt 拷进 \`{comfyuiDir}/models/voices\`，再走第 1 步刷新即可。

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
- **\`control_after_generate\` 占位**：名为 \`seed\`/\`noise_seed\` 的 INT（或 object_info 显式声明 \`control_after_generate\`）前面端会渲染生成后控制下拉，其值占据 widgets_values 一个槽位但无 API 输入——提取时消费该值但不写入工作流，否则后续 widget 全部错位（如 TTS-Audio-Suite 的 seed 后跟 "fixed"）。
- **对象型 widgets_values**（如 VHS_VideoCombine）按名取值，跳过内部状态（\`videopreview\` 等带 \`hidden\` 的对象）。
- **Reroute 与 bypass（mode 4）节点直通**：输出跟随其第一条有连线的输入。
- **未注册的 UI-only 节点**：若是 \`Primitive*\` 内联其第一个 widget 值；有输出被使用且非 Primitive → 报错。
- **输出槽位越界**（保存图里 SaveImage 声称 2 个输出但服务端只有 1 个）→ 断开该引用并给警告。
- **必需输入缺失**（required 里没有、且非 lazy/template 类型）→ 明确报错（源图本身断线），不产出"能转但跑不起来"的工作流。\`COMFY_AUTOGROW_V3\`/带 \`template\`/带 \`lazy\` 的输入豁免。
- 提取的每个运行工作流都会先被 \`POST /prompt\` 校验（nodeErrors 必须为空）才算成功。

## 可调参数（运行传参）

- 每个运行工作流带一组**可调参数**：提取时自动识别 提示词（文本输入）、分辨率（EmptyLatentImage 宽高）、步数（KSampler.steps）、种子（KSampler.seed，默认每次随机）、时长（duration/length/frames）、宽高比（aspect_ratio）、加载节点（LoadImage/LoadVideo/LoadAudio 的图片/视频/音频文件，值填服务器上的文件名，用户在面板可拖拽上传）。识别是**通用规则**（对象信息里的 upload 标记/文件列表），不针对具体节点；像 MiniMaxH3 综合加载（media_state JSON）这类通用规则识别不到的输入，让用户在面板"高级参数"里手动添加——值若形如媒体 JSON 数组，会自动拆成 \`media_1/media_2/...\` 参考位（值填子目录文件名，空字符串 = 移除该参考位）。cfg/denoise 与模型选择不在其中，保持工作流原样。用户可在面板"编辑工作流"里改默认值/随机开关，或添加高级参数（任意节点输入）。
- \`action: list\` 输出每个工作流的 \`parameters\` 字段就是结构化参数清单（\`name\` 是英文参数名、\`label\` 是中文含义、\`default\` 是默认值、\`random\` 表示是否每次随机、\`numberKind\` 是数字参数的类型（\`int\` 只接受整数，传小数会四舍五入；\`float\` 可传小数如 cfg 7.5、denoise 0.6；没有该字段表示类型未知，按小数传即可）、\`options\` 是下拉选项列表、\`upload\` 表示加载节点上传类型），用之前先看它。带 \`options\` 的参数必须从选项里取值（加载节点可从文件列表选，也可提示用户拖拽上传新文件）。
- 运行时可传 \`parameters\` 覆盖：\`{"prompt": "新提示词", "seed": 42, "width": 1024}\`。显式传值优先于默认；seed 类参数不传时按工作流设置随机（每次不同）。**参数名必须用清单里的英文 \`name\`**（prompt/seed/width/height/steps/duration/aspect_ratio），不要自造；带 \`options\` 的参数传值必须落在选项内，否则会报错。\`aspect_ratio\` 这类联动参数：只传它时 \`size\` 会自动跟随新比例的默认尺寸（如 9:16 → 768×1376），也可显式传 \`size\` 覆盖。

## 加载区与上传（给用户）

- 工作流库页面（运行主题）**最底部**有一个"**加载区**"（类似 ComfyUI 的 LoadImage 节点）：由若干**加载位**组成（只有一个时铺满面板，多个时等宽排列），点击任一加载位打开选择窗口——顶部"全部 / 已导入 / 已生成"导航条 + 右侧粘贴/点击上传区，下面是瀑布流列表。用户可用"添加加载区"增加加载位，鼠标悬停加载位右上角的 × 删除该位，选择窗口第一格的"空"用于清空该位但保留它。
- **已导入** = ComfyUI input 目录里可被加载节点使用的图像/视频/音频；**已生成** = 之前工作流产出的结果（output，选中时自动复制进 input）；**全部** = 两者合并。选择窗口里视频与音频可直接播放试听。
- 粘贴/上传新图 → 自动上传 → 列表刷新出现该图；点击文件名 → 放入该加载位并关闭窗口（像素尺寸在**上传时**自动记录并显示在大图下方；历史旧图若无记录则不显示尺寸、也不参与尺寸匹配）。
- **默认源素材**：加载区里已放入素材的加载位会按顺序填进工作流里**未显式传值**的加载参数——第 1 个加载位 → 第 1 个图片参数，第 2 个 → 第 2 个，视频/音频参数各自取同类型的加载位；显式传值永远优先，没有对应加载位的参数保持工作流原值。\`comfyui_workflow action: list\` 的输出里有 \`loadArea\`（\`slots\` 加载位数、\`loaded\` 已放入素材数、\`items\` 文件清单），**要知道用户加载了几个素材就看它**，不要反复问用户。聊天消息里出现 \`[已上传图片: 文件名]\` 标记同理：文件已由"贴图"按钮上传到 ComfyUI 的 input 目录，直接可用；文件名带 \`subfolder/\` 前缀的按原样传。
- **尺寸自动匹配**：面板上传/加载时插件会记录图片像素尺寸。图生图 run 时如果**没显式传 width/height**，插件自动用源图分辨率作为输出尺寸（显式传值优先）。加载区大图下方会显示选中图的尺寸（如 \`1024×768\`）。
- **命名与去重**：上传文件按内容哈希命名（\`原名_短哈希.ext\`，如 \`image_3f9a2b1c0d.png\`），同一张图重复上传会直接复用已有文件（不会产生 \`image(1).png\` 之类的重复文件）。
- 选中"已生成"的图后，插件会自动把它从 output 复制到 input 目录（同名），保证加载节点可用。

## 工作流技能包（谁写的、什么时候读）

有些工作流参数多、坑多，或者带一整套风格提示。这类工作流可以挂一个**技能包**：一份 \`SKILL.md\`（适用场景 / 关键参数 / 注意事项）加上若干子目录（\`references/\` \`scripts/\` \`assets/\` \`templates/\` \`agents/\` …，也可以自定义目录名，只有一层），存在技能包目录 \`skills/<目录名>/\` 下。用户在面板里写，**你也可以用 \`comfyui_skill\` 工具自己写**（见下）。

涉及**两个工具**，别弄混作用域：

- **\`comfyui_workflow\`（工作流工具）**：管"工作流库"这一层。\`action: list\` 列出**整个工作流库**（所有 API 工作流 + ComfyUI 端图工作流 + 加载区 + env），**它不是技能包列表**——挂了技能包的工作流只是多一行 \`技能包: <摘要>\`（含文件数与是否必读），正文不进来。\`action: skill { id }\` 取**某一个**工作流的 \`SKILL.md\` 正文。**没有"列出所有工作流技能包"的命令**：发现靠 list 的一行摘要，详情必须按 id 单独查。
- **\`comfyui_skill\`（技能包工具）**：管"某个技能包内部"这一层。每个动作都要带 \`workflow_id\`，只操作**那一个**工作流的技能包。它的 \`action: list\` 是看那个技能包的内部结构（文件/子目录/大小），**不是**"全库技能包一览"。

技能包**不常驻对话**，按需分三步取用，别跳步也别提前全读：

1. \`comfyui_workflow action: list\` 里，挂了技能包的工作流会多出一行 \`技能包: <摘要>\`（必读的写作 \`技能包（运行前必读）\`）。这是你唯一的线索，只有一句话。
2. 决定要用这个工作流之后、运行之前，\`comfyui_workflow action: skill { id: "<工作流id>" }\` 取回 \`SKILL.md\` 正文和技能包的**绝对目录**。返回体是 \`<skill_content>\` 块，照着里面的指示做。
3. 正文里点名某个参考文档（如 \`references/styles.md\`）时，才用文件读取工具按「Base directory + 相对路径」去打开它。\`assets/\` 里可能有参考图（png/jpg 等），同样按需读取（用能读图的文件工具）。**不要**一上来就把整个目录读一遍——分文件存放就是为了让你只取需要的那一份。

规则：
- **「运行前必读」是个布尔开关**：在面板技能包编辑器里勾选，或 \`comfyui_skill action: require { workflow_id, required: true }\` 设置（\`false\` 关掉）。它**只拦 \`action: run\` 这一条路径**：本会话没读过该工作流的技能包就调 \`action: run\`，会被直接拒绝，报错里指明先跑 \`action: skill { id }\`；\`list\` / \`skill\` / \`get\` / \`refresh\` 都不受影响。
- **拦截粒度是「会话 × 工作流」**：读过一次即解除——\`action: skill\`，或 \`comfyui_skill action: read\` 读到 \`SKILL.md\`，都算读过；之后同一会话内 run 不再拦。**换一个新会话会重新拦**（拦截状态记在当前 Agent 会话上，不跨会话、不跨工作流），所以另一个会话的 Agent 跑同一工作流时仍要先读一遍。
- 技能包是**用户为这个工作流写的**，优先级高于你的通用经验：它和本 skill 的通用规则冲突时，以技能包为准。
- 没有 \`技能包:\` 那行的工作流就是没挂，别去猜也别调 \`action: skill\`（会报"没有技能包"）——想给它建一个就用 \`comfyui_skill action: enable\`。

### 自己维护技能包（\`comfyui_skill\` 工具）

技能包不是只读的：\`comfyui_skill\` 让你查看并编写某个工作流的技能包，每个动作都带 \`workflow_id\`。逐个动作：

- \`list\` —— 看这个技能包的内部结构：文件清单（含字节大小）、子目录（含空目录）、摘要、是否必读、绝对目录。技能包已存在才能看（没挂会报"没有技能包"）。
- \`read { path }\` —— 读一个文件（如 \`references/styles.md\`）；超过 40k 字符会截断并标记。读到 \`SKILL.md\` 与 \`comfyui_workflow action: skill\` 一样解除必读拦截。
- \`write { path, content }\` —— **创建或整体覆盖**一个文件。已存在的文件被 write 会丢掉原内容：新建、或写自己刚建的文件才用它；给已有文件加内容用 \`append\`。写 \`SKILL.md\` 时带 \`summary\` 参数会更新 list 里那行摘要。
- \`append { path, content }\` —— 追加到文件末尾（自动空行分隔），不动已有内容。踩坑结论、补充说明用这个。
- \`mkdir { name }\` —— 建一层子目录（\`references\` / \`scripts\` / \`templates\` …可自定义，字母/数字/汉字/下划线/连字符）。先 mkdir 再 write 进去，比直接 write \`目录/文件\` 更稳。
- \`rename { path, to }\` —— 改名/移动。\`to\` 是裸文件名 = 同目录改名；\`to\` 带 \`子目录/\` 前缀 = 挪到那个目录。\`SKILL.md\` 不能改名。
- \`delete { path }\` —— 删一个文件。\`SKILL.md\` 不能删；整包销毁没有对应动作，那是用户在面板上的决定。
- \`enable\` —— **给没有技能包的工作流建一个**：建目录 + 写骨架 \`SKILL.md\`（自动列出该工作流全部可调参数名占位）。**创建只有这一条路**：其他所有动作都要求技能包已存在，没挂技能包时 \`write\` / \`mkdir\` / \`read\` 等都会报"没有技能包"。
- \`require { required: true/false }\` —— 开关「运行前必读」，与面板勾选是同一个布尔值，见上文规则。

什么时候写：
- **跑完一个工作流、踩到了坑**（某个参数组合失败、某个音色不存在、视频必须 async 之类），用 \`append\` 把结论追加进 \`SKILL.md\` 的注意事项，或写进 \`references/\` 下的专题文件。下一次（换个会话也一样）就不用重新踩。
- **总结出了成套的可复用内容**（风格提示词合集、模板、参数配方），\`mkdir\` 一个目录（如 \`templates/\` 或 \`prompts/\`）再 \`write\` 进去，然后在 \`SKILL.md\` 里列一行指向它。
- **工作流还没有技能包**但你判断它值得有：\`action: enable\` 会建好目录并写入一份骨架（自动列出全部可调参数名），往里填内容即可，别整体覆盖骨架。

写作要求：
- \`SKILL.md\` **整份都会进上下文**，所以它只放"怎么选、怎么填、哪里会翻车"和一张指向其他文件的目录。成体系的长内容一律拆进子目录，让后来的自己按需去读。
- 写 \`SKILL.md\` 时带上 \`summary\` 参数（一句话，说明这个工作流什么时候用）——这句话就是 list 里那唯一的一行线索。
- 只写你**验证过**的结论，不要把猜测写成事实；技能包会被后续所有会话当作权威。
- 用户手写的内容不要随意重写或删除，优先用 \`append\` 追加。销毁整个技能包没有对应动作，那是用户在面板上的决定。

## 运行工作流的正确流程（省 token）

1. **list 了解**：\`comfyui_workflow list\` 看每个工作流的名称、描述、**标签**（图生图/文生图/文生视频/图生视频/参考生视频/文生音频/参考生音频等，可自定义）和 \`parameters\` 参数清单（含含义 label 和默认值），挑出符合当前场景的工作流。面板上可点标签筛选工作流列表。
2. **有技能包就先读**：list 里某个工作流带 \`技能包:\` 那一行，说明用户为它写了专属说明书（适用场景、参数怎么填、哪些环节会翻车）。选中它之后、运行之前，先 \`comfyui_workflow action: skill { id }\` 把正文读进来并照着做。标注「运行前必读」的，不读会被 run 直接拒绝。没有这行的工作流跳过本步。
3. **参数决策**：只依据清单里的参数（键名用英文名），选择/覆盖适合的值——**不需要查看工作流内部结构**。
4. **run 直接调用**：\`comfyui_workflow run { id, parameters: {...} }\`。插件直接从库里取该工作流的 JSON 提交给 ComfyUI，你**只传参数覆盖值，绝不自己输出或复制完整工作流 JSON**（那会浪费大量 token）。
   - **视频/音频工作流一律 \`mode: "async"\`**：生成要几分钟，sync 会等待超时中断（报 generation aborted）。async 立即返回 job id，**启动后不要阻塞等待**（不要对返回的 job 用 wait: true 卡住），继续做其他事，后台任务完成时系统会通知你，到时再用 job_output（不 wait）收集结果和媒体回显。
   - 图片生成可 sync（通常 <1 分钟）；若不确定输出类型，也用 async。
- \`action: get\` 只在**诊断/检查**工作流内容时使用（它会输出完整 JSON、占用大量 token），它**不是运行路径**。

## 面板操作引导（转告用户）

- 面板"ComfyUI 端保存"分区列出每个图工作流：未提取显示"未提取"，已提取显示派生出的运行工作流列表。
- 点**提取**：单分量直接拆；多分量弹出选项（分析报告 + 整体/按分量/主流程）。也可点**查看**看节点清单和 JSON。
- 用户也可以不经过图，直接在插件库"新建工作流"粘贴 API JSON（或选择 .json 文件）作为运行工作流导入。
`,
}
