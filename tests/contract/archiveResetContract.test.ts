/**
 * 归档重置 + 窗口化投影**契约**（cycle-83 · 产物治理）。
 *
 * ## 这个契约与单测的分工
 *
 * 单测（`artifactArchive.test.ts` / `projectionWindow.test.ts` / `aggregateGateEvents.test.ts`）
 * 在**小夹具**上钉判据的两态。本契约在**接近真实规模**的夹具上钉三件单测管不到的事：
 *
 *   ① **端到端**：归档 → 快照，两步串起来看读数是否自洽（历史仍可见 / 折叠数如实）；
 *   ② **规模**：79 轮 + 194 条账本规模下节点数必须显著下降（这是用户诉求的本体，
 *      小夹具证明不了——6 个节点"降 60%"没有意义）；
 *   ③ **反向**：关掉窗口（`window:'full'`）后节点数必须**回升**，证明是投影在对数负责，
 *      不是碰巧少算。
 *
 * ## 纪律
 *
 * 全部在 `mkdtempSync` 临时工作区跑，**绝不**在真实 `.cycles/` 上做写操作
 * （本仓有前科：契约测试经 cwd 兜底真写了真实账本 4 条，见 cycle-82 审计日志 H3）。
 * 只有**只读**的真实数据断言允许走 `process.cwd()`。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildWorkflowSnapshot } from '../../src/shared/snapshotCore.ts';
import { archiveBaseline } from '../../src/host/runtime/artifactArchive.ts';
import { verifyLedger, type LedgerEntry } from '../../src/host/runtime/ledger.ts';

const CLEANUPS: string[] = [];
afterEach(() => {
  while (CLEANUPS.length > 0) {
    const d = CLEANUPS.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const HDR = '| 编号 | 优先级 | 任务 | 验证 | 责任 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n';
const DONE = HDR + '| T-01 | P0 | 任务 | 测试 | lead | 完成 |';

/** 造一个"接近真实规模"的工作区：N 轮 × 每轮写任务清单 + M 条账本 + 声明图。 */
function bigWorkspace(cycles: number, ledgerGroups: number): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-archive-contract-'));
  CLEANUPS.push(root);
  const cyclesRoot = join(root, '.cycles', 'cycles');
  for (let n = 1; n <= cycles; n += 1) {
    const dir = join(cyclesRoot, `cycle-${String(n)}`);
    mkdirSync(dir, { recursive: true });
    // 前 3 轮故意留成"不可完成"三形态（模拟 cycle-1/16/75 的真实缺陷）
    if (n === 1) writeFileSync(join(dir, '任务清单.md'), HDR); // empty-task-list
    else if (n === 2) { /* 不写清单 */ } // missing-task-list
    else if (n === 3) writeFileSync(join(dir, '任务清单.md'), HDR + '| T-01 | P0 | a | t | lead | 待办 |'); // has-pending
    else writeFileSync(join(dir, '任务清单.md'), DONE);
    if (n === cycles) {
      // 最新一轮带测试报告（验证 testReport 投影仍接得上）
      mkdirSync(join(dir, 'test-reports'), { recursive: true });
      writeFileSync(join(dir, 'test-reports', 'tr.md'), [
        '## 2. 汇总', '', '| 指标 | 数量 |', '|---|---|',
        '| 通过 | 100 |', '| 失败 | 0 |', '| 错误 | 0 |', '',
        '| 层 | 结果 | 关键数字 |', '|---|---|---|', '| vitest | PASS | 100 |',
      ].join('\n'));
    }
  }
  // 声明图（4 门 + 阶段，供 evidences 边有目标）
  writeFileSync(join(root, '.cycles', 'workflow-graph.yaml'), [
    'nodes:',
    '  - id: plan', '    type: phase', '    label: "计划"',
    '  - id: gate-g0', '    type: gate', '    label: "G0"',
    '  - id: gate-g1', '    type: gate', '    label: "G1"',
    '  - id: gate-g2', '    type: gate', '    label: "G2"',
    '  - id: gate-g3', '    type: gate', '    label: "G3"',
    'edges:',
    '  - { from: plan, to: gate-g0, type: "flow" }',
    '',
  ].join('\n'));
  writeFileSync(join(root, '.cycles', 'config.yml'), 'autonomy_level: L3\n');
  // 账本：ledgerGroups 组 × 4 门，构造合法哈希链
  mkdirSync(join(root, '.cycles', 'gates'), { recursive: true });
  const entries: LedgerEntry[] = [];
  let prev: string | null = null;
  const gates = ['G0', 'G1', 'G2', 'G3'];
  for (let g = 0; g < ledgerGroups; g += 1) {
    for (const gate of gates) {
      const full = { gate, gateName: gate, result: 'PASS' as const, detail: `round ${String(g)} ${gate}`, timestamp: new Date(2026, 0, 1, 0, entries.length).toISOString(), previousHash: prev };
      const e: LedgerEntry = { ...full, hash: createHash('sha256').update(JSON.stringify(full)).digest('hex') };
      entries.push(e);
      prev = e.hash ?? null;
    }
  }
  writeFileSync(join(root, '.cycles', 'gates', 'ledger.json'), JSON.stringify({ entries, chainHead: prev }, null, 2));
  return root;
}

describe('端到端：归档 → 快照（账本一字不变 + 历史仍可见）', () => {
  it('归档 76 轮后：账本字节全等、链有效、快照仍报 archivedCycles 且归档节点在场', () => {
    const root = bigWorkspace(79, 49); // 49 组 × 4 = 196 条（贴近真实的 194）
    const ledgerPath = join(root, '.cycles', 'gates', 'ledger.json');
    const ledgerBefore = readFileSync(ledgerPath, 'utf8');
    expect(verifyLedger(join(root, '.cycles')).ok).toBe(true);

    const r = archiveBaseline(join(root, '.cycles'));
    // 79 - 3（不可完成三形态）= 76
    expect(r.archived.length).toBe(76);
    expect(r.kept.map((k) => k.reason).sort()).toEqual(['empty-task-list', 'has-pending', 'missing-task-list']);
    expect(r.ledger?.unchanged).toBe(true);

    // ★最硬：账本逐字节全等 + 链仍有效
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore);
    expect(verifyLedger(join(root, '.cycles')).ok).toBe(true);

    // ★归档 ≠ 丢失：快照里历史仍可见
    const snap = buildWorkflowSnapshot(join(root, '.cycles'));
    expect(snap.counts.archivedCycles).toBe(76);
    expect(snap.archived.count).toBe(76);
    expect(snap.archived.nodeId).not.toBeNull();
    const archivedNode = snap.nodes.find((n) => n.id === snap.archived.nodeId);
    expect(archivedNode, '归档摘要节点必须在场（否则历史蒸发了）').toBeDefined();
    expect(archivedNode?.label).toContain('76');
    expect(archivedNode?.detail).toContain('cycle-4'); // 点名可回溯
    // 活跃区只剩 3 轮不可完成的
    expect(snap.counts.activeCycles).toBe(3);
    expect(snap.counts.cycles).toBe(3);
  });

  it('归档后当前轮是活跃区残留的旧轮 —— 且如实告警（不假装"最新"）', () => {
    const root = bigWorkspace(20, 5);
    const before = buildWorkflowSnapshot(join(root, '.cycles'));
    expect(before.window.current).toBe('cycle-20');
    archiveBaseline(join(root, '.cycles'));
    const after = buildWorkflowSnapshot(join(root, '.cycles'));
    // cycle-1/2/3 不可完成 ⇒ 全部留在活跃区
    expect(after.window.current).toBe('cycle-3');
    expect(after.window.warnings.some((w) => w.includes('archived'))).toBe(true);
  });
});

describe('规模：窗口化后节点数显著下降（用户诉求的本体）', () => {
  it('79 轮 + 196 条账本：全量摊开 vs 窗口化，节点数降到 1/5 以下', () => {
    const root = bigWorkspace(79, 49);
    const full = buildWorkflowSnapshot(join(root, '.cycles'), '2026-01-01T00:00:00.000Z', { window: 'full' });
    const win = buildWorkflowSnapshot(join(root, '.cycles'), '2026-01-01T00:00:00.000Z');

    // 全量：79 cycle + 196 evt + 宏图 5 + autonomy 1 ≈ 281
    expect(full.counts.nodes).toBeGreaterThan(270);
    expect(full.window.mode).toBe('full');
    expect(full.counts.windowedOut).toBe(0);

    // 窗口化：8 cycle + 8 组 + 宏图 + autonomy ≈ 22
    expect(win.counts.nodes).toBeLessThan(60);
    expect(win.counts.nodes).toBeLessThan(full.counts.nodes / 5);
    expect(win.window.mode).toBe('windowed');
    expect(win.counts.activeCycles).toBe(8);
  });

  it('windowedOut 如实报告被折叠数（cycle 轮 + 账本组，一个不漏）', () => {
    const root = bigWorkspace(79, 49);
    const win = buildWorkflowSnapshot(join(root, '.cycles'));
    // 79 - 8 = 71 轮折叠；49 - 8 = 41 组折叠 ⇒ 112
    expect(win.counts.windowedOut).toBe(71 + 41);
    // 同一读数在两处必须同值（各算一遍迟早分叉）
    expect(win.window.windowedOut).toBe(win.counts.windowedOut);
    // 折叠摘要节点必须在场（静默丢数据是本仓反复踩的形态）
    const foldedNode = win.nodes.find((n) => n.id === 'evt:folded');
    expect(foldedNode).toBeDefined();
    expect(foldedNode?.label).toContain('41 gate groups');
    // 折叠的**条数**如实：41 组 × 每组 4 门 = 164 条，且下标闭区间是 #0–163。
    // 断言用推导值而不是写死数字：夹具改成每组 5 门时这条仍成立。
    const foldedEntries = 41 * 4;
    expect(foldedNode?.detail).toContain(`${String(foldedEntries)} records`);
    expect(foldedNode?.detail).toContain(`#0–${String(foldedEntries - 1)}`);
    // 反向自检：折叠段 + 保留段的条数之和 == 账本总条数（说"折叠 164"就必须真有 164 条）
    const keptGroups = win.nodes.filter((n) => n.id.startsWith('evt:group-')).length;
    expect(foldedEntries + keptGroups * 4).toBe(win.counts.ledgerEntries);
  });

  it('反向自检：同一份夹具，窗口 64 的折叠数必须小于窗口 8（判据真随参数变）', () => {
    const root = bigWorkspace(79, 49);
    const narrow = buildWorkflowSnapshot(join(root, '.cycles'));
    const wide = buildWorkflowSnapshot(join(root, '.cycles'), '2026-01-01T00:00:00.000Z', { window: 64 });
    expect(narrow.counts.windowedOut).toBeGreaterThan(wide.counts.windowedOut);
    // 且宽窗口的节点数更多（不是"参数变了但结果不变"）
    expect(wide.counts.nodes).toBeGreaterThan(narrow.counts.nodes);
  });
});

describe('既有语义零变化（旧客户端照常工作）', () => {
  it('counts 既有五字段语义不变：cycles 仍是**全部活跃轮**（不是窗口内的）', () => {
    const root = bigWorkspace(79, 49);
    const win = buildWorkflowSnapshot(join(root, '.cycles'));
    expect(win.counts.cycles).toBe(79);            // 旧语义：活跃轮总数
    expect(win.counts.activeCycles).toBe(8);       // 新字段：主图里的
    expect(win.counts.ledgerEntries).toBe(196);    // 旧语义：账本总数（不因聚合而变）
    expect(win.counts.incidents).toBe(0);
    expect(win.counts.nodes).toBe(win.nodes.length);
    expect(win.counts.edges).toBe(win.edges.length);
    expect(win.source).toBe('live');
  });

  it('节点 id 前缀仍落在 INV-21 结构化集合（P2 探针不会因新节点变红）', () => {
    const root = bigWorkspace(20, 5);
    archiveBaseline(join(root, '.cycles'));
    const snap = buildWorkflowSnapshot(join(root, '.cycles'));
    const PREFIXES = ['wf:', 'cycle:', 'evt:', 'inc:', 'aux:'];
    const bad = snap.nodes.filter((n) => !PREFIXES.some((p) => n.id.startsWith(p))).map((n) => n.id);
    expect(bad, '非结构化 id: ' + bad.join(',')).toEqual([]);
    // 反向自检：前缀判据能判两态（造一个坏 id 必被点出）
    const fake = [...snap.nodes.map((n) => n.id), 'bad-id-1'];
    expect(fake.filter((id) => !PREFIXES.some((p) => id.startsWith(p)))).toEqual(['bad-id-1']);
  });

  it('确定性：同一 .cycles 两次构建深相等（generatedAt 注入固定值）', () => {
    const root = bigWorkspace(20, 5);
    const a = buildWorkflowSnapshot(join(root, '.cycles'), '2026-01-01T00:00:00.000Z');
    const b = buildWorkflowSnapshot(join(root, '.cycles'), '2026-01-01T00:00:00.000Z');
    expect(a).toEqual(b);
    // 反向：窗口参数不同就会不同（证明上面的"相等"不是恒真）
    const c = buildWorkflowSnapshot(join(root, '.cycles'), '2026-01-01T00:00:00.000Z', { window: 'full' });
    expect(c.counts.nodes).not.toBe(a.counts.nodes);
  });

  it('空 .cycles 不 throw，返回可用空图（未 init 项目必须可用）', () => {
    const root = mkdtempSync(join(tmpdir(), 'anic-archive-empty-'));
    CLEANUPS.push(root);
    mkdirSync(join(root, '.cycles'), { recursive: true });
    const snap = buildWorkflowSnapshot(join(root, '.cycles'), '2026-01-01T00:00:00.000Z');
    expect(snap.counts.nodes).toBe(1); // 只有 autonomy
    expect(snap.nodes.map((n) => n.id)).toEqual(['aux:auto']);
    expect(snap.window.current).toBeNull();
    expect(snap.counts.windowedOut).toBe(0);
    expect(snap.archived.count).toBe(0);
    expect(snap.archived.nodeId).toBeNull();
  });
});

describe('真实仓库只读抽查（证明实现能跑真实规模，不写任何文件）', () => {
  it('真实 .cycles：窗口化节点数 ≤ 真实全量节点数的 1/3，且 windowedOut > 0', () => {
    const real = join(process.cwd(), '.cycles');
    if (!existsSync(real)) {
      // 只在仓库根跑测试时有数据；缺席时本用例诚实跳过（不伪造结论）
      expect(true).toBe(true);
      return;
    }
    const win = buildWorkflowSnapshot(real, '2026-01-01T00:00:00.000Z');
    const full = buildWorkflowSnapshot(real, '2026-01-01T00:00:00.000Z', { window: 'full' });
    expect(full.counts.nodes).toBeGreaterThan(200); // 真实规模的下限（空集恒绿是假守卫）
    expect(win.counts.nodes).toBeLessThan(full.counts.nodes / 3);
    expect(win.counts.windowedOut).toBeGreaterThan(0);
    // 账本总条数不因投影而变（读侧投影绝不改数据面读数）
    expect(win.counts.ledgerEntries).toBe(full.counts.ledgerEntries);
  });
});
