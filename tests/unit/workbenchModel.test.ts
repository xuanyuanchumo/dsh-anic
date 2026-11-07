/**
 * 工作台域表单测（cycle-110）。
 *
 * 域表是分桶/渲染/状态分类的唯一事实源——它错一格，某个分区就从面板上消失
 * （且因为分区组件本身仍在装配数组里，旧行为测试不红）。所以本文件钉三条：
 * ① 16 个分区恰好归一次（无遗漏无重复）；② 分桶保持域表序与装配序；
 * ③ 反向自检——域表漏一项时 unassigned 必须接住（漂移可见）。
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import {
  WORKBENCH_DOMAINS, partitionSections, sectionKeyOf, SECTION_KEY_PROP,
} from '../../src/client/workbench/workbenchModel.ts';

/** 装配层的全部分区 key（panelSectionOrder keyed() 的字面量集合）。 */
const ALL_SECTIONS = [
  'graph', 'live', 'cycles', 'stepTrace', 'diagnostics', 'org', 'skillHealth',
  'techDebt', 'flows', 'ledger', 'hitl', 'budget', 'closure', 'bootstrap', 'config',
  'pluginInfo',
] as const;

/** 造一个带 key 标记的假装配元素。 */
function el(sectionKey: string): ReturnType<typeof createElement> {
  return createElement('div', { [SECTION_KEY_PROP]: sectionKey });
}
const assembled = ALL_SECTIONS.map((k) => el(k));

describe('域表完整性（唯一事实源的三条不变量）', () => {
  it('16 个分区恰好归一次：无遗漏、无重复、无未知键', () => {
    const flat = WORKBENCH_DOMAINS.flatMap((d) => [...d.sections]);
    expect([...flat].sort()).toEqual([...ALL_SECTIONS].sort());
    expect(new Set(flat).size).toBe(flat.length);
  });
  it('六域、id/labelKey/span 形状齐备（labelKey 指向 wb.domain.<id>）', () => {
    expect(WORKBENCH_DOMAINS).toHaveLength(6);
    for (const d of WORKBENCH_DOMAINS) {
      expect(d.labelKey).toBe(`wb.domain.${d.id}`);
      expect(['full', 'auto']).toContain(d.span);
      expect(d.sections.length).toBeGreaterThan(0);
    }
  });
  it('graph 与 settings 是通栏（主叙事与可写面）；其余半宽', () => {
    const byId = new Map(WORKBENCH_DOMAINS.map((d) => [d.id, d]));
    expect(byId.get('overview')?.span).toBe('full');
    expect(byId.get('settings')?.span).toBe('full');
    expect(byId.get('health')?.span).toBe('auto');
  });
});

describe('partitionSections（纯 zip：装配序 × 域表）', () => {
  it('全部入桶、unassigned 为空、桶序与域表一致、桶内保持装配序', () => {
    const { buckets, unassigned } = partitionSections(assembled);
    expect(unassigned).toEqual([]);
    expect([...buckets.keys()]).toEqual(WORKBENCH_DOMAINS.map((d) => d.id));
    // 装配序抽查：overview 桶内 graph 在 cycles 前（装配数组序，不是域表序的重新发明）
    const ov = buckets.get('overview') as NonNullable<typeof buckets.overview>;
    expect(ov.map(sectionKeyOf)).toEqual(['graph', 'live', 'cycles']);
  });
  it('workspaceBadge/详情抽屉形态（无 key 标记）进 unassigned——调用方负责单独安置', () => {
    const badge = createElement('div', { 'data-anic-workspace-badge': 'true' }); // 无标记
    const { unassigned } = partitionSections([badge, ...assembled]);
    expect(unassigned).toHaveLength(1);
  });
  it('反向自检：域表缺一项 ⇒ 该分区落进 unassigned（漂移必须可见）', () => {
    const broken = WORKBENCH_DOMAINS.map((d) =>
      d.id === 'health'
        ? { ...d, sections: d.sections.filter((s) => s !== 'skillHealth') }
        : d);
    const { buckets, unassigned } = partitionSections(assembled, broken);
    expect(buckets.get('health')?.map(sectionKeyOf)).not.toContain('skillHealth');
    expect(unassigned.map(sectionKeyOf)).toEqual(['skillHealth']);
  });
});
