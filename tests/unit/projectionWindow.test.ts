/**
 * 窗口化投影单测（cycle-83）：`planWindow` / `resolveSnapshotWindow` / `summarizeArchived`。
 *
 * ## 这个文件守的判据
 *
 * 「避免过度产物影响判断」的全部可断言内容都在这里：
 *   - 窗口**不静默丢数据**（`folded.length` 就是被折叠的真实数量）；
 *   - **当前轮永远在图里**（哪怕窗口被调成 1）；
 *   - 归档区**不进逐轮列表但必须可见**（摘要节点 + 计数）；
 *   - 非法窗口配置**回缺省 + 告警**（字符串/负数/超大值/小数各一条）。
 *
 * ## 每条都配反向自检
 *
 * 纯函数最容易写出「恒真断言」。所以每个用例都在同一函数上跑一次**错误参数**，
 * 证明判据能判两态（比如窗口调成 1 时确实只剩 1 轮 + 当前轮）。
 */
import { describe, it, expect } from 'vitest';
import {
  planWindow,
  summarizeArchived,
  type CycleFact,
} from '../../src/shared/snapshotProjection/projectionWindow.ts';
import {
  DEFAULT_SNAPSHOT_WINDOW,
  MAX_SNAPSHOT_WINDOW,
  resolveSnapshotWindow,
} from '../../src/shared/snapshotProjection/windowConfig.ts';

/** 造 N 轮活跃事实（1..N）。 */
function actives(n: number): CycleFact[] {
  return Array.from({ length: n }, (_, i) => ({ name: `cycle-${String(i + 1)}`, num: i + 1 }));
}

describe('resolveSnapshotWindow：非法值回缺省 + 告警（不许静默）', () => {
  it('缺省 / 空 / undefined ⇒ DEFAULT_SNAPSHOT_WINDOW 且零告警', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const r = resolveSnapshotWindow(raw);
      expect(r.recent).toBe(DEFAULT_SNAPSHOT_WINDOW);
      expect(r.warnings).toEqual([]);
    }
  });

  it('合法整数原样采纳（字符串与数字两形态同一条判据）', () => {
    expect(resolveSnapshotWindow('12').recent).toBe(12);
    expect(resolveSnapshotWindow(12).recent).toBe(12);
    expect(resolveSnapshotWindow(' 12 ').recent).toBe(12); // 首尾空白容忍
    expect(resolveSnapshotWindow('12').warnings).toEqual([]);
    // 边界：1 与 MAX 都是合法值（不因"太小/太大"被拒——拒绝的是非法形态，不是小值）
    expect(resolveSnapshotWindow(1).recent).toBe(1);
    expect(resolveSnapshotWindow(MAX_SNAPSHOT_WINDOW).recent).toBe(MAX_SNAPSHOT_WINDOW);
  });

  it('字符串非整数 / 小数 / 负数 / 超大值 / 十六进制 ⇒ 全部回缺省 + 逐条告警', () => {
    const cases: Array<[unknown, RegExp]> = [
      ['8abc', /not an integer/],
      ['1.5', /not an integer/],
      ['eight', /not an integer/],
      ['0x10', /not an integer/],
      [-1, /< 1/],
      [0, /< 1/],
      [MAX_SNAPSHOT_WINDOW + 1, /> 64/],
      [999999, /> 64/],
    ];
    for (const [raw, re] of cases) {
      const r = resolveSnapshotWindow(raw);
      expect(r.recent, `${String(raw)} 应回缺省`).toBe(DEFAULT_SNAPSHOT_WINDOW);
      expect(r.warnings.length, `${String(raw)} 必须告警（静默回缺省 = 用户以为设了）`).toBe(1);
      expect(r.warnings[0]).toMatch(re);
    }
  });

  it('反向自检：`Number.parseInt` 式的宽松解析会接受这些坏值——证明严格判据有牙', () => {
    // 旧写法 parseInt('8abc') === 8（"尽量理解"成合法值）、parseInt('1.5') === 1
    // （静默把小数截成整数，语义悄悄变了）。
    expect(Number.parseInt('8abc', 10)).toBe(8);
    expect(Number.parseInt('1.5', 10)).toBe(1);
    // 而闸门对这两个输入**发出告警**并丢弃它们（两态可分的判据是 `warnings.length`，
    // 不是 `recent` —— 因为缺省值恰好也等于 8，只比数值会造出恒真断言）。
    for (const bad of ['8abc', '1.5']) {
      const r = resolveSnapshotWindow(bad);
      expect(r.warnings.length, `${bad} 被静默接受了`).toBe(1);
      expect(r.recent).toBe(DEFAULT_SNAPSHOT_WINDOW);
    }
    // 对照：合法值零告警（证明「有告警」确实来自非法形态，不是闸门逢输入必报）
    expect(resolveSnapshotWindow(8).warnings).toEqual([]);
    // 且小数截断这条必须真的被挡住：1.5 不得被读成 1
    expect(resolveSnapshotWindow('1.5').warnings[0]).toMatch(/not an integer/);
  });
});

describe('planWindow：最近 N 轮 + 当前轮，折叠数如实', () => {
  it('80 轮 + 窗口 8 ⇒ 主图 8 轮、折叠 72 轮（windowedOut 就是 72）', () => {
    const plan = planWindow({ active: actives(80), archived: [], recent: 8 });
    expect(plan.windowed.map((c) => c.name)).toEqual([
      'cycle-73', 'cycle-74', 'cycle-75', 'cycle-76', 'cycle-77', 'cycle-78', 'cycle-79', 'cycle-80',
    ]);
    expect(plan.folded.length).toBe(72);
    expect(plan.current).toBe('cycle-80');
    expect(plan.folded[0]?.name).toBe('cycle-1');
    expect(plan.warnings).toEqual([]);
  });

  it('窗口 ≥ 轮数 ⇒ 全部进窗口、折叠为 0（不是"全部折叠"）', () => {
    const plan = planWindow({ active: actives(5), archived: [], recent: 8 });
    expect(plan.windowed.length).toBe(5);
    expect(plan.folded).toEqual([]);
  });

  it('窗口 = 1 ⇒ 只留最后一轮 + 当前轮（两者同一轮时结果恰为 1）', () => {
    const plan = planWindow({ active: actives(5), archived: [], recent: 1 });
    expect(plan.windowed.map((c) => c.name)).toEqual(['cycle-5']);
    expect(plan.folded.length).toBe(4);
  });

  it('当前轮被显式指定且**不在**最近 N 轮内 ⇒ 仍必须进主图（语义承诺）', () => {
    // 窗口 2 会只剩 cycle-4/5，但声明的当前轮是 cycle-2（比如非单调编号的场地）。
    const plan = planWindow({ active: actives(5), archived: [], recent: 2, current: 'cycle-2' });
    expect(plan.current).toBe('cycle-2');
    expect(plan.windowed.map((c) => c.name)).toEqual(['cycle-2', 'cycle-4', 'cycle-5']);
    expect(plan.folded.map((c) => c.name)).toEqual(['cycle-1', 'cycle-3']);
  });

  it('声明的当前轮不存在 ⇒ 落回最大编号轮 + 如实告警（不静默吞掉声明）', () => {
    const plan = planWindow({ active: actives(5), archived: [], recent: 2, current: 'cycle-99' });
    expect(plan.current).toBe('cycle-5');
    expect(plan.warnings.length).toBe(1);
    expect(plan.warnings[0]).toContain('cycle-99');
  });

  it('无活跃轮 ⇒ 空窗口 + current=null（不是报错，也不是保留最后一轮）', () => {
    const plan = planWindow({ active: [], archived: [], recent: 8 });
    expect(plan.windowed).toEqual([]);
    expect(plan.folded).toEqual([]);
    expect(plan.current).toBeNull();
  });

  it('归档轮比所有活跃轮都新 ⇒ 告警（"当前轮"读数是残留的旧轮，会误导）', () => {
    const plan = planWindow({
      active: actives(3),
      archived: [{ name: 'cycle-9', num: 9, archivedAt: '2026-10-01' }],
      recent: 8,
    });
    expect(plan.warnings.some((w) => w.includes('cycle-9'))).toBe(true);
  });

  it('反向自检：同一批 80 轮，窗口 8 与窗口 64 的折叠数必须不同（判据真的随参数变）', () => {
    const wide = planWindow({ active: actives(80), archived: [], recent: MAX_SNAPSHOT_WINDOW });
    const narrow = planWindow({ active: actives(80), archived: [], recent: 8 });
    expect(wide.folded.length).toBe(80 - MAX_SNAPSHOT_WINDOW);
    expect(narrow.folded.length).toBe(72);
    expect(wide.folded.length).not.toBe(narrow.folded.length);
  });

  it('确定性：同输入两次调用深相等（排序不依赖 Map 遍历顺序）', () => {
    const input = { active: actives(20), archived: [], recent: 5 };
    expect(planWindow(input)).toEqual(planWindow(input));
    // 逆序喂入也必须得到同一结果（数值序排序真的在起作用）
    const reversed = { ...input, active: [...actives(20)].reverse() };
    expect(planWindow(reversed).windowed.map((c) => c.name)).toEqual(planWindow(input).windowed.map((c) => c.name));
  });
});

describe('summarizeArchived：「归档 ≠ 丢失」的可见形态', () => {
  it('零归档 ⇒ 不生成节点（空节点 = 有壳无表体）', () => {
    const s = summarizeArchived([]);
    expect(s.count).toBe(0);
    expect(s.nodeId).toBeNull();
    expect(s.label).toBe('');
  });

  it('1 轮与多轮各自给出带计数的标签 + 首尾点名', () => {
    const one = summarizeArchived([{ name: 'cycle-7', num: 7 }]);
    expect(one.count).toBe(1);
    expect(one.nodeId).toBe('evt:archived');
    expect(one.label).toContain('1 cycle');
    expect(one.label).toContain('cycle-7');

    const many = summarizeArchived([{ name: 'cycle-1', num: 1 }, { name: 'cycle-2', num: 2 }, { name: 'cycle-3', num: 3 }]);
    expect(many.count).toBe(3);
    expect(many.first).toBe('cycle-1');
    expect(many.last).toBe('cycle-3');
    expect(many.label).toContain('3 cycles');
    expect(many.label).toContain('cycle-1');
  });

  it('节点 id 落在 INV-21 结构化前缀集合内（selfCheckRoute P2 认的那些）', () => {
    const PREFIXES = ['wf:', 'cycle:', 'evt:', 'inc:', 'aux:'];
    const s = summarizeArchived([{ name: 'cycle-3', num: 3 }]);
    expect(PREFIXES.some((p) => (s.nodeId ?? '').startsWith(p))).toBe(true);
  });

  it('反向自检：计数必须真的随归档数变化（不是恒 1 的装饰）', () => {
    expect(summarizeArchived([{ name: 'cycle-1', num: 1 }]).count).toBe(1);
    expect(summarizeArchived([{ name: 'cycle-1', num: 1 }, { name: 'cycle-2', num: 2 }]).count).toBe(2);
    // 且标签文本必须随之改变（只改数字不改文本 = 用户看不出）
    expect(summarizeArchived([{ name: 'cycle-1', num: 1 }]).label)
      .not.toBe(summarizeArchived([{ name: 'cycle-1', num: 1 }, { name: 'cycle-2', num: 2 }]).label);
  });
});
