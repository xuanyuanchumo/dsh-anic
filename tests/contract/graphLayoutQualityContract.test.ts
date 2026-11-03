/**
 * 布局质量读数契约（cycle-101 · 白盒化「静默丢弃」与「无出口读数」）。
 *
 * ## 被守卫的两个缺口（研究报告 + 实测）
 *
 * 1. **交叉数无 UI 出口**：`GraphLayout.crossings` 在 cycle-94 就算出来了（同一把尺
 *    量三种布局模式），但**没有任何界面消费** —— 读者切到 flow 模式后无法判断
 *    "到底好没好"。没有数字，"flow 更好读"只是无法验证的说法。
 * 2. **重复 id 静默丢弃**：`planColumns` 对重复 id「首个胜出并 continue」（位置
 *    唯一性是硬不变量，不能改），数据管道出问题时用户只看到"节点少了几个"。
 *
 * ## 三条渲染纪律（与读数条同款）
 *
 * ① 缺省 undefined ⇒ 不渲染（零参调用 = 改造前工具栏）；
 * ② 两读数都为 0 ⇒ 不渲染（健康态不占位，不制造噪声）；
 * ③ 有值时必带 data-* 锚点（可被测试与自动化读取）。
 */
import { describe, expect, it } from 'vitest';
import { renderToolbarTail } from '../../src/client/features/graph/graphToolbarTail.ts';
import type { Viewport } from '../../src/client/features/graph/graphViewport.ts';

const VP: Viewport = { scale: 1, tx: 0, ty: 0 };

function tail(extra: Record<string, unknown> = {}) {
  return renderToolbarTail({
    viewport: VP,
    adjacencyOn: false,
    filterActive: false,
    typeCounts: [],
    onZoomIn: () => undefined,
    onZoomOut: () => undefined,
    onFit: () => undefined,
    onAdjacencyToggle: () => undefined,
    onClear: () => undefined,
    ...extra,
  });
}

/** 从元素数组里找布局质量徽章（按 data-anic-graph-layout-quality 锚点）。 */
function findQuality(nodes: ReturnType<typeof tail>): unknown {
  return nodes.find((n) => n && (n.props as Record<string, unknown>)['data-anic-graph-layout-quality'] === '1') ?? null;
}

describe('布局质量读数（cycle-101）', () => {
  it('① 缺省 undefined ⇒ 不渲染（零参调用 = 改造前工具栏）', () => {
    expect(findQuality(tail())).toBeNull();
  });

  it('② 两读数都为 0 ⇒ 不渲染（健康态不占位）', () => {
    expect(findQuality(tail({ layoutQuality: { crossings: 0, droppedDuplicates: 0 } }))).toBeNull();
  });

  it('③ 有交叉数 ⇒ 渲染且带 data-anic-graph-crossings 锚点', () => {
    const q = findQuality(tail({ layoutQuality: { crossings: 42, droppedDuplicates: 0 } }));
    expect(q).not.toBeNull();
    const json = JSON.stringify(q);
    expect(json).toContain('"data-anic-graph-crossings":"42"');
    expect(json).toContain('交叉 42');
    // 无折叠时不显示折叠徽章（不制造假警报）
    expect(json).not.toContain('data-anic-graph-dropped-ids');
  });

  it('③b 有折叠 ⇒ 渲染且带 data-anic-graph-dropped-ids 锚点（告警语义）', () => {
    const q = findQuality(tail({ layoutQuality: { crossings: 0, droppedDuplicates: 3 } }));
    expect(q).not.toBeNull();
    const json = JSON.stringify(q);
    expect(json).toContain('"data-anic-graph-dropped-ids":"3"');
    expect(json).toContain('折叠 3');
    expect(json).not.toContain('data-anic-graph-crossings');
  });

  it('③c 两者都有 ⇒ 两个徽章同时在场', () => {
    const q = findQuality(tail({ layoutQuality: { crossings: 17, droppedDuplicates: 2 } }));
    const json = JSON.stringify(q);
    expect(json).toContain('"data-anic-graph-crossings":"17"');
    expect(json).toContain('"data-anic-graph-dropped-ids":"2"');
  });

  it('④ 徽章带 title 说明（可发现性：读者知道这个数字是什么）', () => {
    const json = JSON.stringify(findQuality(tail({ layoutQuality: { crossings: 5, droppedDuplicates: 1 } })));
    expect(json).toContain('交叉数 5');
    expect(json).toContain('位置唯一性');
  });
});
