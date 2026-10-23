/**
 * 路由聚合器（纯组合层，130 行）。
 *
 * 六域分区（doc 14 §4）：
 *  data      snapshot + step-trace + self-check + self-init + closure-audit
 *  cycle     cycle + ledger + stack-probe + seg-ledger
 *  review    review（条件性 LLM）
 *  evolution trust + autonomy + breakers + tech-debt
 *  governance archive + budget + sweep + prune
 *  self      self-bootstrap + skill（M7+M8）
 *
 * 共享 deps 经 routeContext 提取（单一职责）；agent 卡目录 dist 相对推导。
 */
import { pluginAssetDir, resolvePluginRoot } from '../pluginRoot.ts';
import { registerSnapshotRoute, type SnapshotCtx } from '../snapshotRoute.ts';
import { registerStepTraceRoute } from './stepTraceRoute.ts';
import { registerSelfCheckRoute } from './selfCheckRoute.ts';
import { registerSelfInitRoute } from './selfInitRoute.ts';
import { registerCycleRoute } from './cycleRoute.ts';
import { registerLedgerRoute } from './ledgerRoute.ts';
import { registerStackProbeRoute } from './stackProbeRoute.ts';
import { registerSegmentedLedgerRoute } from './segmentedLedgerRoute.ts';
import { registerReviewRoute } from './reviewRoute.ts';
import { registerEvolutionRoute } from './evolutionRoute.ts';
import { registerGovernanceRoute } from './governanceRoute.ts';
import { registerSelfBootstrapRoutes } from './selfBootstrapRoute.ts';
import { registerSkillRoutes } from './skillRoute.ts';
import { registerSkillInstallRoute } from './skillInstallRoute.ts';
import { registerSkillHealthRoute } from './skillHealthRoute.ts';
import { registerNativeRoute } from './nativeRoute.ts';
import { registerDualBootstrapRoute } from './dualBootstrapRoute.ts';
import { registerTruthAuditRoute } from './truthAuditRoute.ts';
import { registerInvocationRoute } from './invocationRoute.ts';
import { registerFlowsRoute } from './flowsRoute.ts';
// cycle-72 T-7207：闭环体检（注册↔生产↔消费 三态矩阵）只读查询面。
import { registerClosureAuditRoute } from './closureAuditRoute.ts';
import { buildRouteContext, type SendFn } from './routeContext.ts';
import { loadAgentCards } from '../agents.ts';
import type { InvocationFeed } from '../runtime/invocationFeed.ts';

export type { SendFn } from './routeContext.ts';

export interface RegisterRoutesOptions {
  agentCardsDir?: string;
  /** 实时调用流（cycle-97 动态白盒）；缺省时 /anic/api/invocations/live 显式 500。 */
  invocationFeed?: InvocationFeed | null;
}

function defaultAgentCardsDir(): string {
  // P0-DIR-ROOT（cycle-15）：标记驱动向上查找——旧 `../assets/agents/` 固定层级
  // 只在 dist 单文件布局正确（源码布局会落到 src/host/assets/）。统一走 pluginRoot。
  try { return pluginAssetDir('agents'); } catch { return ''; }
}

/** 注册全部 ANIC 路由（六域分区聚合）。 */
export function registerAnicRoutes(ctx: unknown, options: RegisterRoutesOptions = {}): (() => void) | null {
  const c = ctx as SnapshotCtx;
  if (!c.webServer || typeof c.webServer.register !== 'function') return null;

  const { send, getWorkspaceRoot, loadFlows } = buildRouteContext(ctx);
  const agentCardsDir = options.agentCardsDir ?? defaultAgentCardsDir();
  const disposers: Array<(() => void) | null> = [];

  // ── data 域 ──
  disposers.push(
    registerSnapshotRoute(ctx),
    registerStepTraceRoute(ctx),
    registerSelfCheckRoute(ctx, { send, getWorkspaceRoot, agentCardsDir }),
    registerSelfInitRoute(ctx, { send, getWorkspaceRoot, loadFlows }),
    // 动态白盒数据面（cycle-97）：无工作区依赖，feed 缺失时显式 500。
    registerInvocationRoute(ctx, { send, feed: options.invocationFeed ?? null }),
    // 闭环体检（cycle-72 T-7207）：无工作区依赖（体检根是插件自身），
    // 与快照/自检同属 data 域观测面；未消费/幽灵清单的白盒数据源。
    ...registerClosureAuditRoute(c, { send }),
  );

  // ── cycle 域 ──
  disposers.push(
    registerCycleRoute(ctx, { send, getWorkspaceRoot }),
    registerLedgerRoute(ctx, { send, getWorkspaceRoot }),
    registerStackProbeRoute(ctx, { send, getWorkspaceRoot }),
    registerSegmentedLedgerRoute(c, { send, getWorkspaceRoot }),
  );

  // ── review 域（条件性 LLM）──
  if (agentCardsDir) {
    const { cards } = loadAgentCards(agentCardsDir);
    const cardMap = new Map(cards.map((card) => [card.id, card]));
    registerReviewRoute(
      (method, path, handler) => {
        const d = c.webServer?.register?.({ kind: 'exact', path, handler: handler as (req: unknown, res: unknown) => void });
        if (typeof d === 'function') disposers.push(d);
      },
      {
        getAgentCards: () => cardMap,
        probeCtx: ctx,
        // G5 结论时效：评审结论要落到该工作区的 .cycles/reviews/ledger.json。
        // 走共享 getWorkspaceRoot（无 req）——评审是工具/HTTP 双通道共用的单一路由，
        // 没有面板的 X-ANIC-Workspace 头可依，落到宿主当前会话工作区是唯一诚实解。
        getWorkspaceRoot: () => getWorkspaceRoot(),
      },
    );
  }

  // ── evolution 域 ──
  disposers.push(...registerEvolutionRoute(c, send));

  // ── governance 域 ──（P0-GOV-ROOT：改传共享 getWorkspaceRoot——本地 resolveRoot
  //   的裸 ctx.workspaceRegistry 属性访问在真实 fiber 抛异常，4 路由恒 400 空体）
  disposers.push(...registerGovernanceRoute(c, { send, getWorkspaceRoot }));

  // ── self 域（M7 自举 + M8 跨项目 + 技能自动安装）──
  disposers.push(...registerSelfBootstrapRoutes(c, send));
  disposers.push(...registerSkillRoutes(c, send));
  disposers.push(...registerSkillInstallRoute(ctx, { send, getWorkspaceRoot }));
  // 技能健康观测面（cycle-20 P3 收口）：FlowTracker → analyzeSkillHealth。
  // getWorkspaceRoot 传 req 形态（面板 X-ANIC-Workspace 头参与解析）。
  disposers.push(...registerSkillHealthRoute(ctx, { send, getWorkspaceRoot }));

  // ── native 域（7 脚本原生等价物）──
  if (agentCardsDir) {
    const { cards } = loadAgentCards(agentCardsDir);
    const cardMap = new Map(cards.map((card) => [card.id, card]));
    disposers.push(...registerNativeRoute(ctx, { send, getWorkspaceRoot, agentCards: cardMap }));
  }

  // ── dual 域（双向自举 M11）──
  {
    // P0-DIR-ROOT（cycle-15）：旧 `new URL('../../../')` 在 dist 单文件布局下
    // 解析到仓库父目录——dualBootstrap 一直在审计错误目录。改标记驱动解析。
    const pluginDir = resolvePluginRoot();
    disposers.push(...registerDualBootstrapRoute({ ctx: c, send, getWorkspaceRoot, pluginDir }));
    disposers.push(...registerTruthAuditRoute(c, send));
  }

  // ── flows 域（R3 阶段 2：流程状态流转机观测面 + 运行面）──
  disposers.push(...registerFlowsRoute(c, send, { getWorkspaceRoot }));

  const cleanups = disposers.filter((d): d is () => void => typeof d === 'function');
  if (cleanups.length === 0) return null;
  return () => { for (const d of cleanups) d(); };
}
