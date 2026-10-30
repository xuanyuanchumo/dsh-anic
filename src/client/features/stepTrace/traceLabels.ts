/**
 * 步骤轨迹的**用户面标签**（纯函数层：零 DOM / 零 clock / 零 random / 不读词表）。
 *
 * ## 为什么要有这一层
 *
 * 改造前 `renderStepTrace.ts:60` 把裸 token 直接拼进用户面：
 * `${s.kind} · ${s.status}` ⇒ 界面上出现 `micro-step · done`。
 * 四个状态词的中文键（`trace.statusActive` / `statusFailed` / `statusSkipped` /
 * `statusPending`）**早就存在**于 locale，只是没人接线——本文件就是那条接线。
 *
 * ## 反例（为什么不能直接拼键）
 *
 * 闭环体检的 i18n 扫描器只认**引号字面量里的完整键名**
 * （`i18nClosure.quotedLiteralMatch` / `evidenceIndex` 的 literal 索引）。
 * 拼出来的键在源码里**不可枚举** ⇒ 词表侧仍判它"无人消费" ⇒
 * `i18nDeadKeyContract` ① 照旧红：拼键没有修好缺口，只是把死键换了个名字。
 * 同 `renderClosure.ts` 的 `KIND_KEYS` / `CLUSTER_LABEL_KEYS` 先例：**显式映射表**。
 *
 * ## 为什么仍保留"通用形态 probe"（不是冗余，是两层职责）
 *
 * 宿主与客户端是**两条独立发版链**：宿主可能先发出一个客户端词表里还没有的新状态
 * （例如 `blocked`）。此时不能崩、不能显示键名、不能显示 undefined——必须回落
 * **原始 token**（显示 `blocked`）。而等 locale 补上对应键之后，同一份代码无需
 * 改动即可自动本地化（probe 命中即用）。
 *
 * ## 边界
 *
 * - 词表查找由调用方**注入**（渲染层传 `t`）⇒ 本文件可独立单测，且**能构造
 *   "键不存在"这一态**——真实 locale 里五个状态键都在，用真 `t()` 永远测不出兜底。
 * - 词表键不存在时 `t()` 返回**键名本身**（见 `src/client/i18n.ts` 的缺键回退链）。
 *   所以判定"取不到"必须用 `label === key`，不能用 `!label`（空串也是合法回退形态）。
 */

/** 词表查找函数（渲染层注入 `t`；本文件不碰词表、不碰 DOM、不碰时钟）。 */
export type LabelLookup = (key: string) => string;

/**
 * 已知状态 → 词表键（字面量表）。
 *
 * 取值域 = `src/shared/stepTrace.ts` 的 `StepStatus`
 * （pending / active / done / failed / skipped）——五个值与 locale 里**已存在**的
 * 五个 `trace.status*` 键一一对应。本轮**不新增任何 locale 键**。
 *
 * 为什么不把这张表放进 shared/：那份类型文件 import `node:fs`（宿主侧），
 * 客户端引它会把 node:fs 拖进 web bundle。本表是**客户端呈现层**的映射，
 * 留在客户端域内；共享层只保留"取值域"（类型），映射留在渲染侧。
 */
const STATUS_KEYS: Readonly<Record<string, string>> = {
  pending: 'trace.statusPending',
  active: 'trace.statusActive',
  done: 'trace.statusDone',
  failed: 'trace.statusFailed',
  skipped: 'trace.statusSkipped',
};

/** 状态 token → 词表键；未知状态给通用形态键（取不到时由 resolveLabel 回落 token）。 */
export function statusLocaleKey(status: string): string | null {
  const norm = status.trim().toLowerCase();
  if (norm === '') return null;
  const known = STATUS_KEYS[norm];
  if (known !== undefined) return known;
  // 通用形态：新状态词在旧 locale 里不存在 ⇒ 取不到 ⇒ 调用方回落原始 token。
  return 'trace.status' + (norm.charAt(0).toUpperCase() + norm.slice(1));
}

/**
 * kind（= 声明图节点类型）→ 词表键。
 *
 * 取值域 = 声明图的 `type:` 字段。规范集合是 `graphLayoutSpec.LANE_ORDER` 的八类
 * （phase / micro-step / gate / human-gate / cycle / gate-event / incident / autonomy），
 * 且**全部**已在 `graph.lane.*` 键族里有词条——图区（泳道表头、节点副标签）用的
 * 就是这一族，故此处**复用**它：不新增键，两处视图的措辞也自然一致。
 *
 * 边界：`workflow-graph.yaml` 的 `type:` 是**用户可写**的自由文本（技能参考里
 * 甚至出现过 `play` / `human`），所以这里必须允许取不到键 → 回落原始 kind。
 */
export function kindLocaleKey(kind: string): string | null {
  const norm = kind.trim();
  if (norm === '') return null;
  return 'graph.lane.' + norm;
}

/**
 * 取一条本地化标签；取不到时回落**原始 token**。
 *
 * 为什么要专门判"取不到"：缺键回退链的终点是**键名本身**。用户看到
 * `trace.statusDone` 比看到 `done` 更糟——它既不是人话，也不是真实状态。
 * 所以判据是"标签 === 键名"，而不是"标签为空"（空串同样是该回落的形态）。
 */
export function resolveLabel(key: string | null, fallback: string, lookup: LabelLookup): string {
  const raw = fallback.trim();
  if (key === null) return raw;
  const label = lookup(key);
  if (label === key || label.trim() === '') return raw;
  return label;
}

/**
 * 步骤行的"类型 · 状态"标签（纯函数：同样的输入 + 同样的 lookup ⇒ 同样的输出）。
 *
 * 为什么空段被丢掉而不是留成 `微步骤 · `：空状态段是**畸形数据**的可见形态，
 * 留一个悬空分隔符会让读者以为后面还有第三段。丢掉比留空诚实。
 */
export function composeStepLabel(kind: string, status: string, lookup: LabelLookup): string {
  const parts: string[] = [];
  const kindLabel = resolveLabel(kindLocaleKey(kind), kind, lookup);
  if (kindLabel !== '') parts.push(kindLabel);
  const statusLabel = resolveLabel(statusLocaleKey(status), status, lookup);
  if (statusLabel !== '') parts.push(statusLabel);
  return parts.join(' · ');
}
