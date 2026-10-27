/**
 * 闭环体检**口径声明**与**计数自洽校验**（cycle-82 T3 拆分）。
 *
 * 从 registryClosure.ts 下移：该文件已 248 行，cycle-82 挂入第五族 + 隔离面后越界。
 * 拆分边界沿职责切：本文件只放「判定口径的文字声明」与「逐族计数自洽的校验逻辑」，
 * 不含扫描、不留编排。
 *
 * 消费者 import 路径零变更：registryClosure.ts 再导出本文件的全部公开名。
 *
 * 为什么口径文字要留在一个能被 import 的**数据**里（而不是只写在 markdown）：
 * 面板把 `notes` 直接铺在分区底部——用户看到的读数和它的判定口径必须同屏，
 * 否则"未消费 86 条"会被读成"86 个 bug"。口径漂移（改了判据却没改解释）是本仓
 * 反复出现的形态，把它做成数组常量至少让"两边同一个文件"成为物理事实。
 */
import type { ClusterAudit, ClosureItem } from './closureModel.ts';
import { CLOSURE_BUCKETS, bucketsOf, producedCountOf } from './closureBuckets.ts';
import { tallyProduced } from './closureModel.ts';
import { SKILL_CLOSURE_NOTES } from './skillClosure.ts';

/**
 * 四族 + 连通性的判定口径（**用户面文本**，与面板同屏）。
 *
 * 每条都回答一个读者必然会问的"这个数是什么意思/我该不该行动"。
 * 新增族/新口径必须在此登记——否则面板会给出一个没有解释的读数。
 */
export const CLOSURE_NOTES: readonly string[] = [
  'consumed 判定 = 本仓内有读取方（客户端 fetch / 宿主内部调用 / 内联技能脚本 / 测试或 agent 卡引用）。',
  'tests 与 docs 引用计入证伪面而不计入端点生产消费（测试只证明注册可用）。',
  '工具与路由的对外消费者可以是 DSH 宿主 agent（宿主调用，本仓看不见）→ 未消费项是缺口线索，不是删除判决。',
  '词表条目没有独立写入点（t() 是纯查找），其 producedAt=null / producedKind=no-write-point 是诚实标注而非缺失。',
  'endpoint 的「已生产」判据 = 存在**真注册调用点**（webServer.register({path}) 或 reg(path,…)），'
  + '不是「routes/index.ts 里出现了该字符串」——后者是聚合器回声。',
  '未消费 ≠ 全部是缺陷：code=生产代码内真消费；dynamicClaimed=计算键认领；'
  + 'channelOnly=仅测试/agent 卡引用（无生产消费者）；consumedGap=真缺口；producedGap=只声明没接线。',
  // cycle-78：第六类（通道独占）的口径——声明 ≠ 豁免，必须与真缺口分开计数。
  'declaredChannel（cycle-78）=未消费、但已在 channelRegistry 声明 owner/docRef/reason 的「通道独占」路由'
  + '（外部 curl / 运维脚本 / MCP 客户端 / 人工面）。声明不改变 consumed=false 的事实，'
  + '只把它从「未知缺口」搬到「已知通道」；**新增未消费路由没声明即棘轮红**（契约测试 ③）。',
  'producedByKind 是**全量分类**（合计 = total，no-write-point 也占位），'
  + '故不可与 produced 计数直接互比——后者只数真有写入锚点者。',
  // cycle-75 T6：第四族（技能/MCP）的口径与诚实边界由族实现自带（避免口径漂移）。
  ...SKILL_CLOSURE_NOTES,
];

/**
 * 计数自洽校验：各族计数 = 逐项统计；分类合计 = total；produced 分类合计 = total。
 *
 * 返回问题清单（空 = 自洽）。**不抛错**：调用方（契约测试 / 路由）决定怎么处置；
 * 运行期抛错会让整个面板失去数据，比"红一条测试"更糟（可见的缺口优于隐身）。
 */
export function clustersConsistent(clusters: readonly ClusterAudit[]): string[] {
  const problems: string[] = [];
  for (const c of clusters) {
    if (c.total !== c.items.length) problems.push(c.cluster + ': total != items.length');
    const consumed = c.items.filter((it) => it.consumed).length;
    if (consumed !== c.consumed) problems.push(c.cluster + ': consumed count mismatch');
    const code = c.items.filter((it) => it.evidenceKind === 'code').length;
    if (code !== c.codeConsumed) problems.push(c.cluster + ': codeConsumed count mismatch');
    if (c.total - consumed !== c.unconsumed) problems.push(c.cluster + ': unconsumed count mismatch');
    // 分类合计必须等于 total（互斥且穷尽——漏一类即静默丢失资产）。
    const buckets = bucketsOf(c.items);
    const bucketSum = CLOSURE_BUCKETS.reduce((s, k) => s + buckets[k], 0);
    if (bucketSum !== c.total) {
      problems.push(c.cluster + ': bucket sum ' + String(bucketSum) + ' != total ' + String(c.total));
    }
    // ★cycle-78：两组成分恒等式（语义升级，不是放宽）。
    //   unconsumed = declaredChannel + consumedGap + producedGap
    //   consumed   = code + dynamicClaimed + channelOnly
    // 分开校验而不是只校验总和：总和相等仍可能「未消费项被算进已消费」。
    const unconsumedSum = buckets.declaredChannel + buckets.consumedGap + buckets.producedGap;
    if (unconsumedSum !== c.unconsumed) {
      problems.push(c.cluster + ': unconsumed identity broken (' + String(unconsumedSum) + ' != ' + String(c.unconsumed) + ')');
    }
    const consumedSum = buckets.code + buckets.dynamicClaimed + buckets.channelOnly;
    if (consumedSum !== c.consumed) {
      problems.push(c.cluster + ': consumed identity broken (' + String(consumedSum) + ' != ' + String(c.consumed) + ')');
    }
    // produced 类别分布必须与逐项统计相等，且**合计 = total**（见 CLOSURE_NOTES 最后一条）。
    const tallied = tallyProduced(c.items);
    for (const k of Object.keys(tallied) as Array<keyof typeof tallied>) {
      if (tallied[k] !== c.producedByKind[k]) problems.push(c.cluster + ': producedByKind.' + k + ' mismatch');
    }
    const producedSum = Object.values(c.producedByKind).reduce((s, n) => s + n, 0);
    if (producedSum !== c.total) {
      problems.push(c.cluster + ': producedByKind sum ' + String(producedSum) + ' != total ' + String(c.total));
    }
    // 已生产项数不得超过 total（恒真守卫，防分类实现漂移后自报虚高）。
    if (producedCountOf(c.items) > c.total) problems.push(c.cluster + ': produced > total');
  }
  return problems;
}

/** 供调用方声明"未消费项"类型的窄别名（避免在 registryClosure 里再 import 一次类型）。 */
export type UnconsumedItems = readonly ClosureItem[];
