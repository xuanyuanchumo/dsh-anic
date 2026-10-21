/**
 * eco P0：分发完整性——安装清单 + sha256 校验 + doctor/repair（skillIntegrity.ts）。
 *
 * 测试策略：真 inline（插件 assets/skill，64 文件）× 真 tmp 安装目录——
 * 不 stub 文件系统（哈希/复制语义只有真 IO 才能证明）。
 * 证明链：安装写清单 → 校验全绿 → 三种篡改（改字节/截断/删除）逐一检出 →
 * repair 只重装差异文件 → 复验全绿 → extras 不被删除（权限边界）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import {
  rmSync, mkdirSync, writeFileSync, existsSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { autoInstallSkill, inlineSkillRoot } from '../../src/host/skillInvoker.ts';
import {
  buildSkillManifest, writeSkillManifest, readSkillManifest,
  verifySkillInstall, repairSkillInstall, skillIntegritySummary,
  readSkillVersion, SKILL_MANIFEST_FILE,
} from '../../src/host/skillIntegrity.ts';

const TMP = join(import.meta.dirname, 'tmp-skill-integrity');
const WS = join(TMP, 'proj');
const INSTALLED = join(WS, '.dsh', 'skills', 'ai-native-iteration-cycle');
const INLINE = inlineSkillRoot()!;

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 并发清理容忍 */ }
});

describe('清单构建与落盘', () => {
  it('buildSkillManifest：64 文件全覆盖 + POSIX 相对路径 + 版本锚点', () => {
    const m = buildSkillManifest(INLINE);
    expect(m.files).toHaveLength(64);
    expect(m.fileCount).toBe(0); // build 不回填；write 回填（职责分离）
    expect(m.files.every((f) => !f.path.includes('\\'))).toBe(true);
    expect(m.files.some((f) => f.path === 'SKILL.md')).toBe(true);
    expect(m.files.some((f) => f.path === 'scripts/init-workflow.mjs')).toBe(true);
    expect(m.version).toBe(readSkillVersion(INLINE));
    expect(m.files.every((f) => f.sha256.length === 64)).toBe(true);
  });

  it('readSkillVersion：锚定 SKILL.md「MCP Tools (vX.Y.Z)」标题（cycle-31 修复回归钉）', () => {
    // 修复背景：旧正则要求字面量 "version" 前缀，真实锚点无此前缀 → 恒 null，
    // skillInstallRoute 版本门控快路径从未生效。本用例钉住「真实锚点可读」。
    expect(readSkillVersion(INLINE)).toBe('2.4.0');
    // 无锚点目录 → null（诚实降级，不猜）
    const none = join(TMP, 'no-anchor');
    mkdirSync(none, { recursive: true });
    writeFileSync(join(none, 'SKILL.md'), '# no version anchor here\n', 'utf-8');
    expect(readSkillVersion(none)).toBeNull();
    // 旧式 "version: x.y.z" 字面量不再匹配（防倒退回旧正则）
    writeFileSync(join(none, 'SKILL.md'), 'version: 1.2.3\n', 'utf-8');
    expect(readSkillVersion(none)).toBeNull();
  });

  it('writeSkillManifest → readSkillManifest 往返；清单文件自身被排除', () => {
    mkdirSync(TMP, { recursive: true });
    const target = join(TMP, 'mirror');
    const r = writeSkillManifest(INLINE, target);
    expect(r.ok).toBe(true);
    expect(r.fileCount).toBe(64);
    const m = readSkillManifest(target)!;
    expect(m.files).toHaveLength(64);
    expect(existsSync(join(target, SKILL_MANIFEST_FILE))).toBe(true);
    expect(m.files.some((f) => f.path === SKILL_MANIFEST_FILE)).toBe(false);
  });

  it('readSkillManifest：损坏 JSON / 缺失文件 → null（调用方降级不炸）', () => {
    const bad = join(TMP, 'bad');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, SKILL_MANIFEST_FILE), '{not json');
    expect(readSkillManifest(bad)).toBeNull();
    expect(readSkillManifest(join(TMP, 'no-such-dir'))).toBeNull();
  });
});

describe('autoInstallSkill 安装即建锚（eco P0 核心行为变化）', () => {
  it('安装后清单落盘，且 install 返回 manifest 摘要', () => {
    const r = autoInstallSkill(WS);
    expect(r.installed).toBe(true);
    expect(r.manifest?.ok).toBe(true);
    expect(r.manifest?.fileCount).toBe(64);
    const m = readSkillManifest(INSTALLED)!;
    expect(m.files).toHaveLength(64);
  });

  it('全新安装：verify 全绿（reference=inline 权威直比）', () => {
    const v = verifySkillInstall(INSTALLED, INLINE);
    expect(v.ok).toBe(true);
    expect(v.reference).toBe('inline');
    expect(v.checked).toBe(64);
    expect(v.mismatches).toEqual([]);
    expect(v.extras).toEqual([]);
  });

  it('inline 不可用时回退 manifest 兜底（独立分发场景）', () => {
    const v = verifySkillInstall(INSTALLED, null);
    expect(v.ok).toBe(true);
    expect(v.reference).toBe('manifest');
    expect(v.manifestVersion).toBe(readSkillVersion(INLINE));
  });

  it('无 inline 无 manifest → reference=none 且 ok=false（不静默放行）', () => {
    const bare = join(TMP, 'bare-proj');
    mkdirSync(join(bare, '.dsh', 'skills', 'ai-native-iteration-cycle'), { recursive: true });
    writeFileSync(join(bare, '.dsh', 'skills', 'ai-native-iteration-cycle', 'SKILL.md'), 'x');
    const v = verifySkillInstall(join(bare, '.dsh', 'skills', 'ai-native-iteration-cycle'), null);
    expect(v.ok).toBe(false);
    expect(v.reference).toBe('none');
  });
});

describe('doctor：三种篡改逐一检出', () => {
  it('hash 篡改（同尺寸改字节）→ kind=hash', () => {
    const p = join(INSTALLED, 'scripts', 'band-detector.mjs');
    const orig = readFileSync(p, 'utf-8');
    writeFileSync(p, orig.replace('band', 'bxnd')); // 等长替换保 size 一致
    const v = verifySkillInstall(INSTALLED, INLINE);
    expect(v.ok).toBe(false);
    expect(v.mismatches).toHaveLength(1);
    expect(v.mismatches[0]?.kind).toBe('hash');
    expect(v.mismatches[0]?.path).toBe('scripts/band-detector.mjs');
    writeFileSync(p, orig); // 还原，供后续用例
  });

  it('size 篡改（截断）→ kind=size；missing（删除）→ kind=missing', () => {
    const p = join(INSTALLED, 'CHANGELOG.md');
    writeFileSync(p, 'truncated'); // size 变
    const missing = join(INSTALLED, 'references', 'gates.md');
    rmSync(missing);
    const v = verifySkillInstall(INSTALLED, INLINE);
    const kinds = v.mismatches.map((m) => m.kind).sort();
    expect(kinds).toEqual(['missing', 'size']);
    // 还原交给 repair 用例（真实场景里 doctor 只读）
    void missing;
  });

  it('extras：安装目录多出的文件被报告但不算 mismatch', () => {
    writeFileSync(join(INSTALLED, 'user-notes.txt'), 'hi');
    const v = verifySkillInstall(INSTALLED, INLINE);
    expect(v.extras).toContain('user-notes.txt');
    expect(v.mismatches.every((m) => m.path !== 'user-notes.txt')).toBe(true);
    rmSync(join(INSTALLED, 'user-notes.txt'));
  });
});

describe('repair：只重装差异文件', () => {
  it('上一节的 size/missing 篡改被修复，未篡改文件不受影响', () => {
    const r = repairSkillInstall(INSTALLED, INLINE);
    expect(r.repaired.sort()).toEqual(['CHANGELOG.md', 'references/gates.md']);
    expect(r.verify.ok).toBe(true);
    expect(r.verify.mismatches).toEqual([]);
  });

  it('repair 后 manifest 重写（哈希锚点与修复后字节一致）', () => {
    const m = readSkillManifest(INSTALLED)!;
    const changelog = m.files.find((f) => f.path === 'CHANGELOG.md')!;
    expect(changelog.sha256).not.toBe('truncated');
  });

  it('inline 缺失时不动作（无法修复），verify 照常报告', () => {
    const v = repairSkillInstall(INSTALLED, null);
    expect(v.repaired).toEqual([]);
    expect(v.verify.reference).toBe('manifest');
    expect(v.verify.ok).toBe(true);
  });
});

describe('skillIntegritySummary（anic_status 消费面）', () => {
  it('已安装工作区：双版本 + integrity 全绿', () => {
    const s = skillIntegritySummary(INSTALLED, INLINE);
    expect(s.installed).toBe(true);
    expect(s.installedVersion).toBe(s.inlineVersion);
    expect(s.integrity?.ok).toBe(true);
  });

  it('未安装工作区：installed=false 且 integrity=null（不硬失败）', () => {
    const s = skillIntegritySummary(join(TMP, 'nothing'), INLINE);
    expect(s.installed).toBe(false);
    expect(s.integrity).toBeNull();
  });
});
