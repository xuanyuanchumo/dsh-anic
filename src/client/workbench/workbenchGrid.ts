/**
 * 工作台装配层（cycle-110）—— `renderWorkbench`：分区数组 → 六域卡片网格。
 *
 * ## 装配链（数据管线零改动）
 *
 * 根组件 `...renderWorkbench({...})` 逐字透传 `PanelSectionsInput` →
 * 本文件调 `renderPanelSections(input)`（**同一入参**，分区组件与门控完全
 * 原样）→ `partitionSections` 按域表分桶 → 输出
 * `[workspaceBadge, nav, 网格(域卡), ...overlay]`。
 *
 * 返回形态与 renderPanelSections 一致（Array<ReactElement | null>，空域出
 * null 占位保持数组可 zip），根组件展开进 children——工具栏 / prefs 抽屉 /
 * 数据管线在根组件里逐字不动。
 *
 * ## 「原样移动」纪律（memo 级联拦截的前提）
 *
 * WorkspaceBadge 与各分区都是订阅 store 切片的 memo 组件，装配数组里的
 * 元素是 renderPanelSections 已创建的 ReactElement（props 引用恒定是
 * panelSections.ts 文件头钉的纪律）。本文件**只挪位置不重建**：分区元素
 * 原引用直接入卡，badge 原引用放在网格外——重新 createElement 会生成新
 * props 对象，破坏 memo 拦截的前提。
 *
 * ## 零占位与计数
 *
 * 卡头计数 = 该域分桶长度（= 装配进该域的分区数）：门控关掉的分区仍渲染
 * 关闭形态行（INV-30 关闭形态可观测），所以计数跟装配走而不是跟门控走。
 * 桶为空的域**整卡不渲染**（出 null）、nav 也不出该域 chip——空卡/空锚
 * chip 是噪声（"这里该有东西但没有"），不是信息。契约测试④的反向自检
 * 用域表覆盖参数钉死这一点。
 *
 * ## workspaceBadge 与抽屉
 *
 * 两者不进域表，落 `partitionSections().unassigned`：badge（全局上下文）
 * 认领到**网格之外、nav 之前**（契约测试钉位置序）；其余元素（今天只有
 * 节点详情抽屉，overlay 语义）原样追加在网格之后——与旧行为逐字一致。
 */
import { createElement, type ReactElement } from 'react';
import { t } from '../i18n.ts';
import { renderPanelSections, type PanelSectionsInput } from '../panelSectionOrder.ts';
import { partitionSections, sectionKeyOf, WORKBENCH_DOMAINS, type WorkbenchDomain } from './workbenchModel.ts';
import { classifyDomainStatus, DOMAIN_STATUS_GLYPH, type DomainStatus } from './workbenchStatus.ts';
import { renderWorkbenchNav, workbenchCardId } from './WorkbenchNav.ts';

/** workspace-badge 的装配 key（panelSectionOrder 第 0 个元素；判据唯一）。 */
const BADGE_KEY = 'workspace-badge';

/**
 * 元素 key 双通道读取（真实 React = element.key；smoke stub = props.key）。
 * 与 SECTION_KEY_PROP 的取舍同理（workbenchModel 文件头）：两条读取面
 * 各自都成立时才不算漂移。
 */
function badgeOf(el: ReactElement): boolean {
  return (el.key ?? (el.props as { key?: unknown } | null)?.key) === BADGE_KEY;
}

/** 从 unassigned 桶里认领工作区徽标（原引用移出，不重建）。 */
function takeBadge(unassigned: readonly ReactElement[]): ReactElement | null {
  return unassigned.find(badgeOf) ?? null;
}

/** 单张域卡：卡头（标签 + 状态点 + 计数）+ 卡体（该域分区原样）。 */
function renderDomainCard(domain: WorkbenchDomain, sections: readonly ReactElement[], status: DomainStatus): ReactElement | null {
  if (sections.length === 0) return null; // 零占位：空域整卡不渲染（契约测试钉）
  const countText = t('wb.cardCount', { count: String(sections.length) });
  return createElement(
    'section',
    {
      key: `wb-card-${domain.id}`,
      id: workbenchCardId(domain.id),
      // 卡锚点族（设计文档 §5.3）：card / -status / -count 全可断言。
      'data-anic-wb-card': domain.id,
      'data-anic-wb-card-status': status,
      'data-anic-wb-card-count': String(sections.length),
      ...(domain.span === 'full' ? { 'data-anic-wb-span': 'full' } : {}),
    },
    // 卡头：小标签行（workbenchCss 排版；颜色走令牌）。
    createElement(
      'div',
      { 'data-anic-wb-card-head': domain.id, key: 'head' },
      createElement('span', { key: 'label' }, t(domain.labelKey)),
      createElement('span', {
        key: 'status',
        'data-anic-wb-card-status-dot': status,
        'aria-hidden': 'true',
      }, DOMAIN_STATUS_GLYPH[status]),
      createElement('span', { key: 'count', 'data-anic-wb-card-count-text': 'true' }, countText),
    ),
    // 卡体：该域分区元素**原引用**放入（切片订阅/门控行为完全保留）。
    ...sections,
  );
}

/**
 * 工作台装配（与 renderPanelSections 同入参形态、同返回形态）。
 *
 * @param input   PanelSectionsInput（根组件逐字透传）
 * @param domains 域表覆盖（默认 WORKBENCH_DOMAINS；契约反向自检用它构造
 *                "某域 sections 被清空" ⇒ 对应卡锚点必须缺席）
 * @returns [workspaceBadge, nav, 网格(域卡), ...overlay] —— 展开进根组件 children
 */
export function renderWorkbench(input: PanelSectionsInput, domains: readonly WorkbenchDomain[] = WORKBENCH_DOMAINS): Array<ReactElement | null> {
  // 1. 先按既有装配层产出全部分区（门控/订阅/排序语义零变化）。
  const assembled = renderPanelSections(input);
  // 2. 按域表分桶（workspace-badge 与抽屉落 unassigned）。
  const partition = partitionSections(assembled, domains);
  // 3. 状态分类：每域一次（nav 与卡头共用，读 store 渲染期快照——纯读）。
  const state = input.store.getState();
  const statuses = domains.map((d) => classifyDomainStatus(state, d));
  // 4. 网格（data-anic-wb-grid 锚点）：非空域出卡，空域 null（零占位）。
  const grid = createElement(
    'div',
    { 'data-anic-wb-grid': 'true', key: 'wb-grid' },
    // Map 取值必须走 .get()：方括号在 Map 实例上读的是自有属性（undefined），
    // 六域桶会全部判空 ⇒ 全部卡消失——这是"Map ∩ Record"类型糖真正的陷阱。
    ...domains.map((d, i) => renderDomainCard(d, partition.buckets.get(d.id) ?? [], statuses[i] as DomainStatus)),
  );
  // 5. badge（网格外的全局上下文条）+ nav（粘性域导航；空域不出 chip——
  //    chip 是定位器，指向一张不存在的卡就是静默失约）+ 网格 + overlay。
  const badge = takeBadge(partition.unassigned);
  const navDomains = domains
    .map((domain, i) => ({ domain, status: statuses[i] as DomainStatus }))
    .filter(({ domain }) => (partition.buckets.get(domain.id) ?? []).length > 0);
  const overlays = partition.unassigned.filter((el) => !badgeOf(el));
  return [badge, renderWorkbenchNav(navDomains), grid, ...overlays];
}
