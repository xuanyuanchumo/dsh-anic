/**
 * 分区失败行（cycle-71 T-7117）—— 「分区静默空体」缺陷的结构性收口。
 *
 * ## 缺陷（cycle-71 研究实证，用户可感知的最大剩余缺口）
 *
 * 4s 档 **10 个端点全部没有 `onFail`**（`WorkflowGraphPanel.ts` targets +
 * `governanceTargets.ts`）。`usePanelFetch` 契约明写：
 *
 *   `onFail?: (failure) => void;`  // 省略 = 静默降级（分区不渲染）
 *
 * 而 4s 档各渲染函数在数据为 `null` 时**返回 null**（`renderBudget(null) → null`、
 * `renderSkillHealth(null) → null` 等）。两者叠加：**任一端点挂掉 → 该分区只剩标题、
 * 正文静默空掉**——用户**分不清**「路由挂了」与「这个工作区确实没有数据」。
 * 「不伪造空态」是对的，但**连"取不到"也不说**就退化成静默失败。
 * （另：`state.*` 六个键自设计起**零消费**——本改动同时兑现其中两个。）
 *
 * ## 修复形态（零新机制，与既有架构同构）
 *
 * 1. **单切片按 id 取值**：`PanelState.failures: Record<string, string>`。
 *    为什么不是每端点一切片：`usePanelSlice` 用 uSES 对**选中值**做 `Object.is`
 *    ——即使 `failures` 换引用触发全场通知，分区选中的仍是**同一字符串**
 *    （primitive），`Object.is` 相等 → 该分区**不重渲**。「通知扇出但渲染隔离」
 *    自动成立，无需 10 个切片（panelState 已 96 行，10 切片是纯膨胀）。
 *
 * 2. **零通知不变式**（写侧，`panelActions.markFetchFailure`）：内容相同即不换
 *    对象——否则每个 4s tick 都产生新引用、都通知全场。
 *
 * 3. **端点级 key + 分区级聚合**（本文件的第二层设计）：
 *    `cycles`（list+state）与 `ledger`（list+verify）各有**两个**端点，若按分区
 *    记一条，则「一个成功 clear、一个失败 mark」并发竞态 → 结果取决于完成序，
 *    不稳定。故 key 落到**端点**粒度，分区侧用 `useSectionFailure(store, keys)`
 *    **聚合为单个字符串**（首个非空失败文案）。
 *    聚合结果仍是 primitive → selector 引用稳定契约同时满足。
 *
 * ## 为什么放 components/ 而非 features/
 *
 * 它是**跨域共享机制**（10 个分区都用），与 `sectionShell.ts` 同层。G-FEAT
 * 守卫禁止跨特性 import——共享物必须落中立层（cycle-58 同款裁决）。
 */
import { usePanelSlice } from './panelStore.ts';
import type { PanelDataStore, PanelState } from '../panelState.ts';
import { createElement, type ReactElement } from 'react';
import { token } from '../../shared/tokens.ts';
import { t } from '../i18n.ts';

/** 失败行文案（classifyFailure 的三分类结果）。 */
export type SectionFailureText = string;

/**
 * 聚合 selector（**返回 primitive**——引用稳定契约的两条都满足）。
 *
 * 为什么是「首个非空」而不是拼接：拼接需要 join（每次新字符串 → 每次通知都
 * 重渲）；而「首个非空」在任一失败持续存在时返回**同一字符串**，稳定。
 * 多端点同时失败时只显示首个——信息足够（都是「取不到」，具体哪个由 key 可查）。
 */
function aggregate(keys: readonly string[]): (s: PanelState) => SectionFailureText | null {
  return (s: PanelState): SectionFailureText | null => {
    for (const k of keys) {
      const v = s.failures[k];
      if (typeof v === 'string' && v !== '') return v;
    }
    return null;
  };
}

/** selector 缓存（按 keys 的稳定签名——同一分区每次渲染复用同一函数引用）。 */
const selectorCache = new Map<string, (s: PanelState) => SectionFailureText | null>();
function selectorFor(keys: readonly string[]): (s: PanelState) => SectionFailureText | null {
  const sig = keys.join('\u0000');
  let sel = selectorCache.get(sig);
  if (sel === undefined) {
    sel = aggregate(keys);
    selectorCache.set(sig, sel);
  }
  return sel;
}

/** 单端点的稳定 selector（多数分区只一个端点）。 */
const singleCache = new Map<string, (s: PanelState) => SectionFailureText | null>();

/**
 * 订阅分区失败文案（无失败 → null）。
 *
 * @param keys 端点级失败 key（分区含多端点时全列，聚合取首个非空）。
 *   返回 `null` = 无失败记录；非空字符串 = 分类后的失败原因。
 */
export function useSectionFailure(store: PanelDataStore, keys: string | readonly string[]): SectionFailureText | null {
  const list = typeof keys === 'string' ? [keys] : keys;
  let sel: ((s: PanelState) => SectionFailureText | null) | undefined;
  if (list.length === 1) {
    const k = list[0] ?? '';
    sel = singleCache.get(k);
    if (sel === undefined) {
      sel = selectorFor([k]);
      singleCache.set(k, sel);
    }
  } else {
    sel = selectorFor(list);
  }
  return usePanelSlice(store, sel);
}

/**
 * 失败行（如实说明「这里为什么是空的」）。
 *
 * 语义纪律（不伪造）：
 *   - 文案含**分类后的原因**（路由不可用 500 / 响应畸形 / 网络异常原文）——
 *     用户据此能区分「服务端说没有」与「根本问不到服务端」；
 *   - **有旧数据时**用另一句文案（明说「以下为上一次成功的数据」），
 *     不把陈旧数据伪装成新鲜的（与 live 域的陈旧标注同族纪律）。
 *
 * 锚点命名纪律：`data-anic-failed-<id>` 的 id **转小写**——本仓锚点一律
 * 小写 kebab（`data-anic-cycles-wrap` 等）；camelCase 出现在 `data-*` 的
 * **属性名**里会被 React 判为未知 prop 并告警（HTML 属性名大小写不敏感，
 * 小写化后语义不变，且与全仓约定一致）。
 *
 * @param id 分区 id（如 `skillHealth`；锚点写入时为 `skillhealth`）
 * @param failure 失败文案（useSectionFailure 结果）
 * @param hasData 该分区是否已有可渲染数据（决定用哪句文案）
 */
export function renderSectionFailure(id: string, failure: SectionFailureText | null, hasData: boolean): ReactElement | null {
  if (failure === null) return null;
  return createElement(
    'div',
    {
      [`data-anic-failed-${id.toLowerCase()}`]: 'true',
      style: { fontSize: 11, color: token('anic-warn-text'), padding: '4px 10px', lineHeight: 1.5 },
    },
    hasData ? t('state.sectionFailedStale', { error: failure }) : t('state.sectionFailed', { error: failure }),
  );
}

/** 分区体形状（与 renderFoldableSection 的 children 入参同域——数组形态合法）。 */
export type SectionBody = ReactElement | ReadonlyArray<ReactElement | null> | null;

/**
 * 分区主体的失败感知组装（**数据优先，失败必说**）。
 *
 * 三种形态：
 *   - 有数据 + 无失败 → 数据本身（常态，零额外节点）；
 *   - 有数据 + 有失败 → 数据 + 失败行（陈旧如实标注）；
 *   - 无数据 + 有失败 → 失败行（替代静默空体）；
 *   - 无数据 + 无失败 → null（**保持既有行为**：交由上层既有的
 *     `unavailableText` 未加载降级——零回归）。
 *
 * 「有数据」判据 = `body !== null`；**调用方在无数据时必须传 null**
 * （不要传全 null 数组——数组恒真会误判为「有数据」）。
 */
export function bodyOrFailure(body: SectionBody, id: string, failure: SectionFailureText | null): SectionBody {
  const line = renderSectionFailure(id, failure, body !== null);
  if (body === null) return line;
  if (line === null) return body;
  // 有数据 + 有失败：包一层容器把失败行缀在数据后（陈旧标注）。
  return createElement('div', { 'data-anic-failed-with-data': id }, body, line);
}

/**
 * 分区体的 hook 组装：订阅失败 + 组装（4s 档分区的**唯一**调用形态）。
 *
 * 抽成 hook 是为了让 `panelSections.ts` 每个分区只多一行——该文件已 219 行，
 * 逼近 T3 250 上限；逐分区手写「订阅 + 两形态判断」会把它推过线。
 * 本函数在组件渲染期被无条件调用（满足 hooks 规则）。
 *
 * **注意**：含启停门控的分区（flows/hitl）不能用它——门控会令 hook 变成
 * 条件调用（违反 hooks 规则）。那两处用 `useSectionFailure` + `bodyOrFailure`
 * 显式两步（订阅无条件，组装在门控之内）。
 */
export function useSectionBody(store: PanelDataStore, id: string, keys: string | readonly string[], body: SectionBody): SectionBody {
  const failure = useSectionFailure(store, keys);
  return bodyOrFailure(body, id, failure);
}
