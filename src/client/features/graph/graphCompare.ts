/**
 * 属性对比矩阵（cycle-109 · U3）——**本文件回答**："这几个节点到底差在哪"。
 *
 * ## 为什么行固定 5 条（而不是"按差异自动选行"）
 *
 * 自动选行会让同一次对比在两次渲染里呈现不同的行（数据一变行就换），用户无法
 * 记住"我上次看的是哪一行"，也无法用"第 3 行"指代它。固定行 + `diff` 标记是
 * **位置稳定**的读法：行永远在那儿，差异用标记表达。
 *
 * 行序也是刻意的：先答"它是什么"（类型 / 裁决 / 角色），再答"它在图里多重"
 * （上游度数 / 下游度数）——与 `graphNodeCard` 的"主标签 → 次标签"同一顺序。
 *
 * ## `diff` 的定义（唯一判据）
 *
 * 该行所有列的值**不全相同** ⇒ `diff: true`。单列（只有 1 个节点）恒为 false：
 * 一个节点与它自己没有差异，把单列标成"有差异"会让面板一开始就撒谎。
 *
 * ## 为什么度数标签复用 `graph.traceUp` / `graph.traceDown`
 *
 * i18n 词表在 601 键处**零余量**（`i18nDeadKeyContract` ⑤ 的规模棘轮，注释写着
 * "下轮再加键这条立即红，逼人事先判断这键真的需要吗"）。新增"入度 / 出度"两条
 * 标签会把它推过上限，而改那条守卫属于"改守卫迁就实现"。这两条既有键的值是
 * 「上游（原因）{count}」，传空 count 即得纯方向标签，且语义与度数行完全一致
 * （`graphTrace` 的 up/down 与入/出度同义）。少两条词表条目 = 少两处漏翻面。
 */
import type { WorkflowNode } from '../../workflowGraphData.ts';
import type { TraceAdjacency } from './graphTrace.ts';
import type { NodeRole } from './graphNodeRole.ts';
import { canonicalVerdict } from './gateColors.ts';
import { t } from '../../i18n.ts';

/** 矩阵行键（固定 5 条，顺序即渲染顺序）。 */
export type CompareRowKey = 'type' | 'verdict' | 'up' | 'down' | 'role';

/** 一列 = 一个被对比节点（列头信息足够独立成句）。 */
export interface CompareColumn {
  id: string;
  label: string;
  /** 类型规范键（`graph.lane.*` 的键尾）。 */
  type: string;
  /** 裁决规范键（pass/fail/doubt/pending/skip/none）。 */
  verdict: string;
}

/** 一行 = 一条属性在各列上的取值 + 是否不同。 */
export interface CompareRow {
  key: CompareRowKey;
  /** 行标签（已本地化；不是键名——面板不重新查词表）。 */
  label: string;
  /** 与 `columns` 等长，顺序一一对应。 */
  values: string[];
  diff: boolean;
}

/** 面板渲染所需的全部读数（纯派生，无状态）。 */
export interface CompareMatrix {
  columns: CompareColumn[];
  rows: CompareRow[];
}

/** 矩阵输入（对象形参：5 个位置参数排错顺序的代价太高）。 */
export interface CompareInput {
  /** 选中集（顺序 = 点选顺序，即列顺序）。 */
  ids: readonly string[];
  nodes: readonly WorkflowNode[];
  verdicts: Map<string, string> | undefined;
  /** 正/反邻接表（度数就是它的 size，不另建一份）。 */
  adjacency: TraceAdjacency;
  roles: ReadonlyMap<string, NodeRole>;
}

/** 度数行标签（空 count ⇒ 纯方向标签；理由见文件头末段）。 */
function degreeLabelOf(direction: 'up' | 'down'): string {
  const text = direction === 'up' ? t('graph.traceUp', { count: '' }) : t('graph.traceDown', { count: '' });
  // 模板是「上游（原因）{count}」，空 count 会留下尾随空格——标签不该带它。
  return text.trim();
}

/** 单列取值（5 条行各取一次；列内共享同一份节点与邻接表）。 */
function valuesOf(
  id: string,
  node: WorkflowNode | undefined,
  input: CompareInput,
): Record<CompareRowKey, string> {
  const key = canonicalVerdict(input.verdicts?.get(id) ?? node?.result);
  const role = input.roles.get(id) ?? null;
  return {
    type: node === undefined ? '—' : t('graph.lane.' + node.type),
    verdict: key === null ? t('graph.verdict.none') : t('graph.verdict.' + key),
    up: String(input.adjacency.reverse.get(id)?.length ?? 0),
    down: String(input.adjacency.forward.get(id)?.length ?? 0),
    role: role === null ? '—' : t('graph.nodeRole.' + role),
  };
}

/**
 * 建矩阵（纯函数：结果只依赖入参，同一输入两次调用深相等）。
 *
 * 缺失节点（选中了刚被窗口化掉的 id）**保留该列**并显示 id 作列头：静默删列会
 * 让"我明明选了 3 个，面板只有 2 列"变成一个无法解释的减法（诚实退化优于丢信息）。
 */
export function compareMatrixOf(input: CompareInput): CompareMatrix {
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const columns: CompareColumn[] = input.ids.map((id) => {
    const node = byId.get(id);
    const key = canonicalVerdict(input.verdicts?.get(id) ?? node?.result);
    return {
      id,
      label: node?.label ?? id,
      type: node?.type ?? 'unknown',
      verdict: key ?? 'none',
    };
  });
  const perColumn = input.ids.map((id) => valuesOf(id, byId.get(id), input));
  const rowOf = (key: CompareRowKey, label: string): CompareRow => {
    const values = perColumn.map((v) => v[key]);
    return { key, label, values, diff: new Set(values).size > 1 };
  };
  const rows: CompareRow[] = [
    rowOf('type', t('panel.colType')),
    rowOf('verdict', t('panel.colVerdict')),
    rowOf('up', degreeLabelOf('up')),
    rowOf('down', degreeLabelOf('down')),
    rowOf('role', t('graph.nodeRoleLabel')),
  ];
  return { columns, rows };
}