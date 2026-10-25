/**
 * 闭环体检**计数面形状 + 守卫**（客户端；cycle-78 拆分：closureTypes 已逼近 T3 的 250 行）。
 *
 * 拆法与宿主侧同构：`src/host/closureAudit/closureTotalsTypes.ts` 单独承载 `ClosureTotals`，
 * 客户端这份是**独立持有的第二份声明**（host/client 编译隔离 + G-IND），不是 import 关系。
 *
 * 为什么现在拆：cycle-78 给 totals 加了第六个计数 `channelDeclared`（通道声明数），
 * `ClosureTotals` 的语义注释随之变长；留在 closureTypes.ts 会把该文件推过 250 行
 * （T3 纪律由 objectiveConformanceContract ⑪ 机械守住）。
 *
 * 纪律（与 closureTypes 一致）：fail-closed、逐字段；只判**本客户端真正渲染的字段**。
 */

/** 计数原语（新鲜度：NaN/Infinity 不是合法计数）。 */
export function isNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
export function isStr(v: unknown): v is string { return typeof v === 'string'; }
export function isBool(v: unknown): v is boolean { return typeof v === 'boolean'; }
export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function isStrArray(v: unknown): v is string[] { return Array.isArray(v) && v.every((s) => isStr(s)); }
export function isRecordOf<T extends string>(v: unknown, keys: readonly T[]): boolean {
  return isObj(v) && keys.every((k) => isNum((v as Record<string, unknown>)[k]));
}

export interface ClosureTotals {
  registered: number;
  produced: number;
  consumed: number;
  codeConsumed: number;
  unconsumed: number;
  ghost: number;
  /**
   * ★分层语义（cycle-75 实测校准；cycle-78 升级为三键覆盖未消费）：
   *   unconsumed = channelDeclared + consumedGap + producedGap  ← 这三键**只覆盖未消费**；
   *   consumed   = code + dynamicClaimed + channelOnly          ← 这三键覆盖已消费。
   * 把六键当成「未消费的六等分」是**错的**（实测 44+42+3+1=90 ≠ unconsumed 86）。
   * 之所以仍要同屏可见：不显示这些键，面板就把「已消费」误读成一片健康的绿。
   */
  consumedGap: number;
  /** !produced && !consumed —— 未读取：词表键无写入点 / 只声明未接线（需接线或删除）。 */
  producedGap: number;
  /** consumed && dynamic —— 已认领消费、但证据是**计算键**（非字面量）。 */
  dynamicClaimed: number;
  /** consumed && evidenceKind==='channel' —— 仅测试/agent 卡引用，无生产消费者。 */
  channelOnly: number;
  /**
   * ★cycle-78：!consumed && 已在宿主 channelRegistry 声明（通道独占）。**可选**——
   * 旧服务端无此键时按 0 处理（向前兼容：新增观测面不得把既有面板打瞎）。
   *
   * 恒等式升级（不是放宽）：`channelDeclared + consumedGap + producedGap === unconsumed`。
   * 这一键让「未消费」拆成**已声明通道**（只需维持文档）与**真缺口**（必须补接线）。
   */
  channelDeclared?: number;
}

const TOTAL_KEYS: readonly (keyof ClosureTotals)[] =
  ['registered', 'produced', 'consumed', 'codeConsumed', 'unconsumed', 'ghost',
    'consumedGap', 'producedGap', 'dynamicClaimed', 'channelOnly'];

export function isClosureTotals(v: unknown): v is ClosureTotals {
  if (!isRecordOf(v, TOTAL_KEYS)) return false;
  // cycle-78：channelDeclared 是**可选**新键（旧服务端没有它）；在场则必须是有限数。
  const declared = (v as Record<string, unknown>).channelDeclared;
  return declared === undefined || isNum(declared);
}
