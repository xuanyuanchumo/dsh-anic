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
 *
 * cycle-77 T3（F-07/F-08，台账 §7/§8）把「报告」升级为「判定」：extraDrift（同名不同
 * 哈希的散落副本）、manifestStale（清单版本落后于发行源，实测 2.3.0 vs 2.5.2）、
 * dualTrack（字节+版本+清单新鲜度 → 可断言状态）。判定实现见 skillDrift.ts，
 * 目录树/hash 原语见 skillFs.ts。
 */
import {
  existsSync, readFileSync, writeFileSync, statSync,
  mkdirSync, copyFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import {
  computeExtraDrift, resolveDualTrack, type ExtraDrift, type SkillDualTrackState,
} from './skillDrift.ts';
import {
  SKILL_MANIFEST_FILE, hashFile, walkRelPaths, entryOf, type SkillFileEntry,
} from './skillFs.ts';

export { SKILL_MANIFEST_FILE };

export interface SkillManifestEntry extends SkillFileEntry {}

export interface SkillManifest {
  skill: 'ai-native-iteration-cycle';
  version: string | null;
  fileCount: number;
  generatedAt: string;
  files: SkillManifestEntry[];
}

/** 差异类别；`manifest-version` 是清单层判定（cycle-77 F-08），不是文件字节差异。 */
export type MismatchKind = 'missing' | 'size' | 'hash' | 'manifest-version';

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
  // ── cycle-77 T3 新增字段（只增不改：既有消费方读旧字段语义不变）──
  /** F-08：同名（basename 相同）但 sha256 不同的散落副本；非空即 ok=false，仍不删除。 */
  extraDrift: ExtraDrift[];
  /** F-08：清单 version 落后于发行源版本（修复后未重写清单的诚实暴露）。 */
  manifestStale: boolean;
  /** F-07：双轨判定（in-sync / live-behind / live-diverged / unknown，见 skillDrift.ts）。 */
  dualTrack: SkillDualTrackState;
  /** live 副本版本（SKILL.md 锚点可读时）。 */
  liveVersion: string | null;
  /** 发行源版本（inline 锚点；manifest 兜底时为 null——无对照即不猜）。 */
  inlineVersion: string | null;
}

/** 读技能版本（单一事实源；skillInstallRoute 原地拷贝已收编于此）。
 *
 * 锚点格式（quick-validate checkVersionConsistency 同源）：SKILL.md 里
 * 「MCP Tools (vX.Y.Z)：」标题行。cycle-31 修复：旧正则要求字面量 "version"
 * 前缀，真实锚点无此前缀 → 恒 null → skillInstallRoute 版本门控快路径从未
 * 生效（null===null 防御兜住落重装路径，但 status 汇报误导性 null）。
 */
export function readSkillVersion(skillDir: string): string | null {
  try {
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
    const m = md.match(/MCP Tools \(v([0-9]+\.[0-9]+\.[0-9]+)\)/);
    return m?.[1] ?? null;
  } catch { return null; }
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

/**
 * 构建自 sourceDir、落盘到 targetDir/.anic-manifest.json（autoInstallSkill 收尾动作）。
 *
 * F-08 契约：`version` 恒取 `readSkillVersion(sourceDir)`、`generatedAt` 恒取落盘时刻——
 * 也就是说清单的版本锚点**只能**来自发行源，不允许外部塞值（旧实现留下过
 * version=2.3.0 / generatedAt=2026-10-20 与 SKILL.md 锚点 2.5.2 脱节的历史清单）。
 */
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
  manifest: SkillManifest | null,
  inlineVersion: string | null,
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
  // F-08：同名不同哈希的散落副本判 drift；哈希实现仍只有 hashFile 一处（注入给纯函数）。
  const extraDrift = computeExtraDrift(extras, entries, (rel) => {
    try { return hashFile(join(installedDir, ...rel.split('/'))); } catch { return null; }
  });
  // F-08：清单新鲜度只在 inline 直比时成立——manifest 兜底没有发行源版本可对照，不猜。
  const manifestStale = reference === 'inline'
    && manifest?.version != null && inlineVersion != null && manifest.version !== inlineVersion;
  const byteMismatchCount = mismatches.length;
  if (manifestStale && inlineVersion != null && manifest?.version != null) {
    mismatches.push({
      path: SKILL_MANIFEST_FILE, kind: 'manifest-version',
      expected: inlineVersion, actual: manifest.version,
    });
  }
  const liveVersion = readSkillVersion(installedDir);
  return {
    ok: mismatches.length === 0 && extraDrift.length === 0,
    reference,
    checked: entries.length,
    mismatches,
    extras,
    manifestVersion: manifest?.version ?? null,
    extraDrift,
    manifestStale,
    dualTrack: resolveDualTrack({
      reference, byteMismatchCount, manifestStale, liveVersion, inlineVersion,
    }),
    liveVersion,
    inlineVersion,
  };
}

/**
 * doctor 语义：校验安装副本完整性。
 * inlineDir 提供时走权威直比（逐文件 size+sha256 对比内联副本）；
 * 否则回退安装期清单（inline 不可用/独立分发的场景）。
 */
export function verifySkillInstall(installedDir: string, inlineDir?: string | null): SkillVerifyResult {
  const manifest = readSkillManifest(installedDir);
  if (inlineDir && existsSync(inlineDir)) {
    const entries = walkRelPaths(inlineDir).map((rel) => entryOf(inlineDir, rel));
    return checkAgainst(installedDir, entries, 'inline', manifest, readSkillVersion(inlineDir));
  }
  if (manifest) return checkAgainst(installedDir, manifest.files, 'manifest', manifest, null);
  // 无 inline 无清单 ⇒ reference=none 且 ok=false：判定不了也绝不静默放行。
  return {
    ok: false, reference: 'none', checked: 0, mismatches: [], extras: [], manifestVersion: null,
    extraDrift: [], manifestStale: false, dualTrack: 'unknown',
    liveVersion: readSkillVersion(installedDir), inlineVersion: null,
  };
}

/**
 * repair 语义：只重装差异文件（inline 为唯一事实源），重写清单后复验。
 *
 * F-07/F-08 增强：
 * - 清单重写同时刷新 `version`/`generatedAt`（`writeSkillManifest` 从 inline 读版本），
 *   因此 `manifestStale` 与 `manifest-version` mismatch 在 repair 后必须消失；
 * - `manifest-version` 是清单层判定（path=.anic-manifest.json，inline 侧无此文件），
 *   显式跳过，避免把清单自身当文件去 copy（旧实现靠 existsSync 兜住，语义不明）；
 * - extras / extraDrift **不删除**（见文件头注释的权限边界）；inline 缺失时不动作。
 */
export function repairSkillInstall(
  installedDir: string,
  inlineDir: string | null,
): { repaired: string[]; verify: SkillVerifyResult } {
  const before = verifySkillInstall(installedDir, inlineDir);
  const repaired: string[] = [];
  if (inlineDir && existsSync(inlineDir)) {
    for (const m of before.mismatches) {
      if (m.kind === 'manifest-version') continue; // 清单层判定：由下方清单重写解决
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
