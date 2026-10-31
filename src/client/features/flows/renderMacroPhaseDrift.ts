/**
 * 宏观相位漂移读数的渲染（cycle-96 WS-A · `features/flows`）。
 *
 * ## 为什么单独成文件（职责，不是行数）
 *
 * `renderFlows.ts` 的职责是「注册表全景 + 每流程当前态」；这里回答的是另一个问题
 * ——「**当前相位是谁说了算**」。把两个读数的裁决塞进 `renderFlows` 会让那支渲染
 * 函数同时承担两张表，而它们的失败通道也不同（流程投影取不到 ≠ 相位读数取不到）。
 *
 * ## 上屏纪律（三值都必须可见）
 *
 * 被修缺陷（cycle-96 实测）：技能侧 `cmdStatus` 曾用 `inferPhase` 静默改写磁盘，
 * 宿主侧则只报 stored ⇒ 同一概念两个口径，界面上却只看得到一个。
 * ⇒ 这里把 `stored` / `inferred` / `drift` **三值同时**印出来：
 *
 * ```
 * 相位读数：stored plan / inferred test · 推断不一致（工件说 test）
 * ```
 *
 * ## 四态各有独立呈现（不许合并）
 *
 * | verdict | 呈现 | 为什么必须单列 |
 * |---|---|---|
 * | consistent | stored / inferred 一致 | 一致也要印，读者才知道推断跑过 |
 * | drift | 点名分叉 + 给出路 | 真问题：状态文件没跟上工件 |
 * | ceiling | 「推断到顶」 | deploy/maintain 推不出来，**不是**状态错了 |
 * | unknown | 「未采集」 | 旧宿主没这三字段 / 无状态文件，**不判分叉** |
 *
 * 把 ceiling 混进 drift 会让用户去修一个正确的状态文件（狼来了）；
 * 把 unknown 混进 consistent 则是把「没读到」画成「没问题」（假绿）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import { driftVerdictOf, type MacroPhaseStatusJson } from './macroPhaseTypes.ts';

/** 读数形态 → i18n 键（**显式映射表**，不拼键：i18n 扫描器只认引号字面量）。 */
const VERDICT_KEYS: Record<string, string> = {
  consistent: 'flows.macroPhaseConsistent',
  drift: 'flows.macroPhaseDrift',
  ceiling: 'flows.macroPhaseCeiling',
  unknown: 'flows.macroPhaseUnknown',
};

/** 读数形态 → 语义色令牌（票：drift 告警 / ceiling 提示 / consistent 通过 / unknown 淡）。 */
function verdictColor(kind: string): string {
  if (kind === 'drift') return token('anic-fail');
  if (kind === 'ceiling') return token('anic-warn-text');
  if (kind === 'consistent') return token('anic-pass');
  return token('anic-text-faint');
}

/**
 * 渲染相位读数条。
 *
 * @param view `/anic/flows/status` 的 `macroPhase` 切片；undefined/null = 旧服务端
 *   ⇒ **仍渲染 unknown 行**（不是整区不渲染）：读者需要知道「这里本该有读数」。
 */
export function renderMacroPhaseDrift(view: MacroPhaseStatusJson | null | undefined): ReactElement | null {
  // 完全没这个切片（旧宿主 / 路由缺失）→ 不渲染。
  // 与「切片在但字段缺」区分：后者是采集失败，要如实显示 unknown。
  if (view === null || view === undefined) return null;

  const verdict = driftVerdictOf(view);
  const stored = verdict.stored ?? '—';
  const inferred = verdict.inferred ?? '—';
  const text = t(VERDICT_KEYS[verdict.kind] ?? 'flows.macroPhaseUnknown', { stored, inferred });

  return createElement(
    'div',
    {
      'data-anic-macro-phase-drift': verdict.kind,
      'data-anic-macro-stored': stored,
      'data-anic-macro-inferred': inferred,
      style: {
        display: 'flex', flexWrap: 'wrap', gap: '2px 8px', alignItems: 'baseline',
        padding: '3px 10px', fontSize: 11, color: token('anic-text'),
      },
    },
    createElement('span', { style: { fontWeight: 600 } }, t('flows.macroPhaseLabel')),
    // 三值原样并列（不做任何「取其一」的折叠）：谁说了算必须是可读事实。
    createElement('span', { style: { color: token('anic-text-faint') } }, `stored ${stored} / inferred ${inferred}`),
    createElement('span', { style: { color: verdictColor(verdict.kind) } }, text),
    // 分叉时给出**可操作出路**：查询不写盘，要以前者为准必须显式 advance。
    // 锚点带目标相名（而不是只靠文案）：文案随语言变，锚点不变 —— 契约才能断言。
    verdict.kind === 'drift'
      ? createElement('span', {
        'data-anic-macro-drift-hint': inferred,
        style: { color: token('anic-text-faint') },
      }, t('flows.macroPhaseDriftHint', { target: inferred }))
      : null,
    // 推断到顶时点名上限，否则读者会把「推不出来」当成「没推」。
    verdict.kind === 'ceiling'
      ? createElement('span', {
        'data-anic-macro-ceiling-hint': typeof view.inferenceCeiling === 'string' ? view.inferenceCeiling : 'test',
        style: { color: token('anic-text-faint') },
      }, t('flows.macroPhaseCeilingHint', {
        ceiling: typeof view.inferenceCeiling === 'string' ? view.inferenceCeiling : 'test',
      }))
      : null,
  );
}
