/**
 * 工作台域模型（cycle-110 · W 战线）—— 六域信息架构的唯一事实源。
 *
 * ## 为什么这张表存在
 *
 * cycle-109 时点 16 个分区挤成一条纵向长卷（panelSectionOrder 单数组线性堆叠），
 * 用户原话「功能不清晰」。重构判据是**用户意图**而不是数据来源：
 * 「先看什么」由导航承接，「东西在哪」由六域卡片承载。本表是分桶的唯一真相源：
 * `workbenchGrid` 按它分桶、`WorkbenchNav` 按它出导航 chips、
 * `workbenchStatus` 按它的域 id 分类健康态——三处消费同一张表，
 * 新增/移动分区只改这里（漏配/重复配由 workbenchModel.test 的多重集断言红）。
 * cycle-111：settings 域收入 pluginInfo（插件信息/反馈面板）——16 分区。
 *
 * ## 域表条目形状
 *
 *   - `id`：域标识（锚点 `data-anic-wb-card=<id>` / chip `data-anic-wb-nav-chip=<id>`）；
 *   - `labelKey`：域标签 locale 键（`wb.domain.<id>`），显式字面量而非拼接——
 *     静态提取器只认引号字面量里的完整键名（renderClosure KIND_KEYS 同款教训）；
 *   - `span`：'full' = 通栏卡（grid-column: 1/-1）；'auto' = 半宽随网格折行；
 *   - `sections`：该域收纳的分区 key（= panelSectionOrder.ts keyed() 打的标记，
 *     与 panelAssemblyContract 腿1 的 renderFoldableSection id 同源）。
 *
 * ## 不进域表的两件东西（刻意的）
 *
 *   - `workspace-badge`：它是"你在看哪一块"的**全局上下文**，不属于任何域——
 *     grid 层在卡外单独处理（原样移动装配数组里的该元素，保持切片订阅）；
 *   - 节点详情抽屉（`renderNodeDetail`）：overlay，不参与布局。
 *     这两个元素不带 SECTION_KEY_PROP 标记，落在 `partitionSections` 结果的
 *     `unassigned` 桶——grid 层从该桶认领 workspace-badge、其余追加在网格后
 *     （单元测试钉 unassigned 的这一形状）。
 */
import type { ReactElement } from 'react';

/**
 * 分区 key 标记的 props 属性名（panelSectionOrder.keyed() 写、本模块读）。
 *
 * 为什么不直接用 React 的 `element.key`：真实 React 的 createElement 会把 key
 * 摘到 element 上（props.key 消失），而 `scripts/offline-smoke.mjs` 的 stub
 * createElement 把 key 留在 props 里（element.key 是 undefined）——两条发版
 * 链各留一个读取面就是漂移点。显式标记（`data-anic-section-key` 形态的普通
 * prop）在两种 React 下形状一致，分桶判据只有一条。
 */
export const SECTION_KEY_PROP = 'data-anic-section-key';

/** 读一个装配元素的分区 key 标记（无标记 = badge/抽屉等非域内元素）。 */
export function sectionKeyOf(el: ReactElement): string | undefined {
  const v = (el.props as Record<string, unknown> | null | undefined)?.[SECTION_KEY_PROP];
  return typeof v === 'string' ? v : undefined;
}

/** 域 id 联合（编译期防拼错——六域是封闭集合）。 */
export type WorkbenchDomainId = 'overview' | 'health' | 'flows' | 'diagnostics' | 'quality' | 'settings';

/** 域表条目（见文件头「域表条目形状」）。 */
export interface WorkbenchDomain {
  id: WorkbenchDomainId;
  /** 域标签 locale 键（wb.domain.<id>），显式字面量。 */
  labelKey: string;
  /** 'full' = 通栏卡；'auto' = 半宽。 */
  span: 'full' | 'auto';
  /** 该域收纳的分区 key 集（装配序 = 呈现序，见 partitionSections）。 */
  sections: readonly string[];
}

/**
 * 六域域表——**排序判据**（与旧旅程叙事的差异是有意的，见 docs/agents/工作台重构设计.md §2）：
 * 卡片网格不是线性叙事，`health`（自主级仪表带）提前是英雄指标——
 * 用户第一眼要看到「现在系统什么状态」；`config` 仍最后（观测面先于可写面）。
 */
export const WORKBENCH_DOMAINS: readonly WorkbenchDomain[] = [
  { id: 'overview', labelKey: 'wb.domain.overview', span: 'full', sections: ['graph', 'live', 'cycles'] },
  { id: 'health', labelKey: 'wb.domain.health', span: 'auto', sections: ['org', 'skillHealth', 'techDebt'] },
  { id: 'flows', labelKey: 'wb.domain.flows', span: 'auto', sections: ['flows', 'ledger', 'hitl', 'budget'] },
  { id: 'diagnostics', labelKey: 'wb.domain.diagnostics', span: 'auto', sections: ['stepTrace', 'diagnostics'] },
  { id: 'quality', labelKey: 'wb.domain.quality', span: 'auto', sections: ['closure', 'bootstrap'] },
  { id: 'settings', labelKey: 'wb.domain.settings', span: 'full', sections: ['config', 'pluginInfo'] },
];

/**
 * 分桶结果的域桶形状：Map（`.get(id)` / `.keys()` 与域表同序）∩ Record
 * （`.overview` 等具名访问——六域是封闭集合，类型层直接展开）。
 */
export type WorkbenchBuckets = Map<WorkbenchDomainId, ReactElement[]> & Record<WorkbenchDomainId, ReactElement[]>;

/** 分桶结果：域 id → 该域分区元素（保持装配序）；unassigned 见下。 */
export interface WorkbenchPartition {
  /** 桶序与域表一致（Map 按域表序初始化）。 */
  readonly buckets: WorkbenchBuckets;
  /**
   * 未能归属的元素（装配数组里有但域表没认领的元素）。
   *
   * 恒定形状：恒包含 `workspace-badge`（不进域表的全局上下文，grid 层从
   * 这里认领）与节点详情抽屉（keyed 体系之外）。**其余任何元素落在该桶
   * 都是域表漏配**——单元测试断言除这两类外必为空。
   */
  readonly unassigned: ReactElement[];
}

/**
 * 按域表把装配数组分桶（纯 zip：装配序 × 域表）。
 *
 * 判据是元素的分区 key 标记（panelSectionOrder.keyed() 打的
 * SECTION_KEY_PROP——见该常量注释"为什么不用 element.key"）。分区元素
 * **原引用**入桶——不重建、不包壳，保证 memo 与 usePanelSlice 的切片订阅
 * 原样保留。同一 key 出现两次时两次都进该桶（多重集语义；装配层不产生
 * 重复 key，测试钉多重集相等）。
 */
export function partitionSections(assembled: readonly (ReactElement | null)[], domains: readonly WorkbenchDomain[] = WORKBENCH_DOMAINS): WorkbenchPartition {
  // 域 id → 元素桶（按域表序初始化，保证桶序与域表一致）。
  const buckets = new Map<WorkbenchDomainId, ReactElement[]>();
  for (const d of domains) buckets.set(d.id, []);
  // key → 域 id（O(1) 归属查询；域表 key 重复时后写胜出——测试钉无重复）。
  const keyToDomain = new Map<string, WorkbenchDomainId>();
  for (const d of domains) {
    for (const s of d.sections) keyToDomain.set(s, d.id);
  }
  const unassigned: ReactElement[] = [];
  for (const el of assembled) {
    if (el === null) continue; // 抽屉等条件渲染元素：null 不进桶（grid 层零占位）
    const sectionKey = sectionKeyOf(el);
    const domainId = sectionKey !== undefined ? keyToDomain.get(sectionKey) : undefined;
    const bucket = domainId !== undefined ? buckets.get(domainId) : undefined;
    if (bucket !== undefined) bucket.push(el);
    else unassigned.push(el);
  }
  // Map ∩ Record：六域是封闭集合，缺桶在这里就地补齐（类型层保证逐域可点名）。
  const withDefaults = new Map<WorkbenchDomainId, ReactElement[]>([
    ['overview', []], ['health', []], ['flows', []], ['diagnostics', []], ['quality', []], ['settings', []],
  ]);
  for (const [id, list] of buckets) withDefaults.set(id, list);
  return {
    buckets: withDefaults as WorkbenchBuckets,
    unassigned,
  };
}
