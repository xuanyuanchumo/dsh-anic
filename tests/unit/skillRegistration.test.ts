/**
 * skillRegistration 单元测试（cycle-97 官方技能注册）。
 *
 * 契约锚点：
 *   - dsh-plugin-dev-kb lib/index.js（在用参考实现）：register 输入
 *     { name, description, whenToUse?, source:'runtime', content, resourceBase? }，
 *     dsh-skill validateDefinition 要求 name/description/source/content 四字符串。
 *   - kb/site/reference/subsystems/skills.md：register 返回 disposer。
 *
 * 关键纪律：frontmatter 解析测试用**真实 SKILL.md**（assets/skill/SKILL.md，
 * 字段级转录而非手造样本）——手造样本只会测出解析器匹配手造样本。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSkillFrontmatter, registerRuntimeSkill, classifySkillVisibility, verifyRuntimeSkillVisibility, wireSkillsChange } from '../../src/host/skillRegistration.ts';
import { resetSkillsChangeCount, skillsChangeCount } from '../../src/host/runtime/skillsChangeCounter.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_SKILL_MD = join(HERE, '..', '..', 'assets', 'skill', 'SKILL.md');
/** 真实技能目录（dist 相对推导的同源路径，测试里显式传）。 */
const SKILL_DIR = join(HERE, '..', '..', 'assets', 'skill');

/** cycle-109 新增用例的临时目录（与本文件既有的 registerRuntimeSkill 作用域内 tmpd 分开）。 */
const CLEAN2: string[] = [];
function tmpd2(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anic-skillreg2-'));
  CLEAN2.push(dir);
  return dir;
}
afterEach((): void => { while (CLEAN2.length > 0) { const d = CLEAN2.pop(); if (d) rmSync(d, { recursive: true, force: true }); } });

describe('parseSkillFrontmatter', () => {
  it('解析真实 SKILL.md：name 为 ai-native-iteration-cycle，description 非空，body 以正文开头', () => {
    const md = readFileSync(REAL_SKILL_MD, 'utf-8');
    const parsed = parseSkillFrontmatter(md);
    expect(parsed.name).toBe('ai-native-iteration-cycle');
    expect(parsed.description).toBeTruthy();
    // 折叠块拼接：多行 description 变单空格分隔的单行，无换行残留
    expect(parsed.description).not.toMatch(/\n/);
    expect(parsed.description).toContain('AI-Native');
    // body 保留 frontmatter 终止符后的换行（CRLF 文件的真实字节），正文以 H1 开头
    expect(parsed.body.trimStart()).toMatch(/^#\s+AI-Native/);
  });
  it('单行值与 whenToUse 均可解析', () => {
    const parsed = parseSkillFrontmatter('---\nname: demo\ndescription: one line\nwhenToUse: 插件开发\n---\n\n# Body\n');
    expect(parsed.name).toBe('demo');
    expect(parsed.description).toBe('one line');
    expect(parsed.whenToUse).toBe('插件开发');
    expect(parsed.body).toBe('\n# Body\n');
  });
  it('引号包裹的值去引号', () => {
    const parsed = parseSkillFrontmatter('---\nname: "quoted"\ndescription: \'sq\'\n---\n');
    expect(parsed.name).toBe('quoted');
    expect(parsed.description).toBe('sq');
  });
  it('无 frontmatter → body=全文，name/description 缺失（fail-closed 输入）', () => {
    const parsed = parseSkillFrontmatter('# no frontmatter\n');
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe('# no frontmatter\n');
  });
  it('未知键被忽略，不进结果', () => {
    const parsed = parseSkillFrontmatter('---\nname: a\nversion: 9\nextra: x\ndescription: d\n---\n');
    expect(parsed.name).toBe('a');
    expect(parsed.description).toBe('d');
    expect('version' in parsed).toBe(false);
  });
});

describe('registerRuntimeSkill', () => {
  const CLEANUPS: string[] = [];
  function tmpd(): string {
    const dir = mkdtempSync(join(tmpdir(), 'anic-skillreg-'));
    CLEANUPS.push(dir);
    return dir;
  }
  // 每个用例后清理临时目录（mkdtemp + rmSync 是本仓 12 个测试文件的统一形态）
  afterEach((): void => { while (CLEANUPS.length > 0) { const d = CLEANUPS.pop(); if (d) rmSync(d, { recursive: true, force: true }); } });

  it('注册输入形状与官方契约逐字段一致（真实 SKILL.md）', () => {
    const register = vi.fn((): (() => void) => (): void => {});
    const ctx = { skills: { register } };
    const d = registerRuntimeSkill(ctx, SKILL_DIR);
    expect(d).toBeTypeOf('function');
    expect(register).toHaveBeenCalledTimes(1);
    const input = register.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.name).toBe('ai-native-iteration-cycle');
    expect(input.description).toBeTypeOf('string');
    expect(input.source).toBe('runtime');
    expect(input.content).toBeTypeOf('string');
    expect(String(input.content).trimStart()).toMatch(/^#\s+AI-Native/);
    expect(input.resourceBase).toEqual({ kind: 'directory', path: SKILL_DIR });
    // whenToUse 缺省时不得出现 undefined 值键（undefined 序列化差异是真实契约面）
    expect('whenToUse' in input && input.whenToUse === undefined).toBe(false);
  });
  it('宿主无 skills 服务 → null 跳过（多代防御），不抛异常', () => {
    expect(registerRuntimeSkill({}, SKILL_DIR)).toBeNull();
    expect(registerRuntimeSkill({ skills: {} }, SKILL_DIR)).toBeNull();
  });
  it('技能目录无效 → null 跳过（fail-closed，不猜）', () => {
    const register = vi.fn();
    expect(registerRuntimeSkill({ skills: { register } }, join(tmpd(), 'no-such-dir'))).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });
  it('frontmatter 缺 name/description → null 跳过', () => {
    const register = vi.fn();
    const dir = tmpd();
    writeFileSync(join(dir, 'SKILL.md'), '# no frontmatter\n');
    expect(registerRuntimeSkill({ skills: { register } }, dir)).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });
});

describe('cycle-109 调用策略贯通（fix D1：frontmatter 两键不再被静默丢弃）', () => {
  it('disable-model-invocation: true ⇒ modelInvocable=false 且传 invocation', () => {
    const parsed = parseSkillFrontmatter('---\nname: a\ndescription: d\ndisable-model-invocation: true\n---\n');
    expect(parsed.modelInvocable).toBe(false);
    expect(parsed.invocationDeclared).toBe(true);
  });
  it('user-invocable: false ⇒ userInvocable=false', () => {
    const parsed = parseSkillFrontmatter('---\nname: a\ndescription: d\nuser-invocable: false\n---\n');
    expect(parsed.userInvocable).toBe(false);
    expect(parsed.invocationDeclared).toBe(true);
  });
  it('两键都缺 ⇒ **不传** invocation（缺键不传：不把"没表态"写死成"表过态"）', () => {
    const register = vi.fn((): (() => void) => (): void => {});
    registerRuntimeSkill({ skills: { register } }, SKILL_DIR);
    const input = register.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('invocation' in input).toBe(false);
  });
  it('显式策略键 ⇒ invocation 如实出现在注册输入里', () => {
    const dir = tmpd2();
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false\n---\n\n# B\n');
    const register = vi.fn((): (() => void) => (): void => {});
    registerRuntimeSkill({ skills: { register } }, dir);
    const input = register.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.invocation).toEqual({ modelInvocable: false, userInvocable: false });
  });
  it('非法布尔值不猜（忽略该键，invocation 不出现）', () => {
    const parsed = parseSkillFrontmatter('---\nname: a\ndescription: d\nuser-invocable: yes\n---\n');
    expect(parsed.invocationDeclared).toBeUndefined();
  });
});

describe('classifySkillVisibility（cycle-109 · fix D2：注册 ≠ 可见）', () => {
  const snap = (names: string[], complete = true) => ({ skills: names.map((name) => ({ name, source: 'runtime', provider: 'anic' })), complete });
  it('complete 且命中 ⇒ active（带 source/provider 供分辨层）', () => {
    const r = classifySkillVisibility(snap(['ai-native-iteration-cycle']), 'ai-native-iteration-cycle');
    expect(r.state).toBe('active');
    expect(r.source).toBe('runtime');
    expect(r.provider).toBe('anic');
  });
  it('complete 且未命中 ⇒ absent（点名"可能被 project 层同名压制"）', () => {
    const r = classifySkillVisibility(snap([]), 'ai-native-iteration-cycle');
    expect(r.state).toBe('absent');
    expect(r.reason).toContain('shadow');
  });
  it('complete:false ⇒ unknown（**绝不** absent：不完整观测不可下结论）', () => {
    const r = classifySkillVisibility(snap([], false), 'x');
    expect(r.state).toBe('unknown');
  });
  it('snap=null（宿主无 snapshot/旧代）⇒ unknown，绝不 absent', () => {
    expect(classifySkillVisibility(null, 'x').state).toBe('unknown');
  });
  it('注册不受取证影响：无 snapshot 时 registerRuntimeSkill 仍返回 disposer', () => {
    const register = vi.fn((): (() => void) => (): void => {});
    expect(registerRuntimeSkill({ skills: { register } }, SKILL_DIR)).toBeTypeOf('function');
  });
  it('回读抛错 ⇒ unknown 且不冒泡（旁路不得拖垮激活）', async () => {
    const ctx = {
      skills: {
        register: (): (() => void) => (): void => {},
        snapshot: async (): Promise<never> => { throw new Error('boom'); },
      },
    };
    const r = await verifyRuntimeSkillVisibility(ctx, SKILL_DIR);
    expect(r?.state).toBe('unknown');
    expect(r?.reason).toContain('boom');
  });
  it('回读命中 ⇒ active（真实 SKILL.md 端到端）', async () => {
    const ctx = {
      skills: {
        register: (): (() => void) => (): void => {},
        snapshot: async () => ({ skills: [{ name: 'ai-native-iteration-cycle', source: 'runtime' }], complete: true }),
      },
    };
    const r = await verifyRuntimeSkillVisibility(ctx, SKILL_DIR);
    expect(r?.state).toBe('active');
  });
});

describe('skills/change 计数（cycle-109 · fix D3：工具面/技能面观测对称）', () => {
  it('host 无 ctx.on ⇒ false（不制造假监听）', () => {
    expect(wireSkillsChange({})).toBe(false);
  });
  it('订阅后事件到达 ⇒ 计数 +1（计数叶子与事件名钉死）', () => {
    resetSkillsChangeCount();
    const handlers: Record<string, () => void> = {};
    const ok = wireSkillsChange({ on: (n: string, h: () => void) => { handlers[n] = h; } });
    expect(ok).toBe(true);
    handlers['skills/change']?.();
    handlers['skills/change']?.();
    expect(skillsChangeCount()).toBe(2);
  });
});

describe('入口静态 inject 契约（cycle-97）', () => {
  it('src/index.ts 的 inject 含 skills 且不含可选服务（workspaceRegistry 仍走探测）', () => {
    // 读真实入口源码：消费 ctx.skills 的接线必须经静态 inject（官方 dsh-skill-badge
    // 同形态；ctx.inject 动态挂载在真实宿主不触发——见 skillRegistration.ts 历史注记）。
    const indexText = readFileSync(join(HERE, '..', '..', 'src', 'index.ts'), 'utf8');
    // cycle-74 P0：webServer 不再在父 inject（它由 dsh-web-app 提供，headless 无 => 整插件 pending）。
    expect(indexText).toMatch(/inject\s*=\s*\['tools',\s*'sessions',\s*'skills'\]/);
    expect(indexText, 'webServer 必须不在父 inject（P0）').not.toMatch(/inject\s*=\s*\[[^\]]*webServer/);
    expect(indexText).not.toMatch(/inject\s*=\s*\[[^\]]*workspaceRegistry/);
    // apply 必须经 effect 注册技能（disposer 记账），不能裸调用后丢弃返回值。
    // cycle-109：注册与可见性回读在同一 effect 里（回读是旁路，不得阻塞注册）。
    expect(indexText).toMatch(/registerRuntimeSkill\(ctx\)/);
    expect(indexText).toMatch(/const d = registerRuntimeSkill\(ctx\);/);
    expect(indexText).toMatch(/return d \?\? undefined;/);
    expect(indexText).toMatch(/verifyRuntimeSkillVisibility\(ctx\)/);
    expect(indexText).toMatch(/wireSkillsChange\(ctx\)/);
  });
});
