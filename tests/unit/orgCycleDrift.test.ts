/**
 * 循环坐标漂移渲染契约（cycle-108）。
 *
 * 为什么渲染层也要单独钉：漂移判据在宿主侧算对了、类型也对了，但如果面板
 * 不渲染（或渲染成不可见文本），用户仍然只看到「共 N 轮 · 最新 cycle-105」这一行
 * 「看起来正常」的读数——这正是事故当初的形态（零报错）。所以本文件断言**真实 DOM**：
 * 漂移时必须有 role="alert" + 原因码 + 建议轮次；一致时必须给显式 ✓ 行。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderOrgCycles } from '../../src/client/features/org/renderOrgCycles.ts';
import type { OrgStatusJson } from '../../src/client/components/panelTypes.ts';

type Cycles = OrgStatusJson['cycles'];

const BASE: Cycles = { total: 78, latest: 'cycle-105', converged: 74, failed: 4 };

describe('renderOrgCycles：漂移可见性', () => {
  it('漂移时：alert + 原因码 + 建议下一循环 + 三个坐标数字', () => {
    const html = renderToStaticMarkup(renderOrgCycles({
      ...BASE,
      drift: {
        drift: true,
        headCycle: 107,
        stateCycle: 'cycle-105',
        liveLatest: 'cycle-105',
        archivedLatest: 'cycle-104',
        suggestedCycle: 'cycle-108',
        reasons: [
          { code: 'HEAD_AHEAD_OF_LIVE', head: 107, live: 105 },
          { code: 'STATE_BEHIND_LIVE', state: 105, live: 105 },
        ],
      },
    }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-anic-cycle-drift="true"');
    expect(html).toContain('data-anic-cycle-drift-code="HEAD_AHEAD_OF_LIVE"');
    expect(html).toContain('HEAD 声称 107');
    expect(html).toContain('data-anic-cycle-suggested="cycle-108"');
  });

  it('一致时：显式 ✓ 行（"没有漂移"必须是正面结论，不是沉默）', () => {
    const html = renderToStaticMarkup(renderOrgCycles({
      ...BASE,
      drift: {
        drift: false,
        headCycle: 108,
        stateCycle: 'cycle-108',
        liveLatest: 'cycle-108',
        archivedLatest: 'cycle-104',
        suggestedCycle: 'cycle-109',
        reasons: [],
      },
    }));
    expect(html).toContain('data-anic-cycle-drift="false"');
    expect(html).toContain('循环坐标一致');
    expect(html).not.toContain('role="alert"');
  });

  it('旧宿主不返回 drift ⇒ 只渲染原统计行（不得断渲染、不得伪造一致）', () => {
    const html = renderToStaticMarkup(renderOrgCycles(BASE));
    expect(html).toContain('anic-org-cycles');
    expect(html).toContain('共 78 轮');
    expect(html).not.toContain('cycle-drift');
  });

  it('未知原因码不静默丢：原样列出码名（上游新增码有回声）', () => {
    const html = renderToStaticMarkup(renderOrgCycles({
      ...BASE,
      drift: {
        drift: true, headCycle: null, stateCycle: null, liveLatest: null,
        archivedLatest: null, suggestedCycle: 'cycle-1',
        reasons: [{ code: 'FUTURE_CODE' }],
      },
    }));
    expect(html).toContain('FUTURE_CODE');
  });
});