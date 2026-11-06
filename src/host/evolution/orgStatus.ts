/**
 * 组织状态聚合（原生实现，替代技能 org-status.mjs）。
 * 汇总 trust + autonomy + breakers + cycles + band → 全景状态。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkspaceConfig } from '../config.ts';
import { loadLedger } from '../runtime/ledger.ts';
import { buildTrustScores, recommendBand, type AutonomyBand, type LedgerEntryForTrust } from './trustModel.ts';
import { checkBreakers, decideAction, type BreakerInput } from './autonomyGovernor.ts';
import { loadHistoryScores } from './bandHistory.ts';
import { classifyBand, detectTrend, detectWeViolations, type WeViolation } from './bandDetector.ts';
import { collectBreakerSignals } from './breakerSignals.ts';
import { readHistory, summarizeHistory } from './autonomyHistory.ts';
import { reloadSummary } from '../runtime/hotReload.ts';
import { resolvePluginRoot } from '../pluginRoot.ts';
import { readCycleDrift, type CycleDrift } from './cycleDrift.ts';

/**
 * 给读者的**诚实提示**：hmr 可用性无法在只读快照里断言（headless/SDK profile 没有
 * hmr 服务，桌面 profile 有；只有真正调用 `anic_reload_self` 时才会按请求探测）。
 * 面板把这句话原样显示，避免把"本段是只读快照"误读成"重载能力可用"。
 */
const HMR_PROBE_HINT = 'hmr availability is probed at request time by anic_reload_self; org-status is read-only';

export interface OrgStatus {
  /**
   * cycle-108：`drift` 是**只增字段**——「HEAD/状态机/目录」三个循环坐标是否互相矛盾。
   * 缺陷实证：HEAD 已 cycle-107 而状态机停在 cycle-105，106/107 两轮测试报告
   * 全写进 cycle-105（无一步报错）。面板必须能看见"坐标错了"，否则证据与轮次错配。
   */
  cycles: { total: number; latest: string | null; converged: number; failed: number; drift: CycleDrift };
  ledger: { entries: number; valid: boolean };
  trust: { scores: Record<string, { score: number; approve: number; total: number }>; recommendedBand: string };
  autonomy: {
    currentBand: string;
    configuredBand: string;
    breakers: string[];
    action: string;
    /** cycle-77：自主级变更账的最近 5 条摘要（只追加字段，既有字段语义不变）。 */
    history: Array<{ from: string; to: string; at: string; actor: string; authorization: string; reason: string }>;
    /** 账本总条数（坏 JSON 时为 0，并由 historyError 点名根因，不静默吞）。 */
    historyCount: number;
    historyError?: string;
  };
  band: { current: string; trend: string; weViolations: WeViolation[]; recent: number[] };
  flows: { selfInit: boolean; agentsOrchestration: boolean };
  /**
   * cycle-80：热更新只读投影（构建新鲜度 + 最近一次重载）。
   *
   * 只增字段，既有字段语义不变。为什么必须在 org-status 里：观测到的「当前状态」
   * 若不带「这是哪一版 dist 产出的」，则"改了代码没生效"与"代码本来就该这样"在
   * 白盒面上无法区分。纯只读：不触发重载、不写文件（写入只发生在 anic_reload_self）。
   */
  reload: {
    stale: boolean;
    revision: string | null;
    historyCount: number;
    lastStatus: string | null;
    lastAt: string | null;
    error: string | null;
    hmrProbeHint: string;
  };
  timestamp: string;
}

export function runOrgStatus(workspaceRoot: string, options: {
  currentBand?: string;
  breakersInput?: Partial<BreakerInput>;
  currentScore?: number;
  flows?: { selfInit: boolean; agentsOrchestration: boolean };
}): OrgStatus {
  const cyclesDir = join(workspaceRoot, '.cycles');

  // Cycles
  const cyclesDir2 = join(cyclesDir, 'cycles');
  let cycleDirs: string[] = [];
  if (existsSync(cyclesDir2)) {
    cycleDirs = readdirSync(cyclesDir2).filter((d) => /^cycle-\d+$/.test(d));
  }
  const converged = cycleDirs.filter((d) => existsSync(join(cyclesDir2, d, '交付清单.md'))).length;
  const failed = cycleDirs.filter((d) => existsSync(join(cyclesDir2, d, '审计日志.md')) &&
    readFileSync(join(cyclesDir2, d, '审计日志.md'), 'utf-8').includes('FAIL')).length;
  // cycle-50 T-5001：readdirSync 返回字典序——「cycle-9」字典序大于「cycle-49」（逐字符
  // 比较第 7 位 '9'>'4'），50 轮以上工作区会显示「最新 cycle-9」假象（cycle-49 真机发现）。
  // 数值序取最新：解析数字比较，解析失败的目录名不参与排序（正则已保证 \d+，双保险）。
  const latestCycle = cycleDirs.length > 0
    ? (cycleDirs.reduce<string | null>((best, d) => {
        const num = parseInt(d.replace(/^cycle-/, ''), 10);
        const bestNum = best === null ? -1 : parseInt(best.replace(/^cycle-/, ''), 10);
        return Number.isFinite(num) && num > bestNum ? d : best;
      }, null))
    : null;

  // Ledger
  let ledgerEntries = 0;
  let ledgerValid = true;
  const ledgerPath = join(cyclesDir, 'gates', 'ledger.json');
  const ledger: LedgerEntryForTrust[] = existsSync(ledgerPath) ? loadLedger(cyclesDir) : [];
  ledgerEntries = ledger.length;
  ledgerValid = ledger.every((e, i) => i === 0 || e.gate !== '');

  // Trust
  const trustScoresMap = buildTrustScores(ledger);
  const trustScores: Record<string, { score: number; approve: number; total: number }> = {};
  for (const [gate, ts] of trustScoresMap) {
    trustScores[gate] = { score: ts.trustScore, approve: ts.approveCount, total: ts.totalDecisions };
  }
  const avgTrust = ledger.length > 0
    ? Math.round(ledger.filter((e) => e.result.toLowerCase() === 'pass' || e.result.toLowerCase() === 'approve').length / ledger.length * 100)
    : 0;
  // P1（autonomy 双投影矛盾）：currentBand 缺省时经 INV-25 唯一 loader 读
  // `.cycles/config.yml` 的 `macro_cycle.autonomy_level`，而不是静默兜底 'L2'。
  // 此前同页两个投影会同时显示「autonomy L4」（snapshotCore 读配置）与
  // 「当前: L2」（本函数硬编码）—— 同一工作区、同一时刻、两个真相。
  // 显式传入 currentBand 的调用方（测试/降级路径）仍然优先。
  const configuredBand = loadWorkspaceConfig(cyclesDir).values.autonomyLevel;
  const band = (options.currentBand ?? configuredBand) as AutonomyBand;
  const recommendedBand = recommendBand(band, avgTrust);

  // Autonomy
  //
  // R3 阶段 1（已修）：此前 `DEFAULT_BREAKER_INPUT` 全零 —— checkBreakers 的 8 条
  // 判定从未在真实工作区触发过（纯函数 + 恒零输入 = 永不熔断）。现在由
  // collectBreakerSignals 从真实文件采集（incidents/账本/band-history/config.yml，
  // 对齐技能侧 org-status.mjs:25-82 CB1-CB8），显式 options.breakersInput 仍可
  // 覆盖（测试与持有更丰富信号的调用方优先）。
  const breakerInput: BreakerInput = { ...collectBreakerSignals(workspaceRoot), ...options.breakersInput };
  const breakerResults = checkBreakers(breakerInput);
  const action = decideAction(band, breakerResults);

  // Band
  // cycle-21（两代 schema 收敛）：band-history.json 的真实生产形状是代码质量带
  // （技能 band-detector 写入 avgScore/totalScore）；旧代码 map(e=>e.score) 产出
  // [null,null]（cycle-20 真机发现）。改用 loadHistoryScores 量纲感知读取：
  // trend/WE 检测对自主带（0-1）与质量带（复杂度分）分别取序列，不再混算。
  // band.current 只对自主带分数有阈值语义；质量带/空历史 → 'normal' 不误报。
  const { scores: historyScores, source: historySource } = loadHistoryScores(workspaceRoot);
  const bandCurrent = historySource === 'autonomy' && historyScores.length > 0
    ? classifyBand(historyScores[historyScores.length - 1] ?? 1)
    : 'normal';
  // P3（已修）：trend 原为硬编码 'stable' —— bandDetector.detectTrend 早已实现
  // 却从未被接线（R3 双真相源审计 #10）。现在从真实 band-history 分数序列推导。
  const bandTrend = detectTrend(historyScores);
  // WE 8 规则（cycle-7 移植）的可观测面：org 面板此前只显示 current/trend，
  // 违例事实被采集却不可见 —— 动态白盒要求「能涉及的方面都可见」。
  const weViolations = detectWeViolations(historyScores);
  // cycle-20（P2 仪表带）：最近 12 个分数点——趋势火花线的数据面。
  // 空历史 → 空数组（客户端省略火花线，不伪造平线）。
  const recentScores = historyScores.slice(-12);

  // 自主级变更账（cycle-77 P0「自主级变更不可审计」）：org-status 是用户的观测面，
  // 账本存在却不可见等于「写了没人读」的第二个死端。只读 + 有界投影（最近 5 条），
  // 坏 JSON 时 historyCount 归零但 historyError 响亮点名（不假绿）。
  const historyRead = readHistory(cyclesDir);

  // 热更新只读投影（cycle-80）：把「我跑的是哪一版 dist / 上次重载成没成」接到用户
  // 观测面。pluginRoot 用标记驱动解析（src 布局与 dist bundle 布局自适应），解析失败
  // 时 reloadSummary 按"dist 缺失"诚实返回 stale=true + reason，而不是假装新鲜。
  const reloadRead = reloadSummary(cyclesDir, resolvePluginRoot());

  return {
    cycles: { total: cycleDirs.length, latest: latestCycle, converged, failed, drift: readCycleDrift(workspaceRoot) },
    ledger: { entries: ledgerEntries, valid: ledgerValid },
    trust: { scores: trustScores, recommendedBand },
    autonomy: {
      currentBand: band,
      configuredBand,
      breakers: breakerResults.filter((b) => b.tripped).map((b) => b.id),
      action,
      history: summarizeHistory(historyRead.entries, 5),
      historyCount: historyRead.entries.length,
      ...(historyRead.error !== null ? { historyError: historyRead.error } : {}),
    },
    band: { current: bandCurrent, trend: bandTrend, weViolations, recent: recentScores },
    flows: options.flows ?? { selfInit: true, agentsOrchestration: true },
    reload: {
      stale: reloadRead.stale,
      revision: reloadRead.revision,
      historyCount: reloadRead.historyCount,
      lastStatus: reloadRead.last?.status ?? null,
      lastAt: reloadRead.last?.at ?? null,
      error: reloadRead.error,
      hmrProbeHint: HMR_PROBE_HINT,
    },
    timestamp: new Date().toISOString(),
  };
}
