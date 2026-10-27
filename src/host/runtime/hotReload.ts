/**
 * 热更新重载 · 门面（barrel，cycle-80 WS-1）。
 *
 * 原实现单文件 337 行，超 T3/⑪ 的 ≤250 行硬限，按「一域一文件」拆成三域：
 *   - `buildRevision.ts`     构建指纹与新鲜度（dist 指纹 / 源码 mtime 判据）
 *   - `reloadHistory.ts`     `.cycles/reload-history.json` 史账与跨实例握手落定
 *   - `reloadOrchestrator.ts` 探测 hmr → 判新鲜度 → 先落 in-flight → 触发重载
 *
 * ## 为什么历史域也搬出去了（不是把实现留在这个文件里）
 * 若 `hotReload.ts` 保留史账实现、又按门面再导出 orchestrator，则 orchestrator 需要
 * `readReloadHistory/appendReloadHistory` 时只能 import 本文件 → **hotReload ⇄ orchestrator
 * 真实环**（不是 re-export 边，环检测会红）。所以三者都只依赖更底层的那两个实现文件，
 * 本文件退化成**纯门面**：只做再导出，不反向依赖任何实现。
 *
 * 消费者（工具 / 路由 / 测试）继续从 `runtime/hotReload.ts` 取同一组导出名——路径与
 * 名字零变更，拆分对上层透明。
 */
export * from './buildRevision.ts';
export * from './reloadHistory.ts';
export * from './reloadOrchestrator.ts';
export * from './runningRevision.ts';
