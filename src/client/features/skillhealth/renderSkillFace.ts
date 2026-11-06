/**
 * 技能**注册面**两行读数（cycle-109）—— runtime 技能可见性 + 内部技能库对账。
 *
 * 从 `renderSkillHealth.ts` 拆出（T3 ≤250 行；边界是「调用健康面 / 注册面」）。
 *
 * ## 为什么与「脚本健康」分开两块
 *
 * 脚本健康回答「**这些脚本跑得好不好**」（成功率/超时/耗时）；
 * 这两行回答「**模型看不看得见、库全不全**」（注册面）。两者失败原因完全不同
 * —— 脚本 100% 健康而技能被 project 层同名压制，是完全可能的真实形态。
 * 合并进同一张列表会让读者把两种事故读成同一种。
 *
 * ## 为什么三态各自一个字形 + 一种颜色
 *
 * `unknown` 不是失败：它表示「宿主没给观测通道 / 观测不完整」。把它画成红叉
 * 会让读者去修一个不存在的问题（本仓反复记过「没有证据 ≠ 失败」）。
 *
 * ## 零占位
 *
 * 旧宿主两个字段都缺 ⇒ 整块返回 null（不渲染空壳，与 `graphExtras` 同纪律）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import type { SkillHealthJson } from './renderSkillHealth.ts';

/** 渲染注册面两行；两个字段都缺 ⇒ null。 */
export function renderSkillRegistrationFace(data: SkillHealthJson): ReactElement | null {
  const rt = data.runtimeSkill;
  const lib = data.library;
  if (rt === undefined && lib === undefined) return null;
  const rtGlyph = rt === undefined ? '' : rt.state === 'active' ? '✓' : rt.state === 'absent' ? '✕' : '○';
  const rtColor = rt === undefined ? token('anic-text-faint')
    : rt.state === 'active' ? token('anic-pass')
      : rt.state === 'absent' ? token('anic-fail') : token('anic-text-faint');
  const rtText = rt === undefined ? ''
    : rt.state === 'active' ? t('health.runtimeSkillActive')
      : rt.state === 'absent' ? t('health.runtimeSkillAbsent') : t('health.runtimeSkillUnknown');
  const libGlyph = lib === undefined ? '' : lib.ok ? '✓' : '⚠';
  const libColor = lib === undefined ? token('anic-text-faint')
    : lib.ok ? token('anic-pass') : token('anic-warn-text');
  return createElement(
    'div',
    { 'data-anic-skill-registration': 'true', style: { padding: '2px 10px', display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10 } },
    rt === undefined ? null : createElement(
      'div',
      {
        'data-anic-skill-visibility': rt.state,
        ...(rt.name === null ? {} : { 'data-anic-skill-visibility-name': rt.name }),
        title: rt.reason,
        style: { display: 'flex', alignItems: 'center', gap: 6, color: rtColor, fontFamily: 'ui-monospace, monospace' },
      },
      createElement('span', { style: { width: 12, textAlign: 'center', flexShrink: 0 } }, rtGlyph),
      createElement('span', { style: { color: token('anic-text-dim'), flexShrink: 0 } }, t('health.runtimeSkillLabel')),
      createElement('span', { style: { color: token('anic-text-strong'), overflowWrap: 'anywhere' } }, rt.name ?? '—'),
      createElement('span', { style: { color: token('anic-text-faint') } }, rtText),
      rt.skillsChangeEmits > 0
        ? createElement('span', { 'data-anic-skills-change': String(rt.skillsChangeEmits), style: { color: token('anic-text-faint') } }, t('health.skillsChangeEmits', { count: String(rt.skillsChangeEmits) }))
        : null,
    ),
    lib === undefined ? null : createElement(
      'div',
      {
        'data-anic-skill-library': lib.ok ? 'ok' : 'issues',
        'data-anic-skill-library-count': String(lib.skills),
        'data-anic-skill-library-issues': String(lib.issues),
        title: lib.summary,
        style: { display: 'flex', alignItems: 'center', gap: 6, color: libColor, fontFamily: 'ui-monospace, monospace' },
      },
      createElement('span', { style: { width: 12, textAlign: 'center', flexShrink: 0 } }, libGlyph),
      createElement('span', { style: { color: token('anic-text-dim'), flexShrink: 0 } }, t('health.libraryLabel')),
      createElement('span', { style: { color: token('anic-text-strong') } }, t('health.librarySummary', { version: lib.version, skills: String(lib.skills), issues: String(lib.issues) })),
      lib.ok ? createElement('span', { style: { color: token('anic-text-faint') } }, t('health.libraryOk')) : null,
    ),
  );
}