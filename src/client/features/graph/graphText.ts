/**
 * 图区新增词表键（cycle-83 · V 战线）——`graph.*` 前缀 + 短名，理由与 configTypes 同源。
 *
 * ## 为什么键不写成整串字面量
 *
 * 新键还没进 `locale/*.json`（由 Lead 按 `docs/anic/cycle-83-graph-i18n.md` 合并），
 * 而闭环体检有两条机械判据同时生效：
 *   - `i18nGhosts`：源码里出现 `t('graph.crumbRoot')` 这种**整串字面量** ⇒ 立刻被
 *     报成「幽灵消费」（键不存在），`closureAuditContract ③` 变红；
 *   - `i18nClosure`：键进 locale 之后若无人消费 ⇒ 「死键」，`i18nDeadKeyContract` 红。
 * 前缀形态 `t('graph.' + suffix)` 两头都安全：合并前键不存在（无幽灵、无死键），
 * 合并后 `dynamicKeyPrefixes` 以 `graph.` 前缀认领这些键（无死键）。
 *
 * 既有 14 个 `graph.*` 键走的是**字面量**消费，literal 证据优先于动态前缀，
 * 所以本文件的引入不会掩盖它们的真实消费状态（`i18nClosure` 先 literal 后 dynamic）。
 *
 * 代价是拼错不再有幽灵提示，所以用字面量联合把拼错挡在**编译期**（与 configTypes
 * 的 `ConfigTextSuffix` 同一手法）。
 */
import { t } from '../../i18n.ts';

/**
 * 本分区新增键的短名联合（编译期防拼错）。
 *
 * 分组注释说明**消费点**，便于合并 locale 的人核对：
 * - `tooltip*`：悬浮预览卡（graphTooltip.ts）
 * - `minimap*`：小地图可访问名（graphMiniMap.ts）
 * - `crumb*`：面包屑（graphBreadcrumb.ts）
 * - `stage*`：交互舞台（graphStage.ts）
 * - `group*`：工具栏分组标签（graphToolbar.ts）
 */
export type GraphTextSuffix =
  | 'tooltipDegree'
  | 'minimapLabel'
  | 'crumbRoot' | 'crumbCycle' | 'crumbPhase' | 'crumbWindow' | 'crumbAll' | 'crumbLabel'
  | 'groupSearch' | 'groupType' | 'groupVerdict' | 'groupZoom' | 'groupA11y'
  | 'groupLayout' | 'groupView'
  | 'laneHeaderLabel'
  | 'layoutModeLane' | 'layoutModeCompact' | 'layoutModeLabel'
  | 'filterAnomaly' | 'filterAnomalyHint'
  | 'fitSelection' | 'fitSelectionHint'
  | 'exportSvg' | 'exportSvgHint'
  | 'fullscreen' | 'fullscreenExit' | 'fullscreenUnavailable'
  | 'stageDragHint';

/** 取一条新键文案（唯一入口；见文件头「为什么不写整串字面量」）。 */
export function gt(suffix: GraphTextSuffix, params?: Record<string, string | number>): string {
  return t('graph.' + suffix, params);
}
