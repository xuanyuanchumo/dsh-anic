/**
 * cycle-71 T-7131（用户要求核心）：「最近一次已完成调用全貌卡」的落地测试。
 *
 * 用户原话要求面板默认只展开**最近一次已完成调用**与运行时调用可视化，
 * 并把调用自身的**数据、流程流向、运行状态、运行产物**白盒透明化量化。
 * 本卡是「最近完成的那一次调用全貌」的单点落点（此前它散落在某个 turn 组）。
 *
 * 四条命题（缺一条这张卡就会静默错）：
 *   ① 三态：无已完成调用 → 不渲染；有 → 全字段；error → 三元组；
 *   ② 排序同源：与最完成 turn 判定同源（跳过 in-flight、endedAt ?? startedAt
 *      取 max、startedAt > 0 门槛）——in-flight **不得**被当成「已完成」；
 *   ③ 诚实边界：无数据源的「归属/证据」两段**不渲染**（宁缺勿猜，不伪造）；
 *   ④ INV-27：门禁裁决段的启发式标注必须在场（工具名 → gate 是推断，
 *      不是结构化事实）。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderLastCompletedCard } from '../../src/client/features/live/renderLastCompletedCard.ts';
import { renderLiveSection, lastCompletedOf } from '../../src/client/features/live/renderLiveSection.ts';
import { renderInvocations } from '../../src/client/features/live/renderInvocations.ts';
import { mostRecentCompleted, mostRecentCompletedKey } from '../../src/client/features/live/invocationGrouping.ts';
import type { InvocationJson, InvocationsJson } from '../../src/client/features/live/renderInvocationsTypes.ts';
import type { LedgerListJson } from '../../src/client/features/ledger/renderLedger.ts';

function inv(over: Partial<InvocationJson>): InvocationJson {
  return { callId: 'c1', name: 'anic_evaluate', argumentsPreview: '{}', startedAt: 1, status: 'done', ...over };
}

function snap(invocations: InvocationJson[]): InvocationsJson {
  return { invocations, total: invocations.length, generatedAt: '2026-10-22T00:00:00.000Z' };
}

function ledger(entries: Array<{ gate: string; result: 'PASS' | 'FAIL' }>): LedgerListJson {
  return {
    total: entries.length,
    entries: entries.map((e, i) => ({
      gate: e.gate, gateName: `门${e.gate}`, result: e.result, detail: '',
      timestamp: `2026-10-22T00:00:0${String(i)}Z`, previousHash: null, hash: `h${String(i)}`,
    })),
  };
}

describe('mostRecentCompleted —— 最近一次已完成调用本体', () => {
  it('跳过 in-flight，取 endedAt ?? startedAt 的最大者（与 key 版同源排序）', () => {
    const done = inv({ callId: 'done', turn: 3, status: 'done', startedAt: 100, endedAt: 300 });
    const flight = inv({ callId: 'flight', turn: 4, status: 'in-flight', startedAt: 900 });
    expect(mostRecentCompleted([flight, done])?.callId).toBe('done');
    // 同源：key 版在对称输入下给出同一分组的键
    expect(mostRecentCompletedKey([flight, done])).toBe(3);
  });

  it('endedAt 缺失时回落到 startedAt 参与比较（与 key 版同一行代码）', () => {
    const a = inv({ callId: 'a', startedAt: 100, endedAt: 150, status: 'done' });
    const b = inv({ callId: 'b', startedAt: 400, status: 'error' }); // 无 endedAt
    expect(mostRecentCompleted([a, b])?.callId).toBe('b');
  });

  it('in-flight 独占（无任何已完成）→ null（不把运行中当成已完成）', () => {
    expect(mostRecentCompleted([inv({ status: 'in-flight', startedAt: 500 })])).toBeNull();
    expect(lastCompletedOf(snap([inv({ status: 'in-flight', startedAt: 500 })]))).toBeNull();
  });

  it('空列表 / data 为 null → null（不伪造「最近完成」）', () => {
    expect(mostRecentCompleted([])).toBeNull();
    expect(lastCompletedOf(null)).toBeNull();
  });

  it('startedAt 非法（0/负/非有限）→ 跳过（旧 feed 占位不产生伪造记录）', () => {
    const legacy = inv({ callId: 'legacy', startedAt: 0, status: 'done' });
    const real = inv({ callId: 'real', startedAt: 50, status: 'done' });
    expect(mostRecentCompleted([legacy, real])?.callId).toBe('real');
    expect(mostRecentCompleted([legacy])).toBeNull();
    expect(mostRecentCompleted([inv({ callId: 'nan', startedAt: Number.NaN, status: 'done' })])).toBeNull();
  });

  it('error 态也算已完成（落定语义与 done 同权）', () => {
    expect(mostRecentCompleted([inv({ callId: 'e', status: 'error', startedAt: 10 })])?.callId).toBe('e');
  });
});

describe('renderLastCompletedCard —— 全貌卡七段', () => {
  const full: InvocationJson = {
    callId: 'abcdef1234567890', name: 'anic_flows_gate_check', argumentsPreview: '{"gate":"G2"}',
    startedAt: new Date(2026, 9, 22, 10, 30, 0).getTime(),
    endedAt: new Date(2026, 9, 22, 10, 30, 2).getTime(),
    durationMs: 2345, status: 'done', resultPreview: 'all-pass', turn: 3, step: 1,
  };

  it('全字段：身份(callId 前 8 + turn/step) / 时序(startedAt→endedAt + durationMs) / 参数 / 产出', () => {
    const html = renderToStaticMarkup(renderLastCompletedCard(full));
    expect(html).toContain('data-anic-last-completed="abcdef1234567890"');
    expect(html).toContain('data-anic-last-completed-status="done"');
    // ① 身份：name + callId 前 8 + t3/s1
    expect(html).toContain('anic_flows_gate_check · abcdef12 · t3/s1');
    // ② 时序：本地 HH:MM:SS → HH:MM:SS · 2345ms
    expect(html).toContain('10:30:00 → 10:30:02 · 2345ms');
    // ③ 参数（字面值，HTML 转义形态）
    expect(html).toContain('{&quot;gate&quot;:&quot;G2&quot;}');
    // ④ 产出
    expect(html).toContain('data-anic-last-completed-result');
    expect(html).toContain('all-pass');
  });

  it('a11y：role=region + aria-label 命名地标；且**不进 live region**（APG：自动更新内容禁用）', () => {
    const html = renderToStaticMarkup(renderLastCompletedCard(full));
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="最近一次已完成调用：anic_flows_gate_check"');
    // 2s 轮询会重渲本卡 → 绝不能是 aria-live（否则屏幕阅读器被淹没）
    expect(html).not.toContain('aria-live');
  });

  it('④ error 态：name(code): reason 三元组走「失败」段，不渲染产出段', () => {
    const html = renderToStaticMarkup(renderLastCompletedCard(inv({
      callId: 'err', name: 'anic_gate_check', status: 'error', startedAt: 10, endedAt: 20,
      error: { name: 'GateError', code: 'G1', reason: '缺任务清单' },
      resultPreview: '不应出现——错误态无产出',
    })));
    expect(html).toContain('data-anic-last-completed-error');
    expect(html).toContain('GateError(G1): 缺任务清单');
    expect(html).not.toContain('data-anic-last-completed-result');
  });

  it('超长参数/结果：视觉截断到 240 + title 给全文（不丢字面值）', () => {
    const long = 'x'.repeat(500);
    const html = renderToStaticMarkup(renderLastCompletedCard(inv({ argumentsPreview: long })));
    // 全文在 title（悬停可见完整入参，字面值不被 aria-label 覆盖）
    expect(html).toContain(`title="${long}"`);
    // 可见文本节点恰好是前 240 + 省略号（截断发生在展示层，不是数据层）
    expect(html).toContain(`${'x'.repeat(240)}…</span>`);
    // 可见部分不得是完整长度（title 里的全文不算可见）
    expect(html).not.toContain(`${'x'.repeat(241)}…</span>`);
  });

  it('⑤ 归属（cycle-71 T-10501）：有 join key 时渲染精确流程坐标（cycle · phase）', () => {
    const html = renderToStaticMarkup(renderLastCompletedCard(inv({ callId: 'a', status: 'done', cycle: 'cycle-71', phase: 'build' })));
    expect(html).toContain('data-anic-last-completed-belonging');
    expect(html).toContain('cycle-71');
    expect(html).toContain('build');
    // 精确字段**不带** heuristic 标注（对比 ⑦ 门禁裁决的推断值）
    expect(html).toContain('data-anic-last-completed-belonging');
  });

  it('⑤ 归属：只有 cycle 或只有 phase 时渲染可得部分（缺一不丢另一）', () => {
    const onlyCycle = renderToStaticMarkup(renderLastCompletedCard(inv({ callId: 'c', status: 'done', cycle: 'cycle-71' })));
    expect(onlyCycle).toContain('cycle-71');
    const onlyPhase = renderToStaticMarkup(renderLastCompletedCard(inv({ callId: 'p', status: 'done', phase: 'build' })));
    expect(onlyPhase).toContain('build');
  });

  it('⑤ 归属：两条都缺（多会话歧义/文件缺失）→ 整段不渲染（不渲染空壳，INV-27）', () => {
    const html = renderToStaticMarkup(renderLastCompletedCard(inv({ callId: 'n', status: 'done' })));
    expect(html).not.toContain('data-anic-last-completed-belonging');
  });

  it('⑤ 归属：空串等同缺失（旧宿主/降级路径不产生空壳段）', () => {
    const html = renderToStaticMarkup(renderLastCompletedCard(inv({ callId: 'e', status: 'done', cycle: '', phase: '' })));
    expect(html).not.toContain('data-anic-last-completed-belonging');
  });

  it('诚实边界：⑥「证据」段仍**不渲染**（无绑定到单次调用的工件路径字段，不伪造）', () => {
    const html = renderToStaticMarkup(renderLastCompletedCard(full));
    expect(html).not.toContain('data-anic-last-completed-evidence');
  });

  it('时序缺失（旧 feed 无合法时刻与时长）→ 该段整行不渲染，不渲染空壳', () => {
    const html = renderToStaticMarkup(renderLastCompletedCard(inv({ callId: 'legacy', startedAt: 0, endedAt: 0 })));
    expect(html).not.toContain('data-anic-last-completed-timing');
  });

  it('段标记契约：identity/args/result 三段各一锚点（真机旅程可定位）', () => {
    const html = renderToStaticMarkup(renderLastCompletedCard(full));
    expect(html).toContain('data-anic-last-completed-identity');
    expect(html).toContain('data-anic-last-completed-args');
    expect(html).toContain('data-anic-last-completed-title');
  });
});

describe('renderLiveSection —— 分区编排（卡片在列表之前，兄弟关系非嵌套）', () => {
  it('有已完成调用 → 卡片渲染在调用流之前（同一调用不重复展开）', () => {
    const html = renderToStaticMarkup(renderLiveSection(
      snap([inv({ callId: 'lone', name: 'anic_status', status: 'done', startedAt: 10, endedAt: 20 })]),
      null, true, '',
    ));
    expect(html).toContain('data-anic-live-wrap');
    expect(html).toContain('data-anic-last-completed="lone"');
    expect(html).toContain('data-anic-invocations="section"');
    // 卡片树在列表之前
    expect(html.indexOf('data-anic-last-completed=')).toBeLessThan(html.indexOf('data-anic-invocations="section"'));
  });

  it('无已完成调用（只有 in-flight 或空流 / null 态）→ 不渲染卡片，调用流照常', () => {
    const onlyFlight = renderToStaticMarkup(renderLiveSection(
      snap([inv({ callId: 'f', status: 'in-flight', startedAt: 50 })]), null, true, ''));
    expect(onlyFlight).not.toContain('data-anic-last-completed');
    expect(onlyFlight).toContain('data-anic-invocations="section"');
    const nullData = renderToStaticMarkup(renderLiveSection(null, null, true, ''));
    expect(nullData).not.toContain('data-anic-last-completed');
    expect(nullData).toContain('data-anic-invocations-pending');
  });

  it('账本切片直通⑦段：门禁类调用 + 账本条目 → 卡片带裁决与启发标注', () => {
    const html = renderToStaticMarkup(renderLiveSection(
      snap([inv({ callId: 'g', name: 'anic_gate_check', status: 'done', startedAt: 10, endedAt: 20 })]),
      null, true, '', ledger([{ gate: 'G0', result: 'PASS' }]),
    ));
    expect(html).toContain('data-anic-last-completed-gate');
    expect(html).toContain('data-anic-last-completed-gate-heuristic="true"');
  });
});

describe('renderInvocations —— cycle-71 T-7131 量化补全（P95 / 错误码 top3）', () => {
  it('P95 进概览行（终态样本充足时）；错误码 top3 按次数降序呈现', () => {
    const html = renderToStaticMarkup(renderInvocations({
      invocations: [
        inv({ callId: 'd1', status: 'done', durationMs: 10, startedAt: 1 }),
        inv({ callId: 'd2', status: 'done', durationMs: 20, startedAt: 2 }),
        inv({ callId: 'd3', status: 'done', durationMs: 30, startedAt: 3 }),
        inv({ callId: 'e1', status: 'error', durationMs: 5, startedAt: 4, error: { name: 'E', code: 'G1' } }),
        inv({ callId: 'e2', status: 'error', durationMs: 5, startedAt: 5, error: { name: 'E', code: 'G1' } }),
        inv({ callId: 'e3', status: 'error', durationMs: 5, startedAt: 6, error: { name: 'E', code: 'G2' } }),
      ],
      total: 6, generatedAt: '2026-10-22T00:00:00.000Z',
    }, null));
    expect(html).toContain('P95 30ms');
    expect(html).toContain('错误码');
    expect(html).toContain('G1×2');
    expect(html).toContain('G2×1');
    // 只取 top3：第 4 个码不出现（此处只有两个码，断言顺序即可）
    expect(html.indexOf('G1×2')).toBeLessThan(html.indexOf('G2×1'));
  });

  it('无终态时长样本 → 不渲染 P95 段（不伪造 0ms）；无错误 → 不渲染错误码段', () => {
    const html = renderToStaticMarkup(renderInvocations({
      invocations: [inv({ callId: 'f', status: 'in-flight', startedAt: 9 })],
      total: 1, generatedAt: '2026-10-22T00:00:00.000Z',
    }, null));
    expect(html).not.toContain('P95');
    expect(html).not.toContain('错误码');
  });

  it('null 数据态不渲染量化段（没有数据就没有量化）', () => {
    const html = renderToStaticMarkup(renderInvocations(null, null));
    expect(html).not.toContain('P95');
    expect(html).not.toContain('错误码');
  });
});

describe('renderLastCompletedCard —— ⑦ 门禁裁决段（含 INV-27 启发标注）', () => {
  it('门禁类工具 + 账本有匹配条目 → 渲染裁决值，且**必须**带 heuristic 标注', () => {
    const html = renderToStaticMarkup(renderLastCompletedCard(
      inv({ callId: 'g', name: 'anic_gate_check', status: 'done', startedAt: 10, endedAt: 20 }),
      ledger([{ gate: 'G2', result: 'PASS' }, { gate: 'G1', result: 'FAIL' }]),
    ));
    expect(html).toContain('data-anic-last-completed-gate');
    // 取最近一条匹配（G1 在数组末尾 = 最新）
    expect(html).toContain('data-anic-last-completed-gate-value="G1"');
    expect(html).toContain('G1 FAIL');
    // INV-27：工具名 → gate 是推断，标注必须在场
    expect(html).toContain('data-anic-last-completed-gate-heuristic="true"');
    expect(html).toContain('heuristic');
  });

  it('anic_flows_gate_check 走 G0-G3；anic_multi_agent_gate 走 release 类门（映射表按工具语义分域）', () => {
    const flowGate = renderToStaticMarkup(renderLastCompletedCard(
      inv({ callId: 'x', name: 'anic_flows_gate_check', status: 'done', startedAt: 10, endedAt: 20 }),
      ledger([{ gate: 'G3', result: 'PASS' }]),
    ));
    expect(flowGate).toContain('data-anic-last-completed-gate');
    expect(flowGate).toContain('G3 PASS');
    const mag = renderToStaticMarkup(renderLastCompletedCard(
      inv({ callId: 'x', name: 'anic_multi_agent_gate', status: 'done', startedAt: 10, endedAt: 20 }),
      ledger([{ gate: 'release', result: 'PASS' }]),
    ));
    expect(mag).toContain('data-anic-last-completed-gate');
    expect(mag).toContain('release PASS');
    // 跨域不误配：G3 是 flows 门，不是 multi-agent 评估门
    const mismatch = renderToStaticMarkup(renderLastCompletedCard(
      inv({ callId: 'x', name: 'anic_multi_agent_gate', status: 'done', startedAt: 10, endedAt: 20 }),
      ledger([{ gate: 'G3', result: 'PASS' }]),
    ));
    expect(mismatch).not.toContain('data-anic-last-completed-gate');
  });

  it('非门禁工具（anic_evaluate）→ 整段不渲染（不给无关调用贴裁决）', () => {
    const html = renderToStaticMarkup(renderLastCompletedCard(
      inv({ name: 'anic_evaluate', status: 'done', startedAt: 10, endedAt: 20 }),
      ledger([{ gate: 'G1', result: 'PASS' }]),
    ));
    expect(html).not.toContain('data-anic-last-completed-gate');
  });

  it('账本缺失 / 无匹配 gate → 整段不渲染（不伪造裁决）', () => {
    const noLedger = renderToStaticMarkup(renderLastCompletedCard(
      inv({ name: 'anic_gate_check', status: 'done', startedAt: 10, endedAt: 20 })));
    expect(noLedger).not.toContain('data-anic-last-completed-gate');
    const noMatch = renderToStaticMarkup(renderLastCompletedCard(
      inv({ name: 'anic_gate_check', status: 'done', startedAt: 10, endedAt: 20 }),
      ledger([{ gate: 'G7', result: 'PASS' }]),
    ));
    expect(noMatch).not.toContain('data-anic-last-completed-gate');
  });
});
