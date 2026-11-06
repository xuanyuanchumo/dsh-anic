/**
 * 工作台域健康分类（cycle-110）—— `classifyDomainStatus`：PanelState 快照 → 六域状态。
 *
 * ## 判据来源（字段形状逐一对照渲染层确认，不猜）
 *
 * 每条判据读的字段形状都先打开了对应 render*.ts 确认：
 *   - diagnostics：`SelfCheckJson.checks[].ok`（renderDiagnostics 红绿行的数据面）；
 *   - health：`TechDebtListingJson.open[].entry.severity`（renderTechDebt severityColor
 *     只把 'critical' 画红）、`OrgStatusJson.cycles.drift.drift`（panelTypes.ts，
 *     renderOrgCycles 的漂移读数——三源坐标错配是"观测面看起来正常"的最危险形态）、
 *     `SkillHealthJson.scripts[].level`（renderSkillHealth levelColor 把 degraded 画红、
 *     slow 画黄——warn 档取 degraded/slow）；
 *   - flows：`LedgerVerifyJson.ok`（renderLedger 链断裂画红）、`HitlAuditJson` 的
 *     pending 形态（renderHitl：逐项 `passed=false` 与 `anyCircuit` 都渲染成
 *     「等待人工」——warn 档两者都算）；
 *   - overview：`invocationsError`（panelState 切片，LiveInvocationsSection 轮询失败行）；
 *   - quality：`ClosureView.totals.ghost`（renderClosure 的幽灵消费清单——有人在读
 *     但没注册，闭环面自身的红灯）与 consumedGap+producedGap（closureTypes 头注
 *     钉死：这两键**只覆盖未消费**——真缺口与未读取，>0 即闭环有缺口）、
 *     `BootstrapJson` 陈旧（复用 bootstrapTypes.staleOf 归一——stale 有 boolean
 *     与 {stale} 两宿主形态，自写第二套归一就是漂移点）。
 *
 * ## 严重度优先
 *
 * fail > warn > idle > ok。'idle' 专指「还没拉到数据」（相关切片全 null）——
 * 未加载不是健康也不是故障，是「不知道」；'ok' 表示已拉到且无任何坏信号。
 * settings 恒 idle：可写面不评级（把「没配置」画成故障是误报，见设计文档 §4）。
 *
 * 纯函数：只读 state，零副作用、零 DOM。
 */
import type { PanelState } from '../panelState.ts';
import type { WorkbenchDomain } from './workbenchModel.ts';
import { staleOf } from '../features/bootstrap/bootstrapTypes.ts';

/** 域状态四档（fail > warn > idle > ok）。 */
export type DomainStatus = 'ok' | 'warn' | 'fail' | 'idle';

/** 状态点字形（nav/卡头共用的色盲第二通道——颜色之外的可辨通道）。 */
export const DOMAIN_STATUS_GLYPH: Record<DomainStatus, string> = { fail: '✕', warn: '⚠', ok: '✓', idle: '○' };

/** 四档严重度权重（数值越大越严重；worse 的比较只认这一个表）。 */
const SEVERITY: Record<DomainStatus, number> = { fail: 3, warn: 2, idle: 1, ok: 0 };

/** 取更严重的状态（多信号合入同一域时的合并元语——显式映射而非内联比较）。 */
function worse(a: DomainStatus, b: DomainStatus): DomainStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** diagnostics 域：check 有失败项 ⇒ fail；未拉到 ⇒ idle。 */
function classifyDiagnostics(s: PanelState): DomainStatus {
  if (s.check === null) return 'idle';
  return s.check.checks.some((p) => !p.ok) ? 'fail' : 'ok';
}

/** health 域：techDebt critical ⇒ fail；org drift 或技能 degraded/slow ⇒ warn；全 null ⇒ idle。 */
function classifyHealth(s: PanelState): DomainStatus {
  const { orgStatus, skillHealth, techDebt } = s;
  if (orgStatus === null && skillHealth === null && techDebt === null) return 'idle';
  if (techDebt !== null && techDebt.open.some((rec) => rec.entry.severity === 'critical')) return 'fail';
  let status: DomainStatus = 'ok';
  if (orgStatus !== null && orgStatus.cycles.drift?.drift === true) status = worse(status, 'warn');
  if (skillHealth !== null && skillHealth.scripts.some((sc) => sc.level === 'degraded' || sc.level === 'slow')) status = worse(status, 'warn');
  return status;
}

/** flows 域：账本链校验失败 ⇒ fail；HITL 有未过/熔断（等待人工）⇒ warn；全 null ⇒ idle。 */
function classifyFlows(s: PanelState): DomainStatus {
  const { ledgerVerify, hitlAudit } = s;
  if (ledgerVerify === null && hitlAudit === null) return 'idle';
  if (ledgerVerify !== null && ledgerVerify.ok === false) return 'fail';
  if (hitlAudit !== null && (hitlAudit.anyCircuit || hitlAudit.checks.some((c) => !c.passed))) return 'warn';
  return 'ok';
}

/** overview 域：实时调用流轮询错误 ⇒ warn（有兜底数据但不可信为新鲜）。 */
function classifyOverview(s: PanelState): DomainStatus {
  return s.invocationsError !== null && s.invocationsError !== '' ? 'warn' : 'ok';
}

/** quality 域：闭环缺口/幽灵消费 或 自举事实陈旧 ⇒ warn；closure/bootstrap 全 null ⇒ idle。 */
function classifyQuality(s: PanelState): DomainStatus {
  const { closure, bootstrap } = s;
  if (closure === null && bootstrap === null) return 'idle';
  let status: DomainStatus = 'ok';
  if (closure !== null) {
    if (closure.totals.ghost > 0) status = worse(status, 'warn');
    // 口径（closureTypes 头注钉死）：consumedGap+producedGap 只覆盖未消费；>0 = 有真缺口。
    if (closure.totals.consumedGap + closure.totals.producedGap > 0) status = worse(status, 'warn');
    if (closure.isolation?.ok === false) status = worse(status, 'warn');
  }
  if (bootstrap !== null && staleOf(bootstrap).stale) status = worse(status, 'warn');
  return status;
}

/**
 * 域健康分类入口（workbenchGrid 卡头与 WorkbenchNav chips 的唯一数据源）。
 *
 * @param state  PanelState 快照（store.getState() —— 渲染期纯读）
 * @param domain 域表条目（判据按 domain.id 分派——传整条目让调用方与域表 zip）
 */
export function classifyDomainStatus(state: PanelState, domain: WorkbenchDomain): DomainStatus {
  switch (domain.id) {
    case 'diagnostics': return classifyDiagnostics(state);
    case 'health': return classifyHealth(state);
    case 'flows': return classifyFlows(state);
    case 'overview': return classifyOverview(state);
    case 'quality': return classifyQuality(state);
    case 'settings': return 'idle';
  }
}
