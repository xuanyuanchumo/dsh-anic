/**
 * 闭环体检客户端形状契约（cycle-75 T3 · docs/agents/闭环三态真值契约.md §2；cycle-76 拆出连通性）。
 *
 * 为什么单独一文件：形状守卫是**数据腿的守门人**——`usePanelFetch` 在 `guard`
 * 返回 false 时走 `onFail`（记端点键 'closure'，分区渲染可见失败行）；
 * 半截响应**不进渲染**，也绝不冒充「零缺口」。
 *
 * 硬约束（契约 §2）：**不得** import host 侧模块——宿主侧同名投影
 * （src/host/closureAudit/closureView.ts）与本文件是**各自持有的两份声明**
 * （host/client 编译隔离 + G-IND）；本文件不得出现 `../host` 路径。
 *
 * 守卫纪律：**fail-closed，逐字段**。任一字段缺失或类型不符 ⇒ isClosureView 返回 false
 * ⇒ 该响应不进渲染面。
 *
 * **fail-closed 的边界（刻意的）**：只对**本客户端真正渲染的字段**严格。
 * 两类东西不判假：
 *   ① 未知**多余**字段（向前兼容：服务端加字段不该让旧客户端变瞎）；
 *   ② 已知枚举的**未知取值**（producedKind / evidenceKind 的新值、
 *      producedByKind 的新 kind 键）——族与产出形态会继续长（cycle-75 已从
 *      三族扩到四族），把一个新增枚举值判成畸形 = 「一条新数据把整个白盒面打瞎」。
 *      对它们改为**形态 + 真值**校验：非空字符串、producedByKind 合计 = 本族 total。
 *      未知取值的展示由渲染层回落原值（可见的漏翻，不是空白）。
 *
 * 另加三条**真值自洽**断言（不只是形状，见 isClosureView）：
 *   ① `truncation.unconsumed.total` 必须等于 `totals.unconsumed`——「总数永不
 *      截断」是契约 §1.4 的硬要求，两侧不等即投影在**隐藏缺口**，必须响亮失败；
 *   ② `truncated` 必须等于 `total > shown`——静默截断（标 false 却少给了条目）
 *      正是「隐藏缺口」的形态；
 *   ③ `consumedGap + producedGap` 必须等于 `unconsumed`——宿主 closureTotalsTypes
 *      的明文口径（这两键**只覆盖未消费**）。**刻意不**对全部四个计数键求和：
 *      dynamicClaimed/channelOnly 不在未消费里，四键相加是实测过的误读
 *      （44+42+3+1=90 ≠ 86）。
 *
 * 纯声明 + 纯谓词：零副作用、零状态、零网络、零 React。
 */

/**
 * ★cycle-78：`ClosureTotals` 形状与守卫已拆至 closureTotalsTypes.ts（T3 ≤250 行；
 * 拆法与宿主侧 closureTotalsTypes.ts 同构）。此处**再导出**保消费者 import 路径零变更。
 */
export type { ClosureTotals } from './closureTotalsTypes.ts';
export { isClosureTotals } from './closureTotalsTypes.ts';
import type { ClosureTotals } from './closureTotalsTypes.ts';
import { isClosureTotals } from './closureTotalsTypes.ts';
import {
  isBool, isNum, isObj, isRecordOf, isStr, isStrArray,
} from './closureTotalsTypes.ts';
/*
 * ★cycle-82 T3 拆分：证据类别（ProducedKind / EvidenceKind）与其**谓词**下移到
 * closureKinds.ts（本文件加入第五族/隔离面子守卫后越界 250 行）。
 * 此处**再导出**保消费者 import 路径零变更（渲染层与契约测试都从本文件取）。
 */
export type { EvidenceKind, ProducedKind } from './closureKinds.ts';
export { EVIDENCE_KINDS, PRODUCED_KINDS, isEvidenceKind, isProducedKind } from './closureKinds.ts';
import type { EvidenceKind, ProducedKind } from './closureKinds.ts';
import { isEvidenceKind, isProducedKind } from './closureKinds.ts';

export interface ClosureClusterView {
  cluster: string;
  unit: string;
  total: number;
  consumed: number;
  codeConsumed: number;
  unconsumed: number;
  /** 本族 produced 类别全量分布（合计 = 本族 total，no-write-point 也占位）。 */
  producedByKind: Record<ProducedKind, number>;
}

export interface ClosureUnconsumedView {
  cluster: string;
  id: string;
  definedAt: string;
  producedKind: ProducedKind;
  /** 是否真有产出锚点（declaration-only / no-write-point ⇒ false）。 */
  produced: boolean;
  /** 消费证据是否来自计算键前缀认领（非字面量）。 */
  dynamic: boolean;
  evidenceKind: EvidenceKind;
  /**
   * ★cycle-78：通道声明（未消费但已声明为「通道独占」）。缺席 = 未声明。
   * 声明**不是豁免**：项仍在未消费明细里，只是归类为 declaredChannel。
   */
  declaredChannel?: { owner: string; docRef: string; reason: string };
  /** 消费证据锚点（≤3 条 file:line；空 = 无）。 */
  evidence: string[];
}

export interface ClosureGhostView { cluster: string; id: string; }

// ★cycle-76 连通性形状与守卫已拆至 closureConnectivityTypes.ts（T3 ≤250 行）；
// 此处**再导出**保消费者 import 路径零变更。
// 注意：`export … from` 不引入本模块作用域，故另用 import 把本文件用到的名字引进来。
export type { ClosureConnectivityView } from './closureConnectivityTypes.ts';
export { isConnectivity } from './closureConnectivityTypes.ts';
import type { ClosureConnectivityView } from './closureConnectivityTypes.ts';
import { isConnectivity } from './closureConnectivityTypes.ts';
// ★cycle-82：第五族与隔离面的形状守卫（各自特性文件；本文件只做聚合调用）。
import type { ArtifactsView as ClosureArtifactsView } from './closureArtifacts.ts';
import { isArtifactsView } from './closureArtifacts.ts';
import type { IsolationView as ClosureIsolationView } from './closureIsolation.ts';
import { isIsolationView } from './closureIsolation.ts';
// 再导出，保消费者 import 路径零变更（renderClosure 与契约测试从本文件取形状）。
export type { ArtifactsView as ClosureArtifactsView } from './closureArtifacts.ts';
export type { IsolationView as ClosureIsolationView } from './closureIsolation.ts';

export interface ClosureTruncation {
  /** 明细截断如实上报（**总数永不截断**——只有明细数组受限）。 */
  unconsumed: { shown: number; total: number; truncated: boolean };
}

export interface ClosureView {
  generatedAt: string;
  totals: ClosureTotals;
  clusters: ClosureClusterView[];
  unconsumed: ClosureUnconsumedView[];
  ghost: ClosureGhostView[];
  notes: string[];
  truncation: ClosureTruncation;
  /**
   * ★cycle-76：连通性。**可选**——旧服务端无此块时旧客户端仍须可用
   * （向前兼容：新增观测面不得把既有面板打瞎）。渲染层缺省不显示该行。
   */
  connectivity?: ClosureConnectivityView;
  /**
   * ★cycle-82：第五族（`.cycles` 文档生命周期）—— 逐模板 × 逐循环矩阵。
   *
   * **可选**：旧服务端无此块时旧客户端仍须可用（向前兼容）。渲染层缺省不显示该分区，
   * 而不是显示一条"失败"——缺席是"这个服务端还没这一面"，不是"这一面红了"。
   * 形状/守卫/渲染在 closureArtifacts.ts（拆出处：本文件已 230 行，守 T3 ≤250）。
   */
  artifacts?: ClosureArtifactsView;
  /**
   * ★cycle-82：跨项目隔离 —— 所有读数的前提（路径越界时上面的数字描述的是别的项目）。
   *
   * 同样可选；形状/守卫/渲染在 closureIsolation.ts。
   */
  isolation?: ClosureIsolationView;
}

/* ── 谓词原语已随 totals 形状下移到 closureTotalsTypes.ts（上面对应 import）────── */

/**
 * produced 类别是否**形态合法**。
 *
 * ⚠ 刻意**不**做白名单（与首版实现相反，见下）：族与产出形态是**会继续长**的
 * （cycle-75 已从三族扩到四族，`skills` 族用的是 handler-in-file）。
 * 把「未知值」判成畸形会让**一个新增枚举值把整个面板打成失败态**——
 * 那是「有一条新数据就把白盒面打瞎」的坏交换。故此处只要求：
 *   非空字符串（缺失 / null / 数字 / 空串仍判 false ⇒ 半截响应照样被拦）。
 * 未知值的**展示**由 renderClosure 的 KIND_KEYS 显式映射回落原值（可见的漏翻）。
 */
function isProducedByKind(v: unknown, total: number): boolean {
  if (!isObj(v)) return false;
  let sum = 0;
  for (const n of Object.values(v)) {
    if (!isNum(n)) return false;
    sum += n;
  }
  return sum === total;
}

export function isClosureClusterView(v: unknown): v is ClosureClusterView {
  if (!isObj(v)) return false;
  if (!isStr(v.cluster) || !isStr(v.unit)) return false;
  if (!isRecordOf(v, ['total', 'consumed', 'codeConsumed', 'unconsumed'])) return false;
  return isProducedByKind(v.producedByKind, v.total as number);
}

export function isClosureUnconsumedView(v: unknown): v is ClosureUnconsumedView {
  if (!isObj(v)) return false;
  if (!isStr(v.cluster) || !isStr(v.id) || !isStr(v.definedAt)) return false;
  if (!isProducedKind(v.producedKind) || !isEvidenceKind(v.evidenceKind)) return false;
  if (!isBool(v.produced) || !isBool(v.dynamic)) return false;
  // cycle-78：通道声明**可选**；在场则三元组必须都是非空字符串（fail-closed）。
  if (v.declaredChannel !== undefined) {
    if (!isObj(v.declaredChannel)) return false;
    const d = v.declaredChannel as Record<string, unknown>;
    if (!isStr(d.owner) || !isStr(d.docRef) || !isStr(d.reason)) return false;
    if (d.owner === '' || d.docRef === '' || d.reason === '') return false;
  }
  return isStrArray(v.evidence);
}

function isTruncation(v: unknown): v is ClosureTruncation {
  if (!isObj(v)) return false;
  const u = v.unconsumed;
  if (!isObj(u)) return false;
  if (!isNum(u.shown) || !isNum(u.total) || !isBool(u.truncated)) return false;
  return u.total >= u.shown; // 已显示多于总数 ⇒ 投影自相矛盾
}

/**
 * 形状守卫（fail-closed）：逐字段校验，任一缺失/类型不符 ⇒ false。
 *
 * 调用点最小纪律（clientRenderContract 同族）：`guard` 返回 false 时
 * `usePanelFetch` 记 `onFail({kind:'malformed'})` ⇒ 分区走失败行，
 * **旧数据不被污染、空表体不会冒充「零缺口」**。
 *
 * 连通性子守卫（cycle-76）已拆至 closureConnectivityTypes.ts 并在此再导出。
 */
export function isClosureView(v: unknown): v is ClosureView {
  if (!isObj(v)) return false;
  if (!isStr(v.generatedAt)) return false;
  if (!isClosureTotals(v.totals)) return false;
  if (!Array.isArray(v.clusters) || !v.clusters.every(isClosureClusterView)) return false;
  if (!Array.isArray(v.unconsumed) || !v.unconsumed.every(isClosureUnconsumedView)) return false;
  if (!Array.isArray(v.ghost)) return false;
  for (const g of v.ghost) { if (!isObj(g) || !isStr(g.cluster) || !isStr(g.id)) return false; }
  if (!isStrArray(v.notes)) return false;
  if (!isTruncation(v.truncation)) return false;
  // ★cycle-76：连通性**在场则严格校验，缺席则放行**（向前兼容旧服务端）。
  if (v.connectivity !== undefined && !isConnectivity(v.connectivity)) return false;
  /*
   * ★cycle-82：第五族（artifacts）与跨项目隔离（isolation）同样「在场则严格、
   * 缺席则放行」。守卫实现放在各自特性文件（closureArtifacts / closureIsolation）——
   * 本文件已 230 行（T3 上限 250），内联两个子守卫必破；且它们与本文件的
   * `ClosureUnconsumedView` 判据无关，独立成域更符合"一域一文件"。
   */
  if (v.artifacts !== undefined && !isArtifactsView(v.artifacts)) return false;
  if (v.isolation !== undefined && !isIsolationView(v.isolation)) return false;
  const tot = v.totals as ClosureTotals;
  const tr = (v.truncation as ClosureTruncation).unconsumed;
  // 真值自洽①：总数永不截断（契约 §1.4）——两侧不等 = 投影在隐藏缺口
  if (tr.total !== tot.unconsumed) return false;
  // 真值自洽②：truncated 必须由 shown/total 推出（标 false 却少给条目 = 静默截断）
  if (tr.truncated !== (tr.total > tr.shown)) return false;
  // 真值自洽③：三分类必须覆盖全部未消费（宿主 closureTotalsTypes 的明文口径）。
  // cycle-78 升级：`channelDeclared + consumedGap + producedGap === unconsumed`。
  // 之所以只加这三键——dynamicClaimed/channelOnly 不在未消费里（实测 44+42+3+1 ≠ 86）；
  // 旧服务端缺 channelDeclared 时按 0 处理（它的两缺口之和本就等于未消费）。
  return (tot.channelDeclared ?? 0) + tot.consumedGap + tot.producedGap === tot.unconsumed;
}

/*
 * 分类判据（classifyItem / classifyUnconsumed / producedAnchorBreakdown）**已下移**
 * 到同域的 closureClassify.ts——本文件只留形状声明与 fail-closed 守卫，
 * 以守住 truthAudit T3 的 250 行纪律（拆分形态与宿主 closureBuckets.ts 同构）。
 * 消费者 import 路径零变更：本文件不再导出它们，调用点从 closureClassify 取。
 */
