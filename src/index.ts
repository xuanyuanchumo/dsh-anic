/**
 * dsh-anic host entry（M1..M8 全功能面）。
 *
 * inject 只列**本插件自身必需**的服务：
 *   tools    —— DSH 工具注册槽位（21 个 anic_* 工具）；
 *   sessions —— 工作区解析的第一后备来源（registry 为可选，用 ctx.get 探测，不进 inject）；
 *   skills   —— 官方技能注册槽位（cycle-97），经 ctx.skills.register 注册 runtime skill。
 *
 * **webServer 已移出本插件 inject（cycle-74 P0 修复）**：它由 `@deepseek-ai/dsh-web-app`
 * bundle 提供（desktop 有、headless 无）。列为硬依赖时 headless 下**整条 fiber pending**，
 * 连不依赖它的 21 工具 / 索引 / 自举链一并失效（沙箱真机实测：
 * `pending (waiting for service: webServer)` 且 `global_anic_count = 0`）——
 * 属「注册了但没激活」的注册面缺口。现将路由面拆为**独立子插件**
 * （anicRoutesPlugin：唯一声明 `inject: ['webServer']` 的地方）：缺席时只它自己 pending，
 * 父插件照常激活；webServer 就绪后 cordis 自动激活之（组合语义）。
 * **不是**「把 webServer 从 inject 删掉了事」：路由确实硬依赖 webServer，
 * 直接删会丢「apply 时就绪」的保证（KB cordis-tutorial/03-services.md:35），
 * 63 条路由可能抢跑静默丢失。
 *
 * 为什么 skills 用**静态** inject 而不是 ctx.inject 动态挂载（cycle-97 实测教训）：
 * 官方消费方（dsh-skill-badge lib/index.js）全部用静态 `const inject = ["skills"]`；
 * cordis 4.0.4 的 ctx.inject(inject, callback) 虽会建嵌套插件纤维，但真实宿主里
 * 回调从未触发（服务在场、路由全通、注册日志全无——即 apply 走了 inject 分支
 * 而嵌套纤维不激活）。静态 inject 由组合器保证时序，是唯一经生产验证的形态。
 * 风险对称性：skills 与 webServer 同由 dsh-base 组合提供——能激活本插件的宿主
 * 必然两者皆有，加 skills 不引入新的激活风险（engines 下限 0.2.0-rc.2 起
 * dsh-base 均含技能子系统，全局安装版与 asar 均已实测验证）。
 * 宿主没有 webServer 时路由整体跳过，插件主体（客户端标签 + 嵌入快照）不受影响。
 */
import { wireRoutes } from './host/anicRoutesPlugin.ts';
import { registerAnicTools } from './host/tools.ts';
import { createInvocationFeed, attachInvocationFeed } from './host/runtime/invocationFeed.ts';
import { createInvocationAttributor } from './host/runtime/invocationAttribution.ts';
import { registerRuntimeSkill } from './host/skillRegistration.ts';
import { registerBuiltinFlows } from './host/flows/builtin.ts';
import { wireToolDisclosureFromConfig } from './host/toolDisclosureWiringRuntime.ts';
import { join } from 'node:path';
import { createScoped } from './host/logger.ts';
import { resolvePluginRoot } from './host/pluginRoot.ts';
import { resolveWorkspaceRoots } from './host/snapshotRoute.ts';
import { buildFreshness, computeBuildRevision, finalizeInFlight, markRunningRevision } from './host/runtime/hotReload.ts';

const reloadLog = createScoped('hot-reload');

/**
 * 热更新握手 + 冷启动新鲜度（cycle-80 WS-2）。
 *
 * ① 握手：`anic_reload_self` 在**触发重载之前**写一条 `in-flight`（重载会杀掉旧实例，
 *    事后没人能写这条）。新实例启动时把它 finalize 成 `reloaded`，"上次重载成没成"
 *    才有闭环答案；非 null 返回值 = 真的换了实例（而不只是冷启动碰巧有历史）。
 * ② 冷启动自愈：`dist` 落后 `src`（stale）时**只记录、不自动重建**。
 *    为什么不自愈构建：那要在插件运行时里引入 tsdown 依赖，并撞上 build-client.mjs 的
 *    F-09 删窗（先删 dist 再构建，失败即整目录消失）——构建职责不在本插件运行时里；
 *    正确动作是把 stale 事实暴露给 org-status/面板（用户可见），重建由人在
 *    `anic_reload_self` 之前显式完成。
 *
 * 任何失败都只记 warn 不抛：可观测性附加项不得影响插件激活。
 */
function runReloadHandshake(ctx: unknown): void {
  try {
    const ws = resolveWorkspaceRoots(ctx as Parameters<typeof resolveWorkspaceRoots>[0]);
    const pluginRoot = resolvePluginRoot();
    if (ws === '' || pluginRoot === '') return;
    const revision = computeBuildRevision(pluginRoot)?.revision ?? null;
    // cycle-81：记录「本实例跑的是哪个 revision」——这是「该不该重载」的唯一判据来源。
    // 同时写工作区旁路：真机实测路由模块读不到本模块内存值（fromRevision 恒 null），
    // 旁路让标记跨模块实例可见（带 TTL，过期即弃；读不到 = 未知 = 不阻拦重载）。
    markRunningRevision(revision, join(ws, '.cycles'));
    const completed = finalizeInFlight(join(ws, '.cycles'), revision);
    if (completed !== null) {
      reloadLog.info(`reload handshake completed: in-flight → ${completed.status} `
        + `(from=${String(completed.fromRevision ?? 'unknown')}, to=${String(completed.toRevision ?? 'unknown')})`);
    }
    const freshness = buildFreshness(pluginRoot);
    if (freshness.stale) {
      reloadLog.warn(`dist is stale (newest src = ${String(freshness.newestSrcFile ?? 'unknown')}); `
        + 'not rebuilding automatically — run build before anic_reload_self');
    }
  } catch (e) {
    reloadLog.warn(e instanceof Error ? e.message : String(e));
  }
}

export const name = 'dsh-anic';
// cycle-74 P0：webServer 已移交路由子插件（anicRoutesPlugin），本插件不再硬依赖它。
export const inject = ['tools', 'sessions', 'skills'];

export function apply(ctx: unknown): void {
  const c = ctx as { effect?: (fn: () => unknown, label?: string) => unknown };
  // 动态白盒调用流（cycle-97）：宿主进程内存态，供路由 + 面板轮询；
  // 事件订阅随插件卸载自动清理（官方 events.md：ctx.on 监听器即效果）。
  // cycle-71：注入归属解析器（方案 A′）——用 session/event 第一参的
  // SessionHeader.cwd 在**事件到达时**解析该调用所属的 cycle/phase；
  // 工作区不可解析 → 字段不落（宁缺勿猜，见 invocationAttribution.ts）。
  const feed = attachInvocationFeed(ctx, createInvocationFeed(), {
    resolveAttribution: createInvocationAttributor(ctx),
  });
  if (typeof c.effect === 'function') {
    // runtime 技能注册（静态 inject 保证 skills 已就绪；stub 宿主无 skills 时
    // registerRuntimeSkill 内部探测跳过，返回 null 即无需清理）。
    c.effect(() => registerRuntimeSkill(ctx) ?? undefined, 'dsh-anic: runtime skill (ctx.skills.register)');
    // cycle-74 P0 修复：路由走**独立子 fiber**（只有它声明 inject webServer）。
    c.effect(() => wireRoutes(ctx, { invocationFeed: feed }) ?? undefined, 'dsh-anic: routes (child fiber, webServer-scoped)');
    c.effect(() => registerAnicTools(ctx), 'dsh-anic: tools (anic_evaluate/iterate/gate_check/bootstrap/snapshot/self_check)');
    // 内置流程注册（R3 阶段 2/3）：FlowRegistry 生命周期跟随插件 fiber（卸载即注销）。
    c.effect(() => registerBuiltinFlows() ?? undefined, 'dsh-anic: builtin flows (gate-check + macro-phase)');
    // cycle-74 工具面按需加载接线：默认 full 时**内部直接返回不注册监听器**（零行为变更）。
    c.effect(() => { wireToolDisclosureFromConfig(ctx); }, 'dsh-anic: tool disclosure (agent/created, indexed only)');
    // cycle-80：热更新握手（finalize in-flight）+ 冷启动新鲜度记录（构建职责不在运行时）。
    c.effect(() => { runReloadHandshake(ctx); }, 'dsh-anic: hot-reload handshake (finalize in-flight + staleness)');
  } else {
    registerRuntimeSkill(ctx);
    wireRoutes(ctx, { invocationFeed: feed });
    registerAnicTools(ctx);
    registerBuiltinFlows();
    wireToolDisclosureFromConfig(ctx);
    runReloadHandshake(ctx);
  }
}
