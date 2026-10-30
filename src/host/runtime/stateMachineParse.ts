/**
 * 工作流图的**解析与索引**（cycle-91 拆分 · 守 T3 ≤250 行）。
 *
 * ## 职责
 *
 * 本文件是「**YAML 文本 → 图数据结构**」的**语法层**：
 * - `loadWorkflowGraph`：从 `.cycles/workflow-graph.yaml` 读文件；
 * - `parseWorkflowGraph`：行级正则解析（零依赖）；
 * - `loadState` / `initState`：状态读写与初始化；
 * - `buildGraphIndex`：节点 Map + 前驱邻接表（O(1) 查找）。
 *
 * ## ⚠️ cycle-91 实测缺陷（在本文件修的）
 *
 * `parseWorkflowGraph` 此前**只认** `id:` / `type:` / `gate:` / `triggers:`，
 * **没有 `next:` 分支** ⇒ 运行时图里**根本没有宏观主线** ⇒
 * 依赖入度 = 0 的节点有 **9 个** ⇒ `gate-g0` 的唯一前驱 `micro-retro`
 * 永远不是 `done` ⇒ **整条 gate-chain 锁死**。
 *
 * 详见 `stateMachineFields.ts` 头注与
 * `tests/contract/stateMachineReachability.test.ts`。
 *
 * ## 边界
 *
 * 纯解析 + 少量 IO（读两个文件）；零 clock、零 random。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseNodeDeclarationFields } from './stateMachineFields.ts';
import { isDependentEdgeType, buildDependentNextEdges } from './stateMachineGraph.ts';
import type { WorkflowGraph, WorkflowNode, WorkflowEdge, NodeState } from './stateMachine.ts';
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
      // cycle-91：`next:` / `on_pass:` / `on_fail:` 三个节点声明字段
      // （此前完全未解析 ⇒ 宏观主线在运行时图里根本不存在，
      //   实测 `gate-g0` 的唯一前驱 `micro-retro` 入度为 0 ⇒ 整条
      //   gate-chain 锁死。详见 `stateMachineFields.ts` 头注）。
      const decl = parseNodeDeclarationFields(line);
      if (decl) {
        if (decl.next !== undefined) currentNode.next = decl.next;
        if (decl.onPass !== undefined) currentNode.onPass = decl.onPass;
        if (decl.onFail !== undefined) currentNode.onFail = decl.onFail;
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
  /**
   * **依赖型**前驱邻接表（只含计入依赖的边类型）。
   *
   * ⚠️ cycle-91：此前这里收的是**全部**边 ⇒ `circuit-breaker`
   * （门禁失败 ⇒ 回退）也被当成前置 ⇒ 目标节点要等"回退源"先 done
   * ⇒ 成环 ⇒ **整条链死锁**。详见 `stateMachineFields.isDependentEdgeType`。
   */
  predecessors: Map<string, string[]>;
  /** **全部**边的前驱邻接表（引用关系也在内，供可达性/图谱分析用）。 */
  allPredecessors: Map<string, string[]>;
}

export function buildGraphIndex(graph: WorkflowGraph): WorkflowGraphIndex {
  const nodeMap = new Map<string, WorkflowNode>();
  for (const n of graph.nodes) nodeMap.set(n.id, n);
  const predecessors = new Map<string, string[]>();
  const allPredecessors = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, key: string, val: string): void => {
    const arr = m.get(key);
    if (arr) arr.push(val);
    else m.set(key, [val]);
  };
  for (const e of graph.edges) {
    push(allPredecessors, e.to, e.from);
    if (!isDependentEdgeType(e.type)) continue;
    push(predecessors, e.to, e.from);
  }
  // cycle-91：`next:` 声明的顺序边**也**是依赖边（宏观主线此前根本不存在），
  // 但**回环已断开**（指向环入口的那条边被剔除）⇒ 依赖图保持 DAG。
  for (const e of buildDependentNextEdges(graph.nodes, graph.edges)) {
    push(predecessors, e.to, e.from);
    push(allPredecessors, e.to, e.from);
  }
  return { nodeMap, predecessors, allPredecessors };
}
