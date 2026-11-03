/**
 * dsh-anic client entry（DSH client 插件契约，核验自：
 * - dsh-client-modules `client.platform === 'web'` 才加载 client 半部；
 * - 客户端加载器按 `window.__ModuleLoader__.load({id, factory})` 调 exports["./client"]；
 * - `inject` 只能列官方能力包名（'slots'/'locale' 均为官方 API 面，非第三方服务）。
 *
 * cycle-99：inject 增加 'locale'——宿主 locale 服务（@deepseek-ai/dsh-client-locale
 * `ctx.provide("locale", LocaleRuntime)`，asar 实包核验）持有语言快照。i18n.ts 的
 * `setLocaleFromHost` 把宿主激活语言写入本地检测链（localStorage 覆盖仍最优先——
 * 用户在面板里手动切过语言时尊重显式选择）。**缺失降级**：locale 服务缺席
 * （旧宿主/独立测试）时 t() 走既有检测链，零行为变化。
 *
 * 命名与 id 规范：包名 dsh-anic（DSH 插件规范前缀），本入口导出 name = 'dsh-anic-client'
 * 与宿主入口 name = 'dsh-anic'（host/index）相区分 —— 与父工程 dsh-codegraph-visualizer
 * 的 host/client 命名惯例一致。
 */
import { integrateWorkflowTab } from './integrations/WorkflowTabIntegration.ts';
import { setLocaleFromHost } from './i18n.ts';

export const name = 'dsh-anic-client';
export const inject = ['slots', 'locale'];

export function apply(ctx: unknown): void {
  integrateWorkflowTab(ctx);
  // 宿主语言联动（cycle-99）：locale 服务存在才订阅；订阅 disposer 随插件 fiber 卸载。
  const c = ctx as { locale?: { getSnapshot?: () => { active?: string }; subscribe?: (fn: () => void) => () => void } };
  const locale = c.locale;
  if (locale && typeof locale.getSnapshot === 'function') {
    const applyActive = (): void => {
      const active = locale.getSnapshot?.().active;
      if (active === 'zh' || active === 'en') setLocaleFromHost(active);
    };
    applyActive();
    if (typeof locale.subscribe === 'function') {
      try { locale.subscribe(applyActive); } catch { /* 订阅失败 → 只用初值，不崩 */ }
    }
  }
}
