/**
 * 流程契约（L0，零 IO）—— R3 阶段 2 骨架（docs/anic/17 §「分阶段迁移路线」）。
 *
 * 设计裁决（R3 报告 §架构契约，逐条承重）：
 *  - guard 必须引用 GuardRegistry 键（字符串），禁止内联闭包 —— 描述子保持
 *    可序列化、可 diff、可在不实例化引擎的情况下静态校验转移完整性。
 *  - apply 是唯一写点（返回下一状态 + 事件，由调用方持久化）；can 是纯查询。
 *  - 投影（persistence kind='projection'）可丢弃可重算，禁止成为第二真相源
 *    （workflow-state.mjs:121-125 的「读回即真相」是反例，INV-22）。
 *  - ModuleEngine 分 long / per-call 生命周期（docs/anic/06:90：只有 CycleRunner
 *    是 per-call，其余全是长命主干 —— 「每流程一个 fiber」是反模式）。
 */

/** 流程状态（描述子各自收窄为字面量联合）。 */
export type FlowState = string;
/** 流程触发器名。 */
export type FlowTrigger = string;

/** 状态转移边。from='*' 表示任意状态皆可（用于 reset/中断类边）。 */
export interface FlowTransition<S extends FlowState = FlowState> {
  from: S | '*';
  to: S;
  trigger: FlowTrigger;
  /** GuardRegistry 键；缺省 = 无守卫（纯结构转移）。 */
  guard?: string;
}

/** 守卫上下文：运行期事实（引擎输出、环境快照）由调用方注入，描述子不感知来源。 */
export interface GuardContext {
  /** 转移发生时的负载（如引擎裁决、配置值）。 */
  payload?: unknown;
  /** 工作区根（仅事实传递；守卫不自行读盘 —— IO 只在引擎层）。 */
  workspaceRoot?: string;
}

/** 守卫裁决。ok=false 且 refusal='SELF_REFUSAL' = 无证据自主动作被拒（INV-28）。 */
export interface GuardResult {
  ok: boolean;
  reason?: string;
  refusal?: 'SELF_REFUSAL';
}

/** 流程描述子（可序列化；注册进 FlowRegistry）。 */
export interface FlowDescriptor<S extends FlowState = FlowState> {
  id: string;
  /** i18n 键（locale/{zh,en}.json flows.<labelKey>）。 */
  labelKey: string;
  states: readonly S[];
  initial: S;
  transitions: readonly FlowTransition<S>[];
  persistence: FlowPersistence;
  /** ModuleEngine 注册键（阶段 2 起 gateCheck 接 engine）。 */
  engine?: string;
  /** 技能脚本回退名（skillInvoker 白名单内）；原生引擎不可用时降级。 */
  scriptFallback?: string;
}

/** 持久化策略：真相只许是账本；投影可丢；none = 纯内存。 */
export interface FlowPersistence {
  kind: 'ledger' | 'projection' | 'none';
  /** 投影路径（相对 .cycles/；kind='projection' 时必填）。 */
  path?: string;
}

/** 已发生的转移事件（replay 的输入；投影与账本共同的原子单位）。 */
export interface FlowEvent<S extends FlowState = FlowState> {
  trigger: FlowTrigger;
  from: S;
  to: S;
  at: string;
  reason?: string;
}

/** 流程运行态（投影文件的内容形态）。 */
export interface FlowRuntimeState<S extends FlowState = FlowState> {
  flowId: string;
  current: S;
  history: FlowEvent<S>[];
  updatedAt: string;
  /** 写投影时的账本链头（staleness 检测用；无账本流程为 null）。 */
  ledgerHead?: string | null;
}

/** apply 结果：ok=false 时 next/event 缺席，拒绝必须带 reason。 */
export interface FlowApplyResult<S extends FlowState = FlowState> {
  ok: boolean;
  next?: S;
  event?: FlowEvent<S>;
  reason?: string;
  refusal?: 'SELF_REFUSAL';
}

/** 守卫函数签名（GuardRegistry 的值类型）。 */
export type GuardFn = (ctx: GuardContext) => GuardResult;

/**
 * 模块引擎契约（阶段 2 骨架）：一个引擎承载一个能力域的 step/verify，
 * 状态流转本身归 FlowMachine —— 引擎不持有流程状态（防双真相源）。
 */
export interface ModuleEngine<I, O> {
  id: string;
  /** long = 随插件根 fiber 常驻；per-call = 每次调用独立（仅 CycleRunner 类）。 */
  lifecycle: 'long' | 'per-call';
  /** 执行一步（纯计算或受控 IO；不写流程状态）。 */
  step(input: I): O;
  /** 输出回验（Post-Verify 精神：效果即记录的前提是效果可验）。 */
  verify?(output: O): boolean;
}
