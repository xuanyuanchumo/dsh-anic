/**
 * renderFlows 渲染测试（cycle-9 · D10 宿主域接线）。
 *
 * 用 renderToStaticMarkup 真渲染（与 invocationsRender.test.ts 同纪律）：
 * 「返回 ReactElement」与「渲染出正确标记」是两个命题。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderFlows, type FlowStatusJson, type FlowEntryJson } from '../../src/client/features/flows/renderFlows.ts';

function entry(over: Partial<FlowEntryJson>): FlowEntryJson {
  return {
    id: 'gate-check',
    labelKey: 'flows.gateCheck',
    states: ['IDLE', 'RUNNING', 'PASSED', 'FAILED'],
    initial: 'IDLE',
    transitions: [{ from: 'IDLE', to: 'RUNNING', trigger: 'run', guard: null }],
    persistence: { kind: 'projection', path: 'flows/gate-check.json' },
    engine: 'gateEngine',
    scriptFallback: 'gate-check',
    ...over,
  };
}

function status(flows: FlowEntryJson[], over: Partial<FlowStatusJson> = {}): FlowStatusJson {
  return {
    flows, total: flows.length,
    running: flows.filter((f) => f.projection?.current === 'RUNNING').length,
    terminal: flows.filter((f) => f.projection && f.projection.current !== 'RUNNING').length,
    neverRun: flows.filter((f) => f.projection === null).length,
    ...over,
  };
}

describe('renderFlows（流程状态机面板分区）', () => {
  it('null（未拉取）→ 整区不渲染（不伪造空态）', () => {
    expect(renderFlows(null)).toBe(null);
  });

  it('空 flows 数组（宿主无注册流程）→ 不渲染', () => {
    expect(renderFlows(status([]))).toBe(null);
  });

  it('一站式概览：标题计数 + 运行/终态/未运行汇总', () => {
    const html = renderToStaticMarkup(renderFlows(status([
      entry({ id: 'a', projection: { flowId: 'a', current: 'RUNNING', history: [], updatedAt: 't' } }),
      entry({ id: 'b', projection: { flowId: 'b', current: 'FAILED', history: [], updatedAt: 't' } }),
      entry({ id: 'c', projection: null }),
    ])));
    expect(html).toContain('data-anic-flows-wrap');
    expect(html).toContain('3 流程');
    expect(html).toContain('运行中 1');
    expect(html).toContain('终态 1');
    expect(html).toContain('未运行 1');
  });

  it('每流程一行：label + 引擎 + 技能回退 + 当前态', () => {
    const html = renderToStaticMarkup(renderFlows(status([
      entry({
        id: 'gate-check',
        projection: { flowId: 'gate-check', current: 'PASSED', history: [{ trigger: 'all-pass', from: 'RUNNING', to: 'PASSED', at: 't' }], updatedAt: 't' },
      }),
    ])));
    expect(html).toContain('data-anic-flow="gate-check"');
    expect(html).toContain('收敛门禁流程'); // labelKey → t() 的中文标签
    expect(html).toContain('引擎 gateEngine');
    expect(html).toContain('技能回退 gate-check');
    expect(html).toContain('当前态：PASSED');
    expect(html).toContain('最近转移 all-pass: RUNNING → PASSED');
    expect(html).toContain('1 次转移');
  });

  it('从未运行：如实显示（projection=null 不伪造 IDLE）', () => {
    const html = renderToStaticMarkup(renderFlows(status([entry({ projection: null })])));
    expect(html).toContain('从未运行');
    expect(html).not.toContain('当前态：IDLE');
  });

  it('失败终态行存在（语义色在 style 内联，标记层只断言态名）', () => {
    const html = renderToStaticMarkup(renderFlows(status([
      entry({ id: 'archive', labelKey: 'flows.archive', engine: null, scriptFallback: 'archive-cycle',
        projection: { flowId: 'archive', current: 'BLOCKED', history: [], updatedAt: 't' } }),
    ])));
    expect(html).toContain('data-anic-flow="archive"');
    expect(html).toContain('BLOCKED');
  });
});
