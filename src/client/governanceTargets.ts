/**
 * 治理证据簇 target 工厂（B2 · cycle-18 从 WorkflowGraphPanel 抽出，T3 ≤250 行）。
 *
 * 账本事件流（list + verify）与 HITL 审计队列三个轮询端点并进面板统一
 * usePanelFetch 的 4s 档；本文件只声明各 target 的 URL/形状守卫/apply——
 * 与 panelLiveTargets.ts 同构（防抖/降级/学头机制在 usePanelFetch 共用）。
 *
 * cycle-46（T-4601 写侧收口）：GovernanceSetters 三 setter 接口收窄为直接
 * 收 PanelActions 动作层引用（setLedgerList/setLedgerVerify/setHitlAudit
 * 是动作集的子集）——接口本身不再需要（结构性类型：PanelActions 满足
 * 全部签名），保留导出名以稳住既有 import 面。
 */
import type { PanelFetchTarget } from './components/usePanelFetch.ts';
import { isLedgerList, isLedgerVerify, ledgerListUrl, LEDGER_VERIFY_URL, type LedgerListJson } from './features/ledger/renderLedger.ts';
import { isHitlAudit, HITL_AUDIT_URL, type HitlAuditJson } from './features/hitl/renderHitl.ts';
import type { PanelActions } from './components/panelActions.ts';

/** 治理证据簇的写侧依赖（动作层子集——结构性兼容，类型别名收口）。 */
export type GovernanceSetters = Pick<PanelActions, 'setLedgerList' | 'setLedgerVerify' | 'setHitlAudit'>;

/** 治理证据簇三 target（失败静默降级：guard 不过/请求失败 → 不 apply，分区不渲染）。
 * ledgerLimit（cycle-24 分页）：账本列表按当前翻页深度拉取（服务端 ?limit 支持）。 */
export function governanceTargets(s: GovernanceSetters, ledgerLimit: number): PanelFetchTarget[] {
  return [
    { url: ledgerListUrl(ledgerLimit), guard: isLedgerList, apply: (v) => s.setLedgerList(v as LedgerListJson) },
    { url: LEDGER_VERIFY_URL, guard: isLedgerVerify, apply: (v) => s.setLedgerVerify(v as Parameters<typeof s.setLedgerVerify>[0]) },
    { url: HITL_AUDIT_URL, guard: isHitlAudit, apply: (v) => s.setHitlAudit(v as HitlAuditJson) },
  ];
}
