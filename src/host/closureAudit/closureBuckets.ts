/**
 * 闭环体检**分类学**（cycle-75 T3 拆分：registryClosure 超 250 行）。
 *
 * 从 registryClosure.ts 下移——它承载「扫描编排 + 分类学」双职责，加入分类后越界。
 * 本文件只定义**分类判据与计数**，不含扫描、不含投影。
 *
 * 消费者 import 路径零变更：registryClosure.ts 再导出本文件的全部公开名。
 *
 * ── 为什么需要分类学（用户诉求「所有功能业务的注册、生产与消费如何确保」）──
 * 上一版把未消费项平铺成一张清单，读者无法据此行动（白盒形式上有、语义上是噪声）。
 * 为什么不只按「未消费」分：「只在测试/agent 卡里被引用」的资产**不算未消费**，
 * 却属于「生产了但没人用」的同一族缺口——分类必须覆盖**全部**资产，
 * 否则面板会把 285 个「已消费」当成一片健康的绿。
 *
 * 判据（互斥且穷尽，合计恒 = 项数；契约测试断言自洽）：
 *   code           consumed && 生产代码内真消费        —— 健康
 *   dynamicClaimed consumed && 计算键认领（非字面量证据）—— 已认领，标注口径
 *   channelOnly    consumed && 仅测试/agent卡引用      —— 无生产消费者（弱消费）
 *   consumedGap    produced && !consumed              —— **真缺口**：生产了没人读
 *   producedGap    !produced && !consumed             —— 产出缺口：只声明、没接线
 *   declaredChannel !consumed && 已声明               —— **通道独占**（cycle-78）：
 *                  未消费，但声明表点名了 owner/docRef/reason。它是「已知通道」，
 *                  不是「未知缺口」——两类的处置动作相反（前者维持/复核文档，
 *                  后者补接线或删声明），故必须分开计数。
 */
import type { ClosureItem } from './closureModel.ts';

export type ClosureBucket =
  | 'code' | 'dynamicClaimed' | 'channelOnly' | 'consumedGap' | 'producedGap'
  /** ★cycle-78：未消费但已在 channelRegistry 声明（通道独占）。 */
  | 'declaredChannel';

/** 分类全序（供穷尽性断言与稳定遍历；顺序即投影排序权重）。 */
export const CLOSURE_BUCKETS: readonly ClosureBucket[] =
  ['code', 'dynamicClaimed', 'channelOnly', 'consumedGap', 'producedGap', 'declaredChannel'];

/**
 * 「已生产」判据：真有写入/接线锚点。
 *
 * `declaration-only`（只声明了名字）与 `no-write-point`（词表族无写入点，
 * 是诚实标注而非缺失）都不算已生产——把它们算进去会让 produced 数字
 * 变成自述，正是本轮要消灭的形态。
 */
export function isProduced(item: ClosureItem): boolean {
  return item.producedAt !== null
    && item.producedKind !== 'declaration-only'
    && item.producedKind !== 'no-write-point';
}

/** 单项归类（互斥穷尽，判据顺序即优先级）。 */
export function bucketOf(item: ClosureItem): ClosureBucket {
  if (!item.consumed) {
    // cycle-78：未消费项先问「声明过没有」——声明 ≠ 豁免，只是把它从「未知缺口」
    // 归到「已知通道」。没声明的仍按产出锚点二分（那才是要动手补的缺口）。
    if (item.declaredChannel !== undefined) return 'declaredChannel';
    return isProduced(item) ? 'consumedGap' : 'producedGap';
  }
  if (item.dynamic) return 'dynamicClaimed';
  if (item.evidenceKind === 'channel') return 'channelOnly';
  return 'code';
}

/** 逐项归类计数（合计恒 = items.length）。 */
export function bucketsOf(items: readonly ClosureItem[]): Record<ClosureBucket, number> {
  const out: Record<ClosureBucket, number> = {
    code: 0, dynamicClaimed: 0, channelOnly: 0, consumedGap: 0, producedGap: 0, declaredChannel: 0,
  };
  for (const it of items) out[bucketOf(it)] += 1;
  return out;
}

/** 已生产项数（逐项判据；聚合层唯一入口，不在别处重算第二套判据）。 */
export function producedCountOf(items: readonly ClosureItem[]): number {
  return items.filter(isProduced).length;
}
