/**
 * 工作流状态机（F1，M2-a）。
 *
 * 读 workflow-graph.yaml（或快照的 graph 结构），跟踪节点状态，
 * advance(nodeId, record) / check(strict) / getCurrentState()。
 *
 * 门禁是唯一暂停点：没有 approved record 不能越过 gate 节点（INV-1）。
 * 状态：pending → running → done / blocked。
 *
 * P0-DAG-PARSE（cycle-39）：真实 workflow-graph.yaml（本仓 / 技能模板
 * workflow-graph.example.yaml / 测试场地三处同形状）的边是**流式形态**
 * `- { from: plan, to: human-intent, type: "..." }`，节点 type 是**小写**
 * `gate`/`human-gate`——旧解析器只认纯文本边（`- from: X to: Y`）与大写
 * `Gate`，真实图上解析出 0 边 0 Gate 节点：advance 的前驱检查恒过、
 * gate 批准检查恒不触发，cycle 状态机全链空转（只有合成测试夹具
 * 「工作」）。契约钉死：tests/contract/stateMachineGraphShape.test.ts。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type NodeStatus = 'pending' | 'running' | 'done' | 'blocked';

export interface WorkflowNode {
  id: string;
  /** 规范化为小写：gate / human-gate / phase / micro-step（YAML 里本就是小写）。 */
  type: 'play' | 'gate' | 'human-gate' | 'phase' | 'micro-step' | 'trigger';
  produces?: string;
  gate?: string;
  done_status?: string;
  triggers?: string[];
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

/** 从 .cycles/workflow-graph.yaml 加载图（简化解析：提取 nodes/edges）。 */
export function loadWorkflowGraph(cyclesDir: string): WorkflowGraph | null {
  const p = join(cyclesDir, 'workflow-graph.yaml');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf-8');
  return parseWorkflowGraph(text);
}

/** 从 workflow-graph.yaml 文本解析（行级，零依赖；双边形态 + type 大小写归一）。 */
export function parseWorkflowGraph(text: string): WorkflowGraph {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  let currentNode: WorkflowNode | null = null;

  for (const line of text.split('\n')) {
    const nodeMatch = line.match(/^\s*-?\s*id:\s*(\S+)/);
    if (nodeMatch?.[1]) {
      currentNode = { id: nodeMatch[1], type: 'play' };
      nodes.push(currentNode);
      continue;
    }
    if (currentNode) {
      const typeMatch = line.match(/^\s*type:\s*(\S+)/);
      if (typeMatch?.[1]) {
        // P0-DAG-PARSE：大小写归一（真实 YAML 是小写 gate/human-gate；
        // 旧代码只认大写 Gate → 真实图 0 个门禁节点）。未知类型保守落 play。
        const raw = typeMatch[1].toLowerCase();
        const known: readonly string[] = ['gate', 'human-gate', 'phase', 'micro-step', 'trigger', 'play'];
        currentNode.type = (known.includes(raw) ? raw : 'play') as WorkflowNode['type'];
        continue;
      }
      const gateMatch = line.match(/^\s*gate:\s*(\S+)/);
      if (gateMatch?.[1]) {
        currentNode.gate = gateMatch[1];
        continue;
      }
      const triggersMatch = line.match(/^\s*triggers:\s*\[(.+)\]/);
      if (triggersMatch?.[1]) {
        currentNode.triggers = triggersMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
        continue;
      }
    }
    // 边形态一（真实正典，P0-DAG-PARSE 修复）：流式
    // `- { from: X, to: Y, type: "gate-chain", condition: "pass" }`
    // （type 之后的字段——condition 等——按需跳过，不要求是最后一个键；
    //  节点 id 含连字符，惰性 \S+? 会截断——用显式字符类 + 边界逗号）
    const flowEdge = line.match(/^\s*-\s*\{\s*from:\s*([\w-]+)\s*,\s*to:\s*([\w-]+)(?:\s*,\s*type:\s*"?([^",}]+)"?)?/);
    if (flowEdge?.[1] && flowEdge?.[2]) {
      edges.push({ from: flowEdge[1], to: flowEdge[2], type: flowEdge[3] });
      continue;
    }
    // 边形态二（旧合成形态，向后兼容）：`- from: X to: Y`
    const edgeMatch = line.match(/^\s*-?\s*from:\s*(\S+)\s+to:\s*(\S+)/);
    if (edgeMatch?.[1] && edgeMatch?.[2]) {
      edges.push({ from: edgeMatch[1], to: edgeMatch[2] });
    }
  }
  return { nodes, edges };
}

/** 从 workflow-state.json 加载当前状态。 */
export function loadState(cyclesDir: string): Record<string, NodeState> {
  const p = join(cyclesDir, 'workflow-state.json');
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    return raw?.nodeStatus ?? raw ?? {};
  } catch {
    return {};
  }
}

/** 初始化状态：所有节点 pending。 */
export function initState(graph: WorkflowGraph): Record<string, NodeState> {
  const state: Record<string, NodeState> = {};
  const now = new Date().toISOString();
  for (const node of graph.nodes) {
    state[node.id] = { nodeId: node.id, status: 'pending', updatedAt: now };
  }
  return state;
}

/** 预计算图索引：节点 Map + 前驱邻接表，O(1) 查找（advance 热路径优化）。 */
export interface WorkflowGraphIndex {
  nodeMap: Map<string, WorkflowNode>;
  predecessors: Map<string, string[]>;
}

export function buildGraphIndex(graph: WorkflowGraph): WorkflowGraphIndex {
  const nodeMap = new Map<string, WorkflowNode>();
  for (const n of graph.nodes) nodeMap.set(n.id, n);
  const predecessors = new Map<string, string[]>();
  for (const e of graph.edges) {
    const arr = predecessors.get(e.to);
    if (arr) arr.push(e.from);
    else predecessors.set(e.to, [e.from]);
  }
  return { nodeMap, predecessors };
}

/**
 * 推进节点状态。
 * - Gate 节点需要 gateApproved=true 才能推进到 done。
 * - 前驱全部 done 才能推进（拓扑序）。
 *
 * 迁移合法性矩阵（doc06 §3.x + doc18 §3 #8，cycle-39 落地 3/5 条）：
 * 1. record.gate === node.gate（门匹配——Gate 节点推进必须携带匹配的门名）；
 * 3. node.status !== 'done'（不重复推进已 done 节点）；
 * 4. 前驱边存在且源节点 done（触发边已批准——即下方前驱检查）。
 * （#2 哈希链校验、#5 记录类型白名单拆二期，见 doc18 §3。）
 */
export function advance(
  graph: WorkflowGraph,
  state: Record<string, NodeState>,
  nodeId: string,
  record?: { gateApproved?: boolean; gate?: string; gateName?: string; result?: 'PASS' | 'FAIL'; detail?: string },
): StateMachineResult {
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
