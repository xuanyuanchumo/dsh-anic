/**
 * snapshotCore 单元测试 —— 纯函数层，无需宿主、无需真实 .cycles/。
 *
 * 夹具承载的是历史上真实踩过的缺陷类（每条断言都对应一个教训）：
 *   - cycle-9 vs cycle-10 数值序（字典序 .sort() 是 gate-check/eval-runner 老缺陷家族）
 *   - autonomy_level 带引号（org-status 正则改写缺陷家族：引号写法不得破坏解析）
 *   - gate 事件 → 宏图门节点 evidences 映射（小写 id 约定）
 *   - 任一数据源缺失 → 安全降级不 throw（宿主路由对未 init 项目必须可用）
 *   - 确定性（同输入同输出；generatedAt 显式注入）
 *   - INV-21：节点/边只携带结构化字段，绝不从 detail 自由文本解析身份
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkflowSnapshot, parseWorkflowGraph } from '../../src/shared/snapshotCore.ts';

const CLEANUPS: string[] = [];
function makeCyclesDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-snap-'));
  const cycles = join(root, '.cycles');
  mkdirSync(cycles, { recursive: true });
  CLEANUPS.push(root);
  return cycles;
}
afterEach((): void => {
  while (CLEANUPS.length > 0) {
    const dir = CLEANUPS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const WORKFLOW_GRAPH = [
  '# workflow graph',
  'nodes:',
  '  - id: intent',
  '    type: play',
  '    label: "意图捕获" # comment',
  '  - id: gate-g0',
  '    type: gate',
  '    label: "G0 评估基线"',
  '  - id: spec',
  '    type: artifact',
  '    label: "规格"',
  'edges:',
  '  - { from: intent, to: spec, type: "flow" }',
  '  - { from: spec, to: gate-g0, type: "flow" }',
  '',
].join('\n');

const LEDGER = JSON.stringify({
  entries: [
    { gate: 'G0', gateName: '评估收敛门', result: 'PASS', detail: '…', timestamp: '2026-10-13T00:00:00.000Z', previousHash: null, hash: 'h0' },
    { gate: 'G2', gateName: '测试收敛门', result: 'PASS', detail: '…', timestamp: '2026-10-13T01:00:00.000Z', previousHash: 'h0', hash: 'h1' },
  ],
  chainHead: 'h1',
});

function writeFullFixture(): string {
  const cycles = makeCyclesDir();
  writeFileSync(join(cycles, 'workflow-graph.yaml'), WORKFLOW_GRAPH);
  for (const n of ['cycle-9', 'cycle-10']) {
    mkdirSync(join(cycles, 'cycles', n), { recursive: true });
    writeFileSync(join(cycles, 'cycles', n, '任务清单.md'), '- [x] P0 完成');
  }
  // W-3 全档（cycle-39）：最新 cycle 的 test-reports（§2 汇总表 + 分层行）
  mkdirSync(join(cycles, 'cycles', 'cycle-10', 'test-reports'), { recursive: true });
  writeFileSync(join(cycles, 'cycles', 'cycle-10', 'test-reports', 'tr.md'), [
    '# 测试报告', '',
    '## 2. 汇总', '',
    '| 指标 | 数量 |', '|---|---|', '| 通过 | 1301 |', '| 失败 | 0 |', '| 错误 | 0 |', '',
    '## 3. 分层结果', '',
    '| 层 | 结果 | 关键数字 |', '|---|---|---|',
    '| validate | ✅ PASS | 12 checks |',
    '| vitest | ✅ PASS | 106 文件 |',
  ].join('\n'));
  mkdirSync(join(cycles, 'gates'), { recursive: true });
  writeFileSync(join(cycles, 'gates', 'ledger.json'), LEDGER);
  mkdirSync(join(cycles, 'incidents'), { recursive: true });
  writeFileSync(join(cycles, 'incidents', 'incident-a.md'), 'x');
  writeFileSync(join(cycles, 'incidents', 'incident-b.md'), 'y');
  writeFileSync(join(cycles, 'config.yml'), 'autonomy_level: "L3"\n');
  return cycles;
}

describe('buildWorkflowSnapshot（完整夹具）', () => {
  const snap = buildWorkflowSnapshot(writeFullFixture(), '2026-01-01T00:00:00.000Z');

  it('宏图节点/边按 workflow-graph.yaml 构建', () => {
    expect(snap.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['wf:intent', 'wf:gate-g0', 'wf:spec']));
    expect(snap.edges).toContainEqual({ from: 'wf:intent', to: 'wf:spec', type: 'flow' });
  });

  it('gate 类型节点映射为 gate 组（唯一不可跳过的人类门）', () => {
    const gate = snap.nodes.find((n) => n.id === 'wf:gate-g0');
    expect(gate?.type).toBe('gate');
  });

  // ★cycle-83 判据更新（不是放宽）：默认路径的账本事件已由「每条一个 evt 节点」
  // 改为「每轮一个门禁摘要组 + 徽章 + 可展开证据」（投影窗口的产物）。
  // **旧契约没有丢**：它在 `window:'full'` 路径上原样保留（静态溯源工件走那条路径），
  // 所以下面同时钉住两条腿——默认路径的聚合形态，与 full 路径的逐条形态。
  it('默认路径：账本按轮聚合成摘要组（不是每条一个节点），徽章写在 label 上', () => {
    expect(snap.counts.ledgerEntries).toBe(2); // 旧读数不变：账本条数仍是 2
    const group = snap.nodes.find((n) => n.id === 'evt:group-0');
    expect(group, '默认路径应产生 evt:group-0 摘要节点').toBeDefined();
    // 徽章必须一眼可读：四门都在 label 上（未出现的门写 —）
    expect(group?.label).toContain('G0 PASS');
    expect(group?.label).toContain('G2 PASS');
    // 反向自检：默认路径**不应**再有逐条 evt:0（否则聚合没生效）
    expect(snap.nodes.some((n) => n.id === 'evt:0')).toBe(false);
  });

  it('full 路径：账本事件仍逐条成节点并链接 event-seq 链（旧契约原样保留）', () => {
    const full = buildWorkflowSnapshot(writeFullFixture(), '2026-01-01T00:00:00.000Z', { window: 'full' });
    expect(full.counts.ledgerEntries).toBe(2);
    expect(full.nodes.find((n) => n.id === 'evt:0')?.label).toContain('G0 PASS');
    expect(full.edges).toContainEqual({ from: 'evt:0', to: 'evt:1', type: 'event-seq' });
  });

  it('evidences 边只在宏图存在同名（小写）门节点时出现', () => {
    // 聚合路径：证据边从**组节点**指向门节点（组内含该门时才有边）。
    const evid = snap.edges.filter((e) => e.type === 'evidences');
    expect(evid.length).toBeGreaterThan(0);
    expect(evid.every((e) => e.from.startsWith('evt:'))).toBe(true);
    expect(evid.some((e) => e.to === 'wf:gate-g0')).toBe(true);
    // full 路径：逐条形态下同一判据仍然成立（无同名门时无 evidences 边）
    const full = buildWorkflowSnapshot(writeFullFixture(), '2026-01-01T00:00:00.000Z', { window: 'full' });
    expect(full.edges).toContainEqual({ from: 'evt:0', to: 'wf:gate-g0', type: 'evidences' });
    expect(full.edges.some((e) => e.from === 'evt:1' && e.type === 'evidences')).toBe(false);
  });

  it('cycle 目录用数值序（cycle-9 先于 cycle-10），cycle-seq 方向正确', () => {
    const ids = snap.nodes.map((n) => n.id);
    expect(ids.indexOf('cycle:cycle-9')).toBeLessThan(ids.indexOf('cycle:cycle-10'));
    expect(snap.edges).toContainEqual({ from: 'cycle:cycle-9', to: 'cycle:cycle-10', type: 'cycle-seq' });
  });

  it('带引号的 autonomy_level 正确解析（引号容错回归）', () => {
    expect(snap.autonomy).toBe('L3');
  });

  it('incidents 以文件名计数并入 aux 组', () => {
    expect(snap.counts.incidents).toBe(2);
    expect(snap.nodes.find((n) => n.id === 'inc:incident-a.md')).toBeTruthy();
    expect(snap.nodes.find((n) => n.id === 'aux:auto')?.label).toContain('autonomy L3');
  });

  it('确定：同输入两次构建深相等（generatedAt 注入）', () => {
    const again = buildWorkflowSnapshot(writeFullFixture(), '2026-01-01T00:00:00.000Z');
    expect(again).toEqual(snap);
  });

  it('INV-21：节点/边只携带结构化字段（detail/testReport 为结构化键，W-3 白盒层）', () => {
    for (const n of snap.nodes) {
      expect(Object.keys(n).every((k) => ['id', 'type', 'label', 'x', 'y', 'result', 'detail', 'testReport'].includes(k))).toBe(true);
    }
    for (const e of snap.edges) {
      expect(Object.keys(e).every((k) => ['from', 'to', 'type'].includes(k))).toBe(true);
    }
  });

  it('W-3 快档：gate-event 节点携带账本 detail（「为什么 PASS/FAIL」白盒层，两条路径都在）', () => {
    // ★cycle-83：默认路径的 detail 是**聚合证据**（组内逐条记录仍在，带条数标注），
    // full 路径的 detail 是单条原文。两种形态都必须把账本 detail 如实带出去
    // ——「聚合」与「看不见」的分界线就是这条证据链还在不在。
    const group = snap.nodes.find((n) => n.id === 'evt:group-0');
    expect(group?.detail).toContain('G0 PASS');
    expect(group?.detail).toContain('…'); // fixture 的 detail 字段如实透传
    expect(group?.detail).toContain('2 records');
    const full = buildWorkflowSnapshot(writeFullFixture(), '2026-01-01T00:00:00.000Z', { window: 'full' });
    expect(full.nodes.find((n) => n.id === 'evt:0')?.detail).toBe('…');
  });

  it('W-3 全档（cycle-39）：含 G2 的门禁节点携带最新测试报告摘要（数字 + 分层行）', () => {
    // ★cycle-83：报告挂在"最近一个含 G2 的组"上（fixture 的两条记录同属组 0）。
    const g2 = snap.nodes.find((n) => n.id === 'evt:group-0');
    expect(g2?.testReport).toBeDefined();
    expect(g2?.testReport?.report).toBe('tr.md');
    expect(g2?.testReport?.passed).toBe(1301);
    expect(g2?.testReport?.failures).toBe(0);
    expect(g2?.testReport?.errors).toBe(0);
    expect(g2?.testReport?.layers.length).toBe(2);
    expect(g2?.testReport?.layers[0]).toContain('validate');
    // full 路径仍是逐条形态：只有 G2 那条携带报告（最小数据面纪律不变）
    const full = buildWorkflowSnapshot(writeFullFixture(), '2026-01-01T00:00:00.000Z', { window: 'full' });
    expect(full.nodes.find((n) => n.id === 'evt:1')?.testReport?.passed).toBe(1301);
    expect(full.nodes.find((n) => n.id === 'evt:0')?.testReport).toBeUndefined();
  });

  it('W-3 全档：不含 G2 的组不携带 testReport（最小数据面纪律）', () => {
    // 造一份只有 G0 的账本 ⇒ 那个组不该挂测试报告（挂上去就是"每轮都像跑过测试"）。
    const cycles = makeCyclesDir();
    mkdirSync(join(cycles, 'gates'), { recursive: true });
    writeFileSync(join(cycles, 'gates', 'ledger.json'), JSON.stringify({
      entries: [{ gate: 'G0', result: 'PASS', detail: 'x', timestamp: '2026-10-13T00:00:00.000Z', previousHash: null, hash: 'h0' }],
      chainHead: 'h0',
    }));
    const onlyG0 = buildWorkflowSnapshot(cycles, '2026-01-01T00:00:00.000Z');
    const node = onlyG0.nodes.find((n) => n.id === 'evt:group-0');
    expect(node).toBeDefined();
    expect(node?.testReport).toBeUndefined();
  });
});

describe('buildWorkflowSnapshot（缺源降级）', () => {
  it('空 .cycles 不 throw，返回可用空图与 L? 兜底', () => {
    const cycles = makeCyclesDir();
    const snap = buildWorkflowSnapshot(cycles, '2026-01-01T00:00:00.000Z');
    // ★cycle-83：counts 新增三个投影读数（activeCycles / archivedCycles / windowedOut），
    // 既有五字段的值与语义**逐字不变**。这里逐个字段断言（而不是 toEqual 整个对象），
    // 是为了让"新增字段"与"旧字段被改动"在同一处可区分——后者才是真破坏。
    expect(snap.counts.nodes).toBe(1);
    expect(snap.counts.edges).toBe(0);
    expect(snap.counts.cycles).toBe(0);
    expect(snap.counts.ledgerEntries).toBe(0);
    expect(snap.counts.incidents).toBe(0);
    // 新增三字段在空项目上必须是 0/0/0（不是 undefined、也不是 NaN）
    expect(snap.counts.activeCycles).toBe(0);
    expect(snap.counts.archivedCycles).toBe(0);
    expect(snap.counts.windowedOut).toBe(0);
    expect(snap.autonomy).toBe('L?');
    expect(snap.nodes.map((n) => n.id)).toEqual(['aux:auto']);
    // 空项目：无当前轮、无归档节点（不生成空壳节点）
    expect(snap.window.current).toBeNull();
    expect(snap.archived.nodeId).toBeNull();
    // 反向自检：既有五字段断言确实有判别力（改一个值必须不等）
    expect(snap.counts.nodes).not.toBe(2);
  });

  it('畸形 ledger.json 不 throw（结构损坏按 0 条处理）', () => {
    const cycles = makeCyclesDir();
    mkdirSync(join(cycles, 'gates'), { recursive: true });
    writeFileSync(join(cycles, 'gates', 'ledger.json'), '{not json');
    const snap = buildWorkflowSnapshot(cycles, '2026-01-01T00:00:00.000Z');
    expect(snap.counts.ledgerEntries).toBe(0);
  });
});

describe('parseWorkflowGraph', () => {
  it('解析节点 id/type/label 并剥离行尾注释', () => {
    const { nodes, edges } = parseWorkflowGraph(WORKFLOW_GRAPH);
    expect(nodes).toEqual([
      { id: 'intent', type: 'play', label: '意图捕获' },
      { id: 'gate-g0', type: 'gate', label: 'G0 评估基线' },
      { id: 'spec', type: 'artifact', label: '规格' },
    ]);
    expect(edges).toEqual([
      { from: 'intent', to: 'spec', type: 'flow' },
      { from: 'spec', to: 'gate-g0', type: 'flow' },
    ]);
  });

  it('缺 type 的节点兜底 phase、缺 type 的边兜底 flow', () => {
    const { nodes, edges } = parseWorkflowGraph('nodes:\n  - id: solo\nedges:\n  - { from: a, to: b }\n');
    expect(nodes[0]?.type).toBe('phase');
    expect(edges[0]?.type).toBe('flow');
  });
});
