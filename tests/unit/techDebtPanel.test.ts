/**
 * cycle-54 T-5401：tech-debt 队列面板渲染测试。
 *
 * 覆盖：响应守卫 / 空队列 / open 列表与截限 / resolved·skipped 计数行 /
 * null 态不渲染。渲染断言用 renderToStaticMarkup（既有面板测试同款）。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderTechDebt, isTechDebtListing, type TechDebtListingJson } from '../../src/client/features/techdebt/renderTechDebt.ts';

function entry(overrides: Partial<TechDebtListingJson['open'][number]['entry']> = {}): TechDebtListingJson['open'][number]['entry'] {
  return {
    id: 'debt-E2-2026-10-21',
    dimension: 'E2',
    severity: 'high',
    description: '某维度失败描述',
    proposedAction: '建议动作',
    createdAt: '2026-10-21T00:00:00.000Z',
    resolved: false,
    ...overrides,
  };
}

function listing(overrides: Partial<TechDebtListingJson> = {}): TechDebtListingJson {
  return {
    open: [],
    openCount: 0,
    resolvedCount: 0,
    skipped: [],
    ...overrides,
  };
}

describe('cycle-54 T-5401 tech-debt 面板渲染', () => {
  it('null 态不渲染（未拉到不伪造空态）', () => {
    expect(renderTechDebt(null)).toBeNull();
  });

  it('守卫：合法形状通过 / 畸形拒绝', () => {
    expect(isTechDebtListing(listing())).toBe(true);
    expect(isTechDebtListing({ open: [], openCount: 0, resolvedCount: 0 })).toBe(false); // 缺 skipped
    expect(isTechDebtListing(null)).toBe(false);
    expect(isTechDebtListing('str')).toBe(false);
  });

  it('空队列渲染零欠债行（合法状态非空态引导）', () => {
    const html = renderToStaticMarkup(renderTechDebt(listing())!);
    expect(html).toContain('data-anic-techdebt-empty');
    expect(html).toContain('零欠债');
    expect(html).toContain('待处理 0');
  });

  it('open 条目渲染：severity 徽标 + 维度 + 描述（data 契约标记）', () => {
    const html = renderToStaticMarkup(renderTechDebt(listing({
      open: [{ file: 'debt-a.json', entry: entry({ severity: 'critical', dimension: 'E5', description: '测试覆盖不足' }) }],
      openCount: 1,
    }))!);
    expect(html).toContain('data-anic-techdebt-entry="debt-E2-2026-10-21"');
    expect(html).toContain('data-anic-techdebt-severity="critical"');
    expect(html).toContain('[critical]');
    expect(html).toContain('E5');
    expect(html).toContain('测试覆盖不足');
  });

  it('截限：超 12 条渲染「还有 N 条」行', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ file: `f${i}.json`, entry: entry({ id: `debt-${i}` }) }));
    const html = renderToStaticMarkup(renderTechDebt(listing({ open: many, openCount: 15 }))!);
    expect(html).toContain('data-anic-techdebt-more="3"');
    expect((html.match(/data-anic-techdebt-entry/g) ?? []).length).toBe(12);
  });

  it('resolved/skipped 计数行只在 >0 时渲染', () => {
    const html = renderToStaticMarkup(renderTechDebt(listing({
      resolvedCount: 3,
      skipped: [{ file: 'self-bootstrap-round-1.json', reason: 'not a TechDebtEntry shape (e.g. self-bootstrap free-form proposal)' }],
    }))!);
    expect(html).toContain('data-anic-techdebt-resolved');
    expect(html).toContain('已消费 3 条');
    expect(html).toContain('data-anic-techdebt-skipped');
    expect(html).toContain('非提案形态 1 个文件');
    // skipped 的 title 悬停带原因（白盒排障）。
    expect(html).toContain('self-bootstrap-round-1.json');
  });

  it('resolved/skipped 为零时不渲染对应行（不制造噪音）', () => {
    const html = renderToStaticMarkup(renderTechDebt(listing({ open: [{ file: 'a.json', entry: entry() }], openCount: 1 }))!);
    expect(html).not.toContain('data-anic-techdebt-resolved');
    expect(html).not.toContain('data-anic-techdebt-skipped');
  });
});
