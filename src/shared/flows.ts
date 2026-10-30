/**
 * ANIC 功能开关注册表与三层合并（docs/anic/13 §2 的 M1 落地切片）。
 *
 * 单实现原则（12 §3.1）：开关语义只有这一份实现，client / host / tests 共用。
 * - FLOWS 是唯一开关清单（9 个 flow，见 13 §2.2）；核心链路（标签壳之外的数据
 *   路由与只读工具）**不在清单里** —— 任何试图以 `flow.*` 关闭核心链路的键都会
 *   落入 unknown 分支被拒绝并告警（INV-29 的实现形态）。
 * - 三层优先级：user > workspace > deployment（越具体越优先，13 §2.1）。
 * - 非法值 fail-safe 回默认并产出 warning（响亮，不静默；13 §2.1）。
 * - 本模块不接触 window/localStorage —— 存储读取在 client 集成层完成，
 *   shared 只做纯解析与合并（可被 host/tests 复用，且不进宿主 bundle 的 DOM 假设）。
 */

export const PREFS_KEY = 'dsh-anic.prefs.v1';

export type FlowLayer = 'user' | 'workspace' | 'deployment';

export interface FlowDefinition {
  /** 全量 id，形如 'flow.workflowTab'（与 docs/anic/13 §2.2 表一致） */
  id: string;
  label: string;
  /** 客户端渲染键（locale/zh|en.json 的 flows.* 段）；label 是 host/诊断侧的中文口径，客户端一律走 t(labelKey) */
  labelKey: string;
  /** 该开关支持哪几层配置（M1 只启用 user 层；workspace/deployment 在 M2-a 接入） */
  layers: readonly FlowLayer[];
  /** 关闭形态契约（degradation contract）：关闭后系统处于什么状态 */
  degradation: string;
}

export interface FlowState {
  enabled: boolean;
  /** 生效值来源层；null = 默认值（未配置） */
  source: FlowLayer | null;
}

export interface ResolvedFlows {
  flows: Record<string, FlowState>;
  warnings: string[];
}

export interface PrefsFile {
  version: 1;
  flows: Record<string, boolean>;
}

/** 10 个 flow 开关（与 docs/anic/13 §2.2 逐行对应 + cycle-9 新增 flowsView，新增开关必须同时更新该表 + locale flows.* 段） */
export const FLOWS: readonly FlowDefinition[] = [
  { id: 'flow.workflowTab', label: 'ANIC 可视化标签', labelKey: 'flows.workflowTab', layers: ['user', 'workspace', 'deployment'], degradation: 'unregister 槽位（既有 disposer 路径）；宿主路由/工具照常' },
  { id: 'flow.stepTrace', label: '白盒流程分区', labelKey: 'flows.stepTrace', layers: ['user', 'workspace', 'deployment'], degradation: '分区隐藏，其余分区/数据不受影响' },
  { id: 'flow.diagnostics', label: '诊断面板', labelKey: 'flows.diagnostics', layers: ['user', 'workspace', 'deployment'], degradation: '面板不注册；遥测仍在内存环形缓冲（不丢证据）' },
  { id: 'flow.approvals', label: '批准卡/HITL 队列', labelKey: 'flows.approvals', layers: ['user', 'workspace', 'deployment'], degradation: '队列只读展示 + 指引改走技能 CLI（自主级自动降 L2）' },
  { id: 'flow.autoRefresh', label: 'live 轮询/刷新', labelKey: 'flows.autoRefresh', layers: ['user', 'workspace', 'deployment'], degradation: '回退手动刷新按钮（条件请求语义仍在）' },
  { id: 'flow.gateRecord', label: '门禁结果自动入账本', labelKey: 'flows.gateRecord', layers: ['workspace', 'deployment'], degradation: '不自动记账，UI 显式标注「未入账本」（诚实降级）' },
  { id: 'flow.budgetEnforce', label: '预算熔断', labelKey: 'flows.budgetEnforce', layers: ['workspace', 'deployment'], degradation: '降级为只告警不熔断（显示风险横幅）' },
  { id: 'flow.selfInit', label: '自举命令', labelKey: 'flows.selfInit', layers: ['workspace', 'deployment'], degradation: '命令返回响亮禁用提示' },
  { id: 'flow.agentsOrchestration', label: '子代理编排流', labelKey: 'flows.agentsOrchestration', layers: ['workspace', 'deployment'], degradation: '编排配方标记停用；工具面照常（手动编排不受影响）' },
  // cycle-9（D10 宿主域接线）：flows 状态面板分区。路由 /anic/flows/status 与
  // 状态机本身不关（核心链路），只关面板分区 —— 关闭形态契约与 stepTrace 同款。
  { id: 'flow.flowsView', label: '流程状态机面板', labelKey: 'flows.flowsView', layers: ['user', 'workspace', 'deployment'], degradation: '分区隐藏，其余分区/数据不受影响' },
];

export const FLOW_IDS: readonly string[] = FLOWS.map((f) => f.id);

function isFlowLayer(value: unknown): value is FlowLayer {
  return value === 'user' || value === 'workspace' || value === 'deployment';
}

/** 未知/非法键的统一告警文案（INV-29：核心链路不可关的解释就写在这里） */
function unknownSwitchWarning(id: string, layer: FlowLayer): string {
  return `unknown flow switch '${id}' at ${layer} layer (ignored) — core chain (snapshot route / readonly tools) is NOT switchable, see docs/anic/13 §2.3`;
}

/**
 * 三层合并：user > workspace > deployment > 默认(true)。
 * 任何层的未知键/非法值都进 warnings，不抛错（开关体系自身的 fail-safe）。
 */
export function resolveFlows(layers: {
  user?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  deployment?: Record<string, unknown>;
}): ResolvedFlows {
  const warnings: string[] = [];
  const flows: Record<string, FlowState> = {};
  for (const def of FLOWS) flows[def.id] = { enabled: true, source: null };

  const ordered: ReadonlyArray<readonly [FlowLayer, Record<string, unknown> | undefined]> = [
    ['deployment', layers.deployment],
    ['workspace', layers.workspace],
    ['user', layers.user],
  ];
  for (const [layer, bucket] of ordered) {
    if (!bucket) continue;
    for (const [id, value] of Object.entries(bucket)) {
      if (!(id in flows)) {
        warnings.push(unknownSwitchWarning(id, layer));
        continue;
      }
      if (typeof value !== 'boolean') {
        warnings.push(`non-boolean value for '${id}' at ${layer} layer (ignored, default kept)`);
        continue;
      }
      // cycle-90 修正：**层不支持 ⇒ 该层写入被拒**（fail-closed）。
      //
      // 实测反例：`flow.selfInit` / `flow.gateRecord` / `flow.budgetEnforce` /
      // `flow.agentsOrchestration` 的 `layers` **不含 'user'**，但 user 层写入
      // 此前**照样生效** —— resolveFlows 不看 `layers`，只按层序覆盖。
      // 后果是**双重失真**：
      //   ① 面板的 checkbox 让用户以为能关（`prefsDrawer.ts` 按 layers 渲染 title，
      //      但 checkbox 本身没禁）——用户点了，界面变了；
      //   ② 而该层写入本应被拒（`panel.selfInitOff` 那条 locale 键写的就是
      //      「该开关只支持工作区/部署层，用户层不可写」）—— 真相与界面相反。
      //
      // 修法：层不在该开关的 `layers` 里 ⇒ **忽略该层写入 + 产出 warning**，
      // 不改生效值。这样「不可写」在**数据面**与**界面面**同时成立。
      const def = FLOWS.find((f) => f.id === id);
      if (def !== undefined && !def.layers.includes(layer)) {
        warnings.push(`'${id}' does not support the ${layer} layer (ignored; supported: ${def.layers.join('/')})`);
        continue;
      }
      flows[id] = { enabled: value, source: layer };
    }
  }
  return { flows, warnings };
}

/**
 * 该开关在**用户层**是否可写（面板据此禁用 checkbox 并给出提示）。
 *
 * 为什么需要独立函数：`resolveFlows` 是**合并**语义（读三层配置），
 * 而面板要的是**单层可写性**（这个开关我能不能点）。
 * 两者是不同的抽象层 —— 混在一起会让面板为了画一个 disabled checkbox
 * 而去构造三层配置。
 *
 * 与 `resolveFlows` 的拒绝逻辑**同源**（都读 `FlowDefinition.layers`），
 * 避免两处各判一次、判出不同结果。
 */
export function isUserWritable(flowId: string): boolean {
  const def = FLOWS.find((f) => f.id === flowId);
  // 未知 id ⇒ **可写**（保守：让用户能试，由 resolveFlows 产出 unknown 告警）。
  // 反过来（未知判为不可写）会让新加的开关在配好 locale 前就变成死开关。
  if (def === undefined) return true;
  return def.layers.includes('user');
}

/** 关闭中的 flow id 列表（INV-30 观测面的数据源） */
export function disabledFlowIds(resolved: ResolvedFlows): string[] {
  return Object.keys(resolved.flows).filter((id) => {
    const state = resolved.flows[id];
    return state ? !state.enabled : false;
  });
}

/**
 * prefs 原文解析（client 层从 localStorage 读到的字符串）。
 * 任何解析失败/版本不符/形状非法 → fail-safe 回默认空偏好 + warning（响亮）。
 */
export function parseRawPrefs(raw: string | null | undefined): { prefs: PrefsFile; warnings: string[] } {
  const fallback: PrefsFile = { version: 1, flows: {} };
  if (raw === null || raw === undefined || raw === '') return { prefs: fallback, warnings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { prefs: fallback, warnings: ['prefs: unparseable JSON — reset to defaults'] };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { prefs: fallback, warnings: ['prefs: not an object — reset to defaults'] };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    return { prefs: fallback, warnings: [`prefs: unsupported version ${String(obj.version)} — reset to defaults`] };
  }
  if (!obj.flows || typeof obj.flows !== 'object') {
    return { prefs: fallback, warnings: ['prefs: missing flows object — reset to defaults'] };
  }
  return { prefs: { version: 1, flows: obj.flows as Record<string, boolean> }, warnings: [] };
}
