/**
 * 门禁证据装配器（P0-2 修复）。
 *
 * 背景：`nativeRoute.ts` 此前把 `evidenceByGate = {}` 直接喂给 `runAllGates`，
 * 后果是**五个门全部零证据** → `heuristicEvaluate` 恒 `doubt` →
 * 「多门评审」这条功能在真实工作区里从未产出过一次有效裁决
 * （`trustModel` 因此永远收不到 approve，自主级永远升不上去）。
 *
 * 本模块是唯一证据来源：把**真实工作区工件与真实账本**翻译成结构化
 * `EvidenceItem[]`（带 `result` 三态），而不是让调用方自己拼字符串。
 *
 * 两个世界的门名必须分清（这是本模块存在的根因）：
 *   - **ANIC 门**（本插件 `GateName`）：`intent|spec|plan|pr|release` —— 人类审批门，
 *     来自技能侧 `scripts/multi-agent-gate.mjs:101-152` 的 `GATE_AGENTS`。
 *   - **收敛门**（真实账本里的 `gate` 值）：`G0|G1|G2|G3` —— 来自 `gate-check`。
 * 技能侧 `pr`/`release` 门的判定依赖 `getPassedGates()`（`:90-99`）读账本取
 * G0-G3 的**最新 PASS 集合**，再用 `['G0','G1','G2','G3'].every(...)` 判全绿
 * （`:395`、`:427`）。本模块复刻同一判据。
 *
 * 诚实纪律（INV-23）：**没有证据 ≠ 通过**。缺失的工件产出 `FAIL` 证据而非跳过，
 * 因为「门禁要求的东西不存在」是一个确定的失败事实，不是一个未知。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceItem, GateName } from './multiAgentGate.ts';
import { verifyLedger } from '../runtime/ledger.ts';

/** 收敛门名（真实账本中的 `gate` 取值）。 */
export const CONVERGENCE_GATES = ['G0', 'G1', 'G2', 'G3'] as const;

interface LedgerEntryLite {
  gate?: unknown;
  result?: unknown;
  timestamp?: unknown;
}

/** 文件存在且非空（空文件不算证据 —— 与「文件存在即 pass」的伪自信划清界限）。 */
function nonEmptyFile(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** 候选路径中第一个存在且非空的文件；都不满足返回 null。 */
function firstNonEmpty(paths: Array<string | null>): string | null {
  for (const p of paths) {
    if (p !== null && nonEmptyFile(p)) return p;
  }
  return null;
}

/**
 * 读账本，返回**每个收敛门的最新一条裁决**。
 * 判据与技能侧 `getPassedGates()`（`multi-agent-gate.mjs:90-99`）一致：
 * 按 timestamp 取该门最新条目，不按数组顺序（历史条目可能乱序）。
 */
export function latestConvergenceVerdicts(cyclesDir: string): Map<string, 'PASS' | 'FAIL'> {
  const out = new Map<string, 'PASS' | 'FAIL'>();
  const ledgerPath = join(cyclesDir, 'gates', 'ledger.json');
  if (!existsSync(ledgerPath)) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
  } catch {
    return out; // 结构损坏 → 空集（调用方会把它翻译成 FAIL 证据）
  }
  const entries: unknown = Array.isArray(raw) ? raw : (raw as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return out;

  const latestTs = new Map<string, string>();
  for (const item of entries as LedgerEntryLite[]) {
    const gate = typeof item?.gate === 'string' ? item.gate : null;
    const result = item?.result;
    if (gate === null || (result !== 'PASS' && result !== 'FAIL')) continue;
    const ts = typeof item.timestamp === 'string' ? item.timestamp : '';
    const prev = latestTs.get(gate);
    if (prev === undefined || ts >= prev) {
      latestTs.set(gate, ts);
      out.set(gate, result);
    }
  }
  return out;
}

/** 最新 cycle 目录（`cycle-<数字>` 中数字最大者），无则 null。 */
export function latestCycleDir(cyclesDir: string): string | null {
  const parent = join(cyclesDir, 'cycles');
  if (!existsSync(parent)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(parent).filter((d) => /^cycle-\d+$/.test(d));
  } catch {
    return null;
  }
  if (dirs.length === 0) return null;
  const num = (d: string): number => Number.parseInt(d.slice('cycle-'.length), 10);
  const best = dirs.reduce((a, b) => (num(a) >= num(b) ? a : b));
  return join(parent, best);
}

/** 一条「工件存在性」证据：存在且非空 → PASS，否则 FAIL（附缺失原因）。 */
function artifactEvidence(id: string, label: string, path: string | null, tried: string[]): EvidenceItem {
  if (path !== null) {
    return { id, content: `${label} 存在：${path}`, result: 'PASS' };
  }
  return { id, content: `${label} 缺失（已尝试：${tried.join(' / ')}）`, result: 'FAIL' };
}

/**
 * 收敛门证据：G0-G3 各自的账本裁决 + 账本链完整性。
 * 未出现在账本中的收敛门 → FAIL（「从未记录过」不等于「通过」）。
 */
function convergenceEvidence(cyclesDir: string): EvidenceItem[] {
  const verdicts = latestConvergenceVerdicts(cyclesDir);
  const items: EvidenceItem[] = [];
  for (const gate of CONVERGENCE_GATES) {
    const v = verdicts.get(gate);
    items.push({
      id: `ledger:${gate}`,
      content: v === undefined ? `账本无 ${gate} 裁决记录` : `账本 ${gate} 最新裁决 ${v}`,
      result: v === undefined ? 'FAIL' : v,
    });
  }
  const chain = verifyLedger(cyclesDir);
  // 空账本不是「校验通过」（单测抓出的真空真值）：`verifyLedger` 对缺失文件
  // 返回 `{ok:true,total:0}`，若照搬就会产出「账本哈希链校验通过（0 条）」
  // 这条 PASS 证据 —— 而事实是**根本没有账本可校验**。0 条即无证据，
  // 按 INV-23「没有证据 ≠ 通过」判 FAIL。
  items.push({
    id: 'ledger:chain',
    content:
      chain.total === 0
        ? '账本不存在或为空，无可校验的哈希链'
        : chain.ok
          ? `账本哈希链校验通过（${String(chain.total)} 条）`
          : `账本哈希链断裂（${String(chain.total)} 条，brokenAt=${String(chain.brokenAt)}：${chain.reason ?? '未知'}）`,
    result: chain.total > 0 && chain.ok ? 'PASS' : 'FAIL',
  });
  return items;
}

/**
 * 收集全部 ANIC 门的证据（唯一实现）。
 *
 * 路径容差（实测发现，2026-10-17）：技能侧 `multi-agent-gate.mjs` 只认
 * `.cycles/intent/spec.md`（:235）与 `.cycles/intent/plan.md`（:299），
 * 但**真实工作区**（dsh-codegraph-visualizer）把这两份工件放在
 * `.cycles/spec.md` 与 `.cycles/plan.md` —— 即技能脚本自身的路径已经漂移
 * （与 docs/anic 09 §S-1「配置文件名漂移」同族）。插件侧不能复制这个漂移：
 * 按**候选序列**取第一个存在且非空者，两代布局都能读到证据。
 *
 * @param workspaceRoot 工作区根（含 `.cycles/`）
 */
export function collectGateEvidence(workspaceRoot: string): Record<GateName, EvidenceItem[]> {
  const cyclesDir = join(workspaceRoot, '.cycles');
  const cycleDir = latestCycleDir(cyclesDir);
  const inCycle = (name: string): string | null => (cycleDir === null ? null : join(cycleDir, name));

  const intentCandidates = [join(cyclesDir, 'intent', 'intent.md'), join(cyclesDir, 'intent.md')];
  const specCandidates = [join(cyclesDir, 'intent', 'spec.md'), join(cyclesDir, 'spec.md')];
  const planCandidates = [
    join(workspaceRoot, 'plan.md'),
    join(cyclesDir, 'intent', 'plan.md'),
    join(cyclesDir, 'plan.md'),
    inCycle('当前循环总规划.md'),
  ].filter((p): p is string => p !== null);
  const auditCandidates = [inCycle('审计日志.md')].filter((p): p is string => p !== null);
  const deliveryCandidates = [inCycle('交付清单.md')].filter((p): p is string => p !== null);
  const nonFuncCandidates = [inCycle('非功能验证报告.md')].filter((p): p is string => p !== null);

  const convergence = convergenceEvidence(cyclesDir);

  // intent 门：意图工件本身。技能侧 `evaluateIntentGate` 只读 intent.md（:155）。
  const intentEv: EvidenceItem[] = [
    artifactEvidence('artifact:intent', '意图工件', firstNonEmpty(intentCandidates), intentCandidates),
  ];

  // spec 门：规格工件（技能侧 `evaluateSpecGate` 只读 spec.md，:235）。
  const specEv: EvidenceItem[] = [
    artifactEvidence('artifact:spec', '规格工件', firstNonEmpty(specCandidates), specCandidates),
  ];

  // plan 门：计划工件（技能侧 `evaluatePlanGate` 三候选，:298-301）。
  const planEv: EvidenceItem[] = [artifactEvidence('artifact:plan', '计划工件', firstNonEmpty(planCandidates), planCandidates)];

  // pr 门：技能侧要求「有改动」+ G0-G3 全绿（:395）。
  const prEv: EvidenceItem[] = [...convergence];

  // release 门：G0-G3 全绿 + 链校验 + 三份收尾工件（:427-461）。
  const releaseEv: EvidenceItem[] = [
    ...convergence,
    artifactEvidence('artifact:non-functional', '非功能验证报告', firstNonEmpty(nonFuncCandidates), nonFuncCandidates.length > 0 ? nonFuncCandidates : ['(无最新 cycle)']),
    artifactEvidence('artifact:audit', '审计日志', firstNonEmpty(auditCandidates), auditCandidates.length > 0 ? auditCandidates : ['(无最新 cycle)']),
    artifactEvidence('artifact:delivery', '交付清单', firstNonEmpty(deliveryCandidates), deliveryCandidates.length > 0 ? deliveryCandidates : ['(无最新 cycle)']),
  ];

  return { intent: intentEv, spec: specEv, plan: planEv, pr: prEv, release: releaseEv };
}
