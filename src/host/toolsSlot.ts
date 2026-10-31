/**
 * DSH tools 槽位的最小形状契约（tools.ts 与 toolsSkillGateway.ts 共享）。
 * 独立成文件以避免 tools ↔ toolsSkillGateway 的 type-only 循环引用。
 *
 * ★cycle-82：本文件同时承载**工具出口的无损 JSON 防线**（`wireGuard`）。
 * 为什么放在契约层而不是各 gateway：真正的缺陷不是某个字段漏了 `?? null`，
 * 而是「任何工具返回的 canonical value 都可能有可选 undefined 字段」这一整类。
 * 修在一个共同的出口才能对新工具、新字段持续生效（语义裁决见 runtime/jsonSanitize.ts）。
 */
import { sanitizeForWire } from './runtime/jsonSanitize.ts';
// cycle-89 T-04：未知参数键守卫（参数面语义裁决，独立成文件守 T3 ≤250 行）。
import { withArgumentGuard } from './toolsArgGuard.ts';

/**
 * 工具调用呈现视图（DSH ToolCallView 子集）。
 * M10-d 技能优先面：工具调用时可视化透明化。
 */
export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other';

/** 通用卡片视图（pending 状态）。 */
export interface GenericCallView {
  card: 'generic';
  title: string;
  kind?: ToolCallKind;
  rawInput?: unknown;
}

/** 终端卡片视图（pending 状态）——命令执行类工具。
 *
 * 字段名对齐官方 0.2.0-rc.2 presentation.d.ts:77-93（TerminalCallView）：
 * `description?` 是渲染在终端卡片上方的单行摘要（官方注释原文 "rendered ABOVE
 * the terminal card"）。cycle-39 T-3914 前 dsh-anic 用自造 `summary?`——
 * capable UI 按官方字段读取时丢弃该行（DSH 规范审计 P1）。
 */
export interface TerminalCallView {
  card: 'terminal';
  title: string;
  description?: string;
  cwd?: string;
}

export type ToolCallView = GenericCallView | TerminalCallView;

/** 通用结果视图（completed 状态）。 */
export interface GenericResultView {
  card: 'generic';
  title?: string;
}

/** 终端结果视图（completed 状态）——含退出码、信号与输出。 */
export interface TerminalResultView {
  card: 'terminal';
  title?: string;
  output?: string;
  exitCode?: number;
  /** 进程被信号终止时（宿主 ToolResultView 官方超集的 signal 字段）——与 exitCode 互斥呈现。 */
  signal?: string;
}

export type ToolResultView = GenericResultView | TerminalResultView;

/**
 * 模型可见内容块（DSH ContentBlock 子集，本插件只用 text 块）。
 *
 * 宿主证据（安装版 0.2.0-rc.2，与 dsh-plugin-dev-kb tools.md:23 契约一致）：
 * dsh-llm/lib/index.js:594 请求组装期 `contentHasImage(content)` 调
 * `content.some(...)` —— content 必须是 ContentBlock[]。render 返回裸字符串时
 * 注册表的 snapshotProjection（dsh-tools/lib/index.js:2564）不拦截（字符串是
 * 无损 JSON），直到请求组装才 `content.some is not a function` 崩溃
 * （P0-RENDER-CONTENT：真模型实测 anic_evaluate/anic_status/anic_skill 三工具同错）。
 */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/**
 * 工具输出声明（DSH tools.register API 要求）。
 * schema: object-rooted JSON Schema（assertSupportedJsonSchema 校验）。
 * render: (args, value) => ContentBlock[]，纯投影到模型可见内容块数组。
 * presentationMeta: 可选，附加呈现元数据（JsonValue）。
 */
export interface ToolOutput {
  schema: Record<string, unknown>;
  /** 必须返回内容块数组（不是字符串）—— 见 TextContentBlock 的宿主证据注释。 */
  render: (args: Record<string, unknown>, value: unknown) => TextContentBlock[];
  presentationMeta?: (args: Record<string, unknown>, value: unknown) => unknown;
}

export interface ToolRegistration {
  name: string;
  description: string;
  /**
   * 模型面输入 schema（DSH 工具契约字段名是 `parameters`，不是 inputSchema）。
   *
   * 宿主证据（app.asar dsh-host-tools ToolRuntime）：
   * - `register(definition)` 注册时**只**校验 `output`，`parameters` 原样保留；
   * - 会话发起时 `wireSchemas → schemaOf(definition)` 解构 `{name,description,parameters,…}`
   *   并 `snapshotJsonValue(parameters)` —— undefined 直接抛
   *   `tool "<name>" parameters must be lossless JSON before schema projection`，
   *   **整个对话立即失败**（P0-TOOLS-FIELDS：曾用 `inputSchema` 字段名，注册成功但
   *   每次对话报 lossless JSON 错误，12 个工具全部如此）。
   * - 值为标准 function-calling JSON Schema：`{type:'object', properties:{…}, required?:[…]}`。
   */
  parameters: Record<string, unknown>;
  /**
   * 工具体（DSH 契约字段名是 `execute`，不是 handler）。
   * 宿主 `dispatchToolBody` 调 `tool.execute(exec.arguments, exec)` ——
   * 第二个参数是执行上下文。P1-EXEC-SIGNAL（cycle-16）：官方 adding-a-tool.md
   * 契约「遵守 exec.signal —— 信号触发时取消进行中的工作」——长时脚本类工具
   * 必须读取 exec.signal 并传播给子进程；不接取消的同步查询工具可忽略。
   */
  execute: (args: Record<string, unknown>, exec?: ToolExecContext) => Promise<Record<string, unknown>>;
  /** DSH tools.register 必需：输出声明（schema + render）。 */
  output: ToolOutput;
  /** M10-d: pending 状态呈现（DSH UI 工具卡片标题/图标）。 */
  presentCall?: (args: Record<string, unknown>) => ToolCallView | undefined;
  /** M10-d: completed 状态呈现（DSH UI 工具结果卡片）。 */
  presentResult?: (args: Record<string, unknown>, result: Record<string, unknown>) => ToolResultView | undefined;
  /**
   * cycle-40（KB 研究 #2 吸收，subsystems/tools.md:68-88）：
   * 协作式工具调用超时预算（毫秒）。省略 = 无截止。由
   * `@deepseek-ai/dsh-tool-call-timeout-policy`（tools/execute 包装器）强制；
   * **绝不进模型请求**（schemas() 白名单只放 name/description/parameters）。
   * 声明即断言：本工具把 exec.signal 转发给可静止的协作实现——
   * dsh-anic 的脚本执行类工具经 invokeSkillScriptAsync({ signal }) 满足此断言。
   */
  timeoutMs?: number;
  /**
   * cycle-40（KB 研究 #2 吸收，subsystems/tools.md:76-88）：
   * 纯同步分类器——是否可与兄弟工具调用并行。**只有精确 true 入并行组**；
   * 省略/异常/非 true 返回 = 互斥（fail-closed）。绝不模型可见。
   * 入组执行不得改父级共享状态；共享状态须容忍并发分派。
   * dsh-anic 的纯读工具（snapshot/self_check/status 等）标 true；
   * 写侧工具（install/advance/archive…）与 anic_skill（写 FlowTracker）保持省略。
   */
  isConcurrencySafe?: (args: unknown) => boolean;
  /**
   * cycle-74：**宿主原生**渐进式披露开关（`ToolSchema.deferLoading`）。
   *
   * 官方语义（`dsh-llm` ToolSchema 注释逐字）：「Requests deferred loading of the tool
   * definition into model context... Uses Anthropic's **defer_loading** terminology.」
   * 即：置 true 时宿主把该工具定义**延迟加载**进模型上下文（模型仍可经索引发现并按需激活），
   * 这是 Anthropic 工具检索/渐进式披露的标准机制，**不需要**插件自造 restrict + loader 工具。
   *
   * 实测接收面（app.asar dsh-tools/lib/index.js `register`）：宿主注册时只校验 `output`
   * 与 `timeoutMs`，其余字段**原样收下**；投影时 `schemaOf` 解构 `{name,description,parameters,
   * deferLoading}` 并在 `deferLoading === true` 时才把它放进模型 schema。
   */
  deferLoading?: true;
}

/**
 * ★cycle-82：把一次 `execute` 的返回值收敛成**无损 JSON 对象**（工具出口的唯一闸门）。
 *
 * 为什么在这里抛而不是返回 `{error}`：工具返回非对象是**编程错误**（schema 是
 * object-rooted），把它降级成"成功的错误值"会让模型以为工具跑通了。
 * 宿主对 throw 的语义就是 isError=true —— 让错误可见，与本仓「守卫必须响亮」一致。
 */
export function sanitizeToolValue(value: unknown): Record<string, unknown> {
  const safe = sanitizeForWire(value);
  if (safe === null || typeof safe !== 'object' || Array.isArray(safe)) {
    throw new Error('tool execute must return an object value (canonical value is object-rooted)');
  }
  return safe as Record<string, unknown>;
}

/**
 * ★cycle-82：工具注册期的**统一出口防线**（包装 execute）。
 *
 * 缺陷形态（真机实测）：`anic_status` 返回 `value is not lossless JSON` ——
 * `ScriptHealth.recentSuccessRate` 在「近 7 天无调用」时为 `undefined`，被原样
 * 塞进 canonical value；宿主 `visitJsonValue` 遇 undefined 判非法，整个返回值丢弃。
 *
 * 为什么包装**注册**而不是改 20 处 `execute`：调用点越多，漏一个就越隐蔽，
 * 而漏了在 vitest 里不会红（JSON.stringify 会静默吞掉 undefined）。包装注册面后，
 * 任何网关（含未来新增的）都自动经过同一道闸门 —— 出口防线才有保修期。
 * 语义裁决（对象删键 / 数组 null / Date→ISO …）见 runtime/jsonSanitize.ts 头注。
 */
export function wireGuard(tool: ToolRegistration): ToolRegistration {
  const inner = tool.execute;
  return {
    ...tool,
    // cycle-89 T-04：未知键守卫接在**唯一出口**（wireGuard），对新工具自动生效，
    // 无需在 20+ 个 gateway 里逐个打补丁。守卫实现见 toolsArgGuard.ts。
    execute: withArgumentGuard(tool, async (args, exec) => sanitizeToolValue(await inner(args, exec))),
  };
}

/**
 * 构造通用工具输出声明：object-rooted schema + JSON 文本块渲染。
 * 所有 ANIC 工具返回 JSON 对象，统一用此工厂避免 12 处重复。
 * render 包一个 text 块（ContentBlock[] 契约见 TextContentBlock 注释）。
 *
 * ★cycle-82 第二层：render 侧再 sanitize 一次。宿主对 canonical value 的校验发生在
 * render **之前**（本文件的 wireGuard 才是主防线）；这一层守的是「有人绕过注册面
 * 直接调 render」的形态，保证模型看到的 JSON 文本永不因 undefined 变成半截对象。
 * 快路径保证合法值原样通过（零重建）。
 */
export function makeToolOutput(): ToolOutput {
  return {
    schema: { type: 'object' },
    // JSON.stringify(undefined) 返回 undefined（非字符串）——值缺失时兜底为 null，
    // 保证 text 字段永远是 string（TextContentBlock 契约）。
    render: (_args, value) => [{
      type: 'text',
      text: JSON.stringify(sanitizeForWire(value === undefined ? null : value), null, 2),
    }],
  };
}

export interface ToolsSlot {
  register?: (tool: ToolRegistration) => (() => void) | null | undefined;
}

/**
 * 工具执行上下文（DSH dispatch 第二参的最小契约面）。
 * 宿主保证 signal 必需且由调用方持有（adding-a-tool.md：exec.signal 不可移除）。
 */
export interface ToolExecContext {
  signal?: AbortSignal;
  /**
   * 调用方 agent（cycle-92）—— 渐进式披露按需解锁的归属依据。
   *
   * 宿主契约 `ToolRunContext` 带 `agent`。indexed 模式把工具全 restrict 掉，只有
   * 知道「哪个 agent 在取 schema」才能只解锁它 —— 放宽别的 agent 就是跨会话越权。
   */
  agent?: unknown;
}

/**
 * 包装 async execute 添加错误边界（P1-4）。
 *
 * cycle-22 语义修正（官方契约对齐，adding-a-tool.md「execute() 约定的规则」）：
 * - **基础设施故障 = 抛异常**——注册表捕获异常并收敛为 isError=true 的结果，
 *   模型与轨迹据此看到失败。旧实现把一切异常折叠成 { error } 正常返回，
 *   isError=false 的「成功」无法区分 infra 故障与领域失败（与官方语义相反）。
 * - **领域失败 = 规范值**——调用方应显式返回 { error: ... } 等规范值
 *   （如 script not whitelisted / validateWorkspace 拒绝），不经 throw。
 *   现有 gateway 均已遵守（grep 验证无 intentional throw）。
 * - 本包装保留的意义：async 边界统一（签名透传 exec）+ 注释锚点，
 *   不再吞异常——异常沿 Promise 拒绝传播给注册表。
 * P1-EXEC-SIGNAL：签名透传 exec（第二参），调用方可读 exec.signal 取消子进程。
 */
export function safeHandler(
  fn: (args: Record<string, unknown>, exec?: ToolExecContext) => Promise<Record<string, unknown>>,
): (args: Record<string, unknown>, exec?: ToolExecContext) => Promise<Record<string, unknown>> {
  return async (args, exec) => fn(args, exec);
}
