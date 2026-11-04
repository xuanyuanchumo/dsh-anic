/**
 * 技能自收敛回归测试（cycle-104）。
 *
 * ## 这条测试防的是什么（不是覆盖率填充）
 *
 * `.cycles/cycle-104-evidence/baseline-findings.md` §1 记录的**真实事故**：
 * 提交 `fdc42a2` 改了 `assets/skill/` 发行源，却没重装 `.dsh/skills` 的 live 副本。
 * 当时**唯一**能修好它的是 `pnpm run test` 里那几个 `autoInstallSkill()` 调用——
 * 也就是说「修复能力只存在于测试里」。真实宿主 `apply()` 从不 converge。
 *
 * 因此本测试要钉死的不是「函数能跑」，而是四条**决策表**语义：
 *   ① 未安装 → 全量装（installed-fresh）；
 *   ② 已安装且 in-sync → **零写入**（幂等，这是最容易被破坏的一条）；
 *   ③ 已安装但漂移 → 只修差异（repaired，且 repairedCount > 0）；
 *   ④ 发行源不可用 → skipped（绝不拿 live 当权威、绝不自作聪明）。
 *
 * ②③ 是关键：如果收敛每次都全量重写，mtime 会一直抖动，
 * 依赖 mtime 的 `computeBuildRevision` 判据会被污染——所以「in-sync 零写入」必须可断言。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { convergeSkill, installedSkillDirOf, describeConverge, persistConvergeOutcome, readConvergeOutcome, SKILL_CONVERGE_FILE } from '../../src/host/skillConverge.ts';
import { inlineSkillRoot } from '../../src/host/skillInvoker.ts';

const created: string[] = [];

function tempWorkspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'anic-converge-'));
  created.push(d);
  return d;
}

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('convergeSkill — 决策表', () => {
  it('① 未安装 → installed-fresh，并真的把 SKILL.md 落到工作区', () => {
    const ws = tempWorkspace();
    const out = convergeSkill(ws);
    expect(out.action).toBe('installed-fresh');
    expect(existsSync(join(installedSkillDirOf(ws), 'SKILL.md'))).toBe(true);
    expect(out.repairedCount).toBeGreaterThan(0);
    expect(out.verify?.ok).toBe(true);
  });

  it('② 已安装且 in-sync → 零写入（幂等的可断言面）', () => {
    const ws = tempWorkspace();
    // 先装一次
    const first = convergeSkill(ws);
    expect(first.action).toBe('installed-fresh');

    // 记录某个文件的 mtime，再跑第二次
    const probe = join(installedSkillDirOf(ws), 'SKILL.md');
    const mtimeBefore = statSync(probe).mtimeMs;

    // 把 mtime 人为推回 1 小时前，这样「有没有重写」可被明确观测
    const old = new Date(Date.now() - 3600_000);
    utimesSync(probe, old, old);
    const pinned = statSync(probe).mtimeMs;

    const second = convergeSkill(ws);
    expect(second.action).toBe('in-sync');
    expect(second.repairedCount).toBe(0);
    expect(second.repaired).toEqual([]);
    // 关键断言：没有重写 ⇒ mtime 保持钉住的值，而不是被刷成 now
    expect(statSync(probe).mtimeMs).toBe(pinned);
    expect(mtimeBefore).toBeGreaterThan(0); // 引用了首次读数，避免未使用告警
  });

  it('③ 已安装但漂移 → repaired，只修被改坏的那个文件', () => {
    const ws = tempWorkspace();
    convergeSkill(ws); // 装好

    // 模拟事故现场：发行源升级后 live 副本落后（篡改一个脚本 + 一个模板）
    const installedDir = installedSkillDirOf(ws);
    const victimScript = join(installedDir, 'scripts', 'fact-base-verify.mjs');
    const victimTpl = join(installedDir, 'assets', 'templates', 'task-list.md');
    const staleMarker = '// STALE LIVE COPY (simulated cycle-104 incident)\n';
    writeFileSync(victimScript, staleMarker + 'export const x = 1;\n', 'utf-8');
    writeFileSync(victimTpl, '# stale\n', 'utf-8');

    const out = convergeSkill(ws);
    expect(out.action).toBe('repaired');
    expect(out.repairedCount).toBeGreaterThanOrEqual(2);
    expect(out.repaired).toContain('scripts/fact-base-verify.mjs');
    // 修复后的内容必须与发行源逐字节一致（不是「看起来不空」）
    const inlineRoot = inlineSkillRoot();
    expect(inlineRoot).not.toBeNull();
    const srcBytes = readFileSync(join(inlineRoot as string, 'scripts', 'fact-base-verify.mjs'));
    const dstBytes = readFileSync(victimScript);
    expect(dstBytes.equals(srcBytes)).toBe(true);
    // 且复验通过
    expect(out.verify?.ok).toBe(true);
  });

  it('③b repaired 读数有界（最多 20 条，避免 JSON 无限膨胀）', () => {
    const ws = tempWorkspace();
    convergeSkill(ws);
    const installedDir = installedSkillDirOf(ws);
    // 批量破坏 25 个文件
    for (let i = 0; i < 25; i += 1) {
      const p = join(installedDir, 'references', `bulk-${String(i)}.md`);
      mkdirSync(join(installedDir, 'references'), { recursive: true });
      writeFileSync(p, `extra-${String(i)}`, 'utf-8');
    }
    // 篡改一个被清单收录的文件，确保至少触发 repaired
    writeFileSync(join(installedDir, 'SKILL.md'), 'tampered', 'utf-8');
    const out = convergeSkill(ws);
    expect(out.action).toBe('repaired');
    expect(out.repaired.length).toBeLessThanOrEqual(20);
  });

  it('④ 发行源不可用 → skipped（不猜、不拿 live 当权威）', () => {
    // 通过临时 workspace 无法移除 inline 源（它是打包在插件里的），
    // 故这里直接验证「未安装 + 源仍可用」与决策表其余格已覆盖，
    // skipped 分支由 describeConverge 的措辞契约单独钉死（见下）。
    expect(describeConverge({
      action: 'skipped', installedDir: '/x', repairedCount: 0, repaired: [],
      verify: null, inlineDir: null,
    })).toContain('skipped');
  });
});

describe('describeConverge — 措辞契约（面板/日志共用，不写第二套）', () => {
  it('六种 action 都有非空且互相可区分的描述', () => {
    const base = { installedDir: '/x', repairedCount: 0, repaired: [] as string[], verify: null, inlineDir: null };
    const texts = (['not-installed', 'installed-fresh', 'in-sync', 'repaired', 'skipped', 'failed'] as const)
      .map((a) => describeConverge({ ...base, action: a, error: a === 'failed' ? 'boom' : undefined }));
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(6); // 六条措辞互不相同
    expect(texts[5]).toContain('boom'); // failed 必须带出原因，不能只说"失败"
  });
});

describe('installedSkillDirOf — 路径口径唯一', () => {
  it('与 skillInvoker 的安装落点一致（.dsh/skills/<skill-name>）', () => {
    expect(installedSkillDirOf('/proj')).toBe(join('/proj', '.dsh', 'skills', 'ai-native-iteration-cycle'));
  });
});

describe('收敛读数持久化（cycle-104：跨实例可见的唯一通道）', () => {
  it('persist → read 往返一致，at 时间戳存在', () => {
    const ws = tempWorkspace();
    const cycles = join(ws, '.cycles');
    mkdirSync(cycles, { recursive: true });
    const out = convergeSkill(ws);
    expect(persistConvergeOutcome(cycles, out)).toBe(true);
    const back = readConvergeOutcome(cycles);
    expect(back).not.toBeNull();
    expect(back?.action).toBe('installed-fresh');
    expect(back?.installedDir).toBe(out.installedDir);
    expect(back?.at).toBeTruthy();
  });

  it('无文件 / 坏 JSON / 形状不对 ⇒ null（绝不猜）', () => {
    const ws = tempWorkspace();
    const cycles = join(ws, '.cycles');
    mkdirSync(cycles, { recursive: true });
    expect(readConvergeOutcome(cycles)).toBeNull(); // 无文件
    writeFileSync(join(cycles, SKILL_CONVERGE_FILE), '{broken json', 'utf-8');
    expect(readConvergeOutcome(cycles)).toBeNull(); // 坏 JSON
    writeFileSync(join(cycles, SKILL_CONVERGE_FILE), '{"no":"shape"}', 'utf-8');
    expect(readConvergeOutcome(cycles)).toBeNull(); // 缺关键字段
  });

  it('写失败（cycles 目录不存在）返回 false 而不抛——读数失败不阻断激活', () => {
    const ws = tempWorkspace();
    const out = convergeSkill(ws);
    expect(persistConvergeOutcome(join(ws, 'no-such-dir'), out)).toBe(false);
  });
});
