/**
 * 图节点的**健康度**判据（cycle-91）—— 把 `testReport` 变成可读的编码。
 *
 * ## 为什么需要这个文件（实测缺口）
 *
 * `WorkflowNode.testReport` 携带 `{ report, passed, failures, errors, layers }`
 * —— 这是**图上最值钱的信号**（"2666 个用例全过" vs "3 个失败 1 个错误"），
 * 但此前它**只出现在节点详情抽屉里**（`gateColors.renderNodeDetail`），
 * **图上一个像素都没占**。
 *
 * ⇒ 用户要判断"哪个门禁的测试在红"，必须**逐个点开节点**。
 * 在 35 节点 / 249 节点的图上，这是**不可用的**。
 *
 * ## 三条诚实边界
 *
 * 1. **无 testReport ⇒ 不画**（不是画"0 失败"）。`null` 与 `0` 是两件事。
 * 2. **分母为 0 ⇒ 比率不可判定**（不是 0）。`passed=0, failures=0, errors=0`
 *    意味着"没有用例" ⇒ 失败率**无定义**。
 * 3. **颜色不是唯一通道**：失败数同时进 **meta 行的文字**（`✓2666 ✗3`），
 *    这样灰度打印与色盲模式下仍可读（WCAG 1.4.1）。
 *
 * ## 为什么不画"比例环"
 *
 * 研究建议里的"比例环"方案会引入第二个 `<circle>`——而
 * `graphNodeCard.ts` 钉死了「**每节点恰好一个 `<circle>`**」
 * （smoke 数据驱动断言：`circle 数 == 节点数`）。
 * ⇒ 改用 **`<rect>` 分段色条**：保留"颜色不是唯一通道"的优势，
 *   且不破坏不变量。
 *
 * ## 边界
 *
 * 纯函数、零 IO、零 DOM：可独立单测。
 */
import type { WorkflowNode } from '../../workflowGraphData.ts';

/** 健康度分档（决定色条的**整体**色调与徽标形态）。 */
export type HealthBand = 'ok' | 'warn' | 'bad' | 'unknown';

/** 一个节点的健康度读数。 */
export interface HealthReadout {
  /** 分档。 */
  band: HealthBand;
  /** 失败率（0..1）；**不可判定时为 null**（分母为 0 或无 testReport）。 */
  failureRate: number | null;
  /** 通过数。 */
  passed: number;
  /** 失败数。 */
  failures: number;
  /** 错误数。 */
  errors: number;
  /** 用例总数。 */
  total: number;
}

/**
 * 节点的健康度读数。
 *
 * @param n 节点
 * @returns 读数；**无 testReport 时 band='unknown' 且 failureRate=null**
 */
export function healthOf(n: WorkflowNode): HealthReadout {
  const t = n.testReport;
  if (t === undefined) {
    return { band: 'unknown', failureRate: null, passed: 0, failures: 0, errors: 0, total: 0 };
  }
  const passed = Number.isFinite(t.passed) ? t.passed : 0;
  const failures = Number.isFinite(t.failures) ? t.failures : 0;
  const errors = Number.isFinite(t.errors) ? t.errors : 0;
  const total = passed + failures + errors;
  // 分母为 0 ⇒ 失败率**无定义**（不是 0）——「没有用例」不等于「没有失败」。
  if (total === 0) {
    return { band: 'unknown', failureRate: null, passed, failures, errors, total };
  }
  const rate = (failures + errors) / total;
  const band: HealthBand = failures + errors === 0 ? 'ok' : rate >= 0.01 ? 'bad' : 'warn';
  return { band, failureRate: rate, passed, failures, errors, total };
}

/**
 * 色条的**分段比例**（绿=passed / 红=failures / 琥珀=errors）。
 *
 * @returns 各段的相对宽度（和为 1）；无 testReport ⇒ 空数组
 */
export function healthSegments(h: HealthReadout): Array<{ kind: 'passed' | 'failures' | 'errors'; ratio: number }> {
  if (h.total === 0) return [];
  const out: Array<{ kind: 'passed' | 'failures' | 'errors'; ratio: number }> = [];
  if (h.passed > 0) out.push({ kind: 'passed', ratio: h.passed / h.total });
  if (h.failures > 0) out.push({ kind: 'failures', ratio: h.failures / h.total });
  if (h.errors > 0) out.push({ kind: 'errors', ratio: h.errors / h.total });
  return out;
}

/**
 * meta 行的**测试摘要**（`✓2666 ✗3`）。
 *
 * ## 为什么要有它（不是只靠颜色）
 *
 * WCAG 1.4.1「颜色不能是唯一通道」：色觉障碍用户（约 8% 男性）看不出
 * 红色段与琥珀段的区别 ⇒ 分段色条对他们等价于「一条普通色条」。
 * ⇒ 数字必须以**文字**形式出现在节点上。
 *
 * @returns 摘要文本；无 testReport / 无用例 ⇒ null（不画"0"）
 */
export function healthSummaryText(h: HealthReadout): string | null {
  if (h.total === 0) return null;
  const parts: string[] = [];
  if (h.passed > 0) parts.push(`✓${String(h.passed)}`);
  if (h.failures > 0) parts.push(`✗${String(h.failures)}`);
  if (h.errors > 0) parts.push(`!${String(h.errors)}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * 某个门禁被多少条证据边支撑（**边流量编码**）。
 *
 * ## 为什么需要
 *
 * 研究发现：当前 `wf:gate-g0` 被 8 条 `evidences` 边支撑，与只被 1 条
 * 支撑的门禁**画得一模一样**（同样粗的淡虚线）。读者看不出"这是枢纽"。
 *
 * @param edges    全部边
 * @param gateId   目标门禁 id
 * @param edgeType 只统计该类型的边（`undefined` = 全部）
 * @returns 支撑边数
 */
export function supportCountOf(
  edges: readonly { from: string; to: string; type?: string }[],
  gateId: string,
  edgeType?: string,
): number {
  let n = 0;
  for (const e of edges) {
    if (e.to !== gateId) continue;
    if (edgeType !== undefined && e.type !== edgeType) continue;
    n++;
  }
  return n;
}

/**
 * **边流量编码**的宽度：基础宽度 × 支撑度分档系数。
 *
 * @param baseWidth 该边类型的默认宽度（来自 `EDGE_STYLES`）
 * @param support  支撑数；undefined = 不启用
 *
 * ## 为什么是「系数」而不是「绝对宽度」
 *
 * 不同边类型的默认宽度不同（0.7 / 0.8 / 0.9）⇒ 用**绝对宽度**会让细边
 * （evidences 0.7）比粗边（cycle-seq 0.9）还粗 ⇒ **跨类型比较会失真**。
 * ⇒ 用**系数**（1.0 / 1.4 / 1.9）⇒ 保持类型间的相对关系不变。
 */
export function supportWidth(baseWidth: number, support: number | undefined): number {
  if (support === undefined || support <= 0) return baseWidth;
  if (support === 1) return baseWidth;
  if (support <= 3) return baseWidth * 1.4;
  return baseWidth * 1.9;
}

/**
 * 支撑度的**描边宽度档**（边流量编码）。
 *
 * | 支撑数 | 宽度 | 含义 |
 * |---|---|---|
 * | 0 | 0.7 | 无支撑（孤立） |
 * | 1 | 0.9 | 普通 |
 * | 2-3 | 1.3 | 多个支撑 |
 * | ≥4 | 1.8 | **枢纽** |
 *
 * @returns 描边宽度（世界坐标 px）
 */
export function supportWidthOf(count: number): number {
  if (count <= 0) return 0.7;
  if (count === 1) return 0.9;
  if (count <= 3) return 1.3;
  return 1.8;
}
