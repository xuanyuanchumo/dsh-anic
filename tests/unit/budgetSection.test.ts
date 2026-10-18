/**
 * 治理预算分区测试（cycle-24 · P3 治理预算视图）。
 *
 * 渲染纪律：renderToStaticMarkup 真渲染（非字符串断言），契约标记逐个钉死。
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderBudget, isBudget, humanBytes, type BudgetJson } from '../../src/client/features/budget/renderBudget.ts';

function budget(over: Partial<BudgetJson> = {}): BudgetJson {
  return {
    totalBytes: 3 * 1024 * 1024,
    fileCount: 42,
    dirCount: 7,
    status: 'normal',
    warnBytes: 500 * 1024 * 1024,
    alertBytes: 2 * 1024 * 1024 * 1024,
    largestFiles: [
      { path: 'D:/p/.cycles/cycles/cycle-99/test-report.md', bytes: 2 * 1024 * 1024 },
      { path: 'D:/p/.cycles/gates/ledger.json', bytes: 1.5 * 1024 * 1024 },
    ],
    ...over,
  };
}

describe('renderBudget（治理预算分区）', () => {
  it('null → null（未拉取不渲染，不伪造空态）', () => {
    expect(renderBudget(null)).toBeNull();
  });

  it('分区锚点 + 状态徽标（normal 绿语义标记）', () => {
    const html = renderToStaticMarkup(createElement('div', null, renderBudget(budget())));
    expect(html).toContain('data-anic-budget-wrap');
    expect(html).toContain('data-anic-budget-status="normal"');
    expect(html).toContain('治理预算');
    expect(html).toContain('正常');
  });

  it('余量条：填充 + warn 刻度 + role=img aria 标签', () => {
    const html = renderToStaticMarkup(createElement('div', null, renderBudget(budget())));
    expect(html).toContain('data-anic-budget-bar="normal"');
    expect(html).toContain('data-anic-budget-fill');
    expect(html).toContain('data-anic-budget-warnmark');
    expect(html).toContain('role="img"');
    // aria 标签含人性化字节数（3.0MB 已用 / 500MB warn / 2.0GB alert）
    expect(html).toContain('3.0 MB');
    expect(html).toContain('500 MB');
    expect(html).toContain('2.0 GB');
  });

  it('三态徽标：warn / alert 各自语义标记（文字即通道，颜色第二通道）', () => {
    const warn = renderToStaticMarkup(createElement('div', null, renderBudget(budget({ status: 'warn', totalBytes: 600 * 1024 * 1024 }))));
    expect(warn).toContain('data-anic-budget-status="warn"');
    const alert = renderToStaticMarkup(createElement('div', null, renderBudget(budget({ status: 'alert', totalBytes: 3 * 1024 * 1024 * 1024 }))));
    expect(alert).toContain('data-anic-budget-status="alert"');
  });

  it('统计行：文件数/目录数如实', () => {
    const html = renderToStaticMarkup(createElement('div', null, renderBudget(budget())));
    expect(html).toContain('data-anic-budget-stats');
    expect(html).toContain('42');
    expect(html).toContain('7');
  });

  it('大文件榜：行契约 + 完整路径 title 悬停', () => {
    const html = renderToStaticMarkup(createElement('div', null, renderBudget(budget())));
    expect(html).toContain('data-anic-budget-largest');
    expect(html).toContain('data-anic-budget-file');
    expect(html).toContain('test-report.md');
    expect(html).toContain('ledger.json');
  });

  it('largestFiles 空 → 榜区不渲染（不伪造空榜）', () => {
    const html = renderToStaticMarkup(createElement('div', null, renderBudget(budget({ largestFiles: [] }))));
    expect(html).not.toContain('data-anic-budget-largest');
  });
});

describe('isBudget 形状守卫', () => {
  it('完整形状通过', () => {
    expect(isBudget(budget())).toBe(true);
  });
  it('缺数值字段拒绝', () => {
    const { totalBytes: _drop, ...rest } = budget();
    expect(isBudget(rest)).toBe(false);
  });
  it('非法 status 拒绝', () => {
    expect(isBudget({ ...budget(), status: 'huge' })).toBe(false);
  });
  it('largestFiles 非数组拒绝', () => {
    expect(isBudget({ ...budget(), largestFiles: 'none' })).toBe(false);
  });
  it('非对象拒绝', () => {
    expect(isBudget(null)).toBe(false);
    expect(isBudget('normal')).toBe(false);
  });
});

describe('humanBytes 人性化', () => {
  it('B 级取整', () => {
    expect(humanBytes(512)).toBe('512 B');
  });
  it('KB/MB 一位小数', () => {
    expect(humanBytes(1536)).toBe('1.5 KB');
    expect(humanBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
  it('≥10 取整', () => {
    expect(humanBytes(20 * 1024 * 1024)).toBe('20 MB');
  });
  it('GB 级', () => {
    expect(humanBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
  it('非有限/负数如实返回字符串', () => {
    expect(humanBytes(Number.NaN)).toBe('NaN');
    expect(humanBytes(-5)).toBe('-5');
  });
});
