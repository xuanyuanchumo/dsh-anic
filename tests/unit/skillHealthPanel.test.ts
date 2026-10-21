/**
 * 技能健康面板渲染测试（cycle-20 P3 · ui-domain-plan 技能健康面板）。
 *
 * 与 invocationsRender.test.ts 同纪律：renderToStaticMarkup 真渲染。
 * 契约面：null→不渲染；空历史→引导文案；脚本行（等级徽标/微条形/超时率）；
 * 建议列表（severity 着色）；isSkillHealth 守卫。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderSkillHealth, isSkillHealth, type SkillHealthJson, type ScriptHealthJson } from '../../src/client/features/skillhealth/renderSkillHealth.ts';

function sh(over: Partial<ScriptHealthJson>): ScriptHealthJson {
  return {
    script: 'gate-check', level: 'healthy', total: 10, successRate: 1, timeoutRate: 0, avgDurationMs: 1200, ...over,
  };
}

function report(over: Partial<SkillHealthJson> = {}): SkillHealthJson {
  return {
    scripts: [sh({})],
    suggestions: [],
    overallSuccessRate: 1,
    totalInvocations: 10,
    generatedAt: '2026-10-18T00:00:00.000Z',
    ...over,
  };
}

describe('renderSkillHealth（技能健康面板）', () => {
  it('null → 渲染器返回 null（调用方不渲染本节，与 ledger 同模式）', () => {
    expect(renderSkillHealth(null)).toBeNull();
  });

  it('空调用历史：如实显示引导文案，不伪造绿色', () => {
    const html = renderToStaticMarkup(renderSkillHealth(report({ scripts: [], totalInvocations: 0, overallSuccessRate: 0 })));
    expect(html).toContain('data-anic-skill-health="section"');
    expect(html).toContain('data-anic-skill-health-empty');
    expect(html).toContain('尚无调用历史');
    expect(html).not.toContain('data-anic-skill-health-script');
  });

  it('脚本行：script 名 + 等级标记 + 成功率微条形 + 平均耗时 + 等级标签', () => {
    const html = renderToStaticMarkup(renderSkillHealth(report()));
    expect(html).toContain('data-anic-skill-health-script="gate-check"');
    expect(html).toContain('data-anic-skill-health-level="healthy"');
    expect(html).toContain('data-anic-skill-health-bar="100%"');
    expect(html).toContain('✓'); // healthy 字形
    expect(html).toContain('100%');
    expect(html).toContain('1200ms');
    expect(html).toContain('健康');
  });

  it('六级等级：字形与标签逐级区分（色盲双通道）', () => {
    const levels: ScriptHealthJson['level'][] = ['healthy', 'degraded', 'slow', 'expensive', 'insufficient', 'unused'];
    const scripts = levels.map((lv, i) => sh({ script: `s-${lv}`, level: lv, total: i + 1, successRate: lv === 'degraded' ? 0.6 : 1, timeoutRate: lv === 'slow' ? 0.3 : 0 }));
    const html = renderToStaticMarkup(renderSkillHealth(report({ scripts })));
    for (const lv of levels) {
      expect(html).toContain(`data-anic-skill-health-script="s-${lv}"`);
      expect(html).toContain(`data-anic-skill-health-level="${lv}"`);
    }
    expect(html).toContain('✕'); // degraded
    expect(html).toContain('⏱'); // slow
    expect(html).toContain('⌛'); // expensive
    expect(html).toContain('○'); // insufficient
  });

  it('超时率 > 0 时显示 ⏱%；= 0 时不显示（不渲染零噪音）', () => {
    const withTimeout = renderToStaticMarkup(renderSkillHealth(report({
      scripts: [sh({ timeoutRate: 0.25 })],
    })));
    expect(withTimeout).toContain('⏱25%');
    const noTimeout = renderToStaticMarkup(renderSkillHealth(report()));
    expect(noTimeout).not.toContain('⏱0%');
  });

  it('建议列表：severity 三档着色 + 文案贯通（script: description → action）', () => {
    const html = renderToStaticMarkup(renderSkillHealth(report({
      scripts: [sh({ level: 'degraded', successRate: 0.5, total: 8 })],
      suggestions: [{
        id: 'fix-gate-check', severity: 'critical', script: 'gate-check',
        description: 'gate-check 成功率 50%（8 次调用）', action: '检查 stderr 日志',
      }],
    })));
    expect(html).toContain('data-anic-skill-health-suggestions');
    expect(html).toContain('data-anic-skill-health-suggestion="fix-gate-check"');
    expect(html).toContain('gate-check 成功率 50%（8 次调用）');
    expect(html).toContain('检查 stderr 日志');
  });

  it('无建议时不渲染建议区块（healthy 全绿零噪音）', () => {
    const html = renderToStaticMarkup(renderSkillHealth(report()));
    expect(html).not.toContain('data-anic-skill-health-suggestions');
  });

  it('isSkillHealth 守卫：合法形状过、畸形形状拒', () => {
    expect(isSkillHealth(report())).toBe(true);
    expect(isSkillHealth(null)).toBe(false);
    expect(isSkillHealth('nope')).toBe(false);
    expect(isSkillHealth({ scripts: [] })).toBe(false); // 缺数值汇总
    expect(isSkillHealth({ scripts: [], totalInvocations: 0, overallSuccessRate: 0 })).toBe(true); // 空历史合法
  });
});

describe('cycle-53 T-5301 面板近期窗口展示（双量纲不丢史）', () => {
  const base = {
    suggestions: [], overallSuccessRate: 0.5, totalInvocations: 8,
    generatedAt: '2026-10-21T00:00:00.000Z',
  };

  it('recentSuccessRate 存在 → 主数值/条形看近期，title 带双量纲', () => {
    const html = renderToStaticMarkup(renderSkillHealth({
      ...base,
      scripts: [{
        script: 'workflow-state', level: 'healthy', total: 8,
        successRate: 0.625, recentSuccessRate: 1, timeoutRate: 0, avgDurationMs: 120,
      }],
    }));
    // 主数值 100%（近期）+ title 双量纲（近期 100%/全史 63%）。
    expect(html).toContain('data-anic-skill-health-rate="100%"');
    expect(html).toContain('title="近期成功率 100% · 全史 63%"');
  });

  it('旧宿主无 recentSuccessRate → 回落全史（零回归面）', () => {
    const html = renderToStaticMarkup(renderSkillHealth({
      ...base,
      scripts: [{
        script: 'gate-check', level: 'degraded', total: 5,
        successRate: 0.4, timeoutRate: 0, avgDurationMs: 200,
      }],
    }));
    expect(html).toContain('data-anic-skill-health-rate="40%"');
    expect(html).toContain('title="近期成功率 40% · 全史 40%"');
  });
});

describe('cycle-57 T-5702 面板陈旧态（近 7 天无网关调用）', () => {
  const base = {
    suggestions: [], overallSuccessRate: 0.5, totalInvocations: 3,
    generatedAt: '2026-10-21T00:00:00.000Z',
  };

  it('recentSuccessRate=null（新宿主无近期数据）→ 陈旧徽标 + title 无近期数据说明', () => {
    const html = renderToStaticMarkup(renderSkillHealth({
      ...base,
      scripts: [{
        script: 'workflow-state', level: 'insufficient', total: 3,
        successRate: 0, timeoutRate: 0, avgDurationMs: 100,
        recentSuccessRate: null,
      }],
    }));
    // 陈旧徽标可见（undefined 态可视化——「近 7 天无调用」不是 0% 也不是全史）
    expect(html).toContain('data-anic-skill-health-stale="true"');
    expect(html).toContain('◦7d');
    // title 明确说「当前状态不可判定」而非冒充
    expect(html).toContain('近 7 天无网关调用，当前状态不可判定（展示全史值）');
    // 主数值回落全史（0%）——但 title 与徽标共同标注这是全史值
    expect(html).toContain('data-anic-skill-health-rate="0%"');
  });

  it('旧宿主字段缺省（undefined 形态）→ 无陈旧徽标 + 回落全史 title（零回归面）', () => {
    const html = renderToStaticMarkup(renderSkillHealth({
      ...base,
      scripts: [{
        script: 'gate-check', level: 'degraded', total: 5,
        successRate: 0.4, timeoutRate: 0, avgDurationMs: 200,
      }],
    }));
    expect(html).not.toContain('data-anic-skill-health-stale');
    expect(html).toContain('title="近期成功率 40% · 全史 40%"');
  });
});
