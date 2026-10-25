/**
 * 闭环体检**数据模型**（cycle-75 T3 拆分：scanPrimitives 超 250 行）。
 *
 * 从 scanPrimitives.ts 下移——该文件为「扫描原语 + 数据模型」双职责，加入
 * cycle-75 的 produced 证据字段后越界。本文件只承载**形状与计数**，不含任何
 * 文件遍历/正则匹配（那些留在 scanPrimitives.ts）。
 *
 * 消费者 import 路径零变更：scanPrimitives.ts 再导出本文件的全部公开名。
 *
 * produced 的证据类别（回答「凭什么算已生产」，逐项可查）——接口冻结见
 * docs/agents/闭环三态真值契约.md §1.1。此前 `producedAt` 恒等于 `definedAt`，
 * 读者无法区分「注册了且 handler 就位」与「只声明了名字」——一个数字没有证据就是自述。
 */
export type ProducedKind =
  /** 有真注册调用点：`reg({path})` / `webServer.register({path})`。 */
  | 'register-call'
  /** 同文件内存在 execute:/handler: 实现（工具族的 handler 就位）。 */
  | 'handler-in-file'
  /** 只有字面量声明，注册/接线缺失 —— 产出缺口。 */
  | 'declaration-only'
  /** 词表族：t() 是纯查找，**没有独立写入点**（诚实标注，不是缺失）。 */
  | 'no-write-point';

/** 资产的三态一行（注册 / 生产 / 消费）+ 逐项证据。 */
export interface ClosureItem {
  cluster: string;
  id: string;
  /** 定义处 file:line（相对仓库根，/ 分隔）。 */
  definedAt: string;
  /** 生产锚点；无独立写入点时为 null（词表族）。 */
  producedAt: string | null;
  /** ★cycle-75：produced 的类别。 */
  producedKind: ProducedKind;
  /** ★cycle-75：produced 的证据锚点（≤3 条 file:line）；declaration-only/no-write-point 为空。 */
  producedEvidence: string[];
  consumed: boolean;
  /** 证据类别：code=生产代码引用；channel=测试/agent 卡/技能脚本引用；none=无。 */
  evidenceKind: 'code' | 'channel' | 'none';
  /**
   * 证据来自**计算键**而非字面量（如 t(`budget.status_${data.status}`)，键的后缀由
   * 运行期校验过的联合类型决定）。为真时 evidence 指向模板行 —— 判定为已消费，
   * 但明确标注「不是逐字可 grep 的消费」，防读者把它当成字面量消费。
   */
  dynamic: boolean;
  /** 消费证据（≤3 条 file:line）。空数组 = 未消费。 */
  evidence: string[];
  /**
   * ★cycle-78：**通道声明**（未消费但是「已声明的运维/外部通道」）。
   *
   * 只有 `CHANNEL_DECLARATIONS` 里点名的路由才带本字段；三元组（谁维护 / 哪份文档 /
   * 为什么没有本仓消费方）由 channelRegistry 机器校验。⚠ 声明**不是豁免**：
   * 带本字段的项仍 `consumed=false`、仍计入 unconsumed，只是 bucket 变成
   * `declaredChannel`（「已知通道」而非「未知缺口」）。没声明的未消费路由
   * 仍是 consumedGap/producedGap —— 那才是棘轮要抓的东西。
   */
  declaredChannel?: { owner: string; docRef: string; reason: string };
}

export interface ClusterAudit {
  cluster: string;
  unit: string;
  total: number;
  consumed: number;
  unconsumed: number;
  /** 其中证据类别为 code 的项数（生产代码内真消费）。 */
  codeConsumed: number;
  /**
   * ★cycle-75：produced 的**全量分类**分布（各值之和 = total，不是 produced 数）。
   * 语义说明：它是「每一项属于哪种产出形态」的分类，`no-write-point` 也占位，
   * 故不可与 `isProduced` 计数直接互比。
   */
  producedByKind: Record<ProducedKind, number>;
  items: ClosureItem[];
}

/** produced 类别计数的零值（每个族都必须给全四键，缺键即假统计）。 */
export function emptyProducedTallies(): Record<ProducedKind, number> {
  return { 'register-call': 0, 'handler-in-file': 0, 'declaration-only': 0, 'no-write-point': 0 };
}

/**
 * 逐项汇总 produced 类别分布。
 *
 * 为什么必须逐项统计而不是各构造点自报：自报的数字没有比对面，
 * 一旦新增类别或漏记，总数会静默漂移（本仓既有教训：告警级守卫等于没有守卫）。
 * 本函数从 `items` 单向派生 ⇒ 与明细天然自洽，可被契约测试直接证伪。
 */
export function tallyProduced(items: readonly ClosureItem[]): Record<ProducedKind, number> {
  const out = emptyProducedTallies();
  for (const it of items) out[it.producedKind] += 1;
  return out;
}

/** 资产定义（单一注册表扫描的产物）。 */
export interface AssetDef { id: string; definedAt: string; }
