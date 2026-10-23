/**
 * 路由面**独立 cordis 插件**（cycle-74 T-7407）——修复 P0：headless 下整插件 pending。
 *
 * 被修复缺陷（沙箱真机实测）：`webServer` 是本插件 `inject` 的**硬依赖**，
 * 而它由 `@deepseek-ai/dsh-web-app` bundle 提供（desktop 有、headless 无）⇒
 * headless 下整条 fiber pending，**连不依赖 webServer 的 21 个工具与索引一并失效**：
 *
 *   dsh: warning: 1 entry did not activate
 *   anic (dsh-anic): pending (waiting for service: webServer)
 *
 * 为什么把路由面**单独成 fiber**，而不是把 webServer 从 inject 删掉了事（关键取舍）：
 *   - KB `cordis-tutorial/03-services.md:83-93`：`inject` 用于**硬性依赖**；
 *     缺失时仍可运行的功能应「跳过 inject，在使用处探测」。但**路由确实硬依赖**
 *     webServer —— 直接删 inject 会丢掉「apply 时服务已就绪」的保证（tutorial:35），
 *     63 条路由可能抢在 webServer 就绪前注册 → **静默丢路由**，比现状更糟。
 *   - 拆 fiber 后：cordis 对**本子插件**保留等待语义（缺席即它 pending），
 *     父插件（工具/索引/技能/流程）立即激活；webServer 出现时子插件自动激活。
 *     这正是 cordis 组合语义（tutorial:79「依赖消失→卸载，恢复→再加载」）。
 *
 * 回落：宿主无 `ctx.plugin`（stub/旧代）⇒ 直接注册，与旧行为逐字一致（零回归）。
 */
import { registerAnicRoutes, type RegisterRoutesOptions } from './routes/index.ts';

/** 路由面插件：**唯一**声明 `webServer` 硬依赖的地方。 */
export const anicRoutesPlugin = {
  name: 'dsh-anic-routes',
  inject: ['webServer'],
  apply(ctx: unknown, config?: RegisterRoutesOptions): (() => void) | null {
    return registerAnicRoutes(ctx, config ?? {});
  },
};

interface PluginCapable {
  plugin?: (p: unknown, config?: unknown) => unknown;
}

/**
 * 接线路由面：能 `ctx.plugin` 就挂子 fiber（webServer 缺席只让它自己 pending），
 * 否则直接注册（stub/旧代回落到旧行为）。
 *
 * 返回 disposer 或 undefined（子 fiber 的生命周期由 cordis 系在父 fiber 上，无需手工持有）。
 */
export function wireRoutes(ctx: unknown, config: RegisterRoutesOptions): (() => void) | null | undefined {
  const c = ctx as PluginCapable;
  if (typeof c.plugin === 'function') {
    c.plugin(anicRoutesPlugin, config);
    return undefined;
  }
  return registerAnicRoutes(ctx, config);
}
