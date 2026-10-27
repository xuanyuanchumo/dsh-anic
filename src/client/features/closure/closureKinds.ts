/**
 * 闭环体检客户端**证据类别谓词**（cycle-82：closureTypes.ts 拆分之一，守 T3 ≤250）。
 *
 * 从 closureTypes.ts 下移——该文件加入第五族/隔离面的子守卫后越界。本文件只放
 * "枚举值 → 是否合法"这一层**纯谓词**，不含视图形状、不含整体守卫。
 *
 * 消费者 import 路径零变更：closureTypes.ts **再导出**本文件的全部公开名。
 *
 * ## 为什么枚举值不能进 fail-closed 白名单（下移时原文照抄，口径不变）
 *
 * 族与产出形态会**继续长**（cycle-75 已从三族扩到四族）。把一个新增枚举值判成
 * 畸形 = 「一条新数据把整个白盒面打瞎」——比漏翻严重得多。故「已知值清单」
 * （PRODUCED_KINDS / EVIDENCE_KINDS）只用于展示名映射，**不是**准入白名单：
 * 守卫只要求"非空字符串"，未知取值由渲染层回落原值（可见的漏翻，不是空白）。
 */

/** produced 的证据类别（与宿主 closureModel.ProducedKind 同源同构）。 */
export type ProducedKind = 'register-call' | 'handler-in-file' | 'declaration-only' | 'no-write-point';

/** ⚠ 已知值清单（用于展示名映射），**不是**守卫的准入白名单——见 isProducedKind。 */
export const PRODUCED_KINDS: readonly ProducedKind[] =
  ['register-call', 'handler-in-file', 'declaration-only', 'no-write-point'];

/** 消费证据类别：生产代码 / 通道（测试·agent 卡）/ 无。 */
export type EvidenceKind = 'code' | 'channel' | 'none';

/** ⚠ 同 PRODUCED_KINDS：清单用于展示，不用于准入。 */
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['code', 'channel', 'none'];

/**
 * 产出来源谓词：**非空字符串即认**（刻意宽）。
 *
 * 为什么不用 `PRODUCED_KINDS.includes(v)`：那会把下一个新 kind 判成畸形响应，
 * 于是一条新数据让整个面板走失败行。宽口径的代价只是漏翻一个展示名 —— 两害相权。
 */
export function isProducedKind(v: unknown): v is ProducedKind {
  return typeof v === 'string' && v.length > 0;
}

/** 消费证据类别谓词（同 isProducedKind 的宽口径理由）。 */
export function isEvidenceKind(v: unknown): v is EvidenceKind {
  return typeof v === 'string' && v.length > 0;
}
