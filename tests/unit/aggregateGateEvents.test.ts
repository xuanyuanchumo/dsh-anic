/**
 * 账本事件聚合单测（cycle-83）：`groupGateEvents` / `windowGateGroups` / 证据可展开。
 *
 * ## 聚合的底线：折叠像素，**不折叠事实**
 *
 * 把 194 条账本记录压成「每轮一个摘要节点」是本轮节点数从 297 降到 40 的主要来源。
 * 一旦聚合顺手把 `detail` 丢掉，"为什么这门 PASS/FAIL"就永远查不到了——那不是
 * 聚合，是丢失。所以本文件的重点断言是 `evidenceDetail` 里**逐条记录仍在**，
 * 且被截断时**如实标注**剩余条数。
 *
 * ## 分组为什么是位置法（这条必须有反向自检）
 *
 * INV-21 实测教训：账本 detail 是自由文本，按文本归属会造出 3 组假乱序（15 条 detail
 * 提到多个 cycle）。所以分组只看 gate 字段与顺序（G0 开新组）。反向自检：构造一份
 * detail 里写满 "cycle-9" 的账本，证明**分组结果完全不受 detail 影响**。
 */
import { describe, it, expect } from 'vitest';
import {
  badgeLabel,
  evidenceDetail,
  groupGateEvents,
  groupVerdict,
  windowGateGroups,
  type LedgerEntryFact,
} from '../../src/shared/snapshotProjection/aggregateGateEvents.ts';

const E = (gate: string, result: 'PASS' | 'FAIL', detail = '', i = 0): LedgerEntryFact => ({
  gate, result, detail, timestamp: new Date(2026, 0, 1, 0, i).toISOString(),
});

/** 一轮四门全过。 */
const round = (i: number): LedgerEntryFact[] => [
  E('G0', 'PASS', `Eval cycle-${String(i)}`, i * 4),
  E('G1', 'PASS', `Tasks cycle-${String(i)}`, i * 4 + 1),
  E('G2', 'PASS', `Tests cycle-${String(i)}`, i * 4 + 2),
  E('G3', 'PASS', `Build cycle-${String(i)}`, i * 4 + 3),
];

describe('groupGateEvents：位置法分组（G0 开新组）', () => {
  it('4 轮 × 4 门 ⇒ 4 组，每组恰好覆盖自己的下标区间（不重叠不遗漏）', () => {
    const groups = groupGateEvents([...round(1), ...round(2), ...round(3), ...round(4)]);
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => [g.start, g.end])).toEqual([[0, 3], [4, 7], [8, 11], [12, 15]]);
    // 覆盖性：并集恰为全部下标（不漏一条记录）
    const covered = groups.flatMap((g) => g.evidence.map((e) => e.timestamp));
    expect(covered).toHaveLength(16);
    expect(groups.reduce((n, g) => n + g.entryCount, 0)).toBe(16);
  });

  it('首条不是 G0 时也开组（账本可能从中途开始——历史前缀被裁剪过）', () => {
    const groups = groupGateEvents([E('G2', 'PASS', '', 0), E('G3', 'FAIL', '', 1), ...round(2)]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.gates).toEqual(['G2', 'G3']);
    expect(groups[0]?.entryCount).toBe(2);
  });

  it('空账本 ⇒ 空数组（不是"一个空组"——空组会在图上变成没有信息的点）', () => {
    expect(groupGateEvents([])).toEqual([]);
  });

  it('组内裁决取**最后一次**（同门先 FAIL 后 PASS ⇒ PASS）', () => {
    const groups = groupGateEvents([E('G0', 'PASS'), E('G1', 'FAIL', '', 1), E('G1', 'PASS', '', 2)]);
    expect(groups[0]?.verdicts['G1']).toBe('PASS');
    expect(groupVerdict(groups[0] as never)).toBe('PASS');
  });

  it('反向自检（INV-21）：detail 里写满别的 cycle 号，分组结果**完全不受影响**', () => {
    // 每条 detail 都提到 cycle-9，若判据按文本归属会全部归到同一组。
    const poisoned: LedgerEntryFact[] = [
      E('G0', 'PASS', 'cycle-9 cycle-8 cycle-7'),
      E('G1', 'PASS', 'cycle-9 cycle-8 cycle-7', 1),
      E('G0', 'PASS', 'cycle-9 cycle-8 cycle-7', 2),
      E('G1', 'PASS', 'cycle-9 cycle-8 cycle-7', 3),
    ];
    const groups = groupGateEvents(poisoned);
    // 位置法：两个 G0 ⇒ 两组。若按 detail 归属则会是 1 组。
    expect(groups).toHaveLength(2);
    expect(groups[0]?.start).toBe(0);
    expect(groups[1]?.start).toBe(2);
  });

  it('组内时间戳取最早/最晚（缺失时不伪造时间）', () => {
    const groups = groupGateEvents([E('G0', 'PASS', '', 5), { gate: 'G1', result: 'PASS' }]);
    expect(groups[0]?.startedAt).toBe(groups[0]?.endedAt); // 只有一条有时间戳
    const noTs = groupGateEvents([{ gate: 'G0', result: 'PASS' }]);
    expect(noTs[0]?.startedAt).toBeNull();
    expect(noTs[0]?.endedAt).toBeNull();
  });
});

describe('groupVerdict：整体裁决（有 FAIL 即 FAIL）', () => {
  it('四门全 PASS ⇒ PASS；任一 FAIL ⇒ FAIL；无 PASS 无 FAIL ⇒ null', () => {
    const allPass = groupGateEvents(round(1));
    expect(groupVerdict(allPass[0] as never)).toBe('PASS');
    const oneFail = groupGateEvents([E('G0', 'PASS'), E('G2', 'FAIL', '', 1)]);
    expect(groupVerdict(oneFail[0] as never)).toBe('FAIL');
    const unknown = groupGateEvents([{ gate: 'spec', result: undefined }]);
    expect(groupVerdict(unknown[0] as never)).toBeNull();
  });
});

describe('badgeLabel：徽章写进 label（一眼看出这轮过没过）', () => {
  it('四门全部出现在标签上，未出现的门写 —（省略会让"没跑"与"过了"无法区分）', () => {
    const g = groupGateEvents([E('G0', 'PASS'), E('G2', 'FAIL', '', 1)]);
    const label = badgeLabel(g[0] as never);
    expect(label).toContain('G0 PASS');
    expect(label).toContain('G1 —');
    expect(label).toContain('G2 FAIL');
    expect(label).toContain('G3 —');
  });

  it('可带轮次名（客户端据此对齐 cycle 节点）', () => {
    const g = groupGateEvents(round(1));
    expect(badgeLabel(g[0] as never, 'cycle-12')).toContain('cycle-12');
  });

  it('反向自检：FAIL 与 PASS 的标签必须不同（否则"一眼看出过没过"是空话）', () => {
    const pass = badgeLabel(groupGateEvents(round(1))[0] as never);
    const fail = badgeLabel(groupGateEvents([E('G0', 'FAIL')])[0] as never);
    expect(pass).not.toBe(fail);
  });
});

describe('evidenceDetail：证据必须可展开（聚合 ≠ 看不见）', () => {
  it('逐条记录都在 detail 里，含 gate/result/detail 三段', () => {
    const g = groupGateEvents(round(1));
    const text = evidenceDetail(g[0] as never);
    expect(text).toContain('4 records');
    expect(text).toContain('G0 PASS — Eval cycle-1');
    expect(text).toContain('G3 PASS — Build cycle-1');
  });

  it('超量截断时**如实标注**剩余条数（静默截断 = 变回看不见）', () => {
    // 注意：G0 会开新组，所以超量组必须由**非 G0**门构成（否则每条各成一组）。
    const many = Array.from({ length: 20 }, (_, i) => E('G1', 'PASS', `record ${String(i)}`, i));
    const g = groupGateEvents(many);
    expect(g).toHaveLength(1); // 单个 20 条的组
    const text = evidenceDetail(g[0] as never, 12);
    expect(text).toContain('20 records');
    expect(text).toContain('… (+8 more)'); // 20 - 12 = 8，数字必须真算
  });

  it('G0 是分组边界：20 条 G0 ⇒ 20 个单条组（不是 1 个 20 条组）', () => {
    const many = Array.from({ length: 20 }, (_, i) => E('G0', 'PASS', `r${String(i)}`, i));
    const groups = groupGateEvents(many);
    expect(groups).toHaveLength(20);
    expect(groups.every((g) => g.entryCount === 1)).toBe(true);
  });

  it('单条 detail 超长时截到 maxChars 并保持单行（不让节点详情被一坨文本撑爆）', () => {
    const g = groupGateEvents([E('G0', 'PASS', 'x'.repeat(400))]);
    const text = evidenceDetail(g[0] as never, 12, 50);
    expect(text).not.toContain('x'.repeat(51));
    expect(text).toContain('x'.repeat(50));
  });

  it('反向自检：同一批记录，聚合后的**节点数**远小于逐条摊开（证明聚合真的压了体积）', () => {
    const entries = [...round(1), ...round(2), ...round(3)]; // 12 条 / 3 组
    const groups = groupGateEvents(entries);
    // 逐条摊开 = 12 个节点；聚合 = 3 个节点。这才是聚合的体积收益本体。
    expect(entries.length).toBe(12);
    expect(groups.length).toBe(3);
    expect(groups.length).toBeLessThan(entries.length);
    // 且证据没有被丢掉：每组仍能展开出自己那 4 条
    expect(groups.map((g) => g.evidence.length)).toEqual([4, 4, 4]);
  });
});

describe('windowGateGroups：聚合之后仍要窗口（否则 73 组还是 73 个点）', () => {
  /** 造 N 组账本（每组四门）。 */
  function manyGroups(n: number): LedgerEntryFact[] {
    const out: LedgerEntryFact[] = [];
    for (let i = 0; i < n; i += 1) out.push(...round(i));
    return out;
  }

  it('73 组 + 窗口 8 ⇒ 留 8 组、折叠 65 组，且折叠摘要把组数与条数都报出来', () => {
    const groups = groupGateEvents(manyGroups(73));
    expect(groups).toHaveLength(73);
    const win = windowGateGroups(groups, 8);
    expect(win.kept).toHaveLength(8);
    expect(win.folded).toHaveLength(65);
    expect(win.foldedSummary?.groups).toBe(65);
    expect(win.foldedSummary?.entries).toBe(65 * 4);
    // 折叠的是**最老**那段（首组从下标 0 开始）
    expect(win.foldedSummary?.start).toBe(0);
    // 保留的是最近 8 组（最后一组的末下标 = 最后一条记录）
    expect(win.kept[win.kept.length - 1]?.end).toBe(groups[72]?.end);
  });

  it('组数 ≤ 窗口 ⇒ 不折叠，且**不生成**折叠摘要节点（空节点没信息量）', () => {
    const win = windowGateGroups(groupGateEvents(manyGroups(5)), 8);
    expect(win.kept).toHaveLength(5);
    expect(win.folded).toEqual([]);
    expect(win.foldedSummary).toBeNull();
  });

  it('折叠节点 id 落在 INV-21 结构化前缀集合内', () => {
    const win = windowGateGroups(groupGateEvents(manyGroups(20)), 8);
    const PREFIXES = ['wf:', 'cycle:', 'evt:', 'inc:', 'aux:'];
    expect(PREFIXES.some((p) => (win.foldedSummary?.nodeId ?? '').startsWith(p))).toBe(true);
  });

  it('反向自检：折叠数必须真随窗口变化（不是恒 0 的装饰）', () => {
    const groups = groupGateEvents(manyGroups(30));
    expect(windowGateGroups(groups, 8).folded.length).toBe(22);
    expect(windowGateGroups(groups, 20).folded.length).toBe(10);
    expect(windowGateGroups(groups, 30).folded.length).toBe(0);
  });

  it('保留段与折叠段之和 == 总组数（一条都不丢）', () => {
    const groups = groupGateEvents(manyGroups(37));
    const win = windowGateGroups(groups, 9);
    expect(win.kept.length + win.folded.length).toBe(37);
    // 且折叠段报出的条数 == 被折掉的组的条数之和（不是估的）
    const foldedEntries = win.folded.reduce((n, g) => n + g.entryCount, 0);
    expect(win.foldedSummary?.entries).toBe(foldedEntries);
  });
});
