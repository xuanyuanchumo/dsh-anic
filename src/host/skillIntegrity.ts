/**
 * Skill distribution integrity — 安装清单 + sha256 完整性校验 + doctor/repair。
 *
 * eco 研究报告 P0（.cycles/cycle-16/research/skill-ecosystem.md:238）：autoInstallSkill
 * 此前是「盲拷贝」——64 个文件复制后无任何锚点可验证安装副本是否漂移/损坏/部分覆盖。
 * 本模块把「已安装副本 vs assets/skill 内联副本」的字节对比从评估期提前到安装期：
 * - buildSkillManifest：文件清单（path + size + sha256 + 版本锚点）
 * - verifySkillInstall：doctor 语义——inline 直比（权威）优先，manifest 兜底
 * - repairSkillInstall：repair 语义——只重装差异文件（缺失/尺寸/哈希），绝不动未列文件
 *
 * 清单文件 .anic-manifest.json 是插件私有元数据（隐藏文件，不算技能文件），
 * 自身被排除在清单之外（自引用无意义）。extras（安装目录多出的文件）只报告
 * 不删除——用户/其他工具放入的文件不属于本插件的删除权限。
 */
import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync,
  mkdirSync, copyFileSync,
} from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';

export const SKILL_MANIFEST_FILE = '.anic-manifest.json';

export interface SkillManifestEntry {
  /** POSIX 风格相对路径（跨平台稳定，与安装位置无关）。 */
  path: string;
  size: number;
  sha256: string;
}

export interface SkillManifest {
  skill: 'ai-native-iteration-cycle';
  version: string | null;
  fileCount: number;
  generatedAt: string;
  files: SkillManifestEntry[];
}

export type MismatchKind = 'missing' | 'size' | 'hash';

export interface SkillMismatch {
  path: string;
  kind: MismatchKind;
  expected?: number | string;
  actual?: number | string;
}

export interface SkillVerifyResult {
  ok: boolean;
  /** 对比参考系：inline=与内联副本直比（权威）；manifest=与安装期清单比（兜底）。 */
  reference: 'inline' | 'manifest' | 'none';
  checked: number;
  mismatches: SkillMismatch[];
  /** 安装目录里清单未收录的多余文件（不删除，仅报告）。 */
  extras: string[];
  manifestVersion: string | null;
}

/** 读技能版本（单一事实源；skillInstallRoute 原地拷贝已收编于此）。 */
export function readSkillVersion(skillDir: string): string | null {
  try {
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
    const m = md.match(/version[:\s]+v?([0-9]+\.[0-9]+\.[0-9]+)/i);
    return m?.[1] ?? null;
  } catch { return null; }
}

function hashFile(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/** 递归收集相对 POSIX 路径（排序保确定性；排除清单文件自身）。 */
function walkRelPaths(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === SKILL_MANIFEST_FILE) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(relative(root, abs).split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}

function entryOf(root: string, rel: string): SkillManifestEntry {
  const abs = join(root, ...rel.split('/'));
  return { path: rel, size: statSync(abs).size, sha256: hashFile(abs) };
}

/** 从 sourceDir 内容构建清单（安装后 source==inline，两处字节一致）。 */
export function buildSkillManifest(sourceDir: string): SkillManifest {
  return {
    skill: 'ai-native-iteration-cycle',
    version: readSkillVersion(sourceDir),
    fileCount: 0,
    generatedAt: new Date().toISOString(),
    files: walkRelPaths(sourceDir).map((rel) => entryOf(sourceDir, rel)),
  };
}

/** 构建自 sourceDir、落盘到 targetDir/.anic-manifest.json（autoInstallSkill 收尾动作）。 */
export function writeSkillManifest(sourceDir: string, targetDir: string): { ok: boolean; fileCount: number } {
  try {
    const manifest = buildSkillManifest(sourceDir);
    manifest.fileCount = manifest.files.length;
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, SKILL_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    return { ok: true, fileCount: manifest.fileCount };
  } catch { return { ok: false, fileCount: 0 }; }
}

/** 容错读取已落盘清单（损坏/缺失 → null，调用方降级）。 */
export function readSkillManifest(skillDir: string): SkillManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(skillDir, SKILL_MANIFEST_FILE), 'utf-8')) as SkillManifest;
    if (!Array.isArray(raw.files)) return null;
    return raw;
  } catch { return null; }
}

function checkAgainst(
  installedDir: string,
  entries: SkillManifestEntry[],
  reference: 'inline' | 'manifest',
  manifestVersion: string | null,
): SkillVerifyResult {
  const installedSet = new Set(walkRelPaths(installedDir));
  const expectedSet = new Set(entries.map((e) => e.path));
  const mismatches: SkillMismatch[] = [];
  for (const e of entries) {
    const abs = join(installedDir, ...e.path.split('/'));
    if (!existsSync(abs)) { mismatches.push({ path: e.path, kind: 'missing', expected: e.size }); continue; }
    const size = statSync(abs).size;
    if (size !== e.size) { mismatches.push({ path: e.path, kind: 'size', expected: e.size, actual: size }); continue; }
    if (hashFile(abs) !== e.sha256) mismatches.push({ path: e.path, kind: 'hash', expected: e.sha256, actual: hashFile(abs) });
  }
  const extras = [...installedSet].filter((p) => !expectedSet.has(p)).sort();
  return {
    ok: mismatches.length === 0,
    reference,
    checked: entries.length,
    mismatches,
    extras,
    manifestVersion,
  };
}

/**
 * doctor 语义：校验安装副本完整性。
 * inlineDir 提供时走权威直比（逐文件 size+sha256 对比内联副本）；
 * 否则回退安装期清单（inline 不可用/独立分发的场景）。
 */
export function verifySkillInstall(installedDir: string, inlineDir?: string | null): SkillVerifyResult {
  if (inlineDir && existsSync(inlineDir)) {
    const entries = walkRelPaths(inlineDir).map((rel) => entryOf(inlineDir, rel));
    return checkAgainst(installedDir, entries, 'inline', readSkillManifest(installedDir)?.version ?? null);
  }
  const manifest = readSkillManifest(installedDir);
  if (manifest) return checkAgainst(installedDir, manifest.files, 'manifest', manifest.version);
  return { ok: false, reference: 'none', checked: 0, mismatches: [], extras: [], manifestVersion: null };
}

/**
 * repair 语义：只重装差异文件（inline 为唯一事实源），重写清单后复验。
 * extras 不删除（见文件头注释的权限边界）；inline 缺失时不动作（无法修复）。
 */
export function repairSkillInstall(
  installedDir: string,
  inlineDir: string | null,
): { repaired: string[]; verify: SkillVerifyResult } {
  const before = verifySkillInstall(installedDir, inlineDir);
  const repaired: string[] = [];
  if (inlineDir && existsSync(inlineDir)) {
    for (const m of before.mismatches) {
      const src = join(inlineDir, ...m.path.split('/'));
      const dst = join(installedDir, ...m.path.split('/'));
      if (!existsSync(src)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      repaired.push(m.path);
    }
    writeSkillManifest(inlineDir, installedDir);
  }
  return { repaired, verify: verifySkillInstall(installedDir, inlineDir) };
}

/** anic_status 的技能完整性摘要（installed/inline 双版本 + doctor 结果）。 */
export function skillIntegritySummary(
  installedDir: string | null,
  inlineDir: string | null,
): {
  installed: boolean;
  installedVersion: string | null;
  inlineVersion: string | null;
  integrity: SkillVerifyResult | null;
} {
  const installed = installedDir !== null && existsSync(join(installedDir, 'SKILL.md'));
  return {
    installed,
    installedVersion: installed && installedDir ? readSkillVersion(installedDir) : null,
    inlineVersion: inlineDir && existsSync(inlineDir) ? readSkillVersion(inlineDir) : null,
    integrity: installed && installedDir ? verifySkillInstall(installedDir, inlineDir) : null,
  };
}
