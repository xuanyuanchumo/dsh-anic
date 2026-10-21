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

describe('renderInvocations —— cycle-48 T-4801 结果预览行', () => {
  it('done + resultPreview：渲染 ⇒ 前缀预览（「返回了什么」与参数成对呈现）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'a', status: 'done', argumentsPreview: '{"flowLimit":5}', resultPreview: '最近 5 条流程记录全部成功' }),
    ]), null));
    expect(html).toContain('data-anic-invocation-result');
    expect(html).toContain('⇒');
    expect(html).toContain('最近 5 条流程记录全部成功');
    expect(html).toContain('{&quot;flowLimit&quot;:5}'); // 参数与结果同在（HTML 转义形态）
  });

  it('done 但无 resultPreview（空结果/旧 feed）：不渲染预览节点（不伪造空预览）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([inv({ callId: 'a', status: 'done' })]), null));
    expect(html).not.toContain('data-anic-invocation-result');
  });

  it('error 态不渲染结果预览（error 三元组已有专属行）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'a', status: 'error', resultPreview: '不应出现', error: { name: 'X', code: 'Y' } }),
    ]), null));
    // 渲染条件钉 status === 'done'：即使夹具硬塞 resultPreview，error 态也不渲染
    expect(html).not.toContain('data-anic-invocation-result');
  });

  it('in-flight 态不渲染结果预览（尚未有返回）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'a', status: 'in-flight', resultPreview: '不应出现' }),
    ]), null));
    expect(html).not.toContain('data-anic-invocation-result');
  });

  it('超长 resultPreview 由宿主截断（渲染层不做二次截断——数据面单一职责）', () => {
    const long = 'y'.repeat(200) + '…'; // 宿主 previewOf 截断后的形状（200+省略号）
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'a', status: 'done', resultPreview: long }),
    ]), null));
    expect(html).toContain('data-anic-invocation-result');
    expect(html).toContain('…'); // 截断标记来自宿主提取层
  });
});

describe('renderInvocations —— cycle-60 T-6001 turn 组时间范围', () => {
  /** 构造可分组快照：同 turn 数条、跨 turn 各一条（两个组都有时间范围）。 */
  function groupedSnap(): InvocationsJson {
    // 用真实最近时刻（时:分:秒断言与本地时区一致——夹具与渲染同进程同时区，
    // getHours 端到端自洽，不依赖 UTC 假设）。
    const base = Date.now() - 60_000; // 1 分钟前起
    return snap([
      inv({ callId: 'a', turn: 3, step: 1, startedAt: base, status: 'done', durationMs: 90 }),
      inv({ callId: 'b', turn: 3, step: 2, startedAt: base + 45_000, status: 'done', durationMs: 80 }),
      inv({ callId: 'c', turn: 2, step: 1, startedAt: base - 120_000, status: 'done', durationMs: 70 }),
    ]);
  }

  it('分组 summary 渲染时间范围：首末 startedAt 时刻 + 组内跨度（绝对时序白盒）', () => {
    const html = renderToStaticMarkup(renderInvocations(groupedSnap(), null));
    expect(html).toContain('data-anic-turn-group="t3"');
    // Turn 3 组：首 1 分钟前、末 15 秒前 → 跨度 45s；Turn 2 组：单条跨度 0s。
    expect(html).toContain('跨度 45s');
    expect(html).toContain('跨度 0s');
    // 时:分:秒格式（两位补零）在两组 summary 中各出现（HH:MM:SS 形态）。
    expect(html).toMatch(/data-anic-turn-group="t3"[^]*?\d{2}:\d{2}:\d{2}/);
    expect(html).toMatch(/data-anic-turn-group="t2"[^]*?\d{2}:\d{2}:\d{2}/);
  });

  it('in-flight 条目在组内：时间范围仍用 startedAt 边界（结束时间未落定不参与）', () => {
    const base = Date.now() - 30_000;
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'x', turn: 5, step: 1, startedAt: base, status: 'done', durationMs: 10 }),
      inv({ callId: 'y', turn: 5, step: 2, startedAt: base + 10_000, status: 'in-flight' }),
    ]), null));
    expect(html).toContain('跨度 10s'); // in-flight 的 startedAt 参与边界，endedAt 不存在不参与
  });

  it('组内全部无合法时间戳（旧 feed startedAt 缺省 0/负值）：不渲染时间范围（零伪造）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'a', turn: 1, startedAt: 0, status: 'done' }),
      inv({ callId: 'b', turn: 1, startedAt: -5, status: 'done' }),
    ]), null));
    expect(html).toContain('data-anic-turn-group="t1"');
    expect(html).not.toContain('跨度');
    expect(html).not.toContain('–');
  });

  it('单条组（from===to）：跨度 0s 如实显示（不因单条而隐藏时序）', () => {
    const at = Date.now() - 5_000;
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'solo', turn: 7, startedAt: at, status: 'done', durationMs: 5 }),
    ]), null));
    expect(html).toContain('跨度 0s');
  });

  it('乱序到达（startedAt 非追加序）：时间范围仍取真实首末（min/max 语义不受数组序影响）', () => {
    const base = Date.now() - 90_000;
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'late', turn: 4, startedAt: base + 60_000, status: 'done', durationMs: 1 }),
      inv({ callId: 'early', turn: 4, startedAt: base, status: 'done', durationMs: 1 }),
      inv({ callId: 'mid', turn: 4, startedAt: base + 30_000, status: 'done', durationMs: 1 }),
    ]), null));
    expect(html).toContain('跨度 60s'); // 追加序 slice 会取错边界——min/max 是正确语义
  });
});

describe('renderInvocations —— cycle-63 T-6301/T-6302 组密度与组完成时刻', () => {
  it('组内调用密度渲染：条数/跨度分钟（与时间范围同源 startedAt 边界，互相可验算）', () => {
    const base = Date.now() - 60_000;
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'a', turn: 3, step: 1, startedAt: base, status: 'done', durationMs: 90 }),
      inv({ callId: 'b', turn: 3, step: 2, startedAt: base + 45_000, status: 'done', durationMs: 80 }),
    ]), null));
    // 2 条 / 45s = 45s→0.75 分钟 → 2/0.75 = 2.7 次/分钟
    expect(html).toContain('2.7 次/分钟');
    expect(html).toContain('跨度 45s'); // 同源可验算：两个数字来自同一对边界
  });

  it('单条组（跨度 0s）：密度不渲染（除零不是「无穷密」的诚实陈述）', () => {
    const at = Date.now() - 5_000;
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'solo', turn: 7, startedAt: at, status: 'done', durationMs: 5 }),
    ]), null));
    expect(html).toContain('跨度 0s'); // 时间范围如实（0 跨度是事实）
    expect(html).not.toContain('次/分钟'); // 密度跳过（0 分母不可除）
  });

  it('组完成时刻渲染：组内全部落定 → max endedAt 的 HH:MM:SS（endedAt 产出语义）', () => {
    const base = Date.now() - 60_000;
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'a', turn: 3, step: 1, startedAt: base, endedAt: base + 1_000, status: 'done', durationMs: 1_000 }),
      inv({ callId: 'b', turn: 3, step: 2, startedAt: base + 45_000, endedAt: base + 46_000, status: 'done', durationMs: 1_000 }),
    ]), null));
    expect(html).toContain('完成于');
    expect(html).toMatch(/完成于 \d{2}:\d{2}:\d{2}/); // 完成时刻是 max endedAt（base+46s 的本地时刻）
  });

  it('组内含 in-flight：完成时刻不渲染（组还没完，不伪造完成时刻——时间范围仍渲染）', () => {
    const base = Date.now() - 30_000;
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'x', turn: 5, step: 1, startedAt: base, endedAt: base + 500, status: 'done', durationMs: 500 }),
      inv({ callId: 'y', turn: 5, step: 2, startedAt: base + 10_000, status: 'in-flight' }),
    ]), null));
    expect(html).toContain('跨度 10s'); // 时间范围仍渲染（startedAt 边界不受 in-flight 影响）
    expect(html).not.toContain('完成于'); // 完成时刻跳过（in-flight 未落定）
  });

  it('组内部分条目 endedAt 缺失（旧 feed）：完成时刻不渲染（部分完成无组级完成时刻）', () => {
    const base = Date.now() - 30_000;
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'a', turn: 6, step: 1, startedAt: base, endedAt: base + 500, status: 'done', durationMs: 500 }),
      inv({ callId: 'b', turn: 6, step: 2, startedAt: base + 5_000, status: 'done', durationMs: 100 }), // endedAt 缺失
    ]), null));
    expect(html).toContain('data-anic-turn-group="t6"');
    expect(html).not.toContain('完成于'); // 不拿部分 max 冒充全体落定
  });

  it('组内全部无合法时间戳（旧 feed startedAt 缺省 0/负值）：密度与完成时刻都不渲染（零伪造）', () => {
    const html = renderToStaticMarkup(renderInvocations(snap([
      inv({ callId: 'a', turn: 1, startedAt: 0, endedAt: 100, status: 'done' }),
      inv({ callId: 'b', turn: 1, startedAt: -5, endedAt: 200, status: 'done' }),
    ]), null));
    expect(html).toContain('data-anic-turn-group="t1"');
    expect(html).not.toContain('次/分钟');
    // endedAt 形状在本用例合法（>0），完成时刻可渲染——门槛只看 endedAt 自身
    expect(html).toContain('完成于');
  });
});

describe('renderInvocations —— cycle-64 T-6401 in-flight 已进行时长（时序脉动量化）', () => {
  /** 快照时刻与 startedAt 同源时钟的自洽夹具：genAt = startedAt + elapsed。 */
  function snapAt(invocations: InvocationJson[], genMs: number): InvocationsJson {
    return { invocations, total: invocations.length, generatedAt: new Date(genMs).toISOString() };
  }

  it('in-flight 行渲染已进行时长：elapsed = 快照时刻 − startedAt（宿主同源时钟）', () => {
    const start = Date.now() - 8_000;
    const gen = Date.now(); // 快照时刻 ≈ startedAt + 8s
    const html = renderToStaticMarkup(renderInvocations(snapAt([
      inv({ callId: 'fly', turn: 4, step: 1, startedAt: start, status: 'in-flight' }),
    ], gen), null));
    expect(html).toContain('data-anic-invocation-elapsed');
    expect(html).toMatch(/已进行 [78]s/); // 8s ± 取整边界（Date.now 双取的毫秒差）
  });

  it('脉动语义：同一 in-flight 调用随快照时刻前进（2s 轮询 → 数字自然增长）', () => {
    const start = Date.now() - 5_000;
    const row1 = renderToStaticMarkup(renderInvocations(snapAt([
      inv({ callId: 'fly', turn: 4, startedAt: start, status: 'in-flight' }),
    ], start + 5_000), null));
    const row2 = renderToStaticMarkup(renderInvocations(snapAt([
      inv({ callId: 'fly', turn: 4, startedAt: start, status: 'in-flight' }),
    ], start + 9_400), null));
    expect(row1).toContain('已进行 5s');
    expect(row2).toContain('已进行 9s'); // 9.4s 向下取整 9s
  });

  it('向下取整：0.6s 显示已进行 0s（保守诚实——不进位成 1s）', () => {
    const start = Date.now() - 600;
    const html = renderToStaticMarkup(renderInvocations(snapAt([
      inv({ callId: 'just', turn: 2, startedAt: start, status: 'in-flight' }),
    ], start + 600), null));
    expect(html).toContain('已进行 0s');
  });

  it('done/error 行不渲染已进行时长（durationMs 已有终态时长语义）', () => {
    const base = Date.now() - 10_000;
    const html = renderToStaticMarkup(renderInvocations(snapAt([
      inv({ callId: 'ok', turn: 3, startedAt: base, endedAt: base + 100, status: 'done', durationMs: 100 }),
    ], Date.now()), null));
    expect(html).not.toContain('data-anic-invocation-elapsed');
    expect(html).not.toContain('已进行');
  });

  it('快照时刻早于 startedAt（时钟异常）：不渲染（不显示负数时长——宁可跳过）', () => {
    const start = Date.now();
    const html = renderToStaticMarkup(renderInvocations(snapAt([
      inv({ callId: 'weird', turn: 3, startedAt: start, status: 'in-flight' }),
    ], start - 5_000), null));
    expect(html).not.toContain('data-anic-invocation-elapsed');
    expect(html).not.toContain('已进行');
  });

  it('startedAt 非法（≤0 占位）：不渲染（与 turnTimeRange 门槛同构——零伪造）', () => {
    const html = renderToStaticMarkup(renderInvocations(snapAt([
      inv({ callId: 'legacy', turn: 1, startedAt: 0, status: 'in-flight' }),
    ], Date.now()), null));
    expect(html).not.toContain('data-anic-invocation-elapsed');
  });

  it('generatedAt 不可解析形状（旧宿主）：不渲染（genMs NaN 门槛自然跳过）', () => {
    const legacy = { ...snapAt([
      inv({ callId: 'fly', turn: 1, startedAt: Date.now() - 3_000, status: 'in-flight' }),
    ], Date.now()), generatedAt: 'not-a-date' } as InvocationsJson;
    const html = renderToStaticMarkup(renderInvocations(legacy, null));
    expect(html).not.toContain('data-anic-invocation-elapsed');
    expect(html).not.toContain('已进行');
  });
});
