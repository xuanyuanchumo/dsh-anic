/**
 * 工作台域导航（cycle-110）—— 粘性 chips 行：域标签 + 状态点，点击滚到域卡。
 *
 * ## 为什么是 nav[aria-label] 而不是 role="toolbar"
 *
 * `scripts/offline-smoke.mjs` 的工具栏计数守卫钉死「`data-anic-toolbar` 子树内
 * 按钮 == 3」（刷新/偏好/自举）。域导航是**页面定位**不是**动作组**——
 * ARIA 语义上也是 navigation 而非 toolbar；且它绝不能带 `data-anic-toolbar`
 * 属性、不能渲染进工具栏子树（否则三按钮计数立即红）。导航腿契约
 * （workbenchContract ④）用字符串位置断言钉死这一点。
 *
 * ## 为什么点击行为写原生 scrollIntoView 而不是 <a href="#id">
 *
 * 面板挂在宿主会话视图里，hash 跳转会污染宿主的 location；平滑滚动由
 * `behavior:'smooth'` 给出。无 DOM（测试/沙盒）时 getElementById 抛错——
 * try/catch 静默（点击行为在静态渲染下本就不发生，与根组件 closeNodeDetail
 * 的同款处理）。
 *
 * 纯函数：statuses 由调用方算好传入（本文件不感知 PanelState）。
 */
import { createElement, type ReactElement } from 'react';
import { t } from '../i18n.ts';
import type { WorkbenchDomain } from './workbenchModel.ts';
import { DOMAIN_STATUS_GLYPH, type DomainStatus } from './workbenchStatus.ts';

/** 域卡锚点 id（workbenchGrid 渲染 section id 与此同源——两处拼同一字符串）。 */
export function workbenchCardId(domainId: string): string {
  return `anic-wb-card-${domainId}`;
}

/**
 * 滚动到指定域卡（真实浏览器行为；无 DOM 静默）。
 * 独立导出：WorkbenchNav 的 onClick 与契约测试同用一个入口，行为不漂移。
 */
export function scrollToDomainCard(domainId: string): void {
  try {
    document.getElementById(workbenchCardId(domainId))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch { /* 无 DOM（测试/沙盒）→ 无处可滚，静默 */ }
}

/** 域条目渲染入参（域表 + 状态分类的结果 zip）。 */
export interface WorkbenchNavDomain {
  domain: WorkbenchDomain;
  status: DomainStatus;
}

/** 域导航 chips 行（粘性在工具栏下方——偏移由 workbenchCss 的 top 给出）。 */
export function renderWorkbenchNav(domains: readonly WorkbenchNavDomain[]): ReactElement {
  return createElement(
    'nav',
    {
      'data-anic-wb-nav': 'true',
      // 无障碍：导航地标必须有名（APG）；AT 才会播报「工作台导航」边界。
      'aria-label': t('wb.navLabel'),
      key: 'wb-nav',
    },
    ...domains.map(({ domain, status }) =>
      createElement(
        'button',
        {
          type: 'button',
          key: domain.id,
          // chip 锚点：契约测试按域 id 逐个断言；也是 E2E 旅程的定位符。
          'data-anic-wb-nav-chip': domain.id,
          onClick: (): void => { scrollToDomainCard(domain.id); },
        },
        // 状态点：字形是色盲第二通道（✕/⚠/✓/○），色值经 CSS 令牌
        //（workbenchCss 按状态属性着色——这里只带状态锚点）。
        createElement('span', {
          'data-anic-wb-chip-status': status,
          key: 'status',
          'aria-hidden': 'true',
        }, DOMAIN_STATUS_GLYPH[status]),
        t(domain.labelKey),
      ),
    ),
  );
}
