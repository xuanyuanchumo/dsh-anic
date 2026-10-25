/**
 * 升级路径的返回/入参类型（cycle-77 T4 拆出 —— autonomyUpgrade.ts 加前置条件表后
 * 将超 250 行 T3 上限；与既有 truthAuditTypes.ts 同款「类型单独一文件」纪律）。
 *
 * 为什么返回体如此啰嗦：拒绝路径必须**点名缺哪条前置条件**（机器可读码），
 * 成功路径必须区分「意图」与「回读事实」——只给一句 reason 等于把审计信息
 * 又退回自由文本（那正是本任务要消灭的形态）。
 */
/** 拒绝时点名缺少的前置条件（机器可读码，错误处理不必猜自由文本）。 */
export type UpgradePreconditionCode =
  | 'config_missing'
  | 'current_band_unknown'
  | 'target_not_allowed'
  | 'target_not_adjacent'
  | 'reason_required'
  | 'breaker_tripped'
  | 'trust_below_threshold'
  | 'human_authorization_required'
  | 'history_unrecorded';

export interface UpgradeOptions {
  /** 目标档：只允许 L3/L4（降级走 anic_autonomy_downgrade，方向不混）。 */
  target: string;
  /** 变更理由（必填：审计记录不能只有 from/to）。 */
  reason: string;
  /** 人类显式授权（L3→L4 强制；信任分不足时作为豁免依据）。 */
  humanAuthorized?: boolean;
  /** 记录发起者（默认工具名）。 */
  actor?: string;
  /** 是否写 history（默认 true；false 仅用于测试/只读演练，结果会如实标记）。 */
  record?: boolean;
}

export interface AutonomyUpgradeResult {
  action: 'upgraded' | 'refused' | 'upgrade-failed';
  from: string | null;
  target: string;
  /** 回读到的真实档（Post-Verify 事实；拒绝/未写入时为 null）。 */
  observed: string | null;
  /** 拒绝原因清单（空数组 = 全部前置条件满足）。 */
  missingPreconditions: Array<{ code: UpgradePreconditionCode; detail: string }>;
  threshold: number | null;
  trust: { avg: number; verdict: 'sufficient' | 'insufficient' | 'exempt-by-human' | 'no-evidence' };
  trippedBreakers: string[];
  authorization: 'human' | 'system' | null;
  historyRecorded: boolean;
  historyPath: string | null;
  configPath: string;
  reason: string;
}
