/**
 * 自举分区契约（cycle-89）——「自举结论还作不作数」的呈现面。
 *
 * ## 为什么这块必须有契约（缺陷史）
 *
 * `.cycles/self-bootstrap.json` 停在 2026-10-28 的 `EXHAUSTED`（evalScore 0 /
 * gate FAIL），而同仓 2026-10-30 的 cycle-88 评估与门禁**全 PASS**。两天里
 * 任何人问「自举收敛了吗」，正确回答都是「上次的结论已经不作数了」，但：
 *   - 面板不显示自举状态 → 根本没人问；
 *   - `anic_bootstrap` 工具见到 EXHAUSTED 直接耗尽 → 表面上"跑完了"。
 *
 * 本契约把三件事钉成可断言事实：① 状态/轮次/裁决可读；② 陈旧必须显式现身并
 * 点名变动项；③ 只有可重启形态才出现重启按钮（进行中点重启 = 打断评估）。
 *
 * 全部断言走 `data-anic-bootstrap-*` 锚点与纯函数，不依赖 i18n 文案字面量
 * （文案会随语言变，锚点不会）。
 */
import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  isBootstrap, staleOf, canRestart, type BootstrapJson,
} from '../../src/client/features/bootstrap/bootstrapTypes.ts';
import { renderBootstrap } from '../../src/client/features/bootstrap/renderBootstrap.ts';

/** 一个「陈旧 EXHAUSTED」的典型样本（复刻真实事故形态）。 */
const STALE_EXHAUSTED: BootstrapJson = {
  status: 'EXHAUSTED',
  round: 3,
  maxRounds: 3,
  lastEvalScore: 0,
  lastGateVerdict: 'FAIL',
  facts: {
    gitHead: '0102d86a1b2c3d4e5f60718293a4b5c6d7e8f901',
    gitDirty: false,
    currentCycle: 'cycle-89',
    currentPhase: 'plan',
    ledgerHead: '8b429042906d195e',
    ledgerEntries: 210,
    evalReport: { path: 'cycles/cycle-88/项目评估报告.md', sha256: 'abcdef0123456789' },
    activeCycles: 2,
    archivedCycles: 87,
    skillVersion: '2.6.1',
  },
  factsAt: '2026-10-28T05:30:15.591Z',
  stale: { stale: true, changed: ['gitHead', 'currentCycle'] },
  restartCount: 0,
  history: [
    { round: 1, evalScore: 0, gateVerdict: 'FAIL', timestamp: '2026-10-28T05:18:36.550Z' },
    { round: 2, evalScore: 0, gateVerdict: 'FAIL', timestamp: '2026-10-28T05:24:34.485Z' },
    { round: 3, evalScore: 0, gateVerdict: 'FAIL', timestamp: '2026-10-28T05:30:15.591Z' },
  ],
  lastFailure: { reasons: ['[FAIL] G1: No task entries found', '[FAIL] G2: No test reports', '3 dimension(s) failed: E3, E8, Q2'] },
};

/** 渲染成 HTML 串（server 渲染不需要 DOM，纯函数路径可直接断言）。 */
function html(v: BootstrapJson, handlers?: Parameters<typeof renderBootstrap>[1]): string {
  const el = renderBootstrap(v, handlers);
  expect(isValidElement(el)).toBe(true);
  return renderToStaticMarkup(el);
}

describe('自举分区契约（cycle-89）', () => {
  it('① 守卫：只要求 status 是字符串（新字段不因缺失被判畸形）', () => {
    expect(isBootstrap({ status: 'IDLE' })).toBe(true);
    expect(isBootstrap({ status: 'EXHAUSTED', facts: null })).toBe(true);
    expect(isBootstrap({})).toBe(false);
    expect(isBootstrap(null)).toBe(false);
    expect(isBootstrap([])).toBe(false);
    expect(isBootstrap({ status: 42 })).toBe(false);
  });

  it('② stale 两形态归一：boolean 与 {stale,changed} 都收', () => {
    expect(staleOf({ status: 'IDLE', stale: true })).toEqual({ stale: true, changed: [] });
    expect(staleOf({ status: 'IDLE', stale: { changed: ['a', 'b'] } })).toEqual({ stale: false, changed: ['a', 'b'] });
    expect(staleOf({ status: 'IDLE', stale: { stale: true, changed: ['gitHead'] } }))
      .toEqual({ stale: true, changed: ['gitHead'] });
    // 兜底通道：staleReasons 直接给（旧宿主形态）
    expect(staleOf({ status: 'IDLE', staleReasons: ['currentCycle'] }).changed).toEqual(['currentCycle']);
    expect(staleOf({ status: 'IDLE' })).toEqual({ stale: false, changed: [] });
  });

  it('③ 可重启判据：进行态一律不可；终态 + 陈旧/耗尽可', () => {
    expect(canRestart({ status: 'EVALUATING' })).toBe(false);
    expect(canRestart({ status: 'GATE_CHECKING' })).toBe(false);
    expect(canRestart({ status: 'FIXING' })).toBe(false);
    expect(canRestart({ status: 'VERIFYING' })).toBe(false);
    expect(canRestart({ status: 'IDLE' })).toBe(true);
    expect(canRestart({ status: 'EXHAUSTED', round: 3, maxRounds: 3 })).toBe(true);
    // 陈旧即使还有余量也可重启（结论过期与预算耗尽是两条独立通道）
    expect(canRestart({ status: 'CONVERGED', stale: true })).toBe(true);
    // 有预算、不陈旧、已收敛 → 不必重启
    expect(canRestart({ status: 'CONVERGED', round: 1, maxRounds: 3 })).toBe(false);
  });

  it('④ 状态/轮次/裁决/重启次数都出现在锚点上', () => {
    const out = html({ ...STALE_EXHAUSTED, restartCount: 2 });
    expect(out).toContain('data-anic-bootstrap="EXHAUSTED"');
    expect(out).toContain('data-anic-bootstrap-status="EXHAUSTED"');
    expect(out).toContain('data-anic-bootstrap-restarts="2"');
    // 轮次 3/3 与门禁 FAIL 必须在同一行可见（数字进文案，但不断言语言字面量）
    expect(out).toContain('3/3');
    expect(out).toContain('FAIL');
  });

  it('⑤ 陈旧必须显式现身 + 点名变动项 + 存档时间', () => {
    const out = html(STALE_EXHAUSTED);
    expect(out).toContain('data-anic-bootstrap-stale="true"');
    expect(out).toContain('gitHead');
    expect(out).toContain('currentCycle');
    // 存档时间（短形态）——这是「结论比事实旧」的可核对证据
    expect(out).toContain('2026-10-28 05:30');
  });

  it('⑥ 无 stale 时不渲染陈旧横幅（不制造假告警）', () => {
    const out = html({ status: 'CONVERGED', round: 1, maxRounds: 3, lastEvalScore: 100, lastGateVerdict: 'PASS', stale: false });
    expect(out).not.toContain('data-anic-bootstrap-stale');
  });

  it('⑦ 重启按钮只在「可重启 + 传了 handler」时出现；进行态不出现', () => {
    const withHandler = { onRestart: (): void => { /* noop */ } };
    expect(html(STALE_EXHAUSTED, withHandler)).toContain('data-anic-bootstrap-restart="true"');
    // 没传 handler（未接线的装配）→ 不出现「点了没反应」的按钮
    expect(html(STALE_EXHAUSTED)).not.toContain('data-anic-bootstrap-restart');
    // 进行态（陈旧也不给重启入口——正在跑的评估不能被面板打断）
    expect(html({ status: 'EVALUATING', stale: true }, withHandler)).not.toContain('data-anic-bootstrap-restart');
    // busy 时按钮禁用但仍在（用户能看到"正在重启"）
    expect(html(STALE_EXHAUSTED, { onRestart: withHandler.onRestart, restartBusy: true }))
      .toContain('disabled');
  });

  it('⑧ 事实基线逐项出锚点：活跃/归档**分列**（一个数会把历史读成活性产物）', () => {
    const out = html(STALE_EXHAUSTED);
    for (const key of ['git', 'cycle', 'ledger', 'eval', 'cycles', 'skill']) {
      expect(out, `缺少事实锚点 ${key}`).toContain(`data-anic-bootstrap-fact="${key}"`);
    }
    expect(out).toContain('0102d86');
    expect(out).toContain('cycle-89');
    expect(out).toContain('210');
    expect(out).toContain('2');   // activeCycles
    expect(out).toContain('87');  // archivedCycles
    expect(out).toContain('2.6.1');
  });

  it('⑨ 无 facts（旧版本）→ 如实说明，不伪造一行空值', () => {
    const out = html({ status: 'IDLE' });
    expect(out).toContain('data-anic-bootstrap-nofacts="true"');
    expect(out).not.toContain('data-anic-bootstrap-facts');
  });

  it('⑩ 轮次历史条形：每条一个锚点，超出 8 条截断', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ round: i + 1, evalScore: i * 8, gateVerdict: i % 2 === 0 ? 'FAIL' : 'PASS' }));
    const out = html({ status: 'EXHAUSTED', history: many });
    const bars = out.match(/data-anic-bootstrap-bar=/g) ?? [];
    expect(bars).toHaveLength(8);
    expect(out).toContain('data-anic-bootstrap-history="8"');
  });

  it('⑪ 最近失败原因最多 4 条 + 余量如实计数', () => {
    const out = html(STALE_EXHAUSTED);
    expect(out).toContain('data-anic-bootstrap-failure="3"');
    const out5 = html({ status: 'EXHAUSTED', lastFailure: { reasons: ['a', 'b', 'c', 'd', 'e', 'f'] } });
    expect(out5).toContain('data-anic-bootstrap-failure="6"');
    // 6 条只渲染 4 条 + 一句「另有 2 条」
    expect((out5.match(/<li/g) ?? [])).toHaveLength(4);
  });

  it('⑫ 窄屏可读：事实行使用 flex-wrap（不出现表格布局）', () => {
    const out = html(STALE_EXHAUSTED);
    expect(out).toContain('flex-wrap:wrap');
    expect(out).not.toContain('<table');
  });
});
