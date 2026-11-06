/**
 * 内部技能库**读数**（cycle-109）—— 把「注册表文件存在」升级为「跑起来就能查证」。
 *
 * ## 为什么需要它（修一个真实的零覆盖）
 *
 * `assets/skills/` 有 1 主干 + 9 叶 + 1 元技能、一个 `skills.index.json` 注册表、
 * 以及三个自进化脚本（manifest / drift / ledger）。但 cycle-107 审计实测：
 * **`src/` 对 `skills.index.json` 的引用数 = 0** ——
 * 即「注册表写了、技能文件产了、插件从不消费」。
 *
 * 闭环体检（closureAudit）的第四族只扫 `assets/skill/scripts/*.mjs`（**主干**技能脚本），
 * `assets/skills/**` 整个库**不在任何扫描面内**。于是它是否完整、是否漂移，
 * 只能靠人手工跑一次 `skill-lib-manifest.mjs` —— 而「只在人记得时成立」的检查
 * 等于没有检查（本仓纪律：守卫必须真的会跑）。
 *
 * ## 本模块只做三件事
 *
 * 1. **读**注册表（唯一事实源，不重写它）；
 * 2. **对账**：注册表条目 ⇄ 磁盘目录、SKILL.md、`anchors` 声明 ⇄ 实际文件；
 * 3. **产出结构化读数**（含 issues 清单），供 `GET /anic/skill/health` 与面板消费。
 *
 * ## 三态而不是布尔
 *
 * `ok:false` 可能是「注册表少了一条」也可能是「目录少了」——两者补救动作相反
 * （改表 vs 补文件）。故 `issues` 逐条带 `kind`，且 `ok` 只是「issues 为空」的派生。
 *
 * ## 为什么不复用 `skill-lib-manifest.mjs`
 *
 * 那是 **skill 侧**脚本（用户/agent 手动跑，写文件、有 CLI）。插件运行时需要的是
 * **只读、幂等、无副作用**的读数：脚本会写注册表，运行时绝不能自动改项目事实。
 * ⇒ 两边口径必须同源但职责分离：脚本负责「生成/修」，本模块负责「读/判」。
 * 判据的一致性由 `tests/contract/skillLibraryRegistryContract.test.ts` 钉住。
 *
 * 纯只读（R-31）：不写任何文件、不改项目事实。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pluginAssetDir } from '../pluginRoot.ts';

/** 注册表文件相对库根的名字（唯一事实源的锚点）。 */
export const SKILL_LIBRARY_INDEX = 'skills.index.json';

/** 一条对账问题（`kind` 决定补救动作，不可合并成一句）。 */
export interface SkillLibraryIssue {
  /** `missing-dir` 补文件 / `missing-skill-md` 补文件 / `missing-anchor` 补文件或改表 /
   *  `unregistered-dir` 改表 / `registry-parse` 修表 / `registry-absent` 装库。 */
  kind: 'registry-absent' | 'registry-parse' | 'missing-dir' | 'missing-skill-md' | 'missing-anchor' | 'unregistered-dir';
  /** 相关技能名或目录名。 */
  subject: string;
  /** 具体缺失项（anchor 相对路径等）。 */
  detail: string;
}

/** 一个库条目的读数。 */
export interface SkillLibraryEntryReadout {
  name: string;
  dir: string;
  version: string;
  tier: string;
  /** SKILL.md 是否在场（在场 = 可被 agent 读取）。 */
  skillMdPresent: boolean;
  /** 声明的 anchors 命中数 / 总数（0/0 = 没声明锚点，不算错）。 */
  anchorsPresent: number;
  anchorsTotal: number;
}

/** 库读数（`GET /anic/skill/health` 的 `library` 段）。 */
export interface SkillLibraryReadout {
  /** 库根是否可解析（false = 装包缺 assets/skills，极度异常）。 */
  present: boolean;
  /** 注册表 version（来自文件，不猜）。 */
  version: string;
  /** 注册表 updatedAt（原样字符串）。 */
  updatedAt: string;
  /** 主干技能声明（`spine` 段）。 */
  spine: { name: string; anchor: string; anchorPresent: boolean } | null;
  skills: SkillLibraryEntryReadout[];
  /** 全部对账问题；`ok = issues.length === 0`。 */
  issues: SkillLibraryIssue[];
  ok: boolean;
  /** 判定时刻（ISO）。 */
  checkedAt: string;
}

/** 注册表的窄形状（只取对账要用的字段；多余键忽略）。 */
interface RegistryShape {
  version?: unknown;
  updatedAt?: unknown;
  spine?: { name?: unknown; anchor?: unknown };
  skills?: Array<{ name?: unknown; dir?: unknown; version?: unknown; tier?: unknown; anchors?: unknown }>;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 目录存在且是目录（不是文件）。 */
function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 读一次内部技能库并对账。
 *
 * @param libDir 库根（默认 `assets/skills`；测试可注入夹具）
 * @param nowIso 判定时刻（测试可注入，避免时间抖动）
 */
export function readSkillLibrary(libDir = pluginAssetDir('skills'), nowIso?: string): SkillLibraryReadout {
  const checkedAt = nowIso ?? new Date().toISOString();
  const empty: SkillLibraryReadout = {
    present: false, version: '', updatedAt: '', spine: null, skills: [], issues: [], ok: false, checkedAt,
  };
  if (libDir === '' || !isDir(libDir)) {
    return { ...empty, issues: [{ kind: 'registry-absent', subject: libDir, detail: 'assets/skills not found — package incomplete' }] };
  }
  const indexPath = join(libDir, SKILL_LIBRARY_INDEX);
  let raw = '';
  try {
    raw = readFileSync(indexPath, 'utf-8');
  } catch {
    return { ...empty, present: true, issues: [{ kind: 'registry-absent', subject: indexPath, detail: 'skills.index.json missing' }] };
  }
  let reg: RegistryShape;
  try {
    reg = JSON.parse(raw) as RegistryShape;
  } catch (e) {
    return {
      ...empty, present: true,
      issues: [{ kind: 'registry-parse', subject: indexPath, detail: e instanceof Error ? e.message : String(e) }],
    };
  }

  const issues: SkillLibraryIssue[] = [];
  const skills: SkillLibraryEntryReadout[] = [];
  const registeredDirs = new Set<string>();

  for (const s of reg.skills ?? []) {
    const name = asString(s.name);
    const dir = asString(s.dir);
    if (name === '' || dir === '') {
      issues.push({ kind: 'registry-parse', subject: name || '(unnamed)', detail: 'entry lacks name/dir' });
      continue;
    }
    registeredDirs.add(dir);
    const abs = join(libDir, dir);
    if (!isDir(abs)) {
      issues.push({ kind: 'missing-dir', subject: name, detail: dir });
      skills.push({ name, dir, version: asString(s.version), tier: asString(s.tier), skillMdPresent: false, anchorsPresent: 0, anchorsTotal: 0 });
      continue;
    }
    const skillMdPresent = existsSync(join(abs, 'SKILL.md'));
    if (!skillMdPresent) issues.push({ kind: 'missing-skill-md', subject: name, detail: dir + '/SKILL.md' });
    const anchors = Array.isArray(s.anchors) ? s.anchors.filter((a): a is string => typeof a === 'string') : [];
    let anchorsPresent = 0;
    for (const a of anchors) {
      if (existsSync(join(abs, a))) anchorsPresent += 1;
      else issues.push({ kind: 'missing-anchor', subject: name, detail: dir + '/' + a });
    }
    skills.push({
      name, dir, version: asString(s.version), tier: asString(s.tier),
      skillMdPresent, anchorsPresent, anchorsTotal: anchors.length,
    });
  }

  // 反向：磁盘上有、注册表里没有的目录（幽灵技能 = 没人知道它存在）。
  // 只扫一层目录；`_meta` 是元技能所在的合法**容器**目录 —— 只要它的某个子目录
  // 已被注册，整棵子树就算已登记（否则每个新增 meta 技能都会多报一条假幽灵）。
  const registeredList = [...registeredDirs];
  for (const entry of readdirSync(libDir)) {
    const abs = join(libDir, entry);
    if (!isDir(abs)) continue;
    if (entry.startsWith('.')) continue;
    const covered = registeredDirs.has(entry) || registeredList.some((d) => d.startsWith(entry + '/'));
    if (!covered) {
      issues.push({ kind: 'unregistered-dir', subject: entry, detail: 'dir exists but not in skills.index.json' });
    }
  }

  const spineRaw = reg.spine;
  const spineName = asString(spineRaw?.name);
  const spineAnchor = asString(spineRaw?.anchor);
  // spine.anchor 是**相对插件根**（assets/skill/SKILL.md），不是相对库根 ——
  // 它是主干技能，物理上不在 assets/skills 下。故按插件根推导（仅当库根确为
  // `<root>/assets/skills` 形态；夹具目录则退回库根本身，宁可少判也不越界）。
  const pluginRoot = basename(libDir) === 'skills' && basename(dirname(libDir)) === 'assets'
    ? dirname(dirname(libDir))
    : libDir;
  const spineAnchorPresent = spineAnchor !== '' && existsSync(join(pluginRoot, spineAnchor));
  if (spineName !== '' && spineAnchor !== '' && !spineAnchorPresent) {
    issues.push({ kind: 'missing-anchor', subject: spineName, detail: spineAnchor });
  }
  return {
    present: true,
    version: asString(reg.version),
    updatedAt: asString(reg.updatedAt),
    spine: spineName === '' || spineAnchor === '' ? null : { name: spineName, anchor: spineAnchor, anchorPresent: spineAnchorPresent },
    skills,
    issues,
    ok: issues.length === 0,
    checkedAt,
  };
}

/**
 * 一行摘要（进日志 / org-status / 面板状态行）。
 *
 * 为什么 `verified`/`ok` 也要显式出声：沉默会让读者把「没报错」当成「没检查」
 * （与 `orgStatus` 漂移一致时给 ✓ 行同一条纪律）。
 */
export function summarizeSkillLibrary(r: SkillLibraryReadout): string {
  if (!r.present) return 'internal skill library: ABSENT (assets/skills missing)';
  if (r.issues.length === 0) {
    return `internal skill library v${r.version}: ${String(r.skills.length)} skills, ${String(r.issues.length)} issues`;
  }
  const byKind = new Map<string, number>();
  for (const i of r.issues) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
  const parts = [...byKind.entries()].map(([k, n]) => `${k}×${String(n)}`);
  return `internal skill library v${r.version}: ${String(r.skills.length)} skills, issues=${String(r.issues.length)} (${parts.join(', ')})`;
}

/** 读数缓存 TTL：健康路由是 4s 轮询面，每次全量 stat 11 技能 × 锚点会造成 fs churn。 */
const CACHE_TTL_MS = 5000;
let cache: { at: number; value: SkillLibraryReadout } | null = null;

/**
 * 带缓存的读数（供 4s 轮询路由消费）。
 *
 * 为什么缓存放在**读侧**而不是调用方：路由不止一个消费者（健康路由 / `anic_status`），
 * 若每个调用方各自缓存，「同一时刻两个读者看到不同的库状态」——那是第二真相源。
 */
export function readSkillLibraryCached(libDir?: string): SkillLibraryReadout {
  const now = Date.now();
  if (cache !== null && now - cache.at < CACHE_TTL_MS) return cache.value;
  const value = readSkillLibrary(libDir);
  cache = { at: now, value };
  return value;
}

