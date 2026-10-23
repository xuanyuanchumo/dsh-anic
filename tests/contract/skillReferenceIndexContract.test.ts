/**
 * 技能面渐进式披露契约（cycle-73 T-7302）——「目录索引 ⇄ 参考文档」双向一致。
 *
 * 缺陷类：**参考文档存在但不可发现**。SKILL.md 的「导航索引」是模型在技能面唯一的
 * 发现入口（渐进式披露的第一跳）；新增 references/*.md 却忘了登记进索引，
 * 该文档就永远读不到——「产出了但没人读」在技能面的同族形态。
 * 反向同样致命：索引登记了不存在的文件，模型按图索骥会读到空（假承诺）。
 *
 * 两腿对账（与 panelAssemblyContract 面板三腿同方法论）：
 *   腿 1  磁盘真相：<skill>/references/*.md 实际文件集；
 *   腿 2  索引声明：SKILL.md「导航索引」表里 `references/*.md` 的反引号引用集。
 * 双向集合相等——漏登记与臆造都红。
 *
 * 守卫纪律（沿 docs/agents/开发规范-守卫与约束 §10）：
 *   ① 反向自检：变异体（少一个 / 多一个）必须使集合比较翻假；
 *   ② 扫描集非空下限：references ≥ 10（空集恒绿 = 假守卫）；
 *   ③ 不匹配自身：本测试不写索引，只读。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');

/* 只对账**分发源**（assets/skill）：它是安装/发布的真相源且仓库内可见；
 * .dsh/ 副本被 gitignore、由安装复制产生，若也纳入会在未安装时误红。
 * 两副本一致性由 skillIntegrity（doctor）另管——职责不重叠。 */
const SKILL_DIR = join(ROOT, 'assets', 'skill');
const REFERENCES_DIR = join(SKILL_DIR, 'references');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');

/** 腿 1：磁盘上真实存在的 references/*.md。 */
function actualReferences(): string[] {
  return readdirSync(REFERENCES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => 'references/' + f)
    .sort();
}

/** 腿 2：SKILL.md 里被引用的 `references/*.md`（反引号包裹，索引表形态）。 */
function indexedReferences(): string[] {
  const src = readFileSync(SKILL_MD, 'utf8');
  const found = new Set<string>();
  for (const m of src.matchAll(/`(references\/[A-Za-z0-9_.-]+\.md)`/g)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found].sort();
}

const actual = actualReferences();
const indexed = indexedReferences();

describe('cycle-73 T-7302 技能面渐进式披露契约（目录索引 ⇄ references）', () => {
  it('纪律② 扫描集非空下限：references ≥ 10、索引引用 ≥ 10（空集恒绿 = 假守卫）', () => {
    expect(actual.length).toBeGreaterThanOrEqual(10);
    expect(indexed.length).toBeGreaterThanOrEqual(10);
  });

  it('腿1 ⇄ 腿2：references 文件集与 SKILL.md 索引引用集双向相等', () => {
    expect(indexed).toEqual(actual);
  });

  it('每条索引引用都能在磁盘找到（防「索引指空」的假承诺）', () => {
    const missing = indexed.filter((rel) => !actual.includes(rel));
    expect(missing, '索引登记了不存在的文件: ' + missing.join(', ')).toEqual([]);
  });

  it('每个 references 文件都被索引登记（防「文件存在但不可发现」）', () => {
    const undocumented = actual.filter((rel) => !indexed.includes(rel));
    expect(undocumented, '存在但未登记进导航索引: ' + undocumented.join(', ')).toEqual([]);
  });

  it('纪律① 反向自检：变异体（少一个 / 多一个）必须使对账翻假', () => {
    expect(actual.slice(1)).not.toEqual(actual);
    expect([...actual, 'references/phantom.md'].sort()).not.toEqual(actual);
    expect(indexed.slice(1)).not.toEqual(actual);
    expect([...indexed, 'references/phantom.md'].sort()).not.toEqual(actual);
  });
});
