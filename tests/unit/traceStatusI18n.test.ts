/**
 * 步骤轨迹状态本地化（cycle-90 · 死键归零 P0）的行为测试。
 *
 * ## 被守卫的缺陷（**功能缺口**，不是风格问题）
 *
 * `renderStepTrace.ts` 改造前把裸 token 直接拼进用户面：
 * `${s.kind} · ${s.status}` ⇒ 界面上出现 `micro-step · done`。
 * 四个状态词的中文键（`trace.statusActive` / `statusFailed` / `statusSkipped` /
 * `statusPending`）**早就存在**于 locale，只是没人接线 —— 死键棘轮
 * `i18nDeadKeyContract` 的 RESERVED 表第 78-90 行登记的就是这个缺口。
 *
 * ## 三条不可退让的判据
 *
 * ① **状态词必须本地化**：用户看到「完成/进行中/失败/跳过/待定」，不是裸 token。
 * ② **键名本身绝不能出现在用户面**：`t()` 缺键时回退到键名（见 `src/client/i18n.ts`
 *    的缺键回退链），用户看到 `trace.statusDone` 比看到 `done` **更糟** —— 它既不是
 *    人话，也不是真实状态。必须回落**原始 token**。
 * ③ **兜底必须可测**：宿主与客户端是两条独立发版链，新状态词可能在旧 locale 里
 *    不存在。真 locale 五个状态键都在 ⇒ 用真 `t()` **永远测不出兜底** ⇒ 故
 *    `traceLabels.ts` 把词表查找做成**注入式**，测试用假 lookup 构造"键不存在"这一态。
 *
 * ## 反向自检（判据两态可分，不是恒绿断言）
 *
 * `expect(lookupFallback).toBe(originalToken)` 与
 * `expect(composeStepLabel(..., realT)).toContain('完成')` 必须同时成立 ——
 * 前者证明兜底不是恒真，后者证明接线真的发生了。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { t } from '../../src/client/i18n.ts';
import {
  composeStepLabel,
  kindLocaleKey,
  resolveLabel,
  statusLocaleKey,
  type LabelLookup,
} from '../../src/client/features/stepTrace/traceLabels.ts';
import { renderStepTrace, type StepTraceJson, type TraceStepJson } from '../../src/client/features/stepTrace/renderStepTrace.ts';

/** 假词表：只认给定键，其余一律回退成**键名本身**（复刻真 `t()` 的缺键回退链）。 */
function fakeLookup(dictionary: Record<string, string>): LabelLookup {
  return (key: string) => dictionary[key] ?? key;
}

/** 空词表：所有键都取不到 ⇒ 每一处都必须回落原始 token。 */
const EMPTY: LabelLookup = fakeLookup({});

function step(over: Partial<TraceStepJson>): TraceStepJson {
  return {
    nodeId: 'wf:micro-eval',
    name: '评估',
    kind: 'micro-step',
    status: 'done',
    basis: 'structured',
    sources: ['graph'],
    ledgerVerdict: null,
    cyclesSeen: [],
    producedBy: null,
    warnings: [],
    ...over,
  };
}

function trace(steps: TraceStepJson[]): StepTraceJson {
  return {
    generatedAt: '2026-10-30T00:00:00.000Z',
    steps,
    sourceStatus: { graph: 'ok', nodeState: 'ok', ledger: 'ok', cycleArtifacts: 'ok' },
    warnings: [],
  };
}

describe('traceLabels（纯函数：状态/类型 → 用户面标签）', () => {
  it('① 五个已知状态各映射到**已存在**的词表键（不新增键）', () => {
    // 取值域 = src/shared/stepTrace.ts 的 StepStatus（pending/active/done/failed/skipped）。
    expect(statusLocaleKey('pending')).toBe('trace.statusPending');
    expect(statusLocaleKey('active')).toBe('trace.statusActive');
    expect(statusLocaleKey('done')).toBe('trace.statusDone');
    expect(statusLocaleKey('failed')).toBe('trace.statusFailed');
    expect(statusLocaleKey('skipped')).toBe('trace.statusSkipped');
  });

  it('① 大小写与空白归一（结构化来源可能给出大写 DONE）', () => {
    expect(statusLocaleKey('DONE')).toBe('trace.statusDone');
    expect(statusLocaleKey('  Active  ')).toBe('trace.statusActive');
  });

  it('① 未知状态给通用形态键（不崩、不猜键名），取不到时回落原 token', () => {
    expect(statusLocaleKey('blocked')).toBe('trace.statusBlocked');
    expect(resolveLabel(statusLocaleKey('blocked'), 'blocked', EMPTY)).toBe('blocked');
    // 空状态 = 无可显示 ⇒ 回落空串（不是 undefined、不是 'undefined'）
    expect(resolveLabel(statusLocaleKey(''), '', EMPTY)).toBe('');
  });

  it('② 缺键时回落**原始 token**，绝不回落键名本身', () => {
    // 假 lookup 复刻真 t() 的缺键回退：返回键名
    const key = statusLocaleKey('blocked') as string;
    const label = resolveLabel(key, 'blocked', fakeLookup({}));
    expect(label).toBe('blocked');
    expect(label).not.toBe(key);
    expect(label).not.toContain('trace.status');
  });

  it('② 词表命中时用译文（不是 token）', () => {
    const lookup = fakeLookup({ 'trace.statusDone': '完成', 'trace.statusActive': '进行中' });
    expect(resolveLabel('trace.statusDone', 'done', lookup)).toBe('完成');
    expect(resolveLabel('trace.statusActive', 'active', lookup)).toBe('进行中');
  });

  it('② kind 复用 graph.lane.* 键族（既有键族，无需 Lead 新增）', () => {
    expect(kindLocaleKey('micro-step')).toBe('graph.lane.micro-step');
    expect(kindLocaleKey('phase')).toBe('graph.lane.phase');
    expect(kindLocaleKey('gate')).toBe('graph.lane.gate');
    expect(kindLocaleKey('human-gate')).toBe('graph.lane.human-gate');
    expect(kindLocaleKey('cycle')).toBe('graph.lane.cycle');
    expect(kindLocaleKey('gate-event')).toBe('graph.lane.gate-event');
    expect(kindLocaleKey('incident')).toBe('graph.lane.incident');
    expect(kindLocaleKey('autonomy')).toBe('graph.lane.autonomy');
  });

  it('② kind 未知（用户自写 yaml 的 type）⇒ 回落原始 kind', () => {
    expect(resolveLabel(kindLocaleKey('play'), 'play', EMPTY)).toBe('play');
  });

  it('③ 两段拼接：类型 · 状态（分隔符与改造前一致）', () => {
    const lookup = fakeLookup({
      'graph.lane.micro-step': '微步骤',
      'trace.statusDone': '完成',
    });
    expect(composeStepLabel('micro-step', 'done', lookup)).toBe('微步骤 · 完成');
  });

  it('③ 空段被丢掉而不是留悬空分隔符（畸形数据的诚实形态）', () => {
    const lookup = fakeLookup({ 'graph.lane.micro-step': '微步骤', 'trace.statusDone': '完成' });
    expect(composeStepLabel('', 'done', lookup)).toBe('完成');
    expect(composeStepLabel('micro-step', '', lookup)).toBe('微步骤');
    expect(composeStepLabel('', '', lookup)).toBe('');
  });

  it('③ 纯函数性：同输入同输出（零 DOM / 零时钟 / 零随机）', () => {
    const lookup = fakeLookup({ 'graph.lane.phase': '阶段', 'trace.statusFailed': '失败' });
    const a = composeStepLabel('phase', 'failed', lookup);
    const b = composeStepLabel('phase', 'failed', lookup);
    expect(a).toBe(b);
    expect(a).toBe('阶段 · 失败');
  });
});

describe('renderStepTrace（用户面不再出现裸 token）', () => {
  it('① 状态词本地化：界面出现中文状态词，不出现裸英文 token', () => {
    const html = renderToStaticMarkup(renderStepTrace(trace([
      step({ nodeId: 'a', kind: 'phase', status: 'done' }),
      step({ nodeId: 'b', kind: 'micro-step', status: 'active' }),
      step({ nodeId: 'c', kind: 'gate', status: 'failed' }),
      step({ nodeId: 'd', kind: 'gate', status: 'skipped' }),
      step({ nodeId: 'e', kind: 'phase', status: 'pending' }),
    ])));
    // 五种状态的中文词都在
    expect(html).toContain('完成');
    expect(html).toContain('进行中');
    expect(html).toContain('失败');
    expect(html).toContain('跳过');
    expect(html).toContain('待定');
    // 裸 token 不再出现在用户面（改造前是 `micro-step · done`）
    expect(html).not.toContain('· done');
    expect(html).not.toContain('· active');
    expect(html).not.toContain('· failed');
    expect(html).not.toContain('· skipped');
    expect(html).not.toContain('· pending');
  });

  it('② 键名本身绝不出现在用户面（比英文 token 更糟）', () => {
    const html = renderToStaticMarkup(renderStepTrace(trace([step({})])));
    expect(html).not.toContain('trace.status');
    expect(html).not.toContain('trace.statusDone');
    expect(html).not.toContain('graph.lane');
  });

  it('② 未知状态：回落原始 token（宿主新发的状态词在旧 locale 里不存在）', () => {
    const html = renderToStaticMarkup(renderStepTrace(trace([
      step({ nodeId: 'x', kind: 'phase', status: 'blocked' }),
    ])));
    expect(html).toContain('blocked');
    expect(html).not.toContain('trace.statusBlocked');
  });

  it('② 未知 kind：回落原始 kind（用户自写 workflow-graph.yaml 的 type）', () => {
    const html = renderToStaticMarkup(renderStepTrace(trace([
      step({ nodeId: 'x', kind: 'play', status: 'done' }),
    ])));
    expect(html).toContain('play');
    expect(html).not.toContain('graph.lane.play');
  });

  it('③ 真词表下四类既有状态键确实被用上（接线真发生，不是恒绿）', () => {
    // 直接对真 t() 断言：trace.statusDone 存在且译成「完成」；
    // 若接线被回退成裸 token，这里会红。
    expect(t('trace.statusDone')).toBe('完成');
    expect(t('trace.statusActive')).toBe('进行中');
    expect(t('trace.statusFailed')).toBe('失败');
    expect(t('trace.statusSkipped')).toBe('跳过');
    expect(t('trace.statusPending')).toBe('待定');
  });

  it('③ 渲染不崩且行锚点仍在（data-anic-step 契约不变）', () => {
    const html = renderToStaticMarkup(renderStepTrace(trace([
      step({ nodeId: 'wf:micro-eval' }),
    ])));
    expect(html).toContain('data-anic-steptrace="section"');
    expect(html).toContain('data-anic-step="wf:micro-eval"');
  });
});
