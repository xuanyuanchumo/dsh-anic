/**
 * 节点**角色图例**（cycle-95 · WS-C）—— 把 entry/orphan/leaf/hub 四种形状画进工具栏。
 *
 * ## 为什么图例画的是**形状**而不是色点（这不是审美选择）
 *
 * `src/shared/palette.ts` 的 cycle-94 重校准证明：9 个类型色在浅底与暗底同时
 * ≥3.3 时相对亮度被锁进窄带，色数上限不足 9 —— 只靠色相连**类型**都分不清。
 * 角色是编码在同一个 7px 圆点上的**第五个**维度（类型 / 裁决 / 追溯 / 角色），
 * 靠颜色绝无可能：灰度打印、色觉障碍、强制高对比下全部坍缩成一个点。
 *
 * ⇒ 角色必须走**形状通道**（与 `graphTypeShape` / `graphNodeRoleRender` 同一条
 * WCAG 1.4.1 落地纪律）。所以本文件画的形状必须与图上真实标记**同源**
 * （都从 `roleMarkPath` 取 d），图例自建第二张形状表必然漂移，而漂移后的
 * 图例是**骗人的**（读者按它认角色会认错）。
 *
 * ## 两个硬不变量（图例只能这么画）
 *
 * `scripts/offline-smoke.mjs` 与 `graphVisualUpgradeContract` 钉死
 * 「`<svg>` 恰好 1 个」「`<circle>` 数 == 节点数」。⇒ 图例**不能**新建 svg，
 * 也**不能**用 circle。本文件走的是 `graphEdgeLegend` 验证过的那条路：
 * 纯 CSS 形状 + 一个**内联** `<svg>` 也不行（同一条 `svg === 1`）。
 *
 * 所以角色图例用**纯 CSS 方块/边框组合**表达四档差异（实心 / 描边 / 细边 /
 * 双边框），并把语义写进 `data-anic-graph-role-legend-shape` —— 契约据此断言
 * "四种档位两两不同"，而人眼看到的是四块确实不同的方块。
 *
 * ## 为什么不进 Tab 序列
 *
 * 它是说明而不是控件（与 `graphToolbarLegend` 同款纪律）：`aria-hidden` +
 * 纯展示。AT 用户已能通过节点自身的 `aria-label` 与等价数据表拿到角色信息。
 */
import { createElement, type ReactElement } from 'react';
import type { NodeRole } from './graphNodeRole.ts';
import { ROLE_TRAITS, type RoleTraits } from './graphNodeRoleRender.ts';
import { t } from '../../i18n.ts';

/** 图例里的四档（顺序 = 阅读顺序：起点 → 汇聚 → 终点 → 孤立）。 */
export const LEGEND_ROLES: ReadonlyArray<'entry' | 'hub' | 'leaf' | 'orphan'> = [
  'entry', 'hub', 'leaf', 'orphan',
];

/**
 * 角色 → CSS 视觉档（**与 `ROLE_TRAITS` 同源**，只是把它翻译成可渲染的样式）。
 *
 * 为什么只做"翻译"而不另建一张表：`ROLE_TRAITS` 是角色的唯一特征事实源
 * （契约断言图上的标记与它一致）。图例若自己写 `borderWidth: 2`，改动
 * `ROLE_STROKE_WIDTH` 时图例就会静默不同步 —— 与 `dashToBackground` 同一条
 * "解析而非复制"的纪律。
 */
export function roleLegendStyleOf(role: 'entry' | 'hub' | 'leaf' | 'orphan'): {
  /** 形状档名（契约断言"四档两两不同"）。 */
  shape: string;
  /** 内联样式（边框宽度由 stroke 档翻译而来）。 */
  style: Record<string, string | number>;
} {
  const traits: RoleTraits = ROLE_TRAITS[role];
  const widthOf: Record<RoleTraits['stroke'], number> = {
    bold: 2.5, medium: 2, thin: 1.4, hairline: 1,
  };
  const sizeOf: Record<RoleTraits['size'], number> = { full: 9, small: 7 };
  const box = sizeOf[traits.size];
  const style: Record<string, string | number> = {
    display: 'inline-block',
    width: box,
    height: box,
    borderWidth: widthOf[traits.stroke],
    borderStyle: traits.outline ? 'solid' : 'none',
    // 实心档用背景表达；描边档只留边框（两档在灰度下也分得开）。
    background: traits.outline ? 'transparent' : 'currentColor',
    borderColor: 'currentColor',
    borderRadius: traits.mark === 'ring' ? '50%' : 2,
  };
  // 旋转让 arrow/dot/star 三档在同一尺寸下轮廓不同（形状通道而非颜色）。
  // 单独赋值：`transform: undefined` 在 Record 类型里不是合法值（TS2322），
  // 而且"没有这条样式"与"显式置空"在 React 里行为不同（前者不写 style）。
  if (traits.mark === 'arrow') style['transform'] = 'rotate(45deg)';
  return { shape: `${traits.mark}|${traits.stroke}|${traits.outline ? 'outline' : 'solid'}`, style };
}

/**
 * 渲染角色图例（零 svg / 零 circle，见文件头）。
 *
 * `roleStats` 是可选读数：带上时在每个形状后显示"图里有几个"，用户据此判断
 * "这个角色值不值得找"（0 个的角色搜下去是白搜）。
 *
 * cycle-100：图例升级为**可点选的角色筛选**（第四维 FilterState.roles）——
 * 「找出所有汇聚点/孤立节点」此前在图上无解（角色只进图例说明不进筛选）。
 * 交互裁决：
 * - 每档是 `<button aria-pressed>`（动作语义：点一下只看该角色，再点取消）；
 * - `onToggleRole` 缺省时退化为纯展示 + `aria-hidden`（旧形态，零行为变化）；
 * - 激活档带 `data-anic-graph-role-filter-active`（契约/测试读这个，不解析样式）；
 * - 0 计数的档仍可点但 `disabled`？——不：disabled 会让"hub 恰好没了"这件事
 *   从可筛选变成不可发现（与 chip 带计数同一理由），保持可点，点了全淡。
 */
export function renderRoleLegend(
  stats?: { entry: number; orphan: number; leaf: number; hub: number },
  activeRoles?: readonly string[],
  onToggleRole?: (role: 'entry' | 'hub' | 'leaf' | 'orphan') => void,
): ReactElement {
  const interactive = onToggleRole !== undefined;
  return createElement(
    'span',
    {
      key: 'role-legend',
      'data-anic-graph-role-legend': 'true',
      // 交互形态下容器是控件组（不再是说明）——AT 需要逐档播报按钮与按压态；
      // 纯展示形态维持 aria-hidden（零行为变化）。
      'aria-hidden': interactive ? undefined : 'true',
      // 标题复用既有键 `graph.nodeRoleLabel`（"节点角色"）—— 图例标题是同一句话，
      // 没有理由为它新增一个同义键（死键守卫按前缀认领，键越少越省）。
      title: t('graph.nodeRoleLabel'),
      style: {
        display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 10, opacity: 0.85,
      },
    },
    ...LEGEND_ROLES.map((role) => {
      const spec = roleLegendStyleOf(role);
      const active = activeRoles?.includes(role) === true;
      const itemAttrs: Record<string, unknown> = {
        key: `role-legend-${role}`,
        'data-anic-graph-role-legend-item': role,
        // 形状档进 DOM：契约断言"四档两两不同"，不必去解析 CSS。
        'data-anic-graph-role-legend-shape': spec.shape,
      };
      if (interactive) {
        itemAttrs['type'] = 'button';
        itemAttrs['aria-pressed'] = active ? 'true' : 'false';
        itemAttrs['aria-label'] = `${roleLabel(role)}${stats ? ` (${String(stats[role])})` : ''}`;
        itemAttrs['data-anic-graph-role-filter-active'] = active ? 'true' : 'false';
        itemAttrs['onClick'] = (): void => onToggleRole?.(role);
        itemAttrs['style'] = {
          display: 'inline-flex', alignItems: 'center', gap: 3,
          cursor: 'pointer', font: 'inherit', color: 'inherit',
          border: 'none', padding: '1px 3px', borderRadius: 3,
          // 激活档强调：不靠颜色单独表达（底色 + 边框双通道，灰度可辨）。
          background: active ? 'color-mix(in srgb, currentColor 14%, transparent)' : 'transparent',
          boxShadow: active ? 'inset 0 0 0 1px currentColor' : 'none',
        };
      } else {
        itemAttrs['style'] = { display: 'inline-flex', alignItems: 'center', gap: 3 };
      }
      return createElement(
        interactive ? 'button' : 'span',
        itemAttrs,
        createElement('span', {
          key: 'mark',
          'data-anic-graph-role-legend-mark': spec.shape,
          style: spec.style,
        }),
        createElement('span', { key: 'label' }, roleLabel(role)),
        stats === undefined
          ? null
          : createElement('span', {
              key: 'count',
              'data-anic-graph-role-legend-count': String(stats[role]),
              style: { opacity: 0.7, fontVariantNumeric: 'tabular-nums' },
            }, String(stats[role])),
      );
    }),
  );
}

/** 角色名的可见文案（嵌套键族 `graph.nodeRole.<role>`，WS-D 已合并）。 */
function roleLabel(role: NodeRole): string {
  if (role === null) return '';
  return t('graph.nodeRole.' + role);
}
