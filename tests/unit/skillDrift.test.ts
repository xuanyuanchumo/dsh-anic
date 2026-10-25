/**
 * F-07/F-08 漂移判定测试（cycle-77 T3，台账 §7/§8）——真 IO，不 stub 文件系统。
 *
 * 测试策略与 skillIntegrity.test.ts 一致：真 inline（assets/skill，64 文件）×
 * 真 tmp 安装目录。哈希/复制语义只有真 IO 才能证明，因此这里照样走
 * autoInstallSkill 真安装 → 真篡改 → 真 repair。
 *
 * 覆盖（对应任务书 ①-⑤ + F-07 双轨 + P9 探针）：
 *  ① 顶层同名旧副本、哈希不同 ⇒ extraDrift 点名（台账 §8 实测形态：mcp-server.mjs）
 *  ② 同名同哈希散落副本 ⇒ 允许，不判红
 *  ③ 唯一名 extras ⇒ 仅报告（不属本插件判定域）
 *  ④ manifest version 落后于发行源 ⇒ manifestStale + mismatch kind=manifest-version
 *  ⑤ repair 后 manifest version/generatedAt 刷新且复验绿
 *  F-07：live 改一字节 ⇒ red 且点名该文件；版本落后 ⇒ live-behind；本地分叉 ⇒ live-diverged
 *  P9：自检探针真跑 verfySkillInstall（已装→真判定 / 发行源缺失→SKIP 不假绿 / 未装→省略）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoInstallSkill, inlineSkillRoot } from '../../src/host/skillInvoker.ts';
import {
  verifySkillInstall, repairSkillInstall, readSkillVersion, readSkillManifest,
  SKILL_MANIFEST_FILE, type SkillManifest,
} from '../../src/host/skillIntegrity.ts';
import { compareSkillVersions, computeExtraDrift } from '../../src/host/skillDrift.ts';
import { runSelfChecks } from '../../src/host/routes/selfCheckRoute.ts';

const TMP = join(import.meta.dirname, 'tmp-skill-drift');
const WS = join(TMP, 'proj');
const INSTALLED = join(WS, '.dsh', 'skills', 'ai-native-iteration-cycle');
const INLINE = inlineSkillRoot()!;
const INLINE_VERSION = readSkillVersion(INLINE)!;

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 并发清理容忍 */ }
});

/** 直接改落盘清单（模拟「清单未随修复重写」的历史现场）。 */
function mutateManifest(fn: (m: SkillManifest) => void): void {
  const p = join(INSTALLED, SKILL_MANIFEST_FILE);
  const m = JSON.parse(readFileSync(p, 'utf-8')) as SkillManifest;
  fn(m);
  writeFileSync(p, JSON.stringify(m, null, 2));
}

/** 纯净重装（每个 describe 前把 live 目录恢复到安装态，避免用例间串味）。 */
function freshInstall(): void {
  rmSync(INSTALLED, { recursive: true, force: true });
  expect(autoInstallSkill(WS).installed).toBe(true);
}

describe('F-08 extras 判定（台账 §8：只报告不判定 → 判 drift 但**不删除**）', () => {
  beforeAll(freshInstall);

  it('① 顶层同名旧副本、哈希不同 ⇒ extraDrift 点名，ok=false，文件仍在（不删除）', () => {
    // 复刻台账实测形态：scripts/mcp-server.mjs 存在，顶层又多一份旧的 mcp-server.mjs
    const oldCopy = join(INSTALLED, 'mcp-server.mjs');
    writeFileSync(oldCopy, '// stale top-level copy (16,093B 现场的等价物)\n');
    const v = verifySkillInstall(INSTALLED, INLINE);
    expect(v.ok).toBe(false);
    expect(v.extraDrift).toHaveLength(1);
    expect(v.extraDrift[0]).toMatchObject({
      path: 'mcp-server.mjs',
      counterpart: 'scripts/mcp-server.mjs',
    });
    expect(v.extraDrift[0]?.actualSha256).not.toBe(v.extraDrift[0]?.expectedSha256);
    expect(v.extras).toContain('mcp-server.mjs');
    // 权限边界：repair 也不删它（只报告）
    const r = repairSkillInstall(INSTALLED, INLINE);
    expect(r.verify.extraDrift.map((d) => d.path)).toEqual(['mcp-server.mjs']);
    rmSync(oldCopy);
  });

  it('② 同名同哈希散落副本 ⇒ 允许（不判红），仍列在 extras', () => {
    copyFileSync(join(INSTALLED, 'scripts', 'init-cycle.mjs'), join(INSTALLED, 'init-cycle.mjs'));
    const v = verifySkillInstall(INSTALLED, INLINE);
    expect(v.ok).toBe(true);
    expect(v.extraDrift).toEqual([]);
    expect(v.extras).toContain('init-cycle.mjs');
    rmSync(join(INSTALLED, 'init-cycle.mjs'));
  });

  it('③ 唯一名 extras ⇒ 仅报告（basename 未撞名不属插件判定域）', () => {
    writeFileSync(join(INSTALLED, 'user-notes.txt'), 'human note\n');
    const v = verifySkillInstall(INSTALLED, INLINE);
    expect(v.ok).toBe(true);
    expect(v.extraDrift).toEqual([]);
    expect(v.extras).toEqual(['user-notes.txt']);
    rmSync(join(INSTALLED, 'user-notes.txt'));
  });

  it('④ manifest version 落后于发行源 ⇒ manifestStale:true + mismatch kind=manifest-version', () => {
    mutateManifest((m) => { m.version = '2.3.0'; m.generatedAt = '2026-10-20T01:19:43.028Z'; });
    const v = verifySkillInstall(INSTALLED, INLINE);
    expect(v.ok).toBe(false);
    expect(v.manifestStale).toBe(true);
    expect(v.manifestVersion).toBe('2.3.0');
    expect(v.inlineVersion).toBe(INLINE_VERSION);
    const stale = v.mismatches.find((m) => m.kind === 'manifest-version');
    expect(stale).toMatchObject({ path: SKILL_MANIFEST_FILE, expected: INLINE_VERSION, actual: '2.3.0' });
    // 字节全绿但锚点陈旧 ⇒ 必须判 live-behind（§7 的「repair 会回滚 live」风险面）
    expect(v.mismatches.filter((m) => m.kind !== 'manifest-version')).toEqual([]);
    expect(v.dualTrack).toBe('live-behind');
  });

  it('⑤ repair 后 manifest version/generatedAt 刷新，复验绿', () => {
    const before = readSkillManifest(INSTALLED)!;
    const r = repairSkillInstall(INSTALLED, INLINE);
    expect(r.verify.ok).toBe(true);
    expect(r.verify.manifestStale).toBe(false);
    const after = readSkillManifest(INSTALLED)!;
    expect(after.version).toBe(INLINE_VERSION);
    expect(after.version).not.toBe(before.version);
    expect(after.generatedAt).not.toBe(before.generatedAt);
    expect(Date.parse(after.generatedAt)).toBeGreaterThan(Date.parse(before.generatedAt));
    expect(r.repaired).toEqual([]); // 只刷新清单锚点，未重装任何文件
  });
});

describe('F-07 双轨判定（台账 §7：live 副本落后于 assets 发行源）', () => {
  beforeAll(freshInstall);

  it('live 改一字节 ⇒ red 且点名该文件；repair 后复验绿且 dualTrack=in-sync', () => {
    const rel = 'references/gates.md';
    const p = join(INSTALLED, ...rel.split('/'));
    // 等长翻转尾字节：只破哈希、不动 size（size 差异走另一条判定分支）
    const buf = readFileSync(p);
    buf[buf.length - 1] = buf[buf.length - 1] === 0x0a ? 0x20 : 0x0a;
    writeFileSync(p, buf);
    const v = verifySkillInstall(INSTALLED, INLINE);
    expect(v.ok).toBe(false);
    expect(v.dualTrack).toBe('live-diverged'); // 版本相同但有字节分歧
    expect(v.mismatches.map((m) => `${m.path}:${m.kind}`)).toEqual([`${rel}:hash`]);
    const r = repairSkillInstall(INSTALLED, INLINE);
    expect(r.repaired).toEqual([rel]);
    expect(r.verify.ok).toBe(true);
    expect(r.verify.dualTrack).toBe('in-sync');
  });

  it('live 版本低于发行源 ⇒ dualTrack=live-behind（副本落后，不是本地分叉）', () => {
    const p = join(INSTALLED, 'SKILL.md');
    const orig = readFileSync(p, 'utf-8');
    writeFileSync(p, orig.replace(`(v${INLINE_VERSION})`, '(v2.0.0)'));
    const v = verifySkillInstall(INSTALLED, INLINE);
    expect(v.ok).toBe(false);
    expect(v.liveVersion).toBe('2.0.0');
    expect(v.dualTrack).toBe('live-behind');
    repairSkillInstall(INSTALLED, INLINE);
  });

  it('发行源不可用 ⇒ reference=manifest 且 dualTrack=unknown（无对照不猜）', () => {
    const v = verifySkillInstall(INSTALLED, null);
    expect(v.reference).toBe('manifest');
    expect(v.ok).toBe(true);
    expect(v.dualTrack).toBe('unknown');
    expect(v.inlineVersion).toBeNull();
  });

  it('版本比较与 extras 纯函数边界（不可解析 → null，不猜方向）', () => {
    expect(compareSkillVersions('2.3.0', '2.5.2')).toBeLessThan(0);
    expect(compareSkillVersions('2.5.2', '2.5.2')).toBe(0);
    expect(compareSkillVersions('2.6.0', '2.5.2')).toBeGreaterThan(0);
    expect(compareSkillVersions(null, '2.5.2')).toBeNull();
    expect(compareSkillVersions('nope', '2.5.2')).toBeNull();
    // 同名同哈希 → 不判；同名不同哈希 → 判；唯一名 → 不判；读不出哈希 → 不判「安全」
    // 注：同名 = basename 相同（scripts/a.mjs 的 basename 是 a.mjs）
    const entries = [{ path: 'scripts/a.mjs', sha256: 'aaa' }];
    const hashOf: Record<string, string> = { 'a.mjs': 'aaa', 'top/a.mjs': 'zzz' };
    const h = (rel: string): string | null => hashOf[rel] ?? null;
    expect(computeExtraDrift(['a.mjs', 'top/a.mjs', 'unique.txt', 'b.mjs'], entries, h)).toEqual([
      { path: 'top/a.mjs', counterpart: 'scripts/a.mjs', expectedSha256: 'aaa', actualSha256: 'zzz' },
    ]);
  });
});

describe('P9-skill-dual-track 自检探针（runtime consumer：判定真的被消费）', () => {
  beforeAll(freshInstall);

  const baseInput = {
    agentCardsDir: join(process.cwd(), 'assets', 'agents'),
    indexDir: join(process.cwd(), 'assets', 'index'),
  };

  it('已装技能 ⇒ P9 真判定（ok:true + in-sync 明细）', () => {
    const { checks } = runSelfChecks({ workspaceRoot: WS, ...baseInput });
    const p9 = checks.find((c) => c.id === 'P9-skill-dual-track');
    expect(p9).toBeDefined();
    expect(p9?.ok).toBe(true);
    expect(p9?.skipped).toBeUndefined();
    expect(String(p9?.detail)).toContain('in-sync');
  });

  it('live 漂移 ⇒ P9 ok:false 并点名漂移文件（可 grep 到具体文件）', () => {
    const p = join(INSTALLED, 'scripts', 'band-detector.mjs');
    const orig = readFileSync(p, 'utf-8');
    writeFileSync(p, orig.replace('band', 'bxnd'));
    const { checks } = runSelfChecks({ workspaceRoot: WS, ...baseInput });
    const p9 = checks.find((c) => c.id === 'P9-skill-dual-track');
    expect(p9?.ok).toBe(false);
    expect(String(p9?.detail)).toContain('scripts/band-detector.mjs(hash)');
    repairSkillInstall(INSTALLED, INLINE);
  });

  it('发行源缺失 ⇒ 明确 SKIP（ok 但不参与 allOk，绝不假绿）', () => {
    const { checks, allOk } = runSelfChecks({
      workspaceRoot: WS, ...baseInput,
      skillPaths: { inlineDir: join(TMP, 'no-such-inline'), installedDir: INSTALLED },
    });
    const p9 = checks.find((c) => c.id === 'P9-skill-dual-track');
    expect(p9?.skipped).toBe(true);
    expect(String(p9?.detail)).toContain('SKIP');
    // allOk 只对 skipped 之外的项求值：跳过项不得被当成绿灯，也不得把它算成红灯
    expect(allOk).toBe(checks.filter((c) => !c.skipped).every((c) => c.ok));
  });

  it('未安装技能 ⇒ P9 省略（双轨不成立，不制造假项）', () => {
    const bare = join(TMP, 'bare-proj');
    mkdirSync(join(bare, '.dsh', 'skills'), { recursive: true });
    const { checks } = runSelfChecks({ workspaceRoot: bare, ...baseInput });
    expect(checks.some((c) => c.id === 'P9-skill-dual-track')).toBe(false);
    expect(checks.length).toBe(8); // 既有 8 项形状不变（探针只追加，不删改）
  });
});
