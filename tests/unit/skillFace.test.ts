/**
 * 技能**注册面**两行读数的渲染测试（cycle-109）。
 *
 * 为什么单独测：这两行是本轮「注册 ≠ 可见」「库全不全」两条取证结论的**唯一**用户面。
 * 若它们退化成不渲染或恒绿，宿主侧的三态裁决与对账读数就变成「有数据没人看」
 * —— 那正是本轮要消灭的形态（读数存在但无消费）。
 *
 * 三态各自可断言：`active` 绿 ✓ / `absent` 红 ✕ / `unknown` 淡 ○ —— 颜色不是唯一通道
 * （字形也在，色盲可达）。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderSkillHealth, type SkillHealthJson } from '../../src/client/features/skillhealth/renderSkillHealth.ts';

function report(over: Partial<SkillHealthJson> = {}): SkillHealthJson {
  return { scripts: [], suggestions: [], overallSuccessRate: 0, totalInvocations: 0, generatedAt: 'x', ...over };
}

describe('注册面：零占位', () => {
  it('两个字段都缺（旧宿主）⇒ 整块不渲染', () => {
    const html = renderToStaticMarkup(renderSkillHealth(report()));
    expect(html).not.toContain('data-anic-skill-registration');
    expect(html).not.toContain('data-anic-skill-visibility');
    expect(html).not.toContain('data-anic-skill-library');
  });
});

describe('runtime 技能可见性三态', () => {
  it('active ⇒ 绿 ✓ + 技能名 + 「模型可见」', () => {
    const html = renderToStaticMarkup(renderSkillHealth(report({
      runtimeSkill: { name: 'ai-native-iteration-cycle', state: 'active', reason: 'visible', skillsChangeEmits: 0 },
    })));
    expect(html).toContain('data-anic-skill-visibility="active"');
    expect(html).toContain('data-anic-skill-visibility-name="ai-native-iteration-cycle"');
    expect(html).toContain('模型可见');
    expect(html).toContain('✓');
  });

  it('absent ⇒ 红 ✕ + 「可能被同名技能压制」（点名成因，不只说"不可见"）', () => {
    const html = renderToStaticMarkup(renderSkillHealth(report({
      runtimeSkill: { name: 'n', state: 'absent', reason: 'shadowed', skillsChangeEmits: 0 },
    })));
    expect(html).toContain('data-anic-skill-visibility="absent"');
    expect(html).toContain('同名技能压制');
    expect(html).toContain('✕');
  });

  it('unknown ⇒ 淡 ○ + 「观测不完整」（**不**画成失败）', () => {
    const html = renderToStaticMarkup(renderSkillHealth(report({
      runtimeSkill: { name: 'n', state: 'unknown', reason: 'incomplete', skillsChangeEmits: 0 },
    })));
    expect(html).toContain('data-anic-skill-visibility="unknown"');
    expect(html).toContain('不可判定');
    expect(html).toContain('○');
    expect(html).not.toContain('✕');
  });

  it('skills/change 计数 >0 才显示变更行（0 不制造噪声）', () => {
    const on = renderToStaticMarkup(renderSkillHealth(report({
      runtimeSkill: { name: 'n', state: 'active', reason: 'r', skillsChangeEmits: 3 },
    })));
    expect(on).toContain('data-anic-skills-change="3"');
    const off = renderToStaticMarkup(renderSkillHealth(report({
      runtimeSkill: { name: 'n', state: 'active', reason: 'r', skillsChangeEmits: 0 },
    })));
    expect(off).not.toContain('data-anic-skills-change');
  });
});

describe('内部技能库对账', () => {
  it('ok ⇒ ✓ + 版本/技能数/问题数 + 「注册表与磁盘一致」', () => {
    const html = renderToStaticMarkup(renderSkillHealth(report({
      library: { ok: true, version: '0.4.0', updatedAt: '2026-11-06', skills: 10, issues: 0, summary: 's' },
    })));
    expect(html).toContain('data-anic-skill-library="ok"');
    expect(html).toContain('data-anic-skill-library-count="10"');
    expect(html).toContain('v0.4.0');
    expect(html).toContain('注册表与磁盘一致');
  });

  it('有问题 ⇒ issues 态 + ⚠（不显示"一致"）', () => {
    const html = renderToStaticMarkup(renderSkillHealth(report({
      library: { ok: false, version: '0.4.0', updatedAt: '2026-11-06', skills: 10, issues: 2, summary: 's' },
    })));
    expect(html).toContain('data-anic-skill-library="issues"');
    expect(html).toContain('data-anic-skill-library-issues="2"');
    expect(html).toContain('⚠');
    expect(html).not.toContain('注册表与磁盘一致');
  });

  it('两行同时存在时都渲染（两个面互不遮蔽）', () => {
    const html = renderToStaticMarkup(renderSkillHealth(report({
      runtimeSkill: { name: 'n', state: 'active', reason: 'r', skillsChangeEmits: 1 },
      library: { ok: true, version: '0.4.0', updatedAt: 'x', skills: 10, issues: 0, summary: 's' },
    })));
    expect(html).toContain('data-anic-skill-visibility');
    expect(html).toContain('data-anic-skill-library');
  });
});