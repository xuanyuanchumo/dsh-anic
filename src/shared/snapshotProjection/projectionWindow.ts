/**
 * 窗口化投影：**哪些轮进主图、哪些折叠**（cycle-83 产物治理的核心判据）。
 *
 * ## 被修的形态（用户原话「避免过度的产物影响判断」）
 *
 * 快照把**每个** cycle 目录、**每条**账本记录都摊成一个节点：实测 296 个节点里
 * 273 个（92%）是历史。面板一打开，92% 的像素在讲三周前的事——这不是"信息量大"，
 * 这是**没有投影**：把数据库整表倒进视图，等于没做视图。
 *
 * ## 为什么判据是「最近 N 轮 + 当前轮」而不是"重要度排序"
 *
 * 重要度排序**不可判两态**：一旦"这条为什么被折叠"靠启发式加权，用户永远无法反驳
 * ——他既不能说"你不该折叠我这一轮"，也无法预测下一轮自己还在不在图里。
 * 时间序 + 当前轮是两个**任何人看一眼就能自己核对**的硬判据：
 * 「我这一轮编号几？N 是几？」两数一比，答案唯一。
 *
 * ## 为什么"当前轮"要显式并进窗口（它本就在最近 N 轮内）
 *
 * 编号单调时当前轮恒为最大编号 ⇒ 恒落在最近 N 轮内，这条并集看似冗余。
 * 仍然显式写出来，是因为它守的是一条**语义承诺**而不是一次算术巧合：
 * 「正在干的活永远在图里」。一旦将来出现非单调编号、或"当前轮"改由
 * `.cycles/workflow-state.json` 决定（而不是最大编号），这条承诺必须自动继续成立
 * ——靠"N 恰好够大"来实现的承诺，会在 N 被调小的那一刻静默破掉。
 *
 * ## 归档轮**永不**进逐轮列表（而是合成 1 个摘要节点）
 *
 * 归档的语义是"移出主视图、保留可回溯"，所以它们不进逐轮列表，但**必须**在
 * 快照里以摘要节点继续可见（`summarizeArchived`），并带计数与首尾编号。
 * 归档后目录消失就蒸发 = 「归档即丢失」，那是另一种形态的错误。
 *
 * ## 纪律
 *
 * 纯函数、零 IO（本模块不读盘：调用方把已枚举的事实传进来）。**空输入不是错误**：
 * 未 init 的项目必须返回可用的空窗口而不是抛异常（宿主路由对未 init 项目必须可用）。
 */

/** 一轮循环的结构化事实（**身份只来自目录名**，绝不从文档文本解析——INV-21）。 */
export interface CycleFact {
  /** `cycle-N` 目录名（唯一身份）。 */
  name: string;
  /** 目录名里的数值（排序键）。 */
  num: number;
  /** 归档时间（ISO 日期）；active 轮为 undefined。 */
  archivedAt?: string;
}

/** 投影决定（纯数据，可直接断言）。 */
export interface WindowPlan {
  /** 生效的窗口大小（已过合法性闸门）。 */
  recent: number;
  /** 进主图的**活跃**轮（数值序）。 */
  windowed: CycleFact[];
  /** 被窗口折叠掉的活跃轮（数值序）——`folded.length` 就是快照的 `windowedOut`。 */
  folded: CycleFact[];
  /** 当前轮名（缺省 = 最大编号的活跃轮；无活跃轮 → null）。 */
  current: string | null;
  /** 必须如实上报的问题（窗口合法性、当前轮声明的可疑性等）。 */
  warnings: string[];
}

/** `planWindow` 的输入（全部为已枚举事实，本模块不碰文件系统）。 */
export interface WindowInput {
  active: readonly CycleFact[];
  archived: readonly CycleFact[];
  /** 窗口大小（调用方已过 `resolveSnapshotWindow` 闸门）。 */
  recent: number;
  /** 显式声明的当前轮（缺省取最大编号活跃轮）。 */
  current?: string;
}

/** 数值序（稳定：同 num 按名字，保证确定性——同输入同输出）。 */
function byNum(a: CycleFact, b: CycleFact): number {
  return a.num - b.num || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * 计算窗口。
 *
 * 边界处理（每条都有反向自检用例在 `tests/unit/projectionWindow.test.ts`）：
 * - `recent >= active.length` ⇒ 全部进窗口，`folded` 为空（不是"全部折叠"）；
 * - `recent = 1` ⇒ 只留最后一轮 + 当前轮（两者通常是同一轮）；
 * - 无活跃轮 ⇒ 空窗口且 `current = null`（**不是**报错，也不是保留最后一轮）；
 * - 声明了一个不存在的 `current` ⇒ 落回最大编号轮，但**如实告警**
 *   （声明的意图不该被静默吞掉）。
 */
export function planWindow(input: WindowInput): WindowPlan {
  const warnings: string[] = [];
  const active = [...input.active].sort(byNum);
  const archived = [...input.archived].sort(byNum);
  const n = Math.max(1, Math.floor(input.recent));

  if (active.length === 0) {
    // 无活跃轮：归档区可能仍有历史。此时主图无逐轮节点，但归档摘要节点照常在场
    // （见 summarizeArchived）——"全部归档"是合法状态，不是空项目。
    return { recent: n, windowed: [], folded: [], current: null, warnings };
  }

  // 当前轮：显式声明优先（且必须在活跃区里），否则取最大编号。
  const declared = input.current;
  const fallback = active[active.length - 1]?.name ?? null;
  let current: string | null;
  if (declared !== undefined && declared !== '') {
    if (active.some((c) => c.name === declared)) {
      current = declared;
    } else {
      current = fallback;
      warnings.push(`declared current cycle '${declared}' is not active — using '${String(current)}'`);
    }
  } else {
    current = fallback;
  }

  const keep = new Set<string>();
  for (const c of active.slice(-n)) keep.add(c.name);
  // 语义承诺：正在干的那轮永远在图里（见文件头"为什么并集看似冗余仍然要写"）。
  if (current !== null) keep.add(current);

  const windowed = active.filter((c) => keep.has(c.name));
  const folded = active.filter((c) => !keep.has(c.name));

  // 归档区里出现了比活跃区更大的编号：说明"当前轮已被归档"，此时主图的"当前轮"
  // 是活跃区残留的旧轮——读数会误导。如实告警，不静默继续。
  const maxArchived = archived[archived.length - 1];
  if (maxArchived !== undefined && active.every((c) => c.num < maxArchived.num)) {
    warnings.push(
      `newest archived cycle '${maxArchived.name}' outranks every active cycle — current cycle is '${String(current)}'`,
    );
  }

  return { recent: n, windowed, folded, current, warnings };
}

/**
 * 归档摘要（1 个节点 + 计数）。
 *
 * 为什么单独成函数：它是「归档 ≠ 丢失」这条承诺的机器形态。只要 `count > 0`，
 * 快照里就必须有一个可点开的摘要节点；`count = 0` 时**不生成节点**（空节点是
 * "有壳无表体"的经典形态——一个写着"归档 0 轮"的节点没有任何信息量）。
 *
 * 标签用中性 ASCII 而不是中文：本模块在 `src/shared/`（客户端可见层），
 * 而节点 label 由渲染层逐字显示（既有 `G0 PASS` / `autonomy L2` 同款形态）。
 * 中文用户面文案的 i18n 键登记在 `docs/anic/cycle-83-archive-i18n.md`，
 * 由渲染层按 node.type 二次本地化——那才是 i18n 纪律要求的位置。
 */
export interface ArchiveSummary {
  count: number;
  /** 首/末轮名（数值序）；空归档时为 null。 */
  first: string | null;
  last: string | null;
  /** 节点 id（`evt:` 前缀保持 INV-21 结构化身份；无归档时 null）。 */
  nodeId: string | null;
  /** 人读标签（含计数与首尾，计数必须写在标签上——不能只靠 tooltip）。 */
  label: string;
}

/** 归档区 → 摘要（无归档时 nodeId/label 为空、count=0）。 */
export function summarizeArchived(archived: readonly CycleFact[]): ArchiveSummary {
  const sorted = [...archived].sort(byNum);
  const count = sorted.length;
  if (count === 0) return { count: 0, first: null, last: null, nodeId: null, label: '' };
  const first = sorted[0]?.name ?? null;
  const last = sorted[count - 1]?.name ?? null;
  return {
    count,
    first,
    last,
    // ★ id 前缀必须落在 selfCheckRoute P2 探针认的结构化集合（wf:/cycle:/evt:/inc:/aux:）内。
    // 用 `evt:` 而不是新造一个 `sum:`：新前缀会让 INV-21 探针把合法节点判成坏 id。
    nodeId: 'evt:archived',
    label: count === 1
      ? `archived 1 cycle (${String(first)})`
      : `archived ${String(count)} cycles (${String(first)} … ${String(last)})`,
  };
}
