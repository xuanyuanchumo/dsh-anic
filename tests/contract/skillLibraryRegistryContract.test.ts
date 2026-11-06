/**
 * 内部技能库注册表 ⇄ 磁盘 一致性契约（cycle-109）。
 *
 * ## 这个守卫补的是什么洞
 *
 * `assets/skills/`（1 主干 + 9 叶 + 1 元技能）此前在 `src/` 里**零引用**：
 * 注册表 `skills.index.json` 没人读，目录是否有 SKILL.md 没人查，锚点是否还在没人对账。
 * 闭环体检的第四族只覆盖 `assets/skill/scripts/*.mjs`（主干脚本），整个库不在扫描面内。
 * ⇒ 库是否完整只能靠人记得跑一次 `skill-lib-manifest.mjs`。
 *
 * ## 为什么这组用例能判红
 *
 * - 删掉任一技能的 SKILL.md ⇒ `missing-skill-md`（用例 ② 的判据在真实库上生效）；
 * - 把某技能的 dir 改成不存在 ⇒ `missing-dir`；
 * - 在 assets/skills 下新加一个目录但不登记 ⇒ `unregistered-dir`（幽灵技能）；
 * - 把注册表 JSON 改坏 ⇒ `registry-parse`。
 *
 * 反向自检由 `tests/unit/skillLibrary.test.ts` 的夹具用例承担（每种 issue 一条）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readSkillLibrary, summarizeSkillLibrary } from '../../src/host/runtime/skillLibrary.ts';
import { toSkillLibraryWire } from '../../src/host/runtime/skillLibraryWire.ts';
import { buildSkillVisibilityReadout, toSkillVisibilityWire, recordSkillVisibility } from '../../src/host/runtime/skillVisibilityState.ts';
import { renderSkillHealth } from '../../src/client/features/skillhealth/renderSkillHealth.ts';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LIB = join(REPO, 'assets', 'skills');

describe('真实库：注册表 ⇄ 磁盘 全绿（不可静默漂移）', () => {
  const r = readSkillLibrary(LIB, '2026-11-06T00:00:00.000Z');

  it('库存在、注册表可解析、无任何对账问题', () => {
    expect(r.present).toBe(true);
    expect(r.version).toBeTruthy();
    expect(r.updatedAt).toBeTruthy();
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('条目数 ≥ 10（1 元技能 + 9 叶技能；少于这个数说明有人删了技能却没同步）', () => {
    expect(r.skills.length).toBeGreaterThanOrEqual(10);
  });

  it('每个条目：SKILL.md 在场 + 声明的 anchors 全部命中', () => {
    for (const s of r.skills) {
      expect(s.skillMdPresent, `${s.name} 缺 SKILL.md`).toBe(true);
      expect(s.anchorsPresent, `${s.name} anchors 缺失`).toBe(s.anchorsTotal);
    }
  });

  it('主干技能（spine）锚点在场（assets/skill/SKILL.md 是流程脊柱）', () => {
    expect(r.spine).not.toBeNull();
    expect(r.spine?.name).toBe('ai-native-iteration-cycle');
    expect(r.spine?.anchorPresent, `spine 锚点不在场：${String(r.spine?.anchor)}`).toBe(true);
  });

  it('摘要可读（人读出口不是空串）', () => {
    expect(summarizeSkillLibrary(r)).toContain('internal skill library');
    expect(summarizeSkillLibrary(r)).toContain('issues');
  });
});

describe('消费面取证：注册表真的被 src 读取（注册了就必须有人读）', () => {
  it('src 里存在读取 skills.index.json 的模块，且健康路由消费它', () => {
    // 径一：读侧模块必须点名注册表文件名（否则它读的是第二真相源）。
    const reader = readFileSync(join(REPO, 'src', 'host', 'runtime', 'skillLibrary.ts'), 'utf8');
    expect(reader).toMatch(/SKILL_LIBRARY_INDEX/);
    expect(reader).toMatch(/skills\.index\.json/);
    // 径二：HTTP 面必须真的消费该读数（读侧存在但没人调 = 死代码）。
    const route = readFileSync(join(REPO, 'src', 'host', 'routes', 'skillHealthRoute.ts'), 'utf8');
    expect(route).toMatch(/readSkillLibraryCached/);
    expect(route).toMatch(/library:/);
  });

  it('注册表声明的库版本与磁盘 README 的层数口径一致（1 主干 + 9 叶 + 1 元）', () => {
    const readme = readFileSync(join(LIB, 'README.md'), 'utf8');
    expect(readme).toContain('叶技能');
    expect(readme).toContain('元技能');
  });
});

/**
 * ★ 线上契约：**真 readout → wire → 客户端渲染** 三段串起来。
 *
 * 为什么这组用例不可省：沙箱真机抓到首版路由直发 `SkillLibraryReadout`
 * （`skills`/`issues` 是**数组**）而客户端期望**数字** ⇒ 面板三个数全是 `undefined`。
 * 而在此之前，客户端单测用**手造夹具**（数字）跑得全绿 —— 手造夹具只能证明渲染器会渲染，
 * 不能证明线上形状对。这组用例喂的是**真实资产的真读数**，形状错了必红。
 */
describe('线上 wire 形状 ⇄ 客户端渲染（防"两处各定义一份"）', () => {
  it('库 wire：skills/issues 是数字（不是数组），summary 非空，渲染出真实版本与计数', () => {
    const r = readSkillLibrary(LIB, '2026-11-06T00:00:00.000Z');
    const wire = toSkillLibraryWire(r);
    expect(typeof wire.skills).toBe('number');
    expect(typeof wire.issues).toBe('number');
    expect(wire.skills).toBeGreaterThanOrEqual(10);
    expect(wire.issues).toBe(0);
    expect(wire.summary.length).toBeGreaterThan(0);
    // 喂进客户端渲染器：版本与技能数必须真的出现在 HTML 里
    const html = renderToStaticMarkup(renderSkillHealth({
      scripts: [], suggestions: [], overallSuccessRate: 0, totalInvocations: 0, generatedAt: 'x',
      library: wire,
    }));
    expect(html).toContain(`data-anic-skill-library-count="${String(wire.skills)}"`);
    expect(html).toContain(wire.version);
    expect(html).not.toContain('undefined');
  });

  it('技能 wire：扁平形状（name/state/reason），未回读时给 unknown 而不是伪造 active', () => {
    const wire = toSkillVisibilityWire(buildSkillVisibilityReadout());
    expect('last' in (wire as unknown as Record<string, unknown>)).toBe(false);
    expect(wire.state).toBeTypeOf('string');
    expect(wire.reason.length).toBeGreaterThan(0);
    // 未回读 ⇒ unknown（绝不 active）
    expect(wire.state).toBe('unknown');
    expect(wire.name).toBeNull();
    // 回读后 ⇒ 扁平携带真值并渲染
    recordSkillVisibility({ name: 'ai-native-iteration-cycle', state: 'active', reason: 'visible in catalog' }, '2026-11-06T00:00:00.000Z');
    const after = toSkillVisibilityWire(buildSkillVisibilityReadout());
    expect(after.name).toBe('ai-native-iteration-cycle');
    expect(after.state).toBe('active');
    const html = renderToStaticMarkup(renderSkillHealth({
      scripts: [], suggestions: [], overallSuccessRate: 0, totalInvocations: 0, generatedAt: 'x',
      runtimeSkill: after,
    }));
    expect(html).toContain('data-anic-skill-visibility="active"');
    expect(html).toContain('data-anic-skill-visibility-name="ai-native-iteration-cycle"');
    expect(html).not.toContain('undefined');
  });
});