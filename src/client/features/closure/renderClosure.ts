/**
 * 闭环体检分区渲染（纯函数，L5）——GET /anic/api/closure-audit 的 JSON 投影。
 *
 * 白盒诉求（用户原文「同时要白盒透明化、可视化流动等可观测性」）：把「注册了但没人消费 /
 * 产出了但没人读」直接铺在面板上。cycle-75 之前这里把 86 条未消费**平铺**成一张清单，
 * 读者无法据此行动（形式上有白盒、语义上是噪声）——本片按冻结契约 §2 改为**四类分组**，
 * 每项带 `producedKind`（「凭什么算/不算已生产」的证据标签）。
 *
 * 四类（判据唯一实现 = closureClassify.classifyItem）：
 *   consumedGap    真缺口     —— 已注册/已产出，本仓无人读（对外消费者可能是宿主 agent）
 *   producedGap    未读取     —— 无写入点（词表 t() 纯查找）或未接线 ⇒ 接线或删除
 *   dynamicClaimed 计算键认领 —— 有前缀证据、无字面量消费方
 *   channelOnly    仅通道引用 —— 只在测试 / agent 卡里被读到
 *
 * **分层语义（实测校准，本项目踩过的坑）**：`totals.consumedGap + producedGap === unconsumed`
 * 只覆盖未消费；`dynamicClaimed / channelOnly` **不在未消费里**（它们是「已消费但证据弱」）。
 * 实测 44+42+3+1=90 ≠ unconsumed 86 —— 四键并列成一组会被误读成「未消费的四等分」，
 * 故渲染层拆成两行：全量未消费计数 + 证据偏弱行，各自标明语义。
 *
 * 三层诚实（本片存在的理由）：
 *   ① **全量计数**取自宿主亲算的 totals（**永不随明细截断**，契约 §1.4）；
 *   ② 明细分组的计数只覆盖**投影明细**，截断时显式说「已显示 N / 共 M 条」——
 *      静默截断 = 隐藏缺口，正是本分区要消灭的形态；
 *   ③ 取不到数据时（guard 不过 / 路由失败）**失败行可见**，绝不只剩空表体
 *      （cycle-72 真实事故「有壳无表体」在闭环面自身的复发）。
 *
 * 形状守卫在 closureTypes.isClosureView（fail-closed，逐字段）；本文件只渲染已验证的形状。
 * 纪律：用户面文本一律 t()；颜色走 token() 主题令牌；无绝对 http(s) URL；不持状态不发请求。
 */
import { createElement, type ReactElement } from 'react';
import { token, type TokenName } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import { renderSectionFailure } from '../../components/sectionFailure.ts';
import type { ClosureUnconsumedView, ClosureView } from './closureTypes.ts';
import { CLOSURE_CLASSES, classifyItem, producedAnchorBreakdown, type ClosureClassName } from './closureClassify.ts';
// cycle-75 T4：流动可视化（注册 → 生产 → 消费）。纯数据派生 + 纯渲染，无第二真相源。
import { buildClosureFlow, renderClosureFlow } from './closureFlowGraph.ts';

export type {
  ClosureView, ClosureTotals, ClosureClusterView, ClosureUnconsumedView,
  ClosureGhostView, ClosureTruncation,
} from './closureTypes.ts';
export type { ClosureClassName, ClosureClassCounts } from './closureClassify.ts';

const ROW = { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'baseline', padding: '2px 10px', fontSize: 11 } as const;

/**
 * 族名走 locale（cluster id → 键）。**显式映射表而非拼接**——拼接键会让静态提取器
 * 无法枚举（闭环体检自身的可观测性反而被自己的写法遮住），并留下悬空前缀引用；
 * 同 renderHitl 的 CHECK_LABEL_KEYS 先例。
 *
 * 族是**会继续长**的（cycle-75 已从三族扩到四族：加 `skills`）。新族必须在此登记
 * + 补 locale 键（zh/en 键集相等）——漏登记时回落显示原始 id（可见的漏翻，不是空白，
 * 见 clusterLabel），这是刻意的：静默隐藏一个族比露出 `skills` 这个 id 更糟。
 */
const CLUSTER_LABEL_KEYS: Record<string, string> = {
  tools: 'closure.cluster.tools',
  i18n: 'closure.cluster.i18n',
  routes: 'closure.cluster.routes',
  skills: 'closure.cluster.skills',
};

/**
 * 分组标签键（四类；契约 §2 冻结的键名，不得拼写变体）。
 * 写成精确字面量对象而非 `Record<string, string>` 查表：查表在
 * noUncheckedIndexedAccess 下返回 `string | undefined`，会逼出「undefined 文案」。
 */
const GROUP_KEYS = {
  consumedGap: 'closure.group.consumedGap',
  producedGap: 'closure.group.producedGap',
  dynamicClaimed: 'closure.group.dynamicClaimed',
  channelOnly: 'closure.group.channelOnly',
} as const satisfies Record<ClosureClassName, string>;

/** 分组强调色：真缺口最响，仅通道引用最轻（颜色一律走语义令牌，带同源 fallback）。 */
const GROUP_TOKENS = {
  consumedGap: 'anic-fail',
  producedGap: 'anic-doubt',
  dynamicClaimed: 'anic-warn-text',
  channelOnly: 'anic-text-dim',
} as const satisfies Record<ClosureClassName, TokenName>;

/** 产出锚点展示名（覆盖全部 ProducedKind 四值；未知值回落原 id——可见的漏翻，不是空白）。 */
const KIND_KEYS = {
  'register-call': 'closure.kind.registerCall',
  'handler-in-file': 'closure.kind.handlerInFile',
  'declaration-only': 'closure.kind.declarationOnly',
  'no-write-point': 'closure.kind.noWritePoint',
} as const;

function clusterLabel(cluster: string): string {
  const key = CLUSTER_LABEL_KEYS[cluster];
  return key !== undefined ? t(key) : cluster;
}

function kindLabel(kind: string): string {
  const key = (KIND_KEYS as Record<string, string | undefined>)[kind];
  return key !== undefined ? t(key) : kind;
}

/** 明细行（id + producedKind + 证据类别 + 定义锚点）。key 带分组前缀免跨组同名撞车。 */
function row(u: ClosureUnconsumedView, key: string): ReactElement {
  return createElement('div', { key, 'data-anic-unconsumed': u.id, style: { ...ROW, color: token('anic-text') } },
    createElement('span', { style: { color: token('anic-warn-text'), fontWeight: 600 } }, clusterLabel(u.cluster)),
    createElement('span', { style: { minWidth: 260 } }, u.id),
    createElement('span', { style: { color: token('anic-text-dim') } }, kindLabel(u.producedKind)),
    createElement('span', { style: { color: token('anic-text-faint') } },
      t('closure.evidenceOf', { kind: u.evidenceKind }) + ' · ' + u.definedAt),
  );
}

/**
 * 失败行（契约 §2.3：分区失败必须可见，不得只剩空表体）。
 *
 * **不复制第二份实现**：委托 components/sectionFailure.renderSectionFailure
 * （跨域共享中立层，10 个分区同款，锚点 `data-anic-failed-closure`）；本导出给不使用
 * `bodyOrFailure` 装配原语的调用面一个同域入口。`hasData=true` 时文案自动切
 * 「以下为上次成功的数据」——陈旧数据不伪装成新鲜。
 */
export function renderClosureFailure(failure: string | null, hasData: boolean): ReactElement | null {
  return renderSectionFailure('closure', failure, hasData);
}

/** 一个分类分组：标题（本组**已显示**计数）+ 逐项明细；空组不渲染（免四行噪声）。 */
function renderGroup(cls: ClosureClassName, items: readonly ClosureUnconsumedView[]): ReactElement | null {
  if (items.length === 0) return null;
  return createElement('div', { key: cls, 'data-anic-closure-group': cls },
    createElement('div', { 'data-anic-group-count': String(items.length), style: { ...ROW, fontWeight: 600, color: token(GROUP_TOKENS[cls]) } },
      t(GROUP_KEYS[cls], { n: String(items.length) })),
    ...items.slice(0, 40).map((u, i) => row(u, cls + ':' + String(i) + ':' + u.id)),
  );
}

/**
 * 渲染闭环体检分区。
 *
 * @param view 已验证形状的投影；null = 未拉取 / 路由缺失 / 扫描失败。
 * @param failure 失败文案（**装配层已用 bodyOrFailure 时不要重复传**：两条通道调同一
 *   原语，重复传会渲染两行）。view=null 且传了 failure ⇒ 只渲染失败行。
 */
export function renderClosure(view: ClosureView | null, failure: string | null = null): ReactElement | null {
  if (view === null) return renderClosureFailure(failure, false);
  const tot = view.totals;
  const tr = view.truncation.unconsumed;
  const anchors = producedAnchorBreakdown(view.unconsumed);
  // 逐项归类用**唯一判据**（closureClassify.classifyItem）——不在此处重写第二套阈值。
  const byClass = (cls: ClosureClassName): readonly ClosureUnconsumedView[] =>
    view.unconsumed.filter((u) => classifyItem(u) === cls);

  const summary = createElement('div', { 'data-anic-closure-summary': 'true', style: { ...ROW, padding: '6px 10px 2px', color: token('anic-text') } },
    createElement('strong', {}, t('closure.title')),
    createElement('span', { 'data-anic-closure-registered': String(tot.registered) }, t('closure.registered', { n: String(tot.registered) })),
    createElement('span', { 'data-anic-closure-consumed': String(tot.consumed) }, t('closure.consumed', { n: String(tot.consumed), code: String(tot.codeConsumed) })),
    createElement('span', { 'data-anic-closure-unconsumed': String(tot.unconsumed), style: { color: tot.unconsumed > 0 ? token('anic-warn-text') : token('anic-pass'), fontWeight: 600 } }, t('closure.unconsumed', { n: String(tot.unconsumed) })),
    createElement('span', { 'data-anic-closure-ghost': String(tot.ghost), style: { color: tot.ghost > 0 ? token('anic-fail') : token('anic-pass'), fontWeight: 600 } }, t('closure.ghost', { n: String(tot.ghost) })),
  );

  // ① 全量未消费计数（宿主亲算，**永不随明细截断**）：这两键恰好覆盖 unconsumed。
  const buckets = createElement('div', { 'data-anic-closure-buckets': 'true', style: { ...ROW, color: token('anic-text-strong') } },
    createElement('span', { style: { color: token('anic-text-faint') } }, t('closure.bucketsTitle')),
    createElement('span', { 'data-anic-bucket': 'consumedGap', style: { color: token('anic-fail'), fontWeight: 600 } }, t(GROUP_KEYS.consumedGap, { n: String(tot.consumedGap) })),
    createElement('span', { 'data-anic-bucket': 'producedGap' }, t(GROUP_KEYS.producedGap, { n: String(tot.producedGap) })),
  );

  // 证据偏弱行（**不属于未消费**）：已计入 consumed，但消费方不是生产代码。
  const weak = tot.dynamicClaimed > 0 || tot.channelOnly > 0
    ? createElement('div', { 'data-anic-closure-weak': 'true', style: { ...ROW, color: token('anic-text-dim') } },
        createElement('span', { style: { color: token('anic-text-faint') } }, t('closure.weakTitle')),
        createElement('span', { 'data-anic-bucket': 'dynamicClaimed' }, t('closure.weakDynamic', { n: String(tot.dynamicClaimed) })),
        createElement('span', { 'data-anic-bucket': 'channelOnly' }, t('closure.weakChannel', { n: String(tot.channelOnly) })),
      )
    : null;

  // ② 截断如实上报（静默截断 = 隐藏缺口）；未截断时不渲染 N/M 行。
  const truncation = tr.truncated
    ? createElement('div', { 'data-anic-closure-truncation': 'shown=' + String(tr.shown) + ' total=' + String(tr.total), style: { ...ROW, color: token('anic-warn-text') } },
        t('closure.truncated', { shown: String(tr.shown), total: String(tr.total), rest: String(tr.total - tr.shown) }))
    : null;

  // ③ 明细四分组：计数 = **本投影明细**里该类条数（只覆盖已显示部分，与 ① 分层、互不冒充）。
  const detail = createElement('div', { 'data-anic-closure-tables': 'true', style: { padding: '0 0 6px' } },
    createElement('div', { style: { ...ROW, fontWeight: 600, color: token('anic-text-strong') } },
      t('closure.tableUnconsumed', { n: String(view.unconsumed.length) })),
    ...(view.unconsumed.length === 0
      ? [createElement('div', { key: 'none', 'data-anic-closure-none': 'true', style: { ...ROW, color: token('anic-pass') } }, t('closure.noneUnconsumed'))]
      : CLOSURE_CLASSES.map((cls) => renderGroup(cls, byClass(cls))).filter((e) => e !== null)),
    // 产出锚点细分：无写入点（词表）与仅声明未接线是**两种补救动作**，分开报数防互相掩盖。
    anchors.noWritePoint + anchors.declarationOnly > 0
      ? createElement('div', { 'data-anic-closure-anchor-breakdown': 'true', style: { ...ROW, color: token('anic-text-faint') } },
          t('closure.declaredOnly', { nw: String(anchors.noWritePoint), do: String(anchors.declarationOnly) }))
      : null,
    createElement('div', { style: { ...ROW, marginTop: 4, fontWeight: 600, color: token('anic-text-strong') } }, t('closure.tableGhost', { n: String(view.ghost.length) })),
    ...(view.ghost.length === 0
      ? [createElement('div', { key: 'none', 'data-anic-closure-ghost-none': 'true', style: { ...ROW, color: token('anic-pass') } }, t('closure.noneGhost'))]
      : view.ghost.map((g, i) => createElement('div', { key: 'g' + String(i), 'data-anic-ghost': g.id, style: { ...ROW, color: token('anic-text') } },
          createElement('span', { style: { color: token('anic-warn-text'), fontWeight: 600 } }, clusterLabel(g.cluster)),
          createElement('span', { style: { minWidth: 260 } }, g.id),
          createElement('span', { style: { color: token('anic-text-faint') } }, t('closure.ghostHint'))))),
  );

  const notes = createElement('div', { 'data-anic-closure-notes': 'true', style: { padding: '0 10px 6px', fontSize: 10, color: token('anic-text-faint') } },
    createElement('div', {}, t('closure.notesTitle')),
    ...view.notes.map((n, i) => createElement('div', { key: 'n' + String(i) }, '· ' + n)),
    createElement('div', { style: { marginTop: 2 } }, t('closure.generatedAt', { generatedAt: view.generatedAt })),
  );

  const body = createElement('div', { 'data-anic-closure': 'section', style: { borderTop: '1px solid ' + token('anic-border') } },
    summary,
    // cycle-75 T4「可视化流动」：注册 → 生产 → 消费 的流向（缺口发生在哪一段一眼可见）。
    // 数据由纯函数 buildClosureFlow 派生（同一投影、无第二真相源）；渲染同为纯函数。
    renderClosureFlow(buildClosureFlow(view)),
    buckets, weak, truncation, detail, notes);
  if (failure === null) return body;
  // 陈旧数据形态：数据 + 失败行（如实标注「以下为上次成功的数据」）。
  return createElement('div', { 'data-anic-closure-stale': 'true' }, body, renderClosureFailure(failure, true));
}
