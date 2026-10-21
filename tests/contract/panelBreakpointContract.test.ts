/**
 * 响应式断点表契约（cycle-61 T-6101，UI 册 §3 R-1 收口）。
 *
 * ## 为什么钉这个
 *
 * panelCss.ts 的断点表（640/420 两档 @container + prefers-reduced-motion +
 * forced-colors）自 cycle-38 落地起只存在于 CSS 字符串里——eval Q6 的
 * 「9 responsive breakpoints found」只是 grep 计数，任何一轮改坏断点数值、
 * 删掉某档、把 container-type 锚点弄丢，都不会有测试红。断点表是面板在
 * 宿主侧栏/小窗口下的**行为契约**，必须像工具 ID 一样被机械钉死。
 *
 * ## 守卫纪律（同 guardRegistry 三条）
 *
 * - 反向自检：抽取器先证明能识别「违规缺失」形态，再谈守卫；
 * - 扫描集非空下限：PANEL_CSS 为空时恒绿 = 假守卫，直接 FAIL；
 * - 断言按「数值+选择器+行为」三要素逐条钉，不许聚合断言吞细节。
 */
import { describe, it, expect } from 'vitest';
import { PANEL_CSS } from '../../src/shared/panelCss.ts';

const CSS = PANEL_CSS;

/** 反向自检用：把真实 CSS 篡改成「断点表缺失」形态，抽取器必须报缺失。 */
function withoutBlocks(css: string, ...markers: string[]): string {
  let out = css;
  for (const m of markers) {
    const i = out.indexOf(m);
    if (i < 0) throw new Error(`self-check marker not found: ${m}`);
    // 删掉 marker 所在的整段 @container 块（从块头到闭括号）
    const head = out.lastIndexOf('@', i);
    const tail = out.indexOf('}', i);
    out = out.slice(0, head) + out.slice(tail + 1);
  }
  return out;
}

describe('cycle-61 T-6101 响应式断点表契约（R-1 收口）', () => {
  it('扫描集非空下限（PANEL_CSS 为空 = 假守卫恒绿，直接 FAIL）', () => {
    expect(CSS.length).toBeGreaterThan(200);
  });

  it('容器查询锚点：面板根 container-type: inline-size（面板宽度 ≠ 视口宽度——断点语义的地基）', () => {
    expect(CSS).toContain('[data-anic-workflow] { container-type: inline-size; }');
  });

  it('640px 档：工具栏 flex-wrap + row-gap 4px', () => {
    expect(CSS).toContain('@container (max-width: 640px)');
    expect(CSS).toContain('[data-anic-toolbar] { flex-wrap: wrap; row-gap: 4px; }');
  });

  it('640px 档：实时调用条目 flex-wrap（参数预览与状态点不再挤一行）', () => {
    expect(CSS).toContain('@container (max-width: 640px)');
    expect(CSS).toContain('[data-anic-invocation] { flex-wrap: wrap; }');
  });

  it('420px 档：调用条目纵向堆叠（flex-direction column）', () => {
    expect(CSS).toContain('@container (max-width: 420px)');
    expect(CSS).toContain('[data-anic-invocation] { flex-direction: column; gap: 2px; }');
  });

  it('prefers-reduced-motion 全局逃逸：按钮 transition 关闭（动画最小化纪律）', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(CSS).toContain('.anic-btn { transition: none; }');
  });

  it('forced-colors 系统接管：Windows 高对比模式按钮边框用系统色', () => {
    expect(CSS).toContain('@media (forced-colors: active)');
    expect(CSS).toContain('.anic-btn { border: 1px solid ButtonText; }');
  });

  it('断点表完整三档计数（640 恰一档 + 420 恰一档——多档重复也是违规）', () => {
    const c640 = CSS.match(/@container \(max-width: 640px\)/g) ?? [];
    const c420 = CSS.match(/@container \(max-width: 420px\)/g) ?? [];
    expect(c640).toHaveLength(1);
    expect(c420).toHaveLength(1);
  });

  it('反向自检：抽取器（withoutBlocks）真的能识别断点缺失形态', () => {
    const broken = withoutBlocks(CSS, '[data-anic-toolbar] { flex-wrap: wrap');
    expect(broken).not.toContain('@container (max-width: 640px)');
    expect(broken).not.toContain('[data-anic-toolbar] { flex-wrap: wrap; row-gap: 4px; }');
    // 自检有效性：篡改只删了 640 块，420 块必须原样保留
    expect(broken).toContain('@container (max-width: 420px)');
  });
});
