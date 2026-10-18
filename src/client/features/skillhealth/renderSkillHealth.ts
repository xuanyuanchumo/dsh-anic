/**
 * 技能健康面板（ui-domain-plan P3 · cycle-20）——「这些技能脚本健康吗」。
 *
 * 数据面：GET /anic/skill/health（skillHealthRoute）→ analyzeSkillHealth 纯函数
 * 分析 FlowTracker 调用历史。与 anic_status 工具（LLM 面）同一份分析——阈值
 * 单一事实源在 host/runtime/continuousLearning.ts，本文件只做展示不重新判定。
 *
 * 渲染纪律：等级色+字形双通道（色盲可达）；微条形给成功率连续量；建议列表
 * 带严重程度着色。空态如实（totalInvocations=0 → 引导文案，不伪造绿）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import { isObjectLike } from '../live/fetchJson.ts';

export const SKILL_HEALTH_URL = '/anic/skill/health';

/** 与宿主 SkillHealthReport/ScriptHealth/ImprovementSuggestion 对齐的最小客户端形状。 */
export interface ScriptHealthJson {
  script: string;
  level: 'healthy' | 'degraded' | 'slow' | 'expensive' | 'insufficient' | 'unused';
  total: number;
  successRate: number;
  timeoutRate: number;
  avgDurationMs: number;
  lastInvoked?: string;
}

export interface SkillHealthJson {
  scripts: ScriptHealthJson[];
  suggestions: Array<{ id: string; severity: 'info' | 'warn' | 'critical'; script: string; description: string; action: string }>;
  overallSuccessRate: number;
  totalInvocations: number;
  generatedAt: string;
}

/** 响应守卫：scripts 数组 + 数值汇总字段（防畸形数据进渲染层）。 */
export function isSkillHealth(v: unknown): v is SkillHealthJson {
  return isObjectLike(v)
    && Array.isArray((v as { scripts?: unknown }).scripts)
    && typeof (v as { overallSuccessRate?: unknown }).overallSuccessRate === 'number'
    && typeof (v as { totalInvocations?: unknown }).totalInvocations === 'number';
}

/** 等级 → 色（图形令牌，≥3:1）。等级判定在宿主；此处只做语义色映射。 */
function levelColor(level: ScriptHealthJson['level']): string {
  if (level === 'healthy') return token('anic-pass');
  if (level === 'degraded') return token('anic-fail');
  if (level === 'slow' || level === 'expensive') return token('anic-warn-text');
  return token('anic-text-faint');
}

/** 等级 → 字形（色盲第二通道；与色同源单一映射表）。 */
function levelGlyph(level: ScriptHealthJson['level']): string {
  if (level === 'healthy') return '✓';
  if (level === 'degraded') return '✕';
  if (level === 'slow') return '⏱';
  if (level === 'expensive') return '⌛';
  if (level === 'insufficient') return '○';
  return '·';
}

function levelLabel(level: ScriptHealthJson['level']): string {
  if (level === 'healthy') return t('health.levelHealthy');
  if (level === 'degraded') return t('health.levelDegraded');
  if (level === 'slow') return t('health.levelSlow');
  if (level === 'expensive') return t('health.levelExpensive');
  if (level === 'insufficient') return t('health.levelInsufficient');
  return t('health.levelUnused');
}

function pct(rate: number): string {
  return `${String(Math.round(rate * 100))}%`;
}

/** 渲染技能健康分区。null=尚未轮询到（调用方不渲染本节，与 ledger 同模式）。 */
export function renderSkillHealth(data: SkillHealthJson | null): ReactElement | null {
  if (data === null) return null;
  return createElement(
    'section',
    { 'data-anic-skill-health': 'section', style: { borderTop: `1px solid ${token('anic-border')}`, padding: '4px 0 6px' } },
    createElement(
      'div',
      { style: { fontSize: 10, color: token('anic-text-faint'), padding: '0 10px' } },
      t('health.title'),
      t('health.summary', { total: String(data.totalInvocations), rate: pct(data.overallSuccessRate) }),
    ),
    data.totalInvocations === 0
      ? createElement('div', { 'data-anic-skill-health-empty': 'true', style: { fontSize: 11, color: token('anic-text-faint'), padding: '4px 10px' } }, t('health.empty'))
      : createElement(
          'div',
          { 'data-anic-skill-health-list': 'true', style: { padding: '2px 10px', display: 'flex', flexDirection: 'column', gap: 3 } },
          ...data.scripts.map((s) => createElement(
            'div',
            {
              'data-anic-skill-health-script': s.script,
              'data-anic-skill-health-level': s.level,
              key: s.script,
              style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: 'ui-monospace, monospace', color: token('anic-text') },
            },
            // 等级徽标：字形+色双通道。
            createElement('span', { style: { color: levelColor(s.level), flexShrink: 0, width: 12, textAlign: 'center' } }, levelGlyph(s.level)),
            createElement('span', { style: { color: token('anic-text-strong'), minWidth: 90, overflowWrap: 'anywhere' } }, s.script),
            // 成功率微条形：连续量不只在文本里（宽 56px 轨道 + 填充）。
            createElement('span', { 'data-anic-skill-health-bar': pct(s.successRate), style: { width: 56, height: 6, background: token('anic-border'), flexShrink: 0, display: 'inline-block' } },
              createElement('span', { style: { display: 'block', width: pct(s.successRate), height: '100%', background: levelColor(s.level) } })),
            createElement('span', { title: t('health.successRate'), style: { color: token('anic-text-dim') } }, pct(s.successRate)),
            s.timeoutRate > 0 ? createElement('span', { title: t('health.timeoutRate'), style: { color: token('anic-warn-text') } }, `⏱${pct(s.timeoutRate)}`) : null,
            createElement('span', { title: t('health.avgDuration'), style: { color: token('anic-text-faint') } }, `${String(s.avgDurationMs)}ms`),
            createElement('span', { style: { color: token('anic-text-faint') } }, levelLabel(s.level)),
          )),
          // 建议列表：严重程度着色（critical 红 / warn 琥珀 / info 淡）。
          data.suggestions.length > 0
            ? createElement(
                'div',
                { 'data-anic-skill-health-suggestions': 'true', style: { paddingTop: 4 } },
                createElement('div', { style: { fontSize: 10, color: token('anic-text-faint') } }, t('health.suggestionsTitle')),
                ...data.suggestions.map((sug) => createElement(
                  'div',
                  {
                    'data-anic-skill-health-suggestion': sug.id,
                    key: sug.id,
                    style: { fontSize: 10, color: sug.severity === 'critical' ? token('anic-fail') : sug.severity === 'warn' ? token('anic-warn-text') : token('anic-text-dim') },
                  },
                  `${sug.script}: ${sug.description} → ${sug.action}`,
                )),
              )
            : null,
        ),
  );
}
