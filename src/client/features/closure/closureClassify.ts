/**
 * 闭环体检**客户端分类判据**（cycle-75 T3 拆分：closureTypes 超 250 行）。
 *
 * 从 closureTypes.ts 下移——那边只留形状声明与 fail-closed 守卫（数据腿守门人），
 * 这里只管「未消费明细该怎么归类」。拆分形态与宿主侧同构
 * （src/host/closureAudit/closureBuckets.ts 承载分类判据、closureView/Model 承载形状）。
 *
 * 依赖方向：本文件 import closureTypes 的类型；closureTypes **不** import 本文件
 * ——无环（宿主侧也是同一手法，registryClosure 再导出而非反向依赖）。
 *
 * 为什么客户端要自带判据而不是读宿主传来的分类：投影**不带**每项的 bucket
 * （它只带 produced / dynamic / evidenceKind 三个原始证据位），面板要按类分组
 * 就必须自己判。判据是纯函数、零状态，且与宿主 bucketOf 的主形态一致（见 classifyItem 头注）。
 */
import type { ClosureUnconsumedView } from './closureTypes.ts';

/**
 * 未消费清单的四分类（契约 §2 与任务 T3）。
 *
 * 顺序 = 可行动性（真缺口在先）——渲染分组与计数都按此序。
 */
export type ClosureClassName = 'consumedGap' | 'producedGap' | 'dynamicClaimed' | 'channelOnly';

export const CLOSURE_CLASSES: readonly ClosureClassName[] =
  ['consumedGap', 'producedGap', 'dynamicClaimed', 'channelOnly'];

/** 分类计数（**不是**未消费的四等分——见 ClosureTotals 的分层语义注释）。 */
export type ClosureClassCounts = Record<ClosureClassName, number>;

/**
 * 单项归类（用于**未消费明细**的分组；判据顺序即优先级）。
 *
 * 与宿主 `bucketOf` 的关系（**必须说明，防读者以为两处是同一套**）：
 * 宿主判据是 `!consumed` 优先（未消费项只会落 consumedGap/producedGap）；
 * 本函数处理的是**已经是未消费投影**的项，故直接按 produced 二分，主形态与宿主一致。
 *
 * `dynamicClaimed` / `channelOnly` 两条分支：在既有宿主判据下**不可达**
 * （它们蕴含 consumed）。保留的理由是契约 §1.4 的明文要求——「若实测发现
 * dynamic && !consumed 存在，则如实按该形态分类，不要削足适履」；一旦宿主
 * 判据漂移（计算键认领不再算消费），这两条分支即刻可达并如实归位。
 * 渲染层配套：只在它们**确实非空**时才渲染该分组，因此当前面板上不会出现
 * 两个恒为 0 的噪声组（避免「白盒形式上有、语义上是噪声」的原形态复发）。
 *
 * 唯一与宿主有意分歧处：`!produced && dynamic` 时本函数给 dynamicClaimed 而宿主
 * 给 producedGap。理由：dynamic=true 是**比 produced 更具体的证据**——如实呈现它
 * 比随 produced 二分更可信（且该形态在当前数据下不存在，不影响任何计数）。
 */
export function classifyItem(u: ClosureUnconsumedView): ClosureClassName {
  if (u.produced) return 'consumedGap';
  if (u.dynamic) return 'dynamicClaimed';
  if (u.evidenceKind === 'channel') return 'channelOnly';
  return 'producedGap';
}

/**
 * 整体分类计数（按**未消费明细**统计；合计恒 = list.length，每项落且仅落一类）。
 *
 * ⚠ 与 `totals.consumedGap/producedGap` 的关系：同一判据口径，但 totals 是宿主对
 * **全量**未消费（实测 86 条）的计数，而这里只覆盖**投影明细**（同次实测 80 条 =
 * 截断上限）。截断时两者必然不等——**不许互相冒充**，渲染层因此分两层呈现
 * （全量计数 / 明细计数），并把「已显示 N / 共 M 条」显式说出。
 */
export function classifyUnconsumed(list: readonly ClosureUnconsumedView[]): ClosureClassCounts {
  const out: ClosureClassCounts = { consumedGap: 0, producedGap: 0, dynamicClaimed: 0, channelOnly: 0 };
  for (const u of list) out[classifyItem(u)] += 1;
  return out;
}

/**
 * 「未读取」未消费项的**产出锚点细分**（两种成因，两种补救动作，故分开报数）。
 *
 * 为什么不合成一个数：`no-write-point`（词表键由 t() 纯查找，本仓无独立写入点）
 * 与 `declaration-only`（声称注册/接线但调用点缺失）的**补救动作不同**——
 * 前者是「接线或删除这个键」，后者是「补上注册/接线，或删掉声明」。
 * 合成一个数字会让两种缺口互相掩盖（本仓反复踩过的「平铺即噪声」同族）。
 */
export function producedAnchorBreakdown(list: readonly ClosureUnconsumedView[]): { noWritePoint: number; declarationOnly: number } {
  let noWritePoint = 0;
  let declarationOnly = 0;
  for (const u of list) {
    if (u.producedKind === 'no-write-point') noWritePoint += 1;
    else if (u.producedKind === 'declaration-only') declarationOnly += 1;
  }
  return { noWritePoint, declarationOnly };
}
