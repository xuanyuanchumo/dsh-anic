/**
 * Skill 漂移判定（cycle-77 T3：F-07 双轨漂移 + F-08 extras/manifest 面）。
 *
 * 被守卫缺陷（.cycles/tech-debt/cycle-72-债务台账.md §7/§8，线上实测可复现）：
 * - §7 F-07：`src/host/skillInvoker.ts` 把 `.dsh/skills`（`.gitignore` 忽略、git 零跟踪）
 *   排为候选 1，`assets/skill` 只是候选 4 —— live 副本陈旧时运行时照样全绿，发行源
 *   却已落后（实测 importGraph.mjs 4784B vs 8026B）。旧 `verifySkillInstall` 只能回答
 *   「字节不等」，无法区分「live 落后于发行源」与「live 有本地分叉」⇒ 结论不可断言。
 * - §8 F-08：extras 只列不判。live 顶层散落 `mcp-server.mjs`(16,093B)，而 `scripts/`
 *   下是 20,109B —— cycle-71 刚修过命令注入，旧副本若被按路径直接执行即绕过修复；
 *   同时 `.anic-manifest.json` 的 version(2.3.0) 与 SKILL.md 锚点(2.5.2) 脱节。
 *
 * 本模块只做**判定**，不做处置：extras 的删除权限属于人类，插件保持
 * 「只报告不删除」的权限边界（见 skillIntegrity.ts 头注）。判定结论由
 * `verifySkillInstall` 汇总，并被 selfCheckRoute 的 P9-skill-dual-track 探针消费。
 */

/** 清单内文件的判定视图（只取判定所需两字段，便于纯函数复用）。 */
export interface SkillFileEntryLike {
  path: string;
  sha256: string;
}

/** 散落副本漂移：与清单内某文件同名（basename 相同）但内容不同。 */
export interface ExtraDrift {
  /** 安装目录里的散落副本（POSIX 相对路径）。 */
  path: string;
  /** 与之同名的清单内文件路径（判定参照物）。 */
  counterpart: string;
  /** 清单内同名文件的 sha256（= 发行源应有的字节）。 */
  expectedSha256: string;
  /** 散落副本的 sha256（实测）。 */
  actualSha256: string;
}

/** F-07 双轨判定态（不可断言字符串常量化的「可能落后」不是判定）。 */
export type SkillDualTrackState = 'in-sync' | 'live-behind' | 'live-diverged' | 'unknown';

/** 系统垃圾文件白名单：basename 与清单撞名也不算漂移（非本插件产物）。 */
const EXTRA_JUNK_BASENAMES = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

/** POSIX 相对路径的 basename。 */
export function baseNameOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? rel : rel.slice(i + 1);
}

/** 语义化版本三元组比较：a<b → 负数，a==b → 0，a>b → 正数；不可解析 → null。 */
export function compareSkillVersions(a: string | null, b: string | null): number | null {
  const parse = (v: string | null): [number, number, number] | null => {
    const m = v?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * extras 漂移判定（F-08）：同名冲突（basename 与清单内某文件相同）且 sha256 不同 ⇒ drift。
 *
 * 三条边界（对应台账 §8「修复」栏）：
 * - 同名同哈希 ⇒ 允许的散落副本（例如历史安装把 scripts/x 也复制到了顶层），不判红；
 * - basename 唯一、清单里没有同名文件 ⇒ 只报告（用户/其他工具放的文件不属本插件判定域）；
 * - 读不出哈希 ⇒ 不猜（交由下轮重试，绝不默认「安全」）。
 * hashExtra 由调用方注入（单一 sha256 实现留在 skillIntegrity.ts，避免第二套哈希源）。
 */
export function computeExtraDrift(
  extras: string[],
  entries: SkillFileEntryLike[],
  hashExtra: (rel: string) => string | null,
): ExtraDrift[] {
  const byBase = new Map<string, SkillFileEntryLike[]>();
  for (const e of entries) {
    const base = baseNameOf(e.path);
    const list = byBase.get(base);
    if (list) list.push(e);
    else byBase.set(base, [e]);
  }
  const out: ExtraDrift[] = [];
  for (const extra of [...extras].sort()) {
    const base = baseNameOf(extra);
    if (EXTRA_JUNK_BASENAMES.includes(base)) continue;
    const candidates = byBase.get(base);
    if (!candidates || candidates.length === 0) continue; // 唯一名：仅报告
    const actual = hashExtra(extra);
    if (actual === null) continue; // 读不出：不判「安全」
    if (candidates.some((c) => c.sha256 === actual)) continue; // 同名同哈希：允许的副本
    // 参照物取路径字典序首个（多个同名候选时确定性，不随 readdir 顺序漂移）
    const ref = [...candidates].sort((x, y) => x.path.localeCompare(y.path))[0]!;
    out.push({ path: extra, counterpart: ref.path, expectedSha256: ref.sha256, actualSha256: actual });
  }
  return out;
}

/**
 * 双轨判定（F-07）：把「字节差异 + 版本 + 清单新鲜度」收敛成一个可断言的状态。
 *
 * - reference != inline ⇒ unknown：没有发行源可对照，任何结论都是猜测；
 * - 无字节差异且清单新鲜 ⇒ in-sync；
 * - live 版本 < inline 版本，或清单 version 落后于 inline ⇒ live-behind（副本落后于发行源，
 *   正是 §7 的「repair 会把 live 侧修复回滚」风险面）；
 * - 其余有差异但不落后 ⇒ live-diverged（本地改动/分叉，需人类裁决）。
 */
export function resolveDualTrack(input: {
  reference: 'inline' | 'manifest' | 'none';
  /** 字节层差异数（不含 manifest-version 这一清单层判定）。 */
  byteMismatchCount: number;
  manifestStale: boolean;
  liveVersion: string | null;
  inlineVersion: string | null;
}): SkillDualTrackState {
  if (input.reference !== 'inline') return 'unknown';
  if (input.byteMismatchCount === 0 && !input.manifestStale) return 'in-sync';
  const cmp = compareSkillVersions(input.liveVersion, input.inlineVersion);
  if (cmp !== null && cmp < 0) return 'live-behind';
  if (input.manifestStale) return 'live-behind';
  return 'live-diverged';
}

/** 漂移点名单（P9 探针 detail 与日志共用：可 grep 到「哪个文件、哪一类漂移」）。 */
export function nameDriftedFiles(v: {
  mismatches: Array<{ path: string; kind: string }>;
  extraDrift: Array<{ path: string }>;
}): string {
  const items = [
    ...v.mismatches.map((m) => `${m.path}(${m.kind})`),
    ...v.extraDrift.map((d) => `${d.path}(extra-drift)`),
  ];
  return items.length === 0 ? 'none' : items.join(', ');
}
