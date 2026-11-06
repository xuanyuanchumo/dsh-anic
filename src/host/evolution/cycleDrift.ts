/**
 * 循环坐标漂移检测（cycle-108）——「HEAD 说自己跑到了 cycle-N，产物却写进 cycle-M」的白盒判据。
 *
 * ## 缺陷实证（cycle-108 开工前）
 *
 * 本仓 HEAD 已是 `02b958c v0.57.0 cycle-107`，但：
 *   - `.cycles/workflow-state.json` 的 `currentCycle` 停在 **cycle-105**、`currentPhase` 停在 `plan`；
 *   - `.cycles/cycles/` 里只有 **cycle-105**（106/107 从未 `init-cycle`）；
 *   - 结果：`run-tests.mjs` 把 106/107 两轮的真实测试报告**全都写进了 cycle-105/**
 *     （本轮基线实测 `[test-evidence] … cycle-105/test-reports/测试报告.md`）。
 *
 * 危害不是"目录名不好看"：G0 评估报告、G2 测试报告、账本门禁三方**共用这个坐标**。
 * 一旦坐标落后，新一轮的结论会被写进旧循环的审计轨迹里——**证据与轮次错配**，
 * 而面板上 `converged/failed` 的计数也会把两轮揉成一轮。这是"研究→证据→门禁"链上
 * 最隐蔽的一类漂移：**没有任何一步报错**。
 *
 * ## 判据（全部来自可复算事实，无阈值魔法）
 *
 * 1. `HEAD_AHEAD_OF_LIVE`：commit subject 里出现的最大 `cycle-N` > 活跃循环目录最大编号；
 * 2. `STATE_BEHIND_LIVE`：`workflow-state.currentCycle` < 活跃循环最大编号；
 * 3. `STATE_AHEAD_OF_LIVE`：`workflow-state.currentCycle` > 活跃循环最大编号（缺循环工作区）；
 * 4. `STATE_MISSING`：状态文件缺失/无 `currentCycle`；
 * 5. `ARCHIVE_AHEAD_OF_LIVE`：归档最大编号 > 活跃最大编号（活跃面落后于已归档历史）。
 *
 * 纯函数 `detectCycleDrift` 不做 IO —— 单测可穷举；`readCycleDrift` 只读三个源。
 * 采不到 `git`（非 git 工作区）**不是**漂移：`headSubject=null` 时第 1 条判据不参与。
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { listCycleDirNames, readJson } from '../runtime/bootstrapFactsReaders.ts';

/** 漂移原因码（面板按码取 i18n，不把中文写进宿主响应）。 */
export type CycleDriftCode =
  | 'HEAD_AHEAD_OF_LIVE'
  | 'STATE_BEHIND_LIVE'
  | 'STATE_AHEAD_OF_LIVE'
  | 'STATE_MISSING'
  | 'ARCHIVE_AHEAD_OF_LIVE';

export interface CycleDriftReason {
  code: CycleDriftCode;
  /** 该原因涉及的数字（按码取用；缺失即不渲染该项）。 */
  head?: number;
  state?: number;
  live?: number;
  archived?: number;
}

export interface CycleDriftInput {
  /** `git log -1 --format=%s`；非 git / 失败 → null。 */
  headSubject: string | null;
  /** `.cycles/cycles/` 下的目录名（活跃面）。 */
  liveCycles: readonly string[];
  /** `.cycles/archive/` 下的目录名（只作历史）。 */
  archivedCycles: readonly string[];
  /** `.cycles/workflow-state.json` 的 currentCycle。 */
  stateCycle: string | null;
}

export interface CycleDrift {
  drift: boolean;
  headCycle: number | null;
  stateCycle: string | null;
  liveLatest: string | null;
  archivedLatest: string | null;
  reasons: CycleDriftReason[];
  /** 建议的下一循环名（`cycle-<max+1>`）；无任何坐标时为 `cycle-1`。 */
  suggestedCycle: string;
}

/** `cycle-12` → 12；非循环名 → null（不把 `cycle-` 后非数字当 0）。 */
export function cycleNumberOf(name: string | null): number | null {
  if (name === null) return null;
  const m = /^cycle-(\d+)$/.exec(name);
  return m === null ? null : Number(m[1]);
}

/**
 * commit subject 里的最大循环号。
 *
 * 取**最大**而非第一个：合并提交/收口提交常把多轮写进同一标题
 * （如 `cycle-108: … cycle-107 遗留 …`），取首个会把真实的最高轮次漏掉。
 * 完全无命中 → null（普通提交不构成漂移证据）。
 */
export function headCycleOf(subject: string | null): number | null {
  if (subject === null || subject.length === 0) return null;
  const all = [...subject.matchAll(/cycle-(\d+)/g)].map((m) => Number(m[1]));
  if (all.length === 0) return null;
  return Math.max(...all);
}

function latestOf(names: readonly string[]): string | null {
  let best: number | null = null;
  let bestName: string | null = null;
  for (const name of names) {
    const n = cycleNumberOf(name);
    if (n === null) continue;
    if (best === null || n > best) {
      best = n;
      bestName = name;
    }
  }
  return bestName;
}

/** 纯函数判据（无 IO）。 */
export function detectCycleDrift(input: CycleDriftInput): CycleDrift {
  const headCycle = headCycleOf(input.headSubject);
  const liveLatest = latestOf(input.liveCycles);
  const archivedLatest = latestOf(input.archivedCycles);
  const liveN = cycleNumberOf(liveLatest);
  const archivedN = cycleNumberOf(archivedLatest);
  const stateN = cycleNumberOf(input.stateCycle);
  const reasons: CycleDriftReason[] = [];

  if (headCycle !== null && liveN !== null && headCycle > liveN) {
    reasons.push({ code: 'HEAD_AHEAD_OF_LIVE', head: headCycle, live: liveN });
  }
  if (input.stateCycle === null) {
    reasons.push({ code: 'STATE_MISSING' });
  } else if (stateN === null) {
    // 形状不对（如写成了 `107`）同样是缺失：坐标无法参与比较就必须响亮。
    reasons.push({ code: 'STATE_MISSING' });
  } else if (liveN !== null && stateN < liveN) {
    reasons.push({ code: 'STATE_BEHIND_LIVE', state: stateN, live: liveN });
  } else if (liveN !== null && stateN > liveN) {
    reasons.push({ code: 'STATE_AHEAD_OF_LIVE', state: stateN, live: liveN });
  }
  if (archivedN !== null && liveN !== null && archivedN > liveN) {
    reasons.push({ code: 'ARCHIVE_AHEAD_OF_LIVE', archived: archivedN, live: liveN });
  }

  const candidates = [headCycle, stateN, liveN, archivedN].filter((n): n is number => n !== null);
  const next = candidates.length === 0 ? 1 : Math.max(...candidates) + 1;
  return {
    drift: reasons.length > 0,
    headCycle,
    stateCycle: input.stateCycle,
    liveLatest,
    archivedLatest,
    reasons,
    suggestedCycle: `cycle-${String(next)}`,
  };
}

/**
 * `git log -1 --format=%s` 的 5s 记忆化。
 *
 * 为什么需要：`org-status` 是面板**轮询**端点（多个分区共同消费），而每次派生
 * git 子进程在 Windows 上约 20-50ms——把白盒读数接进 5s 级轮询会让一次刷新付出
 * 多次进程创建。HEAD 在 5s 内变化本就意味着"正在提交"，此时读到上一版不改变
 * 任何结论（漂移判定只需轮次号，不需要秒级实时）。
 *
 * 缓存键按工作区隔离（多项目共用一个宿主 profile 时不得串味）。
 */
const SUBJECT_TTL_MS = 5000;
const subjectCache = new Map<string, { at: number; subject: string | null }>();

/** `git log -1 --format=%s`。非 git / 无提交 / 超时 → null（不抛）。 */
export function readHeadSubject(workspace: string): string | null {
  const hit = subjectCache.get(workspace);
  if (hit !== undefined && Date.now() - hit.at < SUBJECT_TTL_MS) return hit.subject;
  let subject: string | null = null;
  try {
    const r = spawnSync('git', ['log', '-1', '--format=%s'], {
      cwd: workspace,
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    if (!r.error && r.status === 0) {
      const s = typeof r.stdout === 'string' ? r.stdout.trim() : '';
      subject = s.length > 0 ? s : null;
    }
  } catch {
    subject = null;
  }
  subjectCache.set(workspace, { at: Date.now(), subject });
  return subject;
}

/** 读三个坐标源并判定。只读，不写任何文件。 */
export function readCycleDrift(workspaceRoot: string): CycleDrift {
  const cyclesDir = join(workspaceRoot, '.cycles');
  const state = readJson(join(cyclesDir, 'workflow-state.json'));
  const raw = state?.['currentCycle'];
  return detectCycleDrift({
    headSubject: readHeadSubject(workspaceRoot),
    liveCycles: listCycleDirNames(join(cyclesDir, 'cycles')),
    archivedCycles: listCycleDirNames(join(cyclesDir, 'archive')),
    stateCycle: typeof raw === 'string' && raw.length > 0 ? raw : null,
  });
}