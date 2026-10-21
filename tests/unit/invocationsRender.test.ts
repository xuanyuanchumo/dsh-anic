/**
 * renderInvocations 渲染测试（cycle-97 动态白盒分区）。
 *
 * 用 renderToStaticMarkup 真渲染（与 orgStatusRender.test.ts 同纪律）：
 * "返回 ReactElement" 与 "渲染出正确标记" 是两个命题，类型对不等于标记对。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderInvocations, type InvocationJson, type InvocationsJson } from '../../src/client/features/live/renderInvocations.ts';

function inv(over: Partial<InvocationJson>): InvocationJson {
  return {
    callId: 'c1', name: 'anic_evaluate', argumentsPreview: '{}',
    startedAt: 1, status: 'done', ...over,
  };
}

function snap(invocations: InvocationJson[]): InvocationsJson {
  return { invocations, total: invocations.length, generatedAt: '2026-10-17T00:00:00.000Z' };
}

/** T-4702：带通道诊断计数的快照夹具（路由 /invocations/live 真实形状）。 */
function snapWithDiag(invocations: InvocationJson[], diagnostics: InvocationsJson['diagnostics']): InvocationsJson {
  return { ...snap(invocations), diagnostics };
}

describe('renderInvocations（动态白盒分区）', () => {
  it('data 为 null：显示等待首轮轮询（不伪造空态引导）', () => {
    const html = renderToStaticMarkup(renderInvocations(null, null));
    expect(html).toContain('data-anic-invocations="section"');
    expect(html).toContain('未取得');
    expect(html).toContain('data-anic-invocations-pending');
    expect(html).not.toContain('data-anic-invocations-empty');
    expect(html).not.toContain('暂无插件调用');
  });
  it('空流：如实显示空态引导文案（与 null 区分）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([]), null));
    expect(html).toContain('data-anic-invocations-empty');
    expect(html).toContain('暂无插件调用');
    expect(html).toContain('0 条');
  });
  it('三态卡片：done/error/in-flight 各自的状态属性与文案', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'a', status: 'done', durationMs: 1234 }),
      inv({ callId: 'b', status: 'error', error: { name: 'GateError', code: 'G1', reason: '缺任务清单' } }),
      inv({ callId: 'c', status: 'in-flight', turn: 2, step: 5 }),
    ]), null));
    expect(html).toContain('data-anic-invocation="a"');
    expect(html).toContain('data-anic-invocation-status="done"');
    expect(html).toContain('data-anic-invocation-status="error"');
    expect(html).toContain('data-anic-invocation-status="in-flight"');
    expect(html).toContain('1234ms');
    expect(html).toContain('GateError(G1)');
    expect(html).toContain('t2/s5'); // turn/step 坐标
    expect(html).toContain('完成');
    expect(html).toContain('失败');
    expect(html).toContain('执行中');
  });
  it('in-flight 卡片带脉冲动画类；样式块含 prefers-reduced-motion 逃逸', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([inv({ status: 'in-flight' })]), null));
    expect(html).toContain('anic-live-dot');
    expect(html).toContain('@keyframes anic-live-pulse');
    expect(html).toContain('prefers-reduced-motion');
    expect(html).toContain('animation:none'); // 降级逃逸真的写了 none，不是只声明媒体查询
  });
  it('疑似失联（possiblyOrphaned）显示"疑似失联"而非"执行中"——不把失联伪装成在跑', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([inv({ status: 'in-flight', possiblyOrphaned: true })]), null));
    expect(html).toContain('疑似失联');
    expect(html).not.toContain('>执行中<');
  });
  it('轮询失败：显示失败原因并保留最后已知数据（两个事实同时呈现）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([inv({ callId: 'a', status: 'done' })]), '路由 500'));
    expect(html).toContain('轮询失败（路由 500）');
    expect(html).toContain('最后已知数据');
    expect(html).toContain('data-anic-invocation="a"'); // 数据仍在，不是空白
  });
  it('错误 reason 截断到 120 字符（不把超长错误刷满面板）', () => {
    const longReason = 'x'.repeat(300);
    const html = renderToStaticMarkup(renderInvocations(snap([inv({ status: 'error', error: { name: 'E', code: 'C', reason: longReason } })]), null));
    expect(html).not.toContain('x'.repeat(121));
    expect(html).toContain('x'.repeat(120));
  });
  it('忠实渲染传入顺序（最新在前的排序契约由 feed.snapshot 承担，见 invocationFeed.test.ts）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'first-passed', name: 'anic_a' }),
      inv({ callId: 'second-passed', name: 'anic_b' }),
    ]), null));
    const iFirst = html.indexOf('data-anic-invocation="first-passed"');
    const iSecond = html.indexOf('data-anic-invocation="second-passed"');
    expect(iFirst).toBeGreaterThan(-1);
    expect(iSecond).toBeGreaterThan(iFirst); // 渲染层不重排：feed 给什么序就什么序
  });

  // ── cycle-20（P2）：turn/step 折叠分组 ──
  it('全部条目无 turn 元数据 → 平铺模式（零回归面：不出现 details 分组）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'a', status: 'done' }),
      inv({ callId: 'b', status: 'done' }),
    ]), null));
    expect(html).toContain('data-anic-invocation-list');
    expect(html).not.toContain('data-anic-turn-group');
    expect(html).not.toContain('<details');
    // 平铺与改造前同构：行内直接是 data-anic-invocation
    expect(html).toContain('data-anic-invocation="a"');
    expect(html).toContain('data-anic-invocation="b"');
  });

  it('有 turn 元数据 → 按组折叠：turn 降序、最新组默认展开、组内行序=feed 序', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'newer', turn: 2, step: 1 }),
      inv({ callId: 'older-a', turn: 1, step: 3 }),
      inv({ callId: 'older-b', turn: 1, step: 1 }),
    ]), null));
    expect(html).toContain('data-anic-turn-group="t2"');
    expect(html).toContain('data-anic-turn-group="t1"');
    // 最新组（t2）默认展开——open 属性出现在第一个 details 上
    const firstDetails = html.indexOf('<details');
    const t2Idx = html.indexOf('data-anic-turn-group="t2"');
    expect(firstDetails).toBeGreaterThan(-1);
    expect(html.slice(firstDetails, firstDetails + 200)).toContain('open');
    expect(t2Idx).toBeGreaterThan(firstDetails);
    expect(t2Idx).toBeLessThan(firstDetails + 200);
    // 组内序=feed 序：older-a 先于 older-b（渲染层不重排契约延伸到组内）
    const ia = html.indexOf('data-anic-invocation="older-a"');
    const ib = html.indexOf('data-anic-invocation="older-b"');
    expect(ia).toBeGreaterThan(-1);
    expect(ib).toBeGreaterThan(ia);
    // 分组摘要带计数
    expect(html).toContain('Turn 2');
    expect(html).toContain('2 次调用');
  });

  it('混合元数据：无 turn 条目归「未分组」组殿后（不丢弃任何事实）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'with-turn', turn: 3, step: 1 }),
      inv({ callId: 'no-turn' }),
    ]), null));
    expect(html).toContain('data-anic-turn-group="t3"');
    expect(html).toContain('data-anic-turn-group="ungrouped"');
    // 未分组殿后
    const t3 = html.indexOf('data-anic-turn-group="t3"');
    const un = html.indexOf('data-anic-turn-group="ungrouped"');
    expect(t3).toBeGreaterThan(-1);
    expect(un).toBeGreaterThan(t3);
    // 无 turn 条目仍在渲染输出里
    expect(html).toContain('data-anic-invocation="no-turn"');
    expect(html).toContain('未标注 turn');
  });
});

// ── cycle-41：用户目标 A（默认展开语义）+ Top5（截限）+ Top4a（播报区）+ 概览量化 ──
describe('renderInvocations —— cycle-41 展开语义与收纳', () => {
  it('目标 A：默认展开 = 含运行中调用的组 + 最近一次已完成所在的组；其余折叠', () => {
    // t3 全部完成且是最近完成（endedAt 最新）；t2 全部完成（更早）；t1 含运行中。
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 't3-done', turn: 3, status: 'done', endedAt: 300 }),
      inv({ callId: 't2-done', turn: 2, status: 'done', endedAt: 200 }),
      inv({ callId: 't1-running', turn: 1, status: 'in-flight' }),
    ]), null));
    const g3 = html.indexOf('data-anic-turn-group="t3"');
    const g2 = html.indexOf('data-anic-turn-group="t2"');
    const g1 = html.indexOf('data-anic-turn-group="t1"');
    expect(g3).toBeGreaterThan(-1);
    expect(g2).toBeGreaterThan(g3); // turn 降序
    expect(g1).toBeGreaterThan(g2);
    // t3（最近完成）与 t1（运行中）默认展开；t2（历史）折叠
    // （断言用「 open 属性」的词边界——marker 属性 open-default="false" 含 open 子串）
    const seg = (idx: number): string => html.slice(idx, idx + 300);
    expect(seg(g3)).toContain('open=""');
    expect(seg(g1)).toContain('open=""');
    expect(seg(g2)).toContain('open-default="false"');
    expect(seg(g2)).not.toContain('open=""');
    // 展开标记（折叠收纳后仍可一眼定位）
    expect(html).toContain('data-anic-turn-group-open-default="true"');
    expect(html).toContain('data-anic-turn-group-open-default="false"');
  });

  it('目标 A：运行中组摘要带「执行中」后缀计数', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'r1', turn: 1, status: 'in-flight' }),
      inv({ callId: 'd1', turn: 1, status: 'done', endedAt: 100 }),
    ]), null));
    expect(html).toContain('（1 执行中）');
  });

  it('目标 A 兼容：旧断言「最新组展开」在新语义下仍成立（最新组含最近完成者）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'newer', turn: 2, step: 1 }),
      inv({ callId: 'older-a', turn: 1, step: 3 }),
      inv({ callId: 'older-b', turn: 1, step: 1 }),
    ]), null));
    const firstDetails = html.indexOf('<details');
    const t2Idx = html.indexOf('data-anic-turn-group="t2"');
    expect(firstDetails).toBeGreaterThan(-1);
    expect(html.slice(firstDetails, firstDetails + 200)).toContain('open');
    expect(t2Idx).toBeGreaterThan(firstDetails);
    expect(t2Idx).toBeLessThan(firstDetails + 200);
  });

  it('Top5 截限：单组超 40 条渲染截断 +「另有 N 条」计数行（数据计数如实）', () => {
    const many: InvocationJson[] = Array.from({ length: 45 }, (_, i) =>
      inv({ callId: `c${String(i)}`, turn: 1, status: 'done', endedAt: i }));
    const html = renderToStaticMarkup(renderInvocations(snap(many), null));
    expect(html).toContain('data-anic-invocation="c39"'); // 前 40 条渲染
    expect(html).not.toContain('data-anic-invocation="c40"'); // 第 41+ 截断
    expect(html).toContain('data-anic-invocation-truncated');
    expect(html).toContain('另有 5 条已收纳');
    expect(html).toContain('组内共 45 条');
  });

  it('Top4a 播报区：announce 非空时渲染 sr-only polite 区；空时不渲染', () => {
    const withA = renderToStaticMarkup(renderInvocations(snap([inv({ callId: 'a' })]), null, true, '新增 2 个调用'));
    expect(withA).toContain('data-anic-invocations-announce');
    expect(withA).toContain('aria-live="polite"');
    expect(withA).toContain('anic-sr-only');
    expect(withA).toContain('新增 2 个调用');
    const noA = renderToStaticMarkup(renderInvocations(snap([inv({ callId: 'a' })]), null, true, ''));
    expect(noA).not.toContain('data-anic-invocations-announce');
  });

  it('概览量化：标题行含运行中/失败计数（仅非零时）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'r', status: 'in-flight' }),
      inv({ callId: 'e', status: 'error', error: { name: 'E', code: 'C' } }),
      inv({ callId: 'd', status: 'done', endedAt: 1 }),
    ]), null));
    expect(html).toContain('运行中 1');
    expect(html).toContain('失败 1');
    const clean = renderToStaticMarkup(renderInvocations(snap([inv({ callId: 'd', status: 'done', endedAt: 1 })]), null));
    expect(clean).not.toContain('运行中');
    expect(clean).not.toContain('失败 1');
  });
});

describe('renderInvocations —— cycle-47 T-4702 通道诊断行', () => {
  const diag = { sessionEvents: 120, sessionToolCalls: 30, toolsResults: 28, anicCalls: 4, anicResults: 4 };

  it('空流 + 诊断计数 > 0：诊断行渲染（「到了但被过滤」一眼可辨——白盒排障）', () => {
    const html = renderToStaticMarkup(renderInvocations(snapWithDiag([], diag), null));
    expect(html).toContain('data-anic-feed-diagnostics');
    expect(html).toContain('通道计数：事件 120');
    expect(html).toContain('工具调用 30');
    expect(html).toContain('anic 调用 4');
  });

  it('空流 + 诊断计数全 0：诊断行仍渲染（「事件没到」与「被过滤」的区分面）', () => {
    const zero = { sessionEvents: 0, sessionToolCalls: 0, toolsResults: 0, anicCalls: 0, anicResults: 0 };
    const html = renderToStaticMarkup(renderInvocations(snapWithDiag([], zero), null));
    expect(html).toContain('data-anic-feed-diagnostics');
    expect(html).toContain('事件 0');
  });

  it('有数据时诊断行也渲染（通道活性持续可见）', () => {
    const html = renderToStaticMarkup(renderInvocations(snapWithDiag([inv({ callId: 'a' })], diag), null));
    expect(html).toContain('data-anic-invocation-list');
    expect(html).toContain('data-anic-feed-diagnostics');
    expect(html).toContain('anic 结果 4');
  });

  it('旧宿主无 diagnostics 字段：诊断行不渲染（可选字段零回归面）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([inv({ callId: 'a' })]), null));
    expect(html).not.toContain('data-anic-feed-diagnostics');
    expect(html).not.toContain('通道计数');
  });

  it('null 态（尚未轮询到）不渲染诊断行——没有数据就没有诊断', () => {
    const html = renderToStaticMarkup(renderInvocations(null, null));
    expect(html).not.toContain('data-anic-feed-diagnostics');
  });
});
