/**
 * 流程的**重置**（reset）语义（cycle-91）。
 *
 * ## 为什么需要这个文件（实测缺陷）
 *
 * 五个流程描述子（gate-check / archive / hitl / auto-fix / 自举 FSM）里
 * **共 11 条** `{from: <终态>, to: 'IDLE', trigger: 'reset'}` 边，
 * 而**全部 11 处** `applyTransition` 调用点**没有一处传 `'reset'`** ——
 * 实测 `grep -rn "applyTransition" src/ -A3 | grep -i reset` **零命中**。
 *
 * ⇒ 那些边**永远不会发生**，但描述子对外**宣称**它们存在
 * （`GET /anic/flows` 的 `transitions` 投影会列出它们）。
 *
 * ## 危害（比"少一条边"更重）
 *
 * 1. **死边比假边更坏**：死边让 `GET /anic/flows` 对外宣称一条永不发生的
 *    转移 ⇒ 读图谱/读 API 的人会基于**不存在的语义**做判断。
 * 2. **`IDLE` 不可达** ⇒ `GET /anic/flows/status` 的 `neverRun` 计数与
 *    `projection.current` 语义失真：「从未运行过」与「运行过并收敛」
 *    在投影层**不可区分**。
 *
 * ## 两条修法的取舍（cycle-91 的决策）
 *
 * | 方案 | 优点 | 缺点 |
 * |---|---|---|
 * | ① **删掉这 11 条边** | 描述子不再说谎 | `IDLE` 彻底不可达 ⇒ 语义问题**没解决**；且丢失"可重置"这一**有用能力** |
 * | ② **加真实触发器** ✅ | 边与实现一致；`IDLE` 可达；能力被真正提供 | 需在 4 个流程的入口加一个参数 |
 *
 * ⇒ 选 ②。
 *
 * ## 重置的语义边界（防误用）
 *
 * `reset` **只重置流程状态投影**，**不动任何外部事实**：
 * - 不删账本条目（账本是**只追加**的审计链，`H4` 门禁明确永拒改历史）；
 * - 不删测试报告 / 评估报告（那是**别的**产物）；
 * - 不改门禁裁决结果本身（`side.allPass` 仍在本轮计算得出）。
 *
 * ⇒ `reset` 的真实用途是「**我要重新跑一遍这套流程，让投影回到干净起点**」，
 *   典型场景：上一轮跑出了 FAIL，现在修好了要重跑；或清理投影以便
 *   `neverRun` 统计复位。
 *
 * ## 为什么用**独立函数**而不是在每个 `finishRun` 里各写一遍
 *
 * 4 个流程的 `finishRun` 形状一致（load → apply → persist）。重置逻辑
 * 嵌进每个函数 ⇒ 4 份近乎相同的代码 ⇒ 改一处漏三处。
 * 本文件提供**一个**实现，各流程调用它。
 */
import { applyTransition, initRuntimeState } from './machine.ts';
import type { FlowDescriptor, FlowEvent, FlowRuntimeState, FlowState } from './contracts.ts';
import { loadFlowProjection, saveFlowProjection } from './persistence.ts';

/**
 * 执行一次 `reset` 转移（若描述子支持）。
 *
 * @param d         流程描述子
 * @param cyclesDir 工作区 `.cycles` 目录
 * @param state     当前状态（由调用方给出，避免重复读盘）
 * @returns 事件（未发生转移时为 null）
 */
export function applyReset<S extends FlowState>(
  d: FlowDescriptor<S>,
  cyclesDir: string,
  state: FlowRuntimeState<S>,
): FlowEvent<S> | null {
  const res = applyTransition(d, {}, state.current, 'reset');
  if (!res.ok || !res.event || !res.next) return null;
  const next = {
    ...state,
    current: res.next,
    history: [...state.history, res.event],
    updatedAt: res.event.at,
  };
  saveFlowProjection(cyclesDir, next);
  return res.event;
}

/**
 * 描述子是否支持 `reset` 转移（供参数校验与能力自检用）。
 *
 * ## 为什么需要这个查询
 *
 * `anic_flows_*` 工具的 `reset` 参数必须**如实**告知模型是否可用——
 * 若某个流程没有 `reset` 边而参数仍然接受 `reset: true`，模型会以为
 * 重置成功了（**静默无效**），那正是本仓最反对的"装饰性参数"。
 */
export function supportsReset<S extends FlowState>(d: FlowDescriptor<S>): boolean {
  return d.transitions.some((t) => t.trigger === 'reset');
}

/**
 * 读取当前投影（不存在则用描述子的初始态）。
 *
 * ## 为什么需要这个
 *
 * 重置要区分两种情形：
 * - **投影不存在** ⇒ 已经处于"从未运行"⇒ 无需重置（`reset` 幂等空转）；
 * - **投影存在且已终态** ⇒ 执行 `reset` 转移。
 */
export function loadForReset<S extends FlowState>(
  d: FlowDescriptor<S>,
  cyclesDir: string,
): FlowRuntimeState<S> {
  return loadFlowProjection<S>(cyclesDir, d.id) ?? initRuntimeState(d);
}
