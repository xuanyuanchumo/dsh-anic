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
  /**
   * configuredBand 为 P1 修复新增的可选字段：配置声明的自主级（与 currentBand 分离，降级时可观测）。
   *
   * history / historyCount / historyError 为 cycle-78 新增的可选字段（**只增不改**）：
   * 自主级变更审计账的投影（host `evolution/orgStatus.ts` 的 `autonomy.history`
   * = 最近 5 条摘要 + 总条数 + 坏账根因）。缺口证据：cycle-77 已把变更结构化成
   * `.cycles/autonomy-history.json`，但面板类型只有 `{currentBand, configuredBand?,
   * breakers, action}` —— 新字段在类型层被丢弃，「L4 是谁授权的、信任豁免是否发生」
   * 在 UI 上永远不可见。全部可选：旧宿主 / 坏响应不得因此断渲染。
   */
  autonomy: {
    currentBand: string;
    configuredBand?: string;
    breakers: string[];
    action: string;
    /** host 侧有界投影（最近 N 条，默认 5），来自 AutonomyHistoryEntry 的摘要。 */
    history?: Array<{
      from: string;
      to: string;
      /** ISO 时间戳（写入时刻，非调用方声称时刻）。 */
      at: string;
      actor: string;
      /** 'human' | 'system'（写成 string 以容忍未来新增来源，渲染侧按语义降级）。 */
      authorization: string;
      reason: string;
      /** 人类显式豁免信任阈值时的豁免内容（avg < threshold 仍升级的合法依据）。 */
      trustExemption?: { avg: number; threshold: number };
    }>;
    /** 账本总条数（host 值；缺省时渲染侧退回 history.length）。 */
    historyCount?: number;
    /** 账本读取失败的根因（坏 JSON / 非数组）——存在即须在 UI 上响亮显示。 */
    historyError?: string;
  };
  /** weViolations 为 cycle-9 新增的可选字段：WE 8 规则违例（bandDetector 检测结果的可观测面）。rule 是数字 1-8（技能同形）。 */
  /** recent 为 cycle-20 仪表带新增：最近 12 个分数点（火花线数据面；空历史=空数组）。 */
  band: { current: string; trend: string; weViolations?: Array<{ rule: number; index?: number; value?: number; desc?: string }>; recent?: number[] };
  flows: { selfInit: boolean; agentsOrchestration: boolean };
  timestamp: string;
  /**
   * cycle-80 新增的**可选** reload 段（与 host `orgStatus.ts` 的 `reload` 同形）。
   *
   * 被守卫缺陷：热更新链路（WS-1 的 `anic_reload_self` / `reload-history.json`）
   * 落地后，"我这次看到的面板到底是哪一版 dist 跑出来的、上一次重载成没成"
   * 在 UI 上完全不可见——用户只能靠"改了没生效"来猜。可选字段：旧宿主 /
   * 未部署 reload 能力时整体缺省，渲染侧必须优雅退场（不得崩、不得假绿）。
   */
  reload?: {
    /** dist 是否落后于 src（构建新鲜度；true = 需要重新 build）。 */
    stale: boolean;
    /** 当前 dist 的构建 revision（sha256(host:client) 前 16 位）；dist 缺失=null。 */
    revision: string | null;
    /** 重载史总条数（0 = 冷启动/从未触发）。 */
    historyCount: number;
    /** 最近一次重载的终态：in-flight/reloaded/refused/unavailable/failed。 */
    lastStatus: string | null;
    /** 最近一次重载的 ISO 时间。 */
    lastAt: string | null;
    /** 重载史读取失败根因（坏 JSON 等）——存在即须在 UI 上响亮显示。 */
    error: string | null;
    /** 给读者的诚实提示：hmr 可用性只能按请求探测，本段是只读快照。 */
    hmrProbeHint: string;
  };
}
