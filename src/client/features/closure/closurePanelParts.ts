/**
 * 闭环分区**渲染部件**（cycle-78 拆分：renderClosure 已 247 行，贴近 T3 的 250 行上限）。
 *
 * 从 renderClosure.ts 下移两件东西：
 *   ① 分组标签/配色映射表（GROUP_KEYS / GROUP_TOKENS）—— 分类从四类扩到五类
 *      （新增 declaredChannel）后，两张表都要加键，留在原文件会越界；
 *   ② 「通道声明 N / 未声明 M」行（cycle-78 新观测面）。
 *
 * 为什么这一行必须存在（白盒化的最后一步）：服务端现在能分出
 * `unconsumed = channelDeclared + consumedGap + producedGap`，但**只有显示出来**，
 * 人才能回答「46 条未消费里哪几条是声明的运维通道、哪几条是真忘了接线」。
 * 未声明 > 0 时用警示色点名前 3 条 —— 那是「新增路由忘了声明」的唯一可见信号。
 *
 * 纪律：用户面文本一律 t()；颜色走 token() 主题令牌；纯函数、零状态、不发请求。
 */
import { createElement, type ReactElement } from 'react';
import { token, type TokenName } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import type { ClosureTotals } from './closureTypes.ts';
import type { ClosureConnectivityView } from './closureConnectivityTypes.ts';
import type { ClosureClassName } from './closureClassify.ts';

/**
 * 分组标签键（五类；契约 §2 冻结的键名，不得拼写变体）。
 *
 * 用显式 `Record<ClosureClassName, string>` 而不是查表 + 兜底：分类是**会继续长**的
 * （cycle-75 四类、cycle-78 五类），缺键必须在**编译期**红，而不是运行期渲染出
 * 「undefined 文案」。同理 GROUP_TOKENS。
 */
export const GROUP_KEYS: Record<ClosureClassName, string> = {
  consumedGap: 'closure.group.consumedGap',
  producedGap: 'closure.group.producedGap',
  dynamicClaimed: 'closure.group.dynamicClaimed',
  channelOnly: 'closure.group.channelOnly',
  // ★cycle-78：已声明通道（未消费但已声明 owner/docRef/reason）。
  declaredChannel: 'closure.group.declaredChannel',
};

/** 分组强调色：真缺口最响，已声明通道最平静（颜色一律走语义令牌）。 */
export const GROUP_TOKENS: Record<ClosureClassName, TokenName> = {
  consumedGap: 'anic-fail',
  producedGap: 'anic-doubt',
  dynamicClaimed: 'anic-warn-text',
  channelOnly: 'anic-text-dim',
  // 已声明 ≠ 健康绿：它仍是未消费。用弱化的付色，避免读者把「已声明」当「已消费」。
  declaredChannel: 'anic-text-dim',
};

/** 与 renderClosure 主行同款排版（拆文件后不引入第二套间距口径）。 */
const ROW = { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'baseline', padding: '2px 10px', fontSize: 11 } as const;

/**
 * 通道声明两数（**routes 族口径**）。
 *
 * 为什么必须按族收窄而不是直接用 `totals.unconsumed`：未消费里还有 39 条 i18n 词表键，
 * 它们**不存在「通道声明」这个概念**（词表没有外部通道）。若把 `unconsumed − declared`
 * 当「未声明」，面板会永久显示「未声明 39」的红色——那是**假警报**，而本仓的既有教训是
 * 「告警级守卫等于没有守卫」（恒亮即无人再看）。声明机制本轮只覆盖路由族，
 * 故未声明数只在 routes 族内计算。
 *
 * @param tot 服务端 totals（`channelDeclared` 可选：旧服务端按 0 处理）
 * @param routesUnconsumed routes 族的未消费数；族缺席（旧服务端）时退回 totals.unconsumed
 */
export function channelDeclaredCounts(
  tot: ClosureTotals,
  routesUnconsumed: number | undefined,
): { declared: number; undeclared: number } {
  const declared = tot.channelDeclared ?? 0;
  const scope = routesUnconsumed ?? tot.unconsumed;
  return { declared, undeclared: Math.max(0, scope - declared) };
}

/**
 * 「通道声明 N / 未声明 M」行（cycle-78 新观测面）。
 *
 * 两个数都来自**服务端亲算的计数**（永不随明细截断）：N = totals.channelDeclared；
 * M = routes 族未消费数 − N（未消费且没声明 ⇒ 棘轮红的那一类）。
 * 明细里的 `undeclared` 只用于**点名**前 3 条（明细会被截断，故只做示例不做计数）。
 *
 * 旧服务端无 `channelDeclared` 键时按 0 处理：此时 M = routes 未消费数（旧服务端确实
 * 没有任何声明机制），显示「未声明 46」是**如实**的，不是误报。
 *
 * @param tot 服务端 totals
 * @param routesUnconsumed routes 族未消费数（族缺席时按 totals.unconsumed 兜底）
 * @param undeclared 投影明细里未声明的路由 id（用于点名；可为空数组）
 */
export function renderChannelDeclared(
  tot: ClosureTotals,
  routesUnconsumed: number | undefined,
  undeclared: readonly string[],
): ReactElement {
  const { declared, undeclared: undeclaredCount } = channelDeclaredCounts(tot, routesUnconsumed);
  const warn = undeclaredCount > 0;
  const names = undeclared.slice(0, 3);
  return createElement('div', {
    'data-anic-closure-declared': 'declared=' + String(declared) + ' undeclared=' + String(undeclaredCount),
    style: { ...ROW, color: warn ? token('anic-fail') : token('anic-text-dim'), fontWeight: warn ? 600 : 400 },
  },
    createElement('span', { 'data-anic-declared-count': String(declared) },
      t('closure.channelDeclared', { n: String(declared) })),
    createElement('span', { 'data-anic-undeclared-count': String(undeclaredCount) },
      t('closure.channelUndeclared', { n: String(undeclaredCount) })),
    // 未声明 > 0：点名前 3 条 —— 只说数字等于让读者自己再翻一遍表。
    warn
      ? createElement('span', { 'data-anic-undeclared-list': names.join(',') },
          t('closure.channelUndeclaredList', { list: names.length === 0 ? '—' : names.join(', ') }))
      : null,
  );
}

/**
 * ★cycle-76 连通性行：注册 → 生产 → **运行时可达**（cycle-82 从 renderClosure 下移，
 * 该文件加入第五族/隔离面后越界 T3 的 250 行）。
 *
 * 为什么必须同屏：一个**空心注册**（注册器存在、`reg()` 也在、但聚合器没调它）在三态
 * 矩阵上显示为**完全健康**——代码在、测试全绿、面板正常，只是那行永不执行。
 * 这一行是唯一能让它现形的地方。
 *
 * `connectivity` 缺席（旧服务端）⇒ 返回 null（不渲染）：缺席是"这个服务端还没这一面"，
 * 不是"这一面红了"，故不用失败色也不用失败行。
 */
export function renderConnectivityRow(c: ClosureConnectivityView | undefined): ReactElement | null {
  if (c === undefined) return null;
  return createElement('div', {
    'data-anic-closure-connectivity': c.connected ? 'ok' : 'broken',
    'data-anic-conn-hops': String(c.hopCount),
    'data-anic-conn-orphans': String(c.orphanRegistrars.length),
    style: { ...ROW, color: c.connected ? token('anic-pass') : token('anic-fail'), fontWeight: 600 },
  },
    createElement('span', {}, c.connected
      ? t('closure.conn.ok', { hops: String(c.hopCount) })
      : t('closure.conn.broken', { broken: String(c.hops.filter((h) => !h.ok).length) })),
    createElement('span', { style: { fontWeight: 400, color: token('anic-text-dim') } },
      t('closure.conn.wired', {
        rw: String(c.routeWired), rt: String(c.routeTotal),
        tw: String(c.toolWired), tt: String(c.toolTotal),
      })),
    c.orphanRegistrars.length > 0
      ? createElement('span', { 'data-anic-conn-orphan-list': c.orphanRegistrars.join(',') },
          t('closure.conn.orphans', { list: c.orphanRegistrars.join(', ') }))
      : null,
  );
}
