export type BlogLocale = "en" | "zh";
export type LocalizedText = Readonly<Record<BlogLocale, string>>;

export interface InvestigationStep {
  title: LocalizedText;
  body: LocalizedText;
}

export interface NoteReference {
  label: LocalizedText;
  url: string;
}

export interface EngineeringNote {
  sequence: string;
  slug: string;
  category: LocalizedText;
  title: LocalizedText;
  summary: LocalizedText;
  outcome: LocalizedText;
  signal: LocalizedText;
  boundary: LocalizedText;
  readingMinutes: number;
  investigation: readonly InvestigationStep[];
  changes: readonly LocalizedText[];
  principles: readonly LocalizedText[];
  references?: readonly NoteReference[];
}

const text = (en: string, zh: string): LocalizedText => ({ en, zh });
const step = (title: LocalizedText, body: LocalizedText): InvestigationStep => ({ title, body });

export const BLOG_UI_COPY = {
  en: {
    title: "Field notes",
    badge: "Engineering",
    provenance: "Based on sanitized CodingAgent work records",
    eyebrow: "Engineering evidence",
    headline: "How we found and corrected product problems.",
    intro: "Each note starts with an observed problem. It shows the tests, the boundary, the change, and the design rule.",
    sourceTitle: "Sanitized source",
    sourceBody: "Raw agent records stay local. We remove accounts, hosts, prompts, identifiers, paths, customer data, and production inventories.",
    collection: "Case files",
    collectionBody: "Nine investigations cover Runtime, tools, Reader, memory, architecture, and interface design.",
    minutes: "min read",
    result: "Result",
    back: "All notes",
    signal: "Observed signal",
    boundary: "Boundary found",
    outcome: "Outcome",
    investigation: "Investigation",
    changes: "What changed",
    principles: "Design rules",
    references: "References",
    next: "Next case",
    missingTitle: "This note is not in the collection.",
    missingBody: "The route can be old, or the note can still be in review.",
  },
  zh: {
    title: "工程札记",
    badge: "工程",
    provenance: "由 CodingAgent 会话脱敏整理",
    eyebrow: "工程证据",
    headline: "我们如何发现并修正产品问题。",
    intro: "每篇札记从观察到的问题开始。它说明测试、边界、更改和设计规则。",
    sourceTitle: "已脱敏来源",
    sourceBody: "原始 Agent 记录保留在本地。我们删除账号、主机、Prompt、标识符、路径、客户数据和生产清单。",
    collection: "问题档案",
    collectionBody: "九篇调查覆盖 Runtime、工具、Reader、记忆、架构与界面设计。",
    minutes: "分钟阅读",
    result: "结果",
    back: "全部札记",
    signal: "观察到的信号",
    boundary: "找到的边界",
    outcome: "最终结果",
    investigation: "排查过程",
    changes: "解决方案",
    principles: "设计规则",
    references: "参考文献",
    next: "下一篇",
    missingTitle: "当前集合中没有这篇札记。",
    missingBody: "路由可能已经过期，或者札记仍在审阅中。",
  },
} as const;

export const ENGINEERING_NOTES: readonly EngineeringNote[] = [
  {
    sequence: "01",
    slug: "semantic-completion-not-eof",
    category: text("Runtime boundary", "运行时边界"),
    title: text("The model completed its content before the request ended.", "模型完成了内容，但请求还没有结束。"),
    summary: text(
      "The model completed text or tool arguments, but the interface still showed an active Turn. The delay occurred in the protocol adapter.",
      "模型完成了文本或工具参数，但界面仍显示活动 Turn。延迟发生在协议适配器中。",
    ),
    outcome: text(
      "The adapter now stops when it receives a terminal protocol event. It does not use HTTP EOF as the product state.",
      "适配器现在会在收到终止协议事件时停止。它不再使用 HTTP EOF 作为产品状态。",
    ),
    signal: text("Visible content complete, Turn still working", "可见内容已完整，Turn 仍在工作"),
    boundary: text("response.completed → adapter result", "response.completed → 适配器结果"),
    readingMinutes: 4,
    investigation: [
      step(
        text("Define each time interval", "定义每个时间区间"),
        text(
          "We measured six intervals: request to headers, first delta, final content, adapter completion, persistence, and tool dispatch. The total duration had hidden these separate waits.",
          "我们测量了六个区间：请求到响应头、首个 delta、最终内容、适配器完成、持久化和工具调度。总时长隐藏了这些独立等待。",
        ),
      ),
      step(
        text("Replay the request shape", "重放请求结构"),
        text(
          "We replayed a captured request shape through the normal backend. We logged only event types and monotonic times. The completion event arrived quickly. The byte stream remained open.",
          "我们通过正常后端重放了已捕获的请求结构。日志只记录事件类型和单调时间。完成事件很快到达。字节流仍保持打开。",
        ),
      ),
      step(
        text("Compare a tested parser", "比较经过测试的解析器"),
        text(
          "Codex uses the completed event as the final protocol state. Its regression test keeps the transport open. This test confirmed the correct boundary.",
          "Codex 使用 completed 事件作为最终协议状态。它的回归测试会让传输保持打开。该测试确认了正确边界。",
        ),
      ),
      step(
        text("Add a permanent test", "添加永久测试"),
        text(
          "We patched both installed copies of the dependency. The test sends terminal events and then keeps the iterator pending. It requires quick completion and iterator cancellation.",
          "我们修补了依赖的两个已安装副本。测试发送终止事件，然后让迭代器保持 pending。测试要求快速完成并取消迭代器。",
        ),
      ),
    ],
    changes: [
      text("Stop at terminal protocol events. Report an error if EOF arrives before a terminal event.", "在终止协议事件处停止。如果 EOF 先于终止事件到达，则报告错误。"),
      text("Measure the first content delta. Do not use a start marker for TTFT.", "测量首个内容 delta。不要使用 start 标记计算 TTFT。"),
      text("Store provider timing and local handler timing in separate telemetry records.", "在不同遥测记录中存储 Provider 时序和本地处理时序。"),
    ],
    principles: [
      text("Protocol state has priority over socket lifetime.", "协议状态优先于套接字寿命。"),
      text("A useful metric has a name for each interval boundary.", "有效指标会为每个区间边界命名。"),
    ],
  },
  {
    sequence: "02",
    slug: "range-first-pdf-reader",
    category: text("Reader performance", "Reader 性能"),
    title: text("Load PDF byte ranges before the full file.", "先加载 PDF 字节区间，不要先加载整个文件。"),
    summary: text(
      "The old preview read a binary PDF as text. It then downloaded and copied the file before parsing it. A resize discarded completed renders.",
      "旧预览把二进制 PDF 当作文本读取。然后，它在解析前下载并复制文件。窗口缩放会丢弃已完成的渲染。",
    ),
    outcome: text(
      "The Reader now loads byte ranges and renders a continuous page stack. It limits canvases and keeps completed pixels visible during zoom.",
      "Reader 现在加载字节区间并渲染连续页面。它限制 Canvas，并在缩放期间保留已完成的像素。",
    ),
    signal: text("Large preview waits, flashes, then fails after resize", "大文件久等、闪烁，并在缩放后绘制失败"),
    boundary: text("File revision → bounded Range → visible page", "文件版本 → 有界 Range → 可见页面"),
    readingMinutes: 5,
    investigation: [
      step(
        text("Measure the full path", "测量完整路径"),
        text(
          "The profile measured the path from a message link to the first rendered page. We compared network data with main-thread data for navigation and zoom.",
          "Profile 测量了从消息链接到首个渲染页面的路径。我们比较了翻页和缩放的网络数据与主线程数据。",
        ),
      ),
      step(
        text("Replace copies with a capability", "用能力凭证替换副本"),
        text(
          "The browser receives a short-lived capability for one path. PDF.js requests byte ranges. The server checks ownership and the file revision for each request.",
          "浏览器接收一个只适用于单一路径的短期能力凭证。PDF.js 请求字节区间。服务端为每个请求检查所有权和文件版本。",
        ),
      ),
      step(
        text("Limit remote adapter leases", "限制远端适配器 Lease"),
        text(
          "Range requests share a short lease for each backend. A revision change invalidates the lease. Runtime shutdown closes it. These limits prevent repeated handshakes and unbounded caches.",
          "Range 请求为每个后端共享短期 Lease。版本变化会使 Lease 失效。Runtime 关闭时会关闭 Lease。这些限制可防止重复握手和无限缓存。",
        ),
      ),
      step(
        text("Scale completed pixels first", "先缩放已完成的像素"),
        text(
          "A gesture first scales the completed canvas. The Reader starts a sharper render after the gesture ends. The old canvas remains visible until the new canvas is ready.",
          "手势先缩放已完成的 Canvas。手势结束后，Reader 开始更清晰的渲染。新 Canvas 就绪前，旧 Canvas 保持可见。",
        ),
      ),
    ],
    changes: [
      text("Use PDFDataRangeTransport and bounded runtime RPC chunks. Do not send binary media through the text endpoint.", "使用 PDFDataRangeTransport 和有界 Runtime RPC 分块。不要通过文本端点发送二进制媒体。"),
      text("Render visible and adjacent pages. Keep the page-view buffer bounded.", "渲染可见页面和相邻页面。限制 page-view buffer。"),
      text("Intercept pinch only at the mounted PDF root. Keep normal page scrolling native.", "只在已挂载的 PDF 根节点拦截捏合。保留原生页面滚动。"),
    ],
    principles: [
      text("Page DOM does not permit the Reader to fetch every page.", "页面 DOM 不允许 Reader 获取每个页面。"),
      text("During a gesture, visual continuity has priority over sharpness.", "手势期间，视觉连续性优先于清晰度。"),
    ],
  },
  {
    sequence: "03",
    slug: "turns-steps-and-messages",
    category: text("Conversation model", "对话模型"),
    title: text("Use Turn, Step, and Message for different data.", "Turn、Step 和 Message 用于不同数据。"),
    summary: text(
      "Message counts caused progress, compaction, and diagnostics to disagree. The UI showed a complete command, but the execution interval had no durable identifier.",
      "Message 数量使进度、Compact 和诊断结果不一致。界面显示完整命令，但执行区间没有持久标识符。",
    ),
    outcome: text(
      "Each data type now has one function. One Turn identifier connects the runtime, timeline, database, and telemetry.",
      "每种数据类型现在只有一个功能。一个 Turn 标识符连接 Runtime、Timeline、数据库和遥测。",
    ),
    signal: text("Progress labels disagree with what the agent is doing", "进度文案与 Agent 实际工作不一致"),
    boundary: text("User input → Agent idle is one Turn", "用户输入 → Agent 再次 idle 是一个 Turn"),
    readingMinutes: 4,
    investigation: [
      step(
        text("Define the data types", "定义数据类型"),
        text(
          "We compared the product terms with Codex event types. A Session contains durable work. A Turn is one work interval. A Step is one unit in a Turn. Messages contain conversation content.",
          "我们比较了产品术语和 Codex 事件类型。Session 包含持久工作。Turn 是一个工作区间。Step 是 Turn 中的一个单元。Message 包含对话内容。",
        ),
      ),
      step(
        text("Measure one command", "测量一条命令"),
        text(
          "We measured a real model flow from argument construction to idle. We recorded ready, approval, pending, running, tool result, and assistant continuation. These states explained each delay.",
          "我们测量了从参数构造到 idle 的真实模型流程。记录包括 ready、审批、pending、running、工具结果和助手续写。这些状态解释了每段延迟。",
        ),
      ),
      step(
        text("Store the Turn", "存储 Turn"),
        text(
          "The database stores each Turn with sequence bounds, status, duration, provider data, and accepted input. Timeline rows and tool events reference the Turn identifier.",
          "数据库存储每个 Turn 的序号边界、状态、时长、Provider 数据和已接收输入。Timeline 行和工具事件引用 Turn 标识符。",
        ),
      ),
      step(
        text("Keep markers after compaction", "Compact 后保留标记"),
        text(
          "Compaction summarizes engine context. It does not replace product history. Turn and compaction markers remain in the display timeline after compaction.",
          "Compact 总结引擎上下文。它不替换产品历史。Compact 后，Turn 和 Compact 标记仍保留在显示 Timeline 中。",
        ),
      ),
    ],
    changes: [
      text("Give each live and replayed tool state the same Turn identifier.", "为每个实时和回放工具状态提供相同的 Turn 标识符。"),
      text("Show ready, pending, running, success, error, and cancellation as different states.", "将 ready、pending、running、success、error 和 cancellation 显示为不同状态。"),
      text("Calculate Turn statistics from durable intervals. Do not use Message row counts.", "根据持久区间计算 Turn 统计信息。不要使用 Message 行数。"),
    ],
    principles: [
      text("Content, execution, and presentation are different layers.", "内容、执行和呈现是不同层。"),
      text("Store ancestry before replay if the replay must show ancestry.", "如果回放必须显示归属关系，请在回放前存储它。"),
    ],
  },
  {
    sequence: "04",
    slug: "durable-recap-contract",
    category: text("Long-session memory", "长会话记忆"),
    title: text("A snapshot defect changed Recap quality.", "快照缺陷改变了 Recap 质量。"),
    summary: text(
      "Recap quality appeared to change with the Session model. Tests showed that all Recap jobs used one generator. The snapshot and scheduler caused the difference.",
      "Recap 质量看起来会随 Session 模型变化。测试表明所有 Recap Job 使用同一个生成器。差异来自快照和调度器。",
    ),
    outcome: text(
      "Recap now uses a versioned Turn contract. The contract has a bounded snapshot, durable scheduling, generator provenance, and an extractive fallback.",
      "Recap 现在使用版本化的 Turn 契约。该契约包含有界快照、持久调度、生成器溯源和抽取式 fallback。",
    ),
    signal: text("Different sessions seem to receive different recap quality", "不同 Session 看起来得到不同质量的 Recap"),
    boundary: text("Completed Turn → quiet window → display-only recap", "完成的 Turn → 静默窗口 → 只读 Recap"),
    readingMinutes: 4,
    investigation: [
      step(
        text("Check the generator", "检查生成器"),
        text(
          "The database and Runtime showed that one operator-selected generator handled every Recap. The completed Turn model is provenance. It does not select Recap behavior.",
          "数据库和 Runtime 表明，一个运营侧生成器处理所有 Recap。已完成 Turn 的模型是溯源数据。它不选择 Recap 行为。",
        ),
      ),
      step(
        text("Inspect the snapshot", "检查快照"),
        text(
          "Long Sessions emphasized the first task because the snapshot started too early. The generator summarized the wrong part of the history.",
          "长 Session 强调第一个任务，因为快照开始得太早。生成器总结了错误的历史部分。",
        ),
      ),
      step(
        text("Evict the Runtime", "回收 Runtime"),
        text(
          "A delayed Recap job existed only in memory. Runtime eviction removed its timer, but the conversation remained. Session age and activity then appeared to change Recap quality.",
          "延迟 Recap Job 只存在于内存中。Runtime 回收删除了计时器，但对话仍然存在。Session 年龄和活动量因此看起来会改变 Recap 质量。",
        ),
      ),
      step(
        text("Version the contract", "对契约进行版本控制"),
        text(
          "One Recap module now owns snapshot bounds, prompt rules, fallback, and generator provenance. A meaning change increments the contract version. Session creation time does not select behavior.",
          "一个 Recap 模块现在拥有快照边界、Prompt 规则、fallback 和生成器溯源。含义变化会增加契约版本。Session 创建时间不选择行为。",
        ),
      ),
    ],
    changes: [
      text("Store quiet-window inputs in Recap jobs. A deployment or eviction must not remove them.", "在 Recap Job 中存储静默窗口输入。部署或回收不得删除这些输入。"),
      text("Center the snapshot on the latest completed Turn. Limit the preceding context.", "以最近完成的 Turn 为快照中心。限制前置上下文。"),
      text("Show Recap only in the display timeline. Do not add it as an engine Message.", "只在显示 Timeline 中显示 Recap。不要将其添加为引擎 Message。"),
    ],
    principles: [
      text("Store a delayed job before it starts.", "在延迟 Job 开始前存储它。"),
      text("Provenance explains behavior. It must not select behavior.", "溯源用于解释行为。它不得选择行为。"),
    ],
  },
  {
    sequence: "05",
    slug: "flat-connector-workspace",
    category: text("Interface evolution", "界面演进"),
    title: text("Give each machine a clear position.", "为每台机器提供明确位置。"),
    summary: text(
      "The Connector page used large forms and then status cards. Later designs added rings and badges. These changes did not correct the page structure.",
      "Connector 页面先使用大型表单，然后使用状态卡片。后续设计添加了圆环和 Badge。这些更改没有修正页面结构。",
    ),
    outcome: text(
      "A flat master-detail workspace separates machine selection from setup, policy, diagnostics, and delete actions. Status text does not use navigation space.",
      "平直的 master-detail 工作区将机器选择与设置、策略、诊断和删除操作分开。状态文字不占用导航空间。",
    ),
    signal: text("The page feels busy even when almost empty", "页面几乎为空，却仍显得拥挤"),
    boundary: text("Navigator selects a machine. The detail view contains actions.", "Navigator 选择机器。Detail View 包含操作。"),
    readingMinutes: 4,
    investigation: [
      step(
        text("Measure the screenshot", "测量截图"),
        text(
          "A status dot covered part of the computer icon. The online label repeated the same state. Large rounded cards also removed clear alignment. Bounding boxes measured each conflict.",
          "状态点覆盖了部分电脑图标。在线标签重复了相同状态。大型圆角卡片也删除了明确对齐。Bounding box 测量了每个冲突。",
        ),
      ),
      step(
        text("Replace the page structure", "替换页面结构"),
        text(
          "The new page uses an edge-to-edge navigator and one detail view. Each machine is one row in this stable structure. It is not a small dashboard.",
          "新页面使用 edge-to-edge Navigator 和一个 Detail View。每台机器是稳定结构中的一行。它不是小型仪表盘。",
        ),
      ),
      step(
        text("Give status a fixed slot", "为状态提供固定槽位"),
        text(
          "StatusDot uses a fixed slot at the end of the row. Its position does not depend on the machine icon. Accessible state remains without visible status text.",
          "StatusDot 使用行尾固定槽位。它的位置不依赖机器图标。删除可见状态文字后，无障碍状态仍然保留。",
        ),
      ),
      step(
        text("Define narrow-screen navigation", "定义窄屏导航"),
        text(
          "Narrow screens use a list-to-detail transition. Focus moves to the detail view. The Back action returns focus to the selected machine row.",
          "窄屏使用列表到详情的转换。焦点移动到 Detail View。返回操作会将焦点移回所选机器行。",
        ),
      ),
    ],
    changes: [
      text("Remove machine rings, status words, card shadows, and permanent dual forms.", "删除机器圆环、状态文字、卡片阴影和永久双表单。"),
      text("Use flat separators for structure. Use small radii only for controls.", "使用平直分隔线表达结构。只对控件使用小圆角。"),
      text("Put delete and policy controls in the selected machine detail view.", "将删除和策略控件放在所选机器的 Detail View 中。"),
    ],
    principles: [
      text("If visual changes do not help, check the spatial model.", "如果视觉更改没有帮助，请检查空间模型。"),
      text("Give status a fixed coordinate.", "为状态提供固定坐标。"),
    ],
  },
  {
    sequence: "06",
    slug: "capability-first-source-tree",
    category: text("Codebase architecture", "代码架构"),
    title: text("Organize the source tree by product capability.", "按产品能力组织源码目录。"),
    summary: text(
      "Framework folders and one large components folder made ownership unclear. We studied established practices from before 2023. We did not copy a recent template.",
      "框架目录和大型 components 目录使所有权不明确。我们研究了 2023 年以前的成熟实践。我们没有复制近期模板。",
    ),
    outcome: text(
      "The modular monolith now uses capability folders and small entrypoints. Reusable domains have inward dependencies. A layout check rejects generic source folders.",
      "模块化单体现在使用能力目录和小型入口。可复用域具有向内依赖。布局检查会拒绝通用源码目录。",
    ),
    signal: text("A file name is easy to find. Its owner is not clear.", "文件名容易找到。所有者不明确。"),
    boundary: text("Capability owns change companions", "由能力拥有共同变化的文件"),
    readingMinutes: 4,
    investigation: [
      step(
        text("Compare established structures", "比较成熟结构"),
        text(
          "We compared Screaming Architecture, colocation, React feature folders, VS Code contributions, Vue platform cores, and ESLint entrypoints. Each structure makes ownership and dependency direction clear.",
          "我们比较了 Screaming Architecture、Colocation、React Feature Folder、VS Code Contribution、Vue Platform Core 和 ESLint 入口。每种结构都明确显示所有权和依赖方向。",
        ),
      ),
      step(
        text("Group files that change together", "对共同变化的文件分组"),
        text(
          "PDF transport, rendering, cache, and assets change together. Composer controls also change together. Authentication and browser adapters do not share ownership because they use TypeScript.",
          "PDF 传输、渲染、缓存和资源会共同变化。Composer 控件也会共同变化。认证和浏览器适配器不会因为使用 TypeScript 而共享所有权。",
        ),
      ),
      step(
        text("Move files without behavior changes", "移动文件时不更改行为"),
        text(
          "We separated file moves from rules and documentation. Rename-aware diffs showed the moves. Tests compared the result with the unchanged behavior baseline.",
          "我们将文件移动与规则和文档分开。Rename-aware diff 显示了移动。测试将结果与未更改的行为基线进行比较。",
        ),
      ),
      step(
        text("Add a layout check", "添加布局检查"),
        text(
          "The layout check rejects new generic root folders and retired component folders. It also rejects reverse domain dependencies and Runtime dependencies in the shared contract.",
          "布局检查会拒绝新的通用根目录和已停用的 component 目录。它还会拒绝域反向依赖和 shared contract 中的 Runtime 依赖。",
        ),
      ),
    ],
    changes: [
      text("Organize server code by identity, persistence, HTTP, transport, Runtime, workspace, and related capabilities.", "按 identity、persistence、HTTP、transport、Runtime、workspace 和相关能力组织服务端代码。"),
      text("Organize browser code by authentication, conversation, dashboard features, files, platform, Sessions, share, and UI.", "按 authentication、conversation、dashboard features、files、platform、Session、share 和 UI 组织浏览器代码。"),
      text("Move a helper only after a second caller uses it. Otherwise, keep it with its only caller.", "只有第二个调用者使用 Helper 后，才移动它。否则，将它保留在唯一调用者旁边。"),
    ],
    principles: [
      text("Directories show code ownership.", "目录显示代码所有权。"),
      text("CI must enforce important architecture rules.", "CI 必须执行重要架构规则。"),
    ],
  },
  {
    sequence: "07",
    slug: "reader-as-peer-workspace",
    category: text("Product composition", "产品布局"),
    title: text("Give the file workspace its own column.", "为文件工作区提供独立列。"),
    summary: text(
      "A docked file had four header rows above it. The Composer also used all available width. Both designs used space for controls instead of work.",
      "停靠文件上方有四个 Header 行。Composer 也使用全部可用宽度。两种设计都将空间用于控件，而不是工作内容。",
    ),
    outcome: text(
      "Conversation and workspace are now peer columns. A file has one title row. Reader controls use that row. The Composer keeps a stable text width.",
      "Conversation 和 Workspace 现在是同级列。文件只有一个标题行。Reader 控件使用该行。Composer 保持稳定的文本宽度。",
    ),
    signal: text("Four forehead rows, little document, drifting controls", "四层额头、文档狭窄、控件漂移"),
    boundary: text("Column geometry belongs to the owning container", "列几何由自己的 Container 决定"),
    readingMinutes: 4,
    investigation: [
      step(
        text("Identify the owner of each row", "确定每行的所有者"),
        text(
          "We identified the owner of each horizontal row. The Chat header did not own the docked file. Mode tabs and a second toolbar repeated visible state.",
          "我们确定了每个水平行的所有者。Chat Header 不拥有停靠文件。Mode Tab 和第二个工具栏重复了可见状态。",
        ),
      ),
      step(
        text("Use peer columns", "使用同级列"),
        text(
          "The workspace starts at the top of the app frame beside the conversation. A compact activity rail selects file, diff, terminal, and related modes.",
          "Workspace 从应用 Frame 顶部开始，并与 Conversation 并排。紧凑的 Activity Rail 选择 File、Diff、Terminal 和相关模式。",
        ),
      ),
      step(
        text("Use one container breakpoint", "使用一个 Container 断点"),
        text(
          "The file title spacer and the PDF toolbar query the same named container. They now cross the breakpoint at the same width. This removes the empty title lane.",
          "文件标题 Spacer 和 PDF Toolbar 查询同一个命名 Container。它们现在在相同宽度跨过断点。此更改删除了空标题通道。",
        ),
      ),
      step(
        text("Keep a stable text width", "保持稳定文本宽度"),
        text(
          "In a wide column, the Composer uses a small capsule. Secondary controls stay outside it. Narrow screens use the stacked layout. State changes do not change text width.",
          "在宽列中，Composer 使用小型 Capsule。次要控件位于其外部。窄屏使用堆叠布局。状态变化不会改变文本宽度。",
        ),
      ),
    ],
    changes: [
      text("Remove the stacked Chat header, mode tabs, file title, and viewer toolbar.", "删除堆叠的 Chat Header、Mode Tab、文件标题和 Viewer Toolbar。"),
      text("Give the active file one title row. Put the PDF controls in that row.", "为活动文件提供一个标题行。将 PDF 控件放入该行。"),
      text("Use Container state for the Composer. Do not use viewport estimates or floating offsets.", "为 Composer 使用 Container 状态。不要使用 Viewport 估算或浮动偏移。"),
    ],
    principles: [
      text("Use more width to show more work.", "使用更多宽度显示更多工作内容。"),
      text("Align a control with the surface that it changes.", "将控件与其更改的 Surface 对齐。"),
    ],
  },
  {
    sequence: "08",
    slug: "dreaming-memory",
    category: text("Agent memory", "智能体记忆"),
    title: text("Dream the memory instead of saving notes.", "用 Dreaming 合成记忆，而不是保存笔记。"),
    summary: text(
      "Each new session started from zero context. A saved-notes design goes stale and misses implicit facts. We adopted the Dreaming architecture from the OpenAI memory system.",
      "每个新会话都从零上下文开始。保存笔记的设计会过期，也会漏掉隐式信息。我们采用了 OpenAI 记忆系统中的 Dreaming 架构。",
    ),
    outcome: text(
      "A background pass now rewrites one memory document for each user. The agent carries preferences and projects into new sessions. A Settings switch turns the whole system on or off.",
      "后台任务现在为每位用户重写一份记忆文档。智能体把偏好与项目带入新会话。设置中的开关可整体开启或关闭。",
    ),
    signal: text("Repeated introductions, stale saved notes, missed implicit preferences", "重复自我介绍、笔记过期、隐式偏好被漏掉"),
    boundary: text("Memory is a rewritten document, not an appended log", "记忆是被重写的文档，而不是追加的日志"),
    readingMinutes: 5,
    investigation: [
      step(
        text("Follow the canonical design", "跟随权威设计"),
        text(
          "The OpenAI Dreaming post defines the target. A background process reads recent conversations and rewrites one fresh memory state. It names three tests. Carry context forward. Follow preferences. Stay current over time.",
          "OpenAI 的 Dreaming 文章定义了目标。后台进程阅读近期对话并重写一份新鲜的记忆状态。它给出三个检验标准。携带上下文。遵循偏好。随时间保持最新。",
        ),
      ),
      step(
        text("Dream in the background", "在后台做梦"),
        text(
          "A slow loop finds users with settled new activity. It reads bounded text excerpts above a high-water mark. One model call rewrites the whole document. A NOOP verdict skips the write.",
          "一个低频循环寻找活动已沉淀的用户。它读取高水位之上的有界文本摘录。一次模型调用重写整份文档。NOOP 判定跳过写入。",
        ),
      ),
      step(
        text("Revise for time", "为时间修订"),
        text(
          "The prompt carries the current date. Plans with past dates become past tense or get dropped. Code extracts the earliest future date from the document. When that date passes, a zero-input dream fires.",
          "提示词携带当前日期。日期已过的计划改为过去式或删除。代码从文档中提取最近的未来日期。日期一过，就触发一次零输入的梦。",
        ),
      ),
      step(
        text("Gate the write path", "守住写入路径"),
        text(
          "Memory text is model output that becomes durable prompt material. An admission gate rejects prose, tag breakouts, and oversize output. The injection block is framed as data, never as instructions.",
          "记忆文本是模型输出，并会成为持久的提示词材料。准入门拒绝散文、标签逃逸和超长输出。注入块被框定为数据，绝不是指令。",
        ),
      ),
      step(
        text("Give the user the controls", "把控制权交给用户"),
        text(
          "Settings shows what the agent remembers with a freshness stamp. The user writes notes that dreaming never rewrites. Clear forgets the state. The switch stops synthesis and injection together. Re-enable skips the paused period.",
          "设置页展示智能体记住的内容和更新时间。用户可写下 dreaming 永不改写的备注。清除会忘掉状态。开关同时停止合成与注入。重新开启会跳过暂停期。",
        ),
      ),
    ],
    changes: [
      text("Add a user_memory row with one dreamed document, a high-water mark, and a review date.", "新增 user_memory 行，包含一份合成文档、高水位标记和复查日期。"),
      text("Run the dreamer beside the automation scheduler in the runtime process.", "让做梦任务与自动化调度器同进程运行。"),
      text("Refresh the injected memory block at each turn boundary. The toggle acts on the next turn.", "在每个回合边界刷新注入的记忆块。开关在下一回合生效。"),
      text("Verify the pipeline with a stubbed generator in check:memory-dreaming.", "用 check:memory-dreaming 中的桩生成器验证整条流水线。"),
    ],
    principles: [
      text("Rewrite memory whole. Append-only notes rot.", "整体重写记忆。只追加的笔记会腐烂。"),
      text("Treat remembered text as data, never as instructions.", "把记住的文本当作数据，绝不当作指令。"),
      text("Account for the passage of time, or memory becomes wrong.", "为时间流逝建模，否则记忆会变错。"),
    ],
    references: [
      { label: text("OpenAI: Dreaming, better memory for ChatGPT (2026)", "OpenAI：Dreaming，更好的 ChatGPT 记忆（2026）"), url: "https://openai.com/index/chatgpt-memory-dreaming/" },
      { label: text("OpenAI Help Center: Memory FAQ", "OpenAI 帮助中心：Memory FAQ"), url: "https://help.openai.com/en/articles/8590148-memory-faq" },
      { label: text("OpenAI Model Spec", "OpenAI Model Spec"), url: "https://github.com/openai/model_spec/blob/main/model_spec.md" },
      { label: text("Letta: Sleep-time Compute", "Letta：Sleep-time Compute"), url: "https://www.letta.com/blog/sleep-time-compute" },
      { label: text("Mem0: scalable memory for agents (arXiv 2504.19413)", "Mem0：可扩展的智能体记忆（arXiv 2504.19413）"), url: "https://arxiv.org/abs/2504.19413" },
      { label: text("Generative Agents (arXiv 2304.03442)", "Generative Agents（arXiv 2304.03442）"), url: "https://arxiv.org/abs/2304.03442" },
      { label: text("Zep: temporal knowledge graph memory (arXiv 2501.13956)", "Zep：时间知识图谱记忆（arXiv 2501.13956）"), url: "https://arxiv.org/abs/2501.13956" },
      { label: text("Memory poisoning attacks in LLM agents (arXiv 2606.04329)", "LLM 智能体的记忆投毒攻击（arXiv 2606.04329）"), url: "https://arxiv.org/abs/2606.04329" },
    ],
  },
  {
    sequence: "09",
    slug: "upstream-semantics-safe-capability-boundary",
    category: text("Tool architecture", "工具架构"),
    title: text("Keep upstream edit semantics behind a workspace capability.", "将上游编辑语义放在工作区能力边界之后。"),
    summary: text(
      "Our edit tool was safe, but its small replacement schema drifted from Pi. Reimplementing the patch would preserve that semantic fork.",
      "我们的编辑工具很安全，但小型替换结构已经偏离 Pi。重新实现 Patch 会保留这个语义分叉。",
    ),
    outcome: text(
      "Pi now owns matching, validation, and patch generation. oiia owns workspace confinement, serialization, evidence bounds, and public redaction.",
      "Pi 现在负责匹配、验证和 Patch 生成。oiia 负责工作区限制、串行化、证据边界和公开脱敏。",
    ),
    signal: text("A safe edit tool rejects valid multi-region work", "安全的编辑工具却拒绝有效的多区域修改"),
    boundary: text("Pi semantics → workspace capability → product evidence", "Pi 语义 → 工作区能力 → 产品证据"),
    readingMinutes: 4,
    investigation: [
      step(
        text("Separate safety from compatibility", "区分安全和兼容"),
        text(
          "We compared accepted arguments, matching rules, mutation ordering, and returned evidence. Path safety was correct. Edit semantics had drifted.",
          "我们比较了参数、匹配规则、修改顺序和返回证据。路径安全是正确的。编辑语义已经偏离。",
        ),
      ),
      step(
        text("Trace the upstream runtime", "追踪上游运行路径"),
        text(
          "Pi accepts multiple disjoint replacements. It repairs common provider shapes. It matches one original snapshot and commits one write.",
          "Pi 接受多个不相交替换。它修复常见 Provider 参数形状。它匹配一份原始快照，并只提交一次写入。",
        ),
      ),
      step(
        text("Define ownership", "定义职责"),
        text(
          "Pi owns text semantics. The Sandbox owns file access. One write lease protects the complete read, validation, and commit transaction.",
          "Pi 负责文本语义。Sandbox 负责文件访问。一个写入 Lease 保护完整的读取、验证和提交事务。",
        ),
      ),
      step(
        text("Preserve product evidence", "保留产品证据"),
        text(
          "The adapter keeps the unified patch from Pi. It bounds durable patch data. Public shares remove replacement text and retain the target path.",
          "适配器保留 Pi 的 Unified Patch。它限制持久化 Patch。公开分享删除替换文本，但保留目标路径。",
        ),
      ),
      step(
        text("Test failure paths", "测试失败路径"),
        text(
          "Tests cover duplicate matches, missing regions, overlap, no-op edits, aborts, CRLF, BOM, fuzzy normalization, and concurrent Sandboxes.",
          "测试覆盖重复匹配、缺失区域、重叠、空修改、中止、CRLF、BOM、模糊规范化和并发 Sandbox。",
        ),
      ),
    ],
    changes: [
      text("Replace local single-edit logic with the public Pi createEditTool implementation.", "用公开的 Pi createEditTool 实现替换本地单区域编辑逻辑。"),
      text("Map a virtual Pi workspace to Sandbox operations under one workspace write lease.", "在一个工作区写入 Lease 下，将虚拟 Pi 工作区映射到 Sandbox 操作。"),
      text("Persist a bounded unified patch, and remove replacement payloads from public shares.", "持久化有界 Unified Patch，并从公开分享中删除替换参数。"),
    ],
    principles: [
      text("Reuse semantics. Adapt capabilities.", "复用语义。适配能力。"),
      text("Safety lives at the boundary, not in a reduced feature set.", "安全属于边界，不属于被削减的功能集。"),
      text("A smaller semantic fork is still maintenance debt.", "较小的语义分叉仍是维护债务。"),
    ],
    references: [
      { label: text("Pi edit tool source", "Pi 编辑工具源码"), url: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/edit.ts" },
      { label: text("Pi edit and patch source", "Pi 编辑与 Patch 源码"), url: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/edit-diff.ts" },
    ],
  },
] as const;

export function localize(locale: BlogLocale, value: LocalizedText): string {
  return value[locale];
}

export function findEngineeringNote(slug: string | undefined): EngineeringNote | undefined {
  return slug ? ENGINEERING_NOTES.find((note) => note.slug === slug) : undefined;
}
