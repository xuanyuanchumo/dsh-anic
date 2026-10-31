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
import { loadWorkspaceConfig } from '../config.ts';
import { join } from 'node:path';
import { registerSelfInitRoute } from './selfInitRoute.ts';
import { registerCycleRoute } from './cycleRoute.ts';
import { registerLedgerRoute } from './ledgerRoute.ts';
import { registerStackProbeRoute } from './stackProbeRoute.ts';
import { registerSegmentedLedgerRoute } from './segmentedLedgerRoute.ts';
import { registerReviewRoute } from './reviewRoute.ts';
import { registerEvolutionRoute } from './evolutionRoute.ts';
import { registerGovernanceRoute } from './governanceRoute.ts';
import { registerSelfBootstrapRoutes } from './selfBootstrapRoute.ts';
// cycle-89：跨工作区自举（「举他」）—— 在目标项目上跑同一循环，源工作区零写入。
import { registerCrossBootstrapRoute } from './crossBootstrapRoute.ts';
import { registerSkillRoutes } from './skillRoute.ts';
import { registerSkillInstallRoute } from './skillInstallRoute.ts';
import { registerSkillHealthRoute } from './skillHealthRoute.ts';
import { registerNativeRoute } from './nativeRoute.ts';
import { registerDualBootstrapRoute } from './dualBootstrapRoute.ts';
import { registerTruthAuditRoute } from './truthAuditRoute.ts';
import { registerInvocationRoute } from './invocationRoute.ts';
import { registerFlowsRoute } from './flowsRoute.ts';
// cycle-90：生命周期指标路由（KM 生存分析 / EWMA 控制图 / 分位数+Gini）。
import { registerLifecycleMetricsRoute } from './lifecycleMetricsRoute.ts';
import { registerResolvedFlowsRoute } from './resolvedFlowsRoute.ts';
import { registerDisclosureRoute } from './disclosureRoute.ts';
// cycle-72 T-7207：闭环体检（注册↔生产↔消费 三态矩阵）只读查询面。
import { registerClosureAuditRoute } from './closureAuditRoute.ts';
// cycle-80：热更新重载运维通道（POST /anic/api/reload，ctx.hmr 的 HTTP 消费面）。
import { registerHotReloadRoute } from './hotReloadRoute.ts';
// cycle-82：配置与路径的可视化编辑面（GET/POST /anic/api/config）。
// 归属 data 域：读是观测、写是**受控**治理动作（回读断言 + 回滚 + .bak）。
import { registerConfigRoute } from './configRoute.ts';
// cycle-83：产物治理（归档基线重置 + 清单）。搬迁目录、绝不碰账本（INV-9）。
import { registerArchiveResetRoute } from './archiveResetRoute.ts';
import { buildRouteContext, type SendFn } from './routeContext.ts';
// cycle-89 T-12：拆卸隔离（单个 disposer 抛错不阻断其余）。
import { safeDisposeAll, disposeErrorSink } from '../runtime/safeDispose.ts';
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

/** 能力索引目录（插件 assets/index）——cycle-73 P7 探针的运行时读取面。 */
function defaultIndexDir(): string {
  try { return pluginAssetDir('index'); } catch { return ''; }
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
    registerSelfCheckRoute(ctx, {
      send, getWorkspaceRoot, agentCardsDir, indexDir: defaultIndexDir(),
      // cycle-74：披露模式从工作区配置读（INV-25 单入口；缺省 full ⇒ 零行为变更）。
      // 读不到工作区时回落 'full'（fail-closed 到零变更，绝不悄悄切 indexed）。
      toolDisclosure: (() => {
        try {
          const root = getWorkspaceRoot();
          if (!root) return 'full' as const;
          return loadWorkspaceConfig(join(root, '.cycles')).values.toolDisclosure;
        } catch { return 'full' as const; }
      })(),
    }),
    registerSelfInitRoute(ctx, { send, getWorkspaceRoot, loadFlows }),
    // 动态白盒数据面（cycle-97）：无工作区依赖，feed 缺失时显式 500。
    registerInvocationRoute(ctx, { send, feed: options.invocationFeed ?? null }),
    // 闭环体检（cycle-72 T-7207）：无工作区依赖（体检根是插件自身），
    // 与快照/自检同属 data 域观测面；未消费/幽灵清单的白盒数据源。
    ...registerClosureAuditRoute(c, { send }),
    // cycle-82：配置与路径（GET/POST /anic/api/config）。
    // 依赖 getWorkspaceRoot（X-ANIC-Workspace 头照常生效）——配置是**工作区**事实，
    // 与闭环体检（插件自身事实）语义相反，故必须走共享选择器而不是 resolvePluginRoot。
    ...registerConfigRoute(ctx, { send, getWorkspaceRoot }),
    // cycle-83：产物治理（GET /anic/api/archive/inventory + POST /anic/api/archive/baseline）。
    // 归属 governance 语义但放 data 域旁：它读的是工作区存档事实，写的是**目录搬迁**
    // （不碰账本）。与 config 同款——必须走 getWorkspaceRoot（工作区事实），
    // 不能用 resolvePluginRoot（那是"插件自身"的语义）。
    ...registerArchiveResetRoute(ctx, { send, getWorkspaceRoot }),
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
  // cycle-89「举他」：跨工作区自举。与自举同域（self），但作用域是**另一个项目**。
  disposers.push(...registerCrossBootstrapRoute(c, send));
  disposers.push(...registerSkillRoutes(c, send));
  disposers.push(...registerSkillInstallRoute(ctx, { send, getWorkspaceRoot }));
  // 技能健康观测面（cycle-20 P3 收口）：FlowTracker → analyzeSkillHealth。
  // getWorkspaceRoot 传 req 形态（面板 X-ANIC-Workspace 头参与解析）。
  disposers.push(...registerSkillHealthRoute(ctx, { send, getWorkspaceRoot }));

  // ── native 域（7 脚本原生等价物）──
  if (agentCardsDir) {
    const { cards } = loadAgentCards(agentCardsDir);
    const cardMap = new Map(cards.map((card) => [card.id, card]));
    disposers.push(...registerNativeRoute(ctx, { send, getWorkspaceRoot, agentCards: cardMap, loadFlows }));
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
  // cycle-90：生命周期指标（三个数学模型的读数出口）。
  disposers.push(...registerLifecycleMetricsRoute(c, send, { getWorkspaceRoot }));
  disposers.push(...registerResolvedFlowsRoute(c, send, { getWorkspaceRoot }));
  // cycle-93：披露运行时读数（进程级，不需要工作区）。
  disposers.push(...registerDisclosureRoute(c, send));

  // ── runtime 域（cycle-80：热更新重载运维通道）──
  // 为什么进 self/runtime 面而非 data：它会触发宿主拆装插件（有副作用），属运维动作；
  // 与 anic_reload_self 共用 reloadSelf 同一实现，状态码语义见 hotReloadRoute 头注。
  disposers.push(...registerHotReloadRoute(c, { send, getWorkspaceRoot }));

  const cleanups = disposers.filter((d): d is () => void => typeof d === 'function');
  if (cleanups.length === 0) return null;
  // cycle-89 T-12：拆卸隔离——单个 disposer 抛错**不得阻断其余**。
  // 原 `for (const d of cleanups) d()` 会因一次抛错而留下**未注销的路由**，
  // 热重载后同路径双注册、旧实现仍可被调用。
  return () => { safeDisposeAll(cleanups, disposeErrorSink('anic routes'), 'anic routes'); };
}
