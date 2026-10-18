/**
 * 治理证据簇 target 工厂（B2 · cycle-18 从 WorkflowGraphPanel 抽出，T3 ≤250 行）。
 *
 * 账本事件流（list + verify）与 HITL 审计队列三个轮询端点并进面板统一
 * usePanelFetch 的 4s 档；本文件只声明各 target 的 URL/形状守卫/apply——
 * 与 panelLiveTargets.ts 同构（防抖/降级/学头机制在 usePanelFetch 共用）。
 */
import type { PanelFetchTarget } from './components/usePanelFetch.ts';
import { isLedgerList, isLedgerVerify, LEDGER_LIST_URL, LEDGER_VERIFY_URL, type LedgerListJson, type LedgerVerifyJson } from './features/ledger/renderLedger.ts';
import { isHitlAudit, HITL_AUDIT_URL, type HitlAuditJson } from './features/hitl/renderHitl.ts';

/** 治理证据簇的 state setter 集（组件 useState 的下传；类型而非实现）。 */
export interface GovernanceSetters {
  setLedgerList: (v: LedgerListJson | null) => void;
  setLedgerVerify: (v: LedgerVerifyJson | null) => void;
  setHitlAudit: (v: HitlAuditJson | null) => void;
}

/** 治理证据簇三 target（失败静默降级：guard 不过/请求失败 → 不 apply，分区不渲染）。 */
export function governanceTargets(s: GovernanceSetters): PanelFetchTarget[] {
  return [
    { url: LEDGER_LIST_URL, guard: isLedgerList, apply: (v) => s.setLedgerList(v as LedgerListJson) },
    { url: LEDGER_VERIFY_URL, guard: isLedgerVerify, apply: (v) => s.setLedgerVerify(v as LedgerVerifyJson) },
    { url: HITL_AUDIT_URL, guard: isHitlAudit, apply: (v) => s.setHitlAudit(v as HitlAuditJson) },
  ];
}
