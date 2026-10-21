/**
 * 面板数据拉取的小工具（cycle-9 从 WorkflowGraphPanel 抽出，T3 模块纪律）。
 *
 * cycle-58 T-5801a：实机上移至 `components/fetchJson.ts`（G-FEAT 特性边界
 * 收口——budget/hitl/ledger/skillhealth/techdebt 五域的 `../live/` 跨特性
 * import 清零）。本文件保留 re-export 垫片：live 域内既有 import
 * （useInvocations 等）与 `tests/unit/fetchJson.test.ts` 路径不破坏；
 * G-SINGLE 守卫语义上「唯一实现」在 components/fetchJson.ts——本垫片不是
 * 第二定义。
 */

export { fetchJsonGuarded, isObjectLike, isFlowStatus, syncTelemetryCounts } from '../../components/fetchJson.ts';
