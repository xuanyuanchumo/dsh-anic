/**
 * 相位漂移读数条的**真渲染**测试（cycle-96 WS-A）。
 *
 * 与 `renderFlows.test.ts` 同纪律（renderToStaticMarkup）：「返回 ReactElement」
 * 与「渲染出正确标记」是两个命题，只有后者能证明用户真的看得见。
 *
 * ## 被守卫缺陷
 *
 * 技能侧 `cmdStatus` 曾用 `inferPhase` 静默改写磁盘；宿主侧只报 stored。
 * ⇒ 同一概念两个口径，界面上却只看得到一个。本文件钉死：**三值都必须上屏**，
 * 且四态（consistent / drift / ceiling / unknown）各有独立呈现，不得合并。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMacroPhaseDrift } from '../../src/client/features/flows/renderMacroPhaseDrift.ts';
import { driftVerdictOf } from '../../src/client/features/flows/macroPhaseTypes.ts';

describe('renderMacroPhaseDrift（三值上屏）', () => {
  it('**切片缺失（旧宿主）→ 不渲染该行**（但也不是整区崩溃）', () => {
    expect(renderMacroPhaseDrift(null)).toBe(null);
    expect(renderMacroPhaseDrift(undefined)).toBe(null);
  });

  it('一致：stored 与 inferred 两值并列印出（证明推断跑过）', () => {
    const html = renderToStaticMarkup(renderMacroPhaseDrift({
      currentPhase: 'test', inferredPhase: 'test', drift: false,
    }));
    expect(html).toContain('data-anic-macro-phase-drift="consistent"');
    expect(html).toContain('data-anic-macro-stored="test"');
    expect(html).toContain('data-anic-macro-inferred="test"');
    expect(html).toContain('stored test / inferred test');
  });

  it('**分叉：两值同时可见 + drift 标识 + 可操作出路**', () => {
    const html = renderToStaticMarkup(renderMacroPhaseDrift({
      currentPhase: 'plan', inferredPhase: 'test', drift: true,
    }));
    expect(html).toContain('data-anic-macro-phase-drift="drift"');
    // 两个值一个都不能少 —— 「谁说了算」是可读事实的前置条件
    expect(html).toContain('data-anic-macro-stored="plan"');
    expect(html).toContain('data-anic-macro-inferred="test"');
    // 出路：查询不写盘 ⇒ 要以前者为准必须显式推进。
    // 断言锚点而不是文案：文案由 locale 提供（本轮新键由 Lead 统一合并），
    // 期间 t() 回退成键名 —— 锚点带目标相名才是语言无关的判据。
    expect(html).toContain('data-anic-macro-drift-hint="test"');
  });

  it('**推断到顶：标 ceiling 而非 drift**（deploy/maintain 推不出来，状态没错）', () => {
    const html = renderToStaticMarkup(renderMacroPhaseDrift({
      currentPhase: 'deploy', inferredPhase: 'test', drift: true, inferenceCeiling: 'test',
    }));
    expect(html).toContain('data-anic-macro-phase-drift="ceiling"');
    // 必须点名上限，否则读者会把「推不出来」当成「没推」
    expect(html).toContain('data-anic-macro-ceiling-hint="test"');
  });

  it('**未采集：标 unknown 而非 consistent**（没读到 ≠ 没问题）', () => {
    const html = renderToStaticMarkup(renderMacroPhaseDrift({ currentPhase: 'plan' }));
    expect(html).toContain('data-anic-macro-phase-drift="unknown"');
    // 缺字段时 inferred 显示占位符，不显示 undefined
    expect(html).not.toContain('undefined');
  });

  it('四态锚点互斥（同一份输入只能落一态）', () => {
    const kinds = new Set([
      driftVerdictOf({ currentPhase: 'test', inferredPhase: 'test', drift: false }).kind,
      driftVerdictOf({ currentPhase: 'plan', inferredPhase: 'test', drift: true }).kind,
      driftVerdictOf({ currentPhase: 'deploy', inferredPhase: 'test', drift: true, inferenceCeiling: 'test' }).kind,
      driftVerdictOf(null).kind,
    ]);
    expect(kinds.size).toBe(4);
  });
});
