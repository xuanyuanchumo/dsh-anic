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
 *
 * cycle-71（T-7117）：三端点补 `onFail`/`onRecover`——此前「失败静默降级 →
 * 分区只剩标题」（用户分不清「路由挂了」与「确实无数据」）。失败 key 落在
 * **端点粒度**（ledger 分区含 list+verify 两端点，若按分区记一条，一个成功
 * clear 与一个失败 mark 并发会竞态）；分区侧由 sectionFailure 聚合。
 */
import type { PanelFetchTarget } from './components/usePanelFetch.ts';
import { isLedgerList, isLedgerVerify, ledgerListUrl, LEDGER_VERIFY_URL, type LedgerListJson } from './features/ledger/renderLedger.ts';
import { isHitlAudit, HITL_AUDIT_URL, type HitlAuditJson } from './features/hitl/renderHitl.ts';
import type { PanelActions } from './components/panelActions.ts';

/**
 * 治理证据簇的写侧依赖（动作层子集——结构性兼容，类型别名收口）。
 *
 * cycle-71：两侧各增失败的 mark/clear（`markFetchFailure`/`clearFetchFailure`）
 * ——三端点从此不再静默降级。别名保留既有导出名，稳住 import 面。
 */
export type GovernanceSetters = Pick<
  PanelActions,
  'setLedgerList' | 'setLedgerVerify' | 'setHitlAudit' | 'markFetchFailure' | 'clearFetchFailure'
>;

/** 治理证据簇三 target（cycle-71：失败不再静默——onFail 记录 + onRecover 清除）。 */
export function governanceTargets(s: GovernanceSetters, ledgerLimit: number): PanelFetchTarget[] {
  return [
    {
      url: ledgerListUrl(ledgerLimit),
      guard: isLedgerList,
      apply: (v) => s.setLedgerList(v as LedgerListJson),
      onFail: (f) => { s.markFetchFailure('ledgerList', f); },
      onRecover: () => { s.clearFetchFailure('ledgerList'); },
    },
    {
      url: LEDGER_VERIFY_URL,
      guard: isLedgerVerify,
      apply: (v) => s.setLedgerVerify(v as Parameters<typeof s.setLedgerVerify>[0]),
      onFail: (f) => { s.markFetchFailure('ledgerVerify', f); },
      onRecover: () => { s.clearFetchFailure('ledgerVerify'); },
    },
    {
      url: HITL_AUDIT_URL,
      guard: isHitlAudit,
      apply: (v) => s.setHitlAudit(v as HitlAuditJson),
      onFail: (f) => { s.markFetchFailure('hitlAudit', f); },
      onRecover: () => { s.clearFetchFailure('hitlAudit'); },
    },
  ];
}
