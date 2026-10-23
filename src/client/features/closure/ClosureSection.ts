/**
 * closure 分区组件（cycle-72 T-7207 闭环体检；T3 拆分：panelSections.ts 越 250 行）。
 *
 * 从 components/panelSections.ts 拆出——该文件为「分区订阅薄组件」的装配层，
 * 加入 closure 分区后越界（truthAudit T3）。本文件与 features/closure/renderClosure.ts
 * 同域（闭环体检），subscription 切片与失败行注入仍走公共原语（panelStore / sectionFailure），
 * 不复制第二份实现。
 */
import { memo, type ReactElement } from 'react';
import { usePanelSlice } from '../../components/panelStore.ts';
import type { PanelDataStore, PanelState } from '../../panelState.ts';
import { t } from '../../i18n.ts';
import { renderClosure } from './renderClosure.ts';
import { renderFoldableSection } from '../../components/sectionShell.ts';
import { useSectionBody } from '../../components/sectionFailure.ts';

const selClosure = (s: PanelState) => s.closure;

function ClosureSectionImpl({ store }: { store: PanelDataStore }): ReactElement {
  const closure = usePanelSlice(store, selClosure);
  // 失败不静默：路由不可用/扫描失败时如实呈现失败行（端点级 key 'closure'）。
  const body = useSectionBody(store, 'closure', 'closure', renderClosure(closure));
  return renderFoldableSection({ id: 'closure', title: t('fold.closure'), defaultOpen: true, children: body });
}

export const ClosureSection = memo(ClosureSectionImpl);
