#!/usr/bin/env node
/**
 * ANIC workflow snapshot generator — 薄封装。构建逻辑唯一实现于
 * src/shared/snapshotCore.ts（宿主热更新路由与生成器共用同一份代码）。
 *
 *   1. ../src/client/workflowGraphData.ts   (typed data module the client bundles)
 *   2. ../artifacts/workflow-snapshot.json  (provenance copy for audit)
 *
 * Requires Node >= 22.18 (native TS type stripping; profile runtime is Node 24).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkflowSnapshot } from '../src/shared/snapshotCore.ts';

const here = dirname(fileURLToPath(import.meta.url));
// 自洽化（cycle-43）：本仓库（PLUGIN_ROOT）独立于验证场地。产出物始终写在本仓库内；
// 数据源 .cycles/ 默认取**本仓库自身**（自举语义：插件可视化自己的迭代历程，与验证
// 场地零绑定——用户红线「实际不应与 dsh-codegraph-visualizer 项目绑定关系」）。
// 可用 --workspace 或环境变量 DSH_ANIC_TEST_WORKSPACE 指向任意实际项目覆盖。
const PLUGIN_ROOT = join(here, '..');
const WORKSPACE = resolve(
  (process.argv.indexOf('--workspace') !== -1 && process.argv[process.argv.indexOf('--workspace') + 1])
    || process.env.DSH_ANIC_TEST_WORKSPACE
    || PLUGIN_ROOT,
);
const CYCLES = join(WORKSPACE, '.cycles');

const snap = buildWorkflowSnapshot(CYCLES);
const { generatedAt, counts, autonomy, nodes, edges } = snap;

const ts = `/**
 * GENERATED FILE — do not edit by hand. Regenerate: pnpm --dir dsh-anic run snapshot
 * Source: real .cycles/ of the workspace (structured fields only; INV-21 compliant).
 * Generated at ${generatedAt}; counts = ${JSON.stringify(counts)}; autonomy = ${autonomy}.
 *
 * 热更新路径：客户端优先 GET /anic/api/workflow-snapshot 取 live 数据（同一构建器实现），
 * 路由不存在或失败时回退到本嵌入快照（多代宿主安全降级）。
 */
export interface WorkflowNode {
  id: string;
  type: 'phase' | 'micro-step' | 'gate' | 'human-gate' | 'cycle' | 'gate-event' | 'incident' | 'autonomy';
  label: string;
  x: number;
  y: number;
  result?: string;
  // cycle-38 W-3 快档：gate-event 节点携带账本 detail 自由文本（snapshotCore
  // 同步契约——嵌入快照与路由快照共用唯一构建器，两处类型必须一致）。
  detail?: string;
  testReport?: { report: string; passed: number; failures: number; errors: number; layers: string[] };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  type: string;
}

export interface WorkflowSnapshot {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  autonomy: string;
  counts: {
    nodes: number;
    edges: number;
    cycles: number;
    ledgerEntries: number;
    incidents: number;
  };
}

export const WORKFLOW_SNAPSHOT: WorkflowSnapshot = ${JSON.stringify({ nodes, edges, autonomy, counts })};
`;

mkdirSync(join(PLUGIN_ROOT, 'src', 'client'), { recursive: true });
writeFileSync(join(PLUGIN_ROOT, 'src', 'client', 'workflowGraphData.ts'), ts);
mkdirSync(join(PLUGIN_ROOT, 'artifacts'), { recursive: true });
writeFileSync(join(PLUGIN_ROOT, 'artifacts', 'workflow-snapshot.json'), JSON.stringify({ generatedAt, autonomy, counts, nodes, edges }, null, 1));

console.log(`snapshot: ${JSON.stringify(counts)}, autonomy=${autonomy} (workspace: ${WORKSPACE})`);
