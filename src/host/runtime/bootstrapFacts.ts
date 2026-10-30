/**
 * 项目事实基线（cycle-89 WP-C · P0）——**自举只能从最新事实重启**。
 *
 * ## 被守卫的缺陷（本模块存在的唯一理由）
 *
 * `.cycles/self-bootstrap.json` 停在 2026-10-28 的 `EXHAUSTED`（3 轮 / evalScore 0 /
 * gate FAIL），而 cycle-88 的 eval/gate **实际全 PASS**。历史产物压过最新项目事实，
 * 于是「自举永远收敛不了」——不是代码不行，是判断依据（磁盘上的旧结论）比现实更旧。
 *
 * 反例（必须避免的写法）：把 `self-bootstrap.json` 的终态当成"项目真相"直接展示/驱动，
 * 或把 `.cycles/archive/**` 里的历史循环一起计入"活跃循环"去算陈旧度。两者都会让
 * 一个刚跑完全绿循环的项目继续被读成失败。
 *
 * ## 边界（本模块**只读**）
 *
 * - 不写任何文件；不写 `.cycles/**`（那是 Lead/编排器的写域）。
 * - 不做"必要的判断"之外的推断：采不到就是 `null`/`false`，绝不猜一个好看的默认值。
 *   例如 `gitHead` 取不到 → `null`（而不是 `''` 或 `'unknown'`），因为 `null` 表示
 *   "这轮没有 git 事实"，能被 `diffFacts` 识别为变化，而空串会伪装成"有事实且为空"。
 * - 归档只当历史：`activeCycles` / `archivedCycles` **分列**，评估报告只从活跃面取。
 *   理由：归档后的循环不需要再被复检，它的失败记录不能否决当前活跃循环的结论。
 *
 * ## 纯函数优先
 *
 * `diffFacts` / `factsDigest` / `activeVsArchived` 都是零 IO 纯函数（可直接单测，
 * 不需要造磁盘 fixture）；只有 `collectProjectFacts` 读盘——它把 IO 收在一个函数里，
 * 其余逻辑因此可被确定性地钉死。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { verifyLedger } from './ledger.ts';
import { readLedgerFacts } from './artifactArchiveFacts.ts';
// 读盘面拆至 bootstrapFactsReaders.ts（T3 ≤250 行：本文件纯函数 + 编排，IO 集中在彼文件）。
import {
  readJson, listCycleDirNames, readGit, readSkillVersion, readLatestEvalReport,
} from './bootstrapFactsReaders.ts';

/** 一份评估报告的指纹（path 相对工作区，响应体不含绝对路径）。 */
export interface EvalReportFacts {
  /** 相对工作区的正斜杠路径，如 `.cycles/cycles/cycle-88/项目评估报告.md`。 */
  path: string;
  sha256: string;
  /** ISO 时间串（mtime）。 */
  mtime: string;
}

/**
 * 项目事实基线 —— 一份"此刻这个项目是什么样"的机器可断言快照。
 *
 * 字段选取原则：只放**会改变质量结论**的事实。加一个字段就意味着多一条"陈旧"触发条件，
 * 滥加会让 stale 恒真（噪声），少加会让重启判据漏掉真实变化（漏报）。
 */
export interface ProjectFacts {
  /** `git rev-parse HEAD`；非 git 仓库或失败 → null（不是 ''）。 */
  gitHead: string | null;
  /** 工作树是否有未提交改动；非 git / 失败 → null。 */
  gitDirty: boolean | null;
  /** `.cycles/workflow-state.json` 的 currentCycle（如 `cycle-89`）。 */
  currentCycle: string | null;
  /** 同上文件的 currentPhase（如 `plan`）。 */
  currentPhase: string | null;
  /** 账本链头（末条 hash）；无账本 → null。 */
  ledgerHead: string | null;
  /** 账本条数（复用 verifyLedger 的读数，不重写解析器）。 */
  ledgerEntries: number;
  /** 账本哈希链是否完整；无账本 → true（空链不构成断裂，与 verifyLedger 同口径）。 */
  ledgerValid: boolean;
  /** 活跃循环里编号最大的那份评估报告指纹；没有 → null。 */
  evalReport: EvalReportFacts | null;
  /** `.cycles/cycles/` 下的活跃循环数（**不含归档**）。 */
  activeCycles: number;
  /** `.cycles/archive/` 下的归档循环数（**只作历史**）。 */
  archivedCycles: number;
  /** 活跃循环目录名（升序），供面板分列显示；不含归档。 */
  activeCycleNames: string[];
  /** 技能版本（CHANGELOG 最新条目标题里的 x.y.z）；取不到 → null。 */
  skillVersion: string | null;
  /** `.cycles/` 是否存在——缺失时路由必须 412 响亮报错，**不得**折叠成 0 分。 */
  hasCyclesDir: boolean;
}

/**
 * 参与"陈旧"判定的键 —— 顺序即 `changed[]` 的报告顺序。
 *
 * 为什么是这些：前六项决定"结论是否还适用于当前代码/配置"，`evalReport.sha256`
 * 决定"评估证据是否已被重写"，循环计数决定"活跃面是否变化"，技能版本决定
 * "使用的评判标准是否换过"。`hasCyclesDir` 不参与比较（缺失由路由单独守卫）。
 */
export const FACT_KEYS = [
  'gitHead',
  'gitDirty',
  'currentCycle',
  'currentPhase',
  'ledgerHead',
  'ledgerEntries',
  'ledgerValid',
  'evalReport',
  'activeCycles',
  'archivedCycles',
  'skillVersion',
] as const;

export type FactKey = (typeof FACT_KEYS)[number];

/** 陈旧判定结果。`changed` 为空 ⇔ `stale === false`（不变量，测试钉死）。 */
export interface FactsDiff {
  stale: boolean;
  changed: string[];
}

/** 稳定序列化：对象按 FACT_KEYS 里的语义取所需子集再 stringify，避免键序抖动。 */
function normalizeForKey(facts: ProjectFacts, key: FactKey): string {
  if (key === 'evalReport') {
    const r = facts.evalReport;
    // 只比 path + sha256：mtime 会因"重新落盘但内容相同"抖动，把内容未变误报成陈旧。
    return r === null ? 'null' : JSON.stringify([r.path, r.sha256]);
  }
  const v = facts[key];
  return v === null || v === undefined ? 'null' : JSON.stringify(v);
}

/**
 * 当前事实 vs 存档事实 → 是否陈旧。
 *
 * 语义裁决（三条都要被测试钉死）：
 *   1. **没有存档事实** ⇒ `stale: true`，`changed: ['facts']`。旧状态文件（cycle-38 前的
 *      形态）没有 facts 字段，我们无法证明它的结论仍然成立——按"未验证即陈旧"处理，
 *      这是唯一能自我修复的方向（loadBootstrapState 会据此标 `stale`，面板才能提示重启）。
 *   2. 任一 `FACT_KEYS` 变化 ⇒ `stale: true`。
 *   3. 全部相等 ⇒ `stale: false, changed: []`。
 */
export function diffFacts(
  prev: ProjectFacts | null | undefined,
  next: ProjectFacts,
): FactsDiff {
  if (!prev) return { stale: true, changed: ['facts'] };
  const changed: string[] = [];
  for (const key of FACT_KEYS) {
    if (normalizeForKey(prev, key) !== normalizeForKey(next, key)) changed.push(key);
  }
  return { stale: changed.length > 0, changed };
}

/**
 * 事实摘要（短哈希）——写进 `history[].factsDigest`，用于回答"那一轮基于哪份事实"。
 *
 * 取 16 位十六进制：足够区分（2^64），又能在一屏 JSON 里读。**不取整段 facts**：
 * 历史条目每条塞一份完整快照会让状态文件无限膨胀（每轮 +1 KB）。
 */
export function factsDigest(facts: ProjectFacts): string {
  const canonical = JSON.stringify(
    FACT_KEYS.map((k) => [k, normalizeForKey(facts, k)]),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * 活跃 vs 归档的**唯一分列口径**（P1：评估/门禁/重启的输入面统一走这里）。
 *
 * 为什么必须集中：一旦某处把 `.cycles/archive/**` 也计入"本项目有几轮"，
 * 归档产物就重新参与了判断——这正是本轮要修的缺陷的镜像形态。
 * 本函数零 IO（吃 facts），所以任何调用点都可以用它做断言。
 */
export function activeVsArchived(facts: ProjectFacts): {
  active: string[];
  archived: number;
  total: number;
  /** 评估/重启只应看活跃面；此字段把"该看什么"写进返回值而不是靠调用方记忆。 */
  evaluationInput: string[];
} {
  const active = [...facts.activeCycleNames];
  return {
    active,
    archived: facts.archivedCycles,
    total: facts.activeCycles + facts.archivedCycles,
    evaluationInput: active,
  };
}

// ── 读盘面在 bootstrapFactsReaders.ts（T3 拆分）──

export function collectProjectFacts(workspace: string): ProjectFacts {
  const cyclesDir = join(workspace, '.cycles');
  const hasCyclesDir = existsSync(cyclesDir);
  const state = hasCyclesDir ? readJson(join(cyclesDir, 'workflow-state.json')) : null;
  const git = hasCyclesDir || existsSync(workspace) ? readGit(workspace) : { head: null, dirty: null };

  const activeCycleNames = hasCyclesDir ? listCycleDirNames(join(cyclesDir, 'cycles')) : [];
  const archivedNames = hasCyclesDir ? listCycleDirNames(join(cyclesDir, 'archive')) : [];

  const ledgerVerify = hasCyclesDir ? verifyLedger(cyclesDir) : null;
  const ledgerRead = hasCyclesDir ? readLedgerFacts(cyclesDir) : null;

  return {
    gitHead: git.head,
    gitDirty: git.dirty,
    currentCycle: typeof state?.currentCycle === 'string' ? state.currentCycle : null,
    currentPhase: typeof state?.currentPhase === 'string' ? state.currentPhase : null,
    ledgerHead: ledgerRead?.chainHead ?? null,
    // 条数以 verifyLedger（既有唯一实现）为准；它读同一份文件，不引入第二套解析。
    ledgerEntries: ledgerVerify?.total ?? 0,
    ledgerValid: ledgerVerify?.ok ?? true,
    evalReport: hasCyclesDir ? readLatestEvalReport(cyclesDir, activeCycleNames) : null,
    activeCycles: activeCycleNames.length,
    archivedCycles: archivedNames.length,
    activeCycleNames,
    skillVersion: hasCyclesDir ? readSkillVersion(workspace) : null,
    hasCyclesDir,
  };
}
