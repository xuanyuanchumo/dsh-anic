/**
 * 流程分区组件（cycle-89 · 从 `panelSections.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 拆出的理由（职责，不是行数）
 *
 * `panelSections.ts` 是「分区订阅薄层聚合面」——每个分区只做
 * 「订阅切片 + 调用既有 render*」。流程分区在 cycle-89 增加了**归属量化条**
 * （join key 的消费面），逻辑从 3 行涨到 20 行，且带**两个**失败通道
 * （flowsStatus 与 flowMatrix 各自独立）。
 *
 * 两个失败通道必须分开记：流程状态机取不到与归属矩阵取不到是**两件事**
 * （前者是流程投影端点挂了，后者是矩阵端点挂了）——
 * 合成一个 key 会让其中一次失败被另一次的成功抹掉。
 *
 * ## 装配顺序（cycle-89）
 *
 * 归属量化条挂在流程分区**顶部**：它是「这些流程属于谁」的摘要，
 * 放在明细之前，读者先看到归属全貌再看细节。
 */
import { memo, type ReactElement } from 'react';
import { createElement } from 'react';
import { usePanelSlice } from '../../components/panelStore.ts';
import type { PanelDataStore, PanelState } from '../../panelState.ts';
import { t } from '../../i18n.ts';
import { renderFoldableSection, renderSectionDisabled } from '../../components/sectionShell.ts';
import { useSectionFailure, bodyOrFailure } from '../../components/sectionFailure.ts';
import { renderFlows } from './renderFlows.ts';
import { renderFlowMatrix } from './renderFlowMatrix.ts';
// cycle-90：生命周期指标读数。
import { renderLifecycleMetrics } from './renderLifecycleMetrics.ts';

interface FlowsSectionProps {
  store: PanelDataStore;
  /** 流程视图开关（关 → 显示关闭形态，不渲染主体）。 */
  enabled: boolean;
}

// 模块级 selector（usePanelSlice 硬契约：引用稳定 + 返回原引用）。
const selFlowsStatus = (s: PanelState) => s.flowsStatus;
const selFlowMatrix = (s: PanelState) => s.flowMatrix;
const selLifecycle = (s: PanelState) => s.lifecycleMetrics;

/** 流程分区实现。 */
function FlowsSectionImpl({ store, enabled }: FlowsSectionProps): ReactElement {
  const flowsStatus = usePanelSlice(store, selFlowsStatus);
  const flowMatrix = usePanelSlice(store, selFlowMatrix);
  const lifecycle = usePanelSlice(store, selLifecycle);
  // hooks 规则：订阅必须**无条件**调用（启停门控只影响 body 组装——下方三元）。
  const failure = useSectionFailure(store, 'flowsStatus');
  const matrixFailure = useSectionFailure(store, 'flowMatrix');
  const lifecycleFailure = useSectionFailure(store, 'lifecycleMetrics');
  // 关闭形态（renderSectionDisabled）优先于失败行——「关了什么」比「取不到」更根本。
  const body = enabled
    ? bodyOrFailure(renderFlows(flowsStatus), 'flows', failure)
    : renderSectionDisabled({ anchorKey: 'data-anic-flowsview-disabled', text: t('flows.disabled') });
  const matrix = enabled
    ? bodyOrFailure(renderFlowMatrix(flowMatrix), 'flowMatrix', matrixFailure)
    : null;
  // cycle-90：生命周期读数（KM / EWMA / 分位数+Gini）挂在归属量化条**下方** ——
  // 两者讲同一件事（「这些流程跑得怎么样」）：量化条答「属于谁」，生命周���答「跑多久、成不成功」。
  const lifecycleBody = enabled
    ? bodyOrFailure(renderLifecycleMetrics(lifecycle), 'lifecycleMetrics', lifecycleFailure)
    : null;
  const extras = [matrix, lifecycleBody].filter((x): x is ReactElement => x !== null);
  const children = extras.length === 0
    ? body
    : Array.isArray(body)
      ? [...extras, ...body]
      : [...extras, body];
  return renderFoldableSection({ id: 'flows', title: t('fold.flows'), children });
}

/** 流程分区（状态机视图 + 归属量化条）。 */
export const FlowsSection = memo(FlowsSectionImpl);
