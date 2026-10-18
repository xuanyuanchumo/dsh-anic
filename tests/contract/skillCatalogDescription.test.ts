/**
 * 契约：SKILL.md 目录描述必须落在官方 catalogDescriptionMaxLength 窗口内（cycle-37 P1）。
 *
 * 背景（dsh-plugin-dev-kb / site/reference/subsystems/skills.md:233）：
 *   宿主把技能 description 注入模型可见的 <available_skills> 目录时会截到
 *   catalogDescriptionMaxLength（默认 500 字符）。修复前本技能 description 折叠后
 *   800 字符、触发词从第 585 字符才开始——目录里触发词整段被截掉，直接伤模型
 *   发现率（2026-10-19 本仓真实会话目录实证：截断发生在 "AI development — …"）。
 *
 * 修复形态（本测试钉死的契约）：
 *   1. 折叠后 description ≤ 500 字符（留 5% 余量按 500 计）；
 *   2. 以 "Triggers:" 开头——任何更短的截断窗口都先保住触发词；
 *   3. 含 'AI-Native'（skillRegistration.test.ts 同锚）与中文触发词面；
 *   4. whenToUse 仍在（技能详情视图的完整上下文，不受目录截断影响）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillFrontmatter } from '../../src/host/skillRegistration.ts';

const REAL_SKILL_MD = join(__dirname, '..', '..', 'assets', 'skill', 'SKILL.md');

/** 官方 catalogDescriptionMaxLength 默认值（skills.md:233）。 */
const CATALOG_DESCRIPTION_MAX = 500;

describe('契约：SKILL.md 目录描述 < catalogDescriptionMaxLength（500）', () => {
  const parsed = parseSkillFrontmatter(readFileSync(REAL_SKILL_MD, 'utf-8'));

  it('折叠后 description ≤ 500 字符（超限 = 目录截断 = 触发词不可见）', () => {
    expect(parsed.description).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const len = parsed.description!.length;
    expect(
      len,
      `description 折叠后 ${len} 字符 > ${CATALOG_DESCRIPTION_MAX}——宿主目录会截断尾部；` +
      '触发词必须前置并压缩全文（见 skills.md:233 catalogDescriptionMaxLength）',
    ).toBeLessThanOrEqual(CATALOG_DESCRIPTION_MAX);
  });

  it('触发词块在 description 开头（任何截断窗口先保住触发词）', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed.description!.startsWith('Triggers:')).toBe(true);
  });

  it('双语触发面：含 AI-Native 与中文触发词（skillRegistration 同锚）', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const desc = parsed.description!;
    expect(desc).toContain('AI-Native');
    expect(desc).toContain('质量门禁');
    expect(desc).toContain('convergence gate');
  });

  it('whenToUse 仍在（详情视图完整上下文，不随目录截断）', () => {
    expect(parsed.whenToUse).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed.whenToUse!.length).toBeGreaterThan(50);
  });
});
