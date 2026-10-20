/**
 * P0-DAG-PARSE 契约（cycle-39 T-3901）：stateMachine 必须能解析**真实**
 * workflow-graph.yaml 形状——流式边 + 小写 type。
 *
 * 缺陷史：旧 parseWorkflowGraph 只认纯文本边（`- from: X to: Y`）与大写
 * `Gate`——本仓 `.cycles/workflow-graph.yaml`、技能模板
 * `assets/skill/assets/config/workflow-graph.example.yaml`、测试场地
 * dsh-codegraph-visualizer 三处的真实图**全部**是流式边 + 小写 gate。
 * 修复前：真实图解析出 0 边 0 Gate 节点，advance 的前驱检查恒过、
 * gate 批准检查恒不触发（合成测试夹具「工作」，真实世界空转）。
 *
 * 迁移合法性矩阵（doc06 §3.x / doc18 §3 #8，cycle-40 全量 5/5）：
 * #1 门匹配 / #2 哈希链（cycleRunner 侧）/ #3 done 拒绝 / #4 前驱边 / #5 白名单。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  parseWorkflowGraph,
  initState,
  advance,
  checkStrict,
  type WorkflowGraph,
} from '../../src/host/runtime/stateMachine.ts';
import { advanceCycle } from '../../src/host/runtime/cycleRunner.ts';
import { verifyLedger, type LedgerEntry } from '../../src/host/runtime/ledger.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_GRAPH = join(HERE, '..', '..', '.cycles', 'workflow-graph.yaml');
const TEMPLATE_GRAPH = join(HERE, '..', '..', 'assets', 'skill', 'assets', 'config', 'workflow-graph.example.yaml');

describe('契约：真实图形状解析（P0-DAG-PARSE 修复前必红）', () => {
  it('本仓真实 workflow-graph.yaml：节点 >0 且**边 >0**（修复前 0 边）', () => {
    const text = readFileSync(REAL_GRAPH, 'utf8');
    const g = parseWorkflowGraph(text);
    expect(g.nodes.length).toBeGreaterThan(10);
    // 修复钉：真实图 15 条流式边全部被解析（修复前 edges.length === 0）
    expect(g.edges.length).toBeGreaterThanOrEqual(15);
  });

  it('真实图的 gate 节点被识别（type 小写归一；修复前 0 个 Gate）', () => {
    const text = readFileSync(REAL_GRAPH, 'utf8');
    const g = parseWorkflowGraph(text);
    const gateNodes = g.nodes.filter((n) => n.type === 'gate');
    const humanGates = g.nodes.filter((n) => n.type === 'human-gate');
    expect(gateNodes.length).toBe(4); // gate-g0..g3
    expect(humanGates.length).toBe(5); // human-intent/spec/plan/pr/release
    // checkStrict 必须能看到这些门（修复前全图 0 门 → checkStrict 恒过）
    const check = checkStrict(g, initState(g));
    expect(check.ok).toBe(false); // 初始态全 pending → 门未批准 → 严格检查必须 FAIL
    expect(String(check.reason)).toContain('gate');
  });

  it('技能模板 workflow-graph.example.yaml 同形状（流式边 + 小写 gate）', () => {
    const text = readFileSync(TEMPLATE_GRAPH, 'utf8');
    const g = parseWorkflowGraph(text);
    expect(g.edges.length).toBeGreaterThanOrEqual(15);
    expect(g.nodes.filter((n) => n.type === 'gate').length).toBe(4);
  });

  it('边 type 字段透传（circuit-breaker/gate-chain 等语义保留）', () => {
    const text = readFileSync(REAL_GRAPH, 'utf8');
    const g = parseWorkflowGraph(text);
    const types = new Set(g.edges.map((e) => e.type ?? ''));
    expect(types.has('human-gate')).toBe(true);
    expect(types.has('gate-chain')).toBe(true);
    expect(types.has('circuit-breaker')).toBe(true);
  });

  it('旧纯文本边形态向后兼容（合成夹具不破）', () => {
    const g = parseWorkflowGraph(`
nodes:
  - id: a
    type: play
edges:
  - from: a to: b
`);
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('大写 Gate 类型仍被归一（历史夹具容错）', () => {
    const g = parseWorkflowGraph(`
nodes:
  - id: g1
    type: Gate
    gate: spec
`);
    expect(g.nodes[0]?.type).toBe('gate');
  });
});

describe('迁移合法性矩阵（doc06 §3.x，cycle-40 全量 5/5）', () => {
  const graph: WorkflowGraph = {
    nodes: [
      { id: 'intent', type: 'phase' },
      { id: 'spec', type: 'gate', gate: 'spec' },
      { id: 'code', type: 'phase' },
    ],
    edges: [
      { from: 'intent', to: 'spec' },
      { from: 'spec', to: 'code' },
    ],
  };

  it('#1 门匹配：record.gate ≠ node.gate 拒绝（即使 gateApproved=true）', () => {
    let state = initState(graph);
    advance(graph, state, 'intent');
    const r = advance(graph, state, 'spec', { gateApproved: true, gate: 'plan' });
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain('gate mismatch');
    expect(state.spec.status).toBe('pending'); // 状态原样不动
  });

  it('#1 门匹配：record.gate === node.gate 放行', () => {
    let state = initState(graph);
    advance(graph, state, 'intent');
    const r = advance(graph, state, 'spec', { gateApproved: true, gate: 'spec' });
    expect(r.ok).toBe(true);
    expect(state.spec.status).toBe('done');
  });

  it('#1 容错：record 未带 gate 字段（仅 gateApproved）仍放行（宽松兼容）', () => {
    let state = initState(graph);
    advance(graph, state, 'intent');
    const r = advance(graph, state, 'spec', { gateApproved: true });
    expect(r.ok).toBe(true); // 旧调用形态（cycleRoute 只带 gateApproved）不破
  });

  it('#3 done 拒绝：已 done 节点重复 advance 被拒', () => {
    let state = initState(graph);
    advance(graph, state, 'intent');
    const r1 = advance(graph, state, 'intent');
    expect(r1.ok).toBe(false);
    expect(String(r1.reason)).toContain('already done');
  });

  it('#4 前驱边：前驱未 done 拒绝（既有语义回归钉）', () => {
    const state = initState(graph);
    const r = advance(graph, state, 'code');
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain('predecessor');
  });

  it('human-gate 节点同样受门批准与门匹配约束（修复前只查大写 Gate）', () => {
    const hg: WorkflowGraph = {
      nodes: [
        { id: 'plan', type: 'phase' },
        { id: 'human-intent', type: 'human-gate' },
      ],
      edges: [{ from: 'plan', to: 'human-intent' }],
    };
    let state = initState(hg);
    advance(hg, state, 'plan');
    const noApproval = advance(hg, state, 'human-intent');
    expect(noApproval.ok).toBe(false);
    expect(String(noApproval.reason)).toContain('gateApproved');
  });

  it('#5 白名单：未知字段拒绝（调用方契约漂移响亮失败）', () => {
    let state = initState(graph);
    advance(graph, state, 'intent');
    const r = advance(graph, state, 'spec', { gateApproved: true, extra: 'oops' } as never);
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain("unknown record field 'extra'");
    expect(state.spec.status).toBe('pending'); // 状态原样不动
  });

  it('#5 类型受检：result 非 PASS/FAIL 枚举拒绝', () => {
    let state = initState(graph);
    advance(graph, state, 'intent');
    const r = advance(graph, state, 'spec', { gateApproved: true, result: 'WARN' as never });
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain("record.result must be 'PASS' | 'FAIL'");
  });

  it('#5 类型受检：gateApproved 非布尔拒绝；record 为数组拒绝', () => {
    let state = initState(graph);
    advance(graph, state, 'intent');
    const r1 = advance(graph, state, 'spec', { gateApproved: 'yes' as never });
    expect(r1.ok).toBe(false);
    expect(String(r1.reason)).toContain('gateApproved must be boolean');
    const r2 = advance(graph, state, 'spec', ['gateApproved'] as never);
    expect(r2.ok).toBe(false);
    expect(String(r2.reason)).toContain('record must be an object');
  });

  it('#5 容错：undefined record 合法（非门节点普通推进）', () => {
    let state = initState(graph);
    const r = advance(graph, state, 'intent');
    expect(r.ok).toBe(true);
    expect(state.intent.status).toBe('done');
  });
});

describe('矩阵 #2：哈希链校验（cycleRunner.advanceCycle 侧，5/5 收口）', () => {
  // 临时目录 + 断链账本 + workflow-graph.yaml 最小夹具
  function mkWorkspace(): { dir: string; cyclesDir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'anic-matrix2-'));
    const cyclesDir = join(dir, '.cycles');
    mkdirSync(join(cyclesDir, 'gates'), { recursive: true });
    writeFileSync(join(cyclesDir, 'workflow-graph.yaml'), `
nodes:
  - id: intent
    type: phase
  - id: spec-gate
    type: gate
    gate: spec
edges:
  - { from: intent, to: spec-gate, type: "gate-chain" }
`);
    return { dir, cyclesDir };
  }

  /** 手工构造一条链：两合法条目（手工算 hash 与 ledger.ts canonical 一致）。 */
  function writeValidLedger(cyclesDir: string): void {
    const mk = (gate: string, result: 'PASS' | 'FAIL', prev: string | null): LedgerEntry => {
      const ts = new Date().toISOString();
      const full = { gate, gateName: gate, result, detail: '', timestamp: ts, previousHash: prev };
      const hash = createHash('sha256').update(JSON.stringify(full)).digest('hex');
      return { ...full, hash };
    };
    const e1 = mk('G0', 'PASS', null);
    const e2 = mk('G1', 'PASS', e1.hash);
    writeFileSync(join(cyclesDir, 'gates', 'ledger.json'), JSON.stringify({ entries: [e1, e2], chainHead: e2.hash }, null, 2));
  }

  it('断链账本上携带门禁证据的 advance 被拒绝（fail-closed，状态原样不动）', () => {
    const { cyclesDir } = mkWorkspace();
    writeValidLedger(cyclesDir);
    // 手工断链：篡改末条 previousHash
    const p = join(cyclesDir, 'gates', 'ledger.json');
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { entries: LedgerEntry[] };
    raw.entries[1]!.previousHash = 'deadbeef';
    writeFileSync(p, JSON.stringify(raw, null, 2));

    const r = advanceCycle(cyclesDir, 1, 'intent', {});
    expect(r.ok).toBe(true); // 纯状态推进（无 gate+result）不读账本 —— 不受断链影响

    const r2 = advanceCycle(cyclesDir, 1, 'spec-gate', { gateApproved: true, gate: 'spec', result: 'PASS', detail: 'x' });
    expect(r2.ok).toBe(false);
    expect(String(r2.reason)).toContain('ledger chain broken');
  });

  it('合法链上携带门禁证据的 advance 放行且新条目入账（链仍有效）', () => {
    const { cyclesDir } = mkWorkspace();
    writeValidLedger(cyclesDir);
    const r = advanceCycle(cyclesDir, 1, 'intent', {});
    expect(r.ok).toBe(true);
    const r2 = advanceCycle(cyclesDir, 1, 'spec-gate', { gateApproved: true, gate: 'spec', result: 'PASS', detail: 'cycle-40 matrix#2' });
    expect(r2.ok).toBe(true);
    expect(r2.ledgerEntry?.gate).toBe('spec');
    const verify = verifyLedger(cyclesDir);
    expect(verify.ok).toBe(true);
    expect(verify.total).toBe(3); // 2 历史 + 1 新
  });
});
