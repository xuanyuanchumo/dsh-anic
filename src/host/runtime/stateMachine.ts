/**
 * 工作流状态机（F1，M2-a）—— 类型声明与**推进语义**。
 *
 * ## 分层（cycle-91 拆分 · 守 T3 ≤250 行）
 *
 * | 文件 | 职责 |
 * |---|---|
 * | 本文件 | 类型声明 + `advance` / `checkStrict`（**推进语义**） |
 * | `stateMachineParse.ts` | YAML 解析 + 图索引构建（**语法层**） |
 * | `stateMachineFields.ts` | 节点声明字段解析（`next:`/`on_pass:`/`on_fail:`） |
 * | `stateMachineGraph.ts` | 依赖图构建（边类型分流 / 环入口 / 断环） |
 * | `tarjanScc.ts` | 强连通分量算法（教科书算法，纯函数） |
 *
 * ## 为什么这样切
 *
 * 「YAML 怎么变成图」与「图怎么推进」是**两个问题**：前者是语法，后者是
 * 语义。cycle-91 的 `next:` 修复同时改了这两层（加解析 + 改前驱判定），
 * 混在一个文件里时，**哪一处改动导致了哪个行为变化**很难看清。
 *
 * ## 迁移合法性矩阵（doc06 §3.x + doc18 §3 #8，cycle-39 落地 3/5 → cycle-40 全量 5/5）
 *
 * 1. record.gate === node.gate（门匹配——Gate 节点推进必须携带匹配的门名）；
 * 2. 哈希链校验（cycleRunner.advanceCycle 侧——账本断链时拒绝推进，fail-closed；
 *    stateMachine 是纯图/状态层不碰磁盘账本，故 #2 落在编排层）；
 * 3. node.status !== 'done'（不重复推进已 done 节点）；
 * 4. 前驱边存在且源节点 done（触发边已批准——即下方前驱检查）；
 * 5. 记录类型白名单（validateRecordShape——未知字段/非法类型拒绝；
 *    实现拆至 recordShape.ts，T3 纪律）。
 */
import { validateRecordShape, type AdvanceRecord } from './recordShape.ts';
import { buildGraphIndex } from './stateMachineParse.ts';

// 保持既有 import 路径零变更：解析层与索引层从本文件重导出。
export { loadWorkflowGraph, parseWorkflowGraph, loadState, initState, buildGraphIndex } from './stateMachineParse.ts';
export type { WorkflowGraphIndex } from './stateMachineParse.ts';
export type NodeStatus = 'pending' | 'running' | 'done' | 'blocked';

export interface WorkflowNode {
  id: string;
  /** 规范化为小写：gate / human-gate / phase / micro-step（YAML 里本就是小写）。 */
  type: 'play' | 'gate' | 'human-gate' | 'phase' | 'micro-step' | 'trigger';
  produces?: string;
  gate?: string;
  done_status?: string;
  triggers?: string[];
  /**
   * **顺序后继**（cycle-91 解析 `next:` 字段）。
   *
   * ⚠️ **它不是依赖边**（详见 `stateMachineFields.ts` 头注）：
   * `maintain → plan` 与 `micro-retro → micro-eval` 都是**回环**
   * （注释明写「形成宏观/微观循环」），若当依赖边 ⇒ 图成环 ⇒
   * 「所有前驱都 done」永远无法满足 ⇒ 宏观循环一次都推不动。
   *
   * ⇒ 只用于**图谱顺序线索**与**可达性分析**；前驱判定走 `on_pass`/
   * `on_fail` + `edges:`。
   */
  next?: string;
  /** 通过后继（`on_pass:`，仅门禁节点有意义）。 */
  onPass?: string;
  /** 失败后继（`on_fail:`，熔断回退路径）。 */
  onFail?: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** 边类型（流式形态的 type 字段；纯文本边无 type → undefined）。 */
  type?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface NodeState {
  nodeId: string;
  status: NodeStatus;
  gateApproved?: boolean;
  updatedAt: string;
}

export interface StateMachineResult {
  ok: boolean;
  state: Record<string, NodeState>;
  reason?: string;
}

export function advance(
  graph: WorkflowGraph,
  state: Record<string, NodeState>,
  nodeId: string,
  record?: AdvanceRecord,
): StateMachineResult {
  // 矩阵 #5：record 形状白名单——任何越界形态在状态变更前拒绝
  const shape = validateRecordShape(record);
  if (!shape.ok) return { ok: false, state, reason: shape.reason };

  // O(1) node lookup via precomputed index (was O(n) find)
  const idx = buildGraphIndex(graph);
  const node = idx.nodeMap.get(nodeId);
  if (!node) return { ok: false, state, reason: `unknown node: ${nodeId}` };

  // 矩阵 #3：done 不可重复推进（幂等拒绝——重复 advance 是契约违规不是无害重试）
  const cur = state[nodeId];
  if (cur?.status === 'done') {
    return { ok: false, state, reason: `node ${nodeId} already done (re-advance rejected)` };
  }

  // O(1) predecessor lookup via adjacency list (was O(e) filter)
  const preds = idx.predecessors.get(nodeId) ?? [];
  for (const pred of preds) {
    const ps = state[pred];
    if (!ps || ps.status !== 'done') {
      return { ok: false, state, reason: `predecessor ${pred} not done` };
    }
  }

  // Gate 节点需要批准 + 矩阵 #1：门名匹配（gate 字段声明的门与 record 携带一致）
  if (node.type === 'gate' || node.type === 'human-gate') {
    if (!record?.gateApproved) {
      return { ok: false, state, reason: `gate ${nodeId} requires gateApproved` };
    }
    if (node.gate && record.gate && node.gate !== record.gate) {
      return { ok: false, state, reason: `gate mismatch: node ${nodeId} expects gate '${node.gate}' but record carries '${record.gate}'` };
    }
  }

  const now = new Date().toISOString();
  state[nodeId] = {
    nodeId,
    status: 'done',
    gateApproved: record?.gateApproved,
    updatedAt: now,
  };
  return { ok: true, state };
}

/** 严格检查：所有 gate 节点必须有 approved record。 */
export function checkStrict(graph: WorkflowGraph, state: Record<string, NodeState>): StateMachineResult {
  for (const node of graph.nodes) {
    if (node.type === 'gate' || node.type === 'human-gate') {
      const ns = state[node.id];
      if (!ns || ns.status !== 'done' || !ns.gateApproved) {
        return { ok: false, state, reason: `gate ${node.id} not approved` };
      }
    }
  }
  return { ok: true, state };
}
