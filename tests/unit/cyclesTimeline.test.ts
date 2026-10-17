// @vitest-environment jsdom
/**
 * renderCyclesTimeline 渲染测试（B1 · P0 UI 缺口，cycle-16）。
 *
 * 与 renderFlows.test.ts / invocationsRender.test.ts 同纪律：renderToStaticMarkup
 * 真渲染——「返回 ReactElement」与「渲染出正确标记」是两个命题。
 *
 * 响应形状契约来源：src/host/routes/cycleRoute.ts:82-89（GET /anic/cycle/list →
 * { cycles: number[], nextCycleNumber }）与 cycleRoute.ts:71-80（GET
 * /anic/cycle/state → { nodes, edges, state }），listCycles 数值序见
 * src/host/runtime/cycleRunner.ts:29-37。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderCyclesTimeline, advancedCountOf, isCycleList, isCycleState, type CycleListJson, type CycleStateJson } from '../../src/client/features/cycles/renderCyclesTimeline.ts';

function list(cycles: number[], next?: number): CycleListJson {
  return { cycles, nextCycleNumber: next ?? (cycles.length > 0 ? Math.max(...cycles) + 1 : 1) };
}

function state(advanced: number): CycleStateJson {
  const s: Record<string, { status: string; updatedAt: string }> = {};
  for (let i = 0; i < advanced; i += 1) s[`n${String(i)}`] = { status: 'done', updatedAt: 't' };
  for (let i = 0; i < 3; i += 1) s[`p${String(i)}`] = { status: 'pending', updatedAt: 't' };
  return { state: s };
}

describe('renderCyclesTimeline（Cycle 时间线分区）', () => {
  it('list=null（未拉取）→ 整区不渲染（不伪造空态）', () => {
    expect(renderCyclesTimeline({ list: null, state: null })).toBe(null);
  });

  it('空 cycles 数组 → 不渲染（诚实：无 cycle 不画条带）', () => {
    expect(renderCyclesTimeline({ list: list([]), state: null })).toBe(null);
  });

  it('渲染条目数与 cycles 数组一致（每 cycle 一格）', () => {
    const html = renderToStaticMarkup(renderCyclesTimeline({ list: list([1, 2, 3, 4, 5]), state: state(2) }));
    for (const num of [1, 2, 3, 4, 5]) {
      expect(html).toContain(`data-anic-cycle-cell="${String(num)}"`);
    }
    expect(html).toContain('data-anic-cycle-strip');
    expect(html).toContain('5 轮');
  });

  it('当前 cycle（list 尾项）高亮：current 标记 + ▶ 字形 + active 色（第二通道）', () => {
    const html = renderToStaticMarkup(renderCyclesTimeline({ list: list([1, 2, 3]), state: state(1) }));
    expect(html).toContain('data-anic-cycle-current="true"');
    expect(html).toContain('▶');
    // 历史格是 · 字形（非颜色通道区分当前/过去）
    expect(html).toContain('·');
  });

  it('过去 cycle 不加裁决（诚实边界：state 只反映当前 cycle，不伪造历史 PASS/FAIL）', () => {
    const html = renderToStaticMarkup(renderCyclesTimeline({ list: list([1, 2, 3]), state: state(3) }));
    // 只有尾项带 current；历史格无任何 verdict 类标记
    const currentCount = (html.match(/data-anic-cycle-current="true"/g) ?? []).length;
    expect(currentCount).toBe(1);
    expect(html).not.toContain('data-anic-cycle-verdict');
  });

  it('state=null：当前格仍渲染，推进数显示 0（不因缺 state 隐藏分区）', () => {
    const html = renderToStaticMarkup(renderCyclesTimeline({ list: list([7]), state: null }));
    expect(html).toContain('data-anic-cycle-cell="7"');
    expect(html).toContain('已推进 0 节点');
  });

  it('advancedCountOf 只数非 pending 节点', () => {
    expect(advancedCountOf(state(4))).toBe(4);
    expect(advancedCountOf(null)).toBe(0);
    expect(advancedCountOf({ state: {} })).toBe(0);
  });

  it('i18n 键消费：标题/摘要文案来自 locale（zh 缺省）', () => {
    const html = renderToStaticMarkup(renderCyclesTimeline({ list: list([1, 2], 3), state: state(5) }));
    expect(html).toContain('Cycle 时间线（2 轮）');
    expect(html).toContain('最新 cycle-2');
    expect(html).toContain('下一轮 cycle-3');
    expect(html).toContain('已推进 5 节点');
  });

  it('形状守卫：isCycleList/isCycleState 拒畸形', () => {
    expect(isCycleList({ cycles: [1] })).toBe(true);
    expect(isCycleList({ cycles: 'no' })).toBe(false);
    expect(isCycleList(null)).toBe(false);
    expect(isCycleList([1, 2])).toBe(false);
    expect(isCycleState({ state: {} })).toBe(true);
    expect(isCycleState({ nodes: [] })).toBe(false);
    expect(isCycleState(null)).toBe(false);
  });

  it('所有颜色经 token() 带同源 fallback（渲染契约纪律）', () => {
    const html = renderToStaticMarkup(renderCyclesTimeline({ list: list([1, 2]), state: null }));
    const vars = html.match(/var\(--anic-[a-z-]+[^)]*\)/g) ?? [];
    expect(vars.length).toBeGreaterThan(0);
    for (const v of vars) {
      expect(v).toMatch(/^var\(--anic-[a-z-]+, #[0-9a-f]{6}\)$/);
    }
  });
});
