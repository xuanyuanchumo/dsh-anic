/**
 * closure 分区组件（cycle-72 T-7207 闭环体检；cycle-75 T3 接失败数据腿）。
 *
 * 从 components/panelSections.ts 拆出——该文件为「分区订阅薄组件」的装配层，
 * 加入 closure 分区后越界（truthAudit T3 250 行）。本文件与 features/closure/
 * renderClosure.ts 同域（闭环体检），subscription 切片与失败行注入仍走公共原语
 * （panelStore / sectionFailure），不复制第二份实现。
 *
 * **cycle-75 T3 修复的真实缺陷形态**（本分区自身复发了 cycle-72 的事故）：
 * 依赖 `useSectionBody(store,'closure','closure', renderClosure(closure))` —— 该原语
 * 在 `body === null` 时**把失败行当作 body 返回**；而本分区随后调用
 * `renderFoldableSection({..., children: body})`，`renderSectionFailure` 的返回值
 * 是**合法的 ReactElement**，本该可见……但 `useSectionBody` 会在无失败且无数据时
 * 返回 null，退化回「只剩标题壳」。改成与 FlowsSection/HitlSection **同款显式两步**
 * （`useSectionFailure` + `bodyOrFailure`）后：
 *   - hooks 无条件调用（分区无启停门控，规则天然满足）；
 *   - 失败 ──▶ 可见失败行；有旧数据 ──▶ 数据 + 陈旧标注；
 *   - 无数据且无失败 ──▶ null，交上层 `renderFoldableSection` 的摘要壳（保持既有降级）。
 *
 * 无启停门控故不使用 `renderSectionDisabled` 分支（与 cycles/skillHealth 同档）。
 */
import { memo, type ReactElement } from 'react';
import { usePanelSlice } from '../../components/panelStore.ts';
import type { PanelDataStore, PanelState } from '../../panelState.ts';
import { t } from '../../i18n.ts';
import { renderClosure } from './renderClosure.ts';
import { renderFoldableSection } from '../../components/sectionShell.ts';
import { useSectionFailure, bodyOrFailure, type SectionBody } from '../../components/sectionFailure.ts';

const selClosure = (s: PanelState) => s.closure;

function ClosureSectionImpl({ store }: { store: PanelDataStore }): ReactElement {
  const closure = usePanelSlice(store, selClosure);
  // 失败不静默：路由不可用 / 响应畸形 / 网络异常时如实呈现失败行（端点级 key 'closure'）。
  // hooks 规则：订阅**无条件**调用（本分区无启停门控，故用同款显式两步）。
  const failure = useSectionFailure(store, 'closure');
  const body: SectionBody = bodyOrFailure(closure === null ? null : renderClosure(closure), 'closure', failure);
  return renderFoldableSection({ id: 'closure', title: t('fold.closure'), defaultOpen: true, children: body });
}

export const ClosureSection = memo(ClosureSectionImpl);
