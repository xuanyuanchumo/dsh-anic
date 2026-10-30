/**
 * 自举分区组件（cycle-89）——订阅切片 + 把点击翻译成重启动作。
 *
 * 与 `ConfigSection` 同构：装配层（`panelSections.ts`）只再导出，渲染体
 * （`renderBootstrap`）保持纯函数，动作腿（`bootstrapTarget.restartBootstrap`）
 * 独立可测。本文件只有三件事：订阅、点击、重试中禁用。
 *
 * ## 为什么重启不弹 confirm()
 *
 * `confirm()` 在宿主 webview 里会阻塞渲染线程，且无法被 jsdom 契约测试断言。
 * 采用「按钮 + 就地结果行」：点一次进入 busy，成功/失败**原文**回写到分区主体
 * 上方——用户看到的是因果，不是弹窗。
 *
 * ## 为什么不做「自动重启」
 *
 * 重启会重置轮次预算（history 保留，EXHAUSTED 可重新开跑）。这是人的决定：
 * 自动重启等于把「门禁一直不过」悄悄变成「它一直在重试」，正是 R06/R07 禁止的
 * 条件通过。面板只给入口，不替人下判断。
 */
import { memo, useCallback, useState, type ReactElement } from 'react';
import { createElement } from 'react';
import { usePanelSlice } from '../../components/panelStore.ts';
import { bindPanelActions } from '../../components/panelActions.ts';
import type { PanelDataStore, PanelState } from '../../panelState.ts';
import { t } from '../../i18n.ts';
import { token } from '../../../shared/tokens.ts';
import { renderFoldableSection } from '../../components/sectionShell.ts';
import { useSectionFailure, bodyOrFailure, type SectionBody } from '../../components/sectionFailure.ts';
import { renderBootstrap } from './renderBootstrap.ts';
import { refreshBootstrapFact, restartBootstrap } from './bootstrapTarget.ts';

const selBootstrap = (s: PanelState) => s.bootstrap;

/** 结果行（成功=pass 色，失败=fail 色；带 `data-anic-bootstrap-note` 锚点）。 */
function renderNote(ok: boolean, text: string): ReactElement {
  return createElement(
    'div',
    {
      'data-anic-bootstrap-note': ok ? 'ok' : 'fail',
      [ok ? 'data-anic-bootstrap-note-ok' : 'data-anic-bootstrap-note-fail']: 'true',
      role: ok ? 'status' : 'alert',
      style: { fontSize: 10, color: ok ? token('anic-pass') : token('anic-fail'), padding: '3px 10px 0' },
    },
    text,
  );
}

/** 自举分区（订阅 4s 档 bootstrap 切片 + 分区失败通道）。 */
function BootstrapSectionImpl({ store }: { store: PanelDataStore; panelId?: string }): ReactElement {
  const data = usePanelSlice(store, selBootstrap);
  const failure = useSectionFailure(store, 'bootstrap');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const onRestart = useCallback((): void => {
    setBusy(true);
    setNote(null);
    void restartBootstrap(undefined, 'panel: reset facts baseline').then((r) => {
      setBusy(false);
      if (!r.ok) {
        // 失败原文进分区（不吞成「失败」）：412 = 缺 .cycles，409 = 正在跑。
        setNote({ ok: false, text: t('bootstrap.restartFailed', { error: r.error ?? 'unknown' }) });
        return;
      }
      setNote({ ok: true, text: t('bootstrap.restartOk', { from: r.from ?? '—' }) });
      void refreshBootstrapFact((v) => { bindPanelActions(store).setBootstrap(v); });
    });
  }, [store]);

  const rendered = data === null ? null : renderBootstrap(data, { onRestart, restartBusy: busy });
  const body: SectionBody = bodyOrFailure(rendered, 'bootstrap', failure);
  // 结果行在前、主体在后：点完按钮后第一眼看到的就是"成没成"。
  const children: ReadonlyArray<ReactElement | null> = body === null
    ? (note === null ? [] : [renderNote(note.ok, note.text)])
    : Array.isArray(body)
      ? [...(note === null ? [] : [renderNote(note.ok, note.text)]), ...body]
      : [note === null ? null : renderNote(note.ok, note.text), body];

  return renderFoldableSection({ id: 'bootstrap', title: t('fold.bootstrap'), children });
}

/** 自举分区（cycle-89 · 自举可重启的可视化腿）。 */
export const BootstrapSection = memo(BootstrapSectionImpl);
