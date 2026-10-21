/**
 * 面板共享类型（cycle-58 T-5801a 新建——G-FEAT 特性边界收口的类型落位）。
 *
 * OrgStatusJson 原定义于 features/org/renderOrgStatus.ts，autonomy 域
 * `import type { OrgStatusJson } from '../org/renderOrgStatus.ts'` 跨特性
 * import（类型 import 无运行时耦合，但 G-FEAT 守卫按文件路径机械判定，
 * 类型共享需中立落位）。上移 components/panelTypes.ts 后 org/autonomy
 * 双域同源 import——「接口形状单一事实源」（renderAutonomyGauge.ts 头注释
 * 原语义保持）。
 *
 * 注意：其余分区专属类型继续留在各域内（renderInvocationsTypes 等）——
 * 只有**跨域消费**的类型才上移本文件（YAGNI）。
 */

/** 组织全景一站式观测面（org-status 路由响应形状——org/autonomy 双域消费）。 */
export interface OrgStatusJson {
  cycles: { total: number; latest: string | null; converged: number; failed: number };
  ledger: { entries: number; valid: boolean };
  trust: { scores: Record<string, { score: number; approve: number; total: number }>; recommendedBand: string };
  /** configuredBand 为 P1 修复新增的可选字段：配置声明的自主级（与 currentBand 分离，降级时可观测） */
  autonomy: { currentBand: string; configuredBand?: string; breakers: string[]; action: string };
  /** weViolations 为 cycle-9 新增的可选字段：WE 8 规则违例（bandDetector 检测结果的可观测面）。rule 是数字 1-8（技能同形）。 */
  /** recent 为 cycle-20 仪表带新增：最近 12 个分数点（火花线数据面；空历史=空数组）。 */
  band: { current: string; trend: string; weViolations?: Array<{ rule: number; index?: number; value?: number; desc?: string }>; recent?: number[] };
  flows: { selfInit: boolean; agentsOrchestration: boolean };
  timestamp: string;
}
