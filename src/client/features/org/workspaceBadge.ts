/**
 * 工作区徽标（cycle-95 WS-D）—— 面板上「你现在看的是哪个项目」的**唯一可见出口**。
 *
 * ## 被守卫的缺口（实测，非推断）
 *
 * 多项目隔离在**数据层**已有三道防线（`components/workspaceGuard.ts`：载荷守卫 /
 * 在途丢弃 / 分键视图态），但**视觉层零提示**：
 *
 * 1. `WorkflowGraphPanel.ts` 学得 `X-ANIC-Workspace` 并回带请求头，却从不显示工作区名
 *    —— 用户看到的只是"某个项目的面板"。
 * 2. `UNKNOWN_WORKSPACE_KEY`（`__unknown__`）在 UI 上没有呈现：宿主还没解析出工作区时，
 *    面板照样渲染成"某个正常项目"，**未知态不可见**。
 * 3. 跨项目历史（`crossProjectHistory`）已由 `GET /anic/self/status` 返回，但面板只画
 *    自举状态本身 —— "这份历史混了别的项目"在界面上查不到。数据没串味，但用户
 *    **无法确认没串味**——这正是用户点名的「不能污染」在可观测性上的漏洞。
 *
 * ## 为什么落在 org 域而非图区
 *
 * G-FEAT 禁止跨特性深 import（`tests/contract/guardRegistry.test.ts`）：纯函数若放图区、
 * 徽标放 org，两边必须 import 彼此 —— 直接违规。单一文件放 org 域，图区侧零耦合；
 * 且 `features/graph/` 除 `graphBreadcrumb.ts` 外都由并行工作流占用（本任务边界）。
 * 本文件自带「纯函数 + 可渲染元素 + store 绑定组件」，装配层只需一行（见文件尾）。
 *
 * ## 数据从既有响应来（不新增路由）
 *
 * 工作区根**已经**在 `GET /anic/api/config` 的响应里（`ConfigJson.workspace`，4s 档）；
 * 跨项目历史来自既有 `GET /anic/self/status`（`panelState.bootstrap` 切片）。
 * 两者都在 store 里，本模块只**读**、只**投影**（`objectiveConformanceContract` ⑧ 钉死路由数）。
 *
 * ## 纪律
 *
 * - **UI 不显示绝对路径**（信息泄露 + 太长）：只显示末两段（`Projects/dsh-anic`）。
 *   完整归一化路径只以 `data-anic-workspace-key` 锚点形式存在，供测试/工具做跨视图
 *   身份比对，**永不进可见文案**。
 * - 全部用户面文案经 `wsText()`（`t('workspace.' + suffix)`）——前缀形态让词表在
 *   合并前后都不产生幽灵消费/死键（理由与 `graph/graphText.ts` 头注同源）。
 * - 纯函数零 DOM / 零 clock：四种边界（未知 / Windows / POSIX / 超长）都能单测。
 */
import { createElement, memo, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import { usePanelSlice } from '../../components/panelStore.ts';
import { UNKNOWN_WORKSPACE_KEY, workspaceKeyOf } from '../../components/workspaceGuard.ts';
import type { PanelDataStore, PanelState } from '../../panelState.ts';

/** 本域词表键的短名联合（编译期防拼错，与 `GraphTextSuffix` 同一手法）。 */
export type WorkspaceTextSuffix =
  | 'badge' | 'badgeAria' | 'unknown'
  | 'crossProject' | 'crossProjectLine' | 'crossProjectCount';

/** 取一条徽标文案（唯一入口；前缀形态见文件头「纪律」）。 */
export function wsText(suffix: WorkspaceTextSuffix, params?: Record<string, string | number>): string {
  return t('workspace.' + suffix, params);
}

/** 标签长度上限（超过就中间省略）。40 是两个中文项目名并排时面板宽度的经验值。 */
const LABEL_MAX = 40;
/** 省略时保留的首尾长度（驱动盘根 + 项目尾名必须还在，否则标签不可辨认）。 */
const LABEL_KEEP = 18;
/** 中间省略符（U+2026）——不用三点 ASCII，后者在等宽字体里占 3 字宽。 */
const ELLIPSIS = '\u2026';

/**
 * 路径 → 分段（保留 Windows 盘符为**首段**，这样 `D:/Proj` 仍有两段可显示）。
 *
 * 只做"切段"，**不**做大小写归一：归一属于身份判定（`workspaceKeyOf`），
 * 而这里是**显示**——把小写化的路径贴到界面上会让用户认不出自己的项目。
 */
function segmentsOf(path: string): string[] {
  const unified = path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return unified === '' ? [] : unified.split('/');
}

/** 中间省略（保留首尾，长度不超过 LABEL_MAX）。 */
function ellipsizeMiddle(text: string): string {
  if (text.length <= LABEL_MAX) return text;
  const keep = LABEL_KEEP < text.length / 2 ? LABEL_KEEP : Math.floor((LABEL_MAX - 1) / 2);
  return text.slice(0, keep) + ELLIPSIS + text.slice(text.length - keep);
}

/**
 * 工作区路径 → 可见标签（**纯函数**，四种边界都有定义）：
 * ① null / undefined / 空白 → `未识别项目`（**绝不返回空串**——空串会被读成"没有这回事"）；
 * ② Windows 路径（含盘符）→ 末两段，`/` 分隔（`D:/Projects/dsh-anic` → `Projects/dsh-anic`）；
 * ③ POSIX 路径 → 末两段（`/home/user/proj` → `user/proj`）；
 * ④ 超过 40 字符 → 中间省略（首尾各 18）。
 *
 * 盘符**不算一段**：`D:/A` 的末两段若照字面取会得到 `D:/A` —— 把盘符贴到界面上等于
 * 半个绝对路径（且 `D:/A` 与 `d:/A` 在视觉上是两个项目）。所以先剔除盘符段再取末两段；
 * 只剩盘符时（`D:` 这种整盘路径）如实显示盘符本身（它是一个位置，不是一条路径）。
 */
export function workspaceLabelOf(path: string | null | undefined): string {
  if (typeof path !== 'string' || path.trim() === '') return wsText('unknown');
  const all = segmentsOf(path.trim());
  if (all.length === 0) return wsText('unknown');
  const drive = /^[A-Za-z]:$/.test(all[0] as string) ? (all[0] as string) : null;
  const segs = drive === null ? all : all.slice(1);
  if (segs.length === 0) return drive as string;
  const tail = segs.length === 1 ? (segs[0] as string) : (segs.slice(-2).join('/'));
  return ellipsizeMiddle(tail);
}

/** 徽标投影：可见标签 + 身份键 + 未知态标记（三者**必须同源**，不得各算一份）。 */
export interface WorkspaceBadge {  label: string;
  key: string;
  unknown: boolean;
}

/**
 * 徽标投影（纯函数）。
 *
 * `key` 用 `workspaceKeyOf`（**归一后**的身份键，与载荷守卫同一个函数）：两处若各算
 * 一份，"同一项目两种路径形态"会在徽标与守卫里得到不同身份 —— 视图抖动 + 隔离失效。
 */
export function workspaceBadgeOf(path: string | null | undefined): WorkspaceBadge {
  const label = workspaceLabelOf(path);
  const key = workspaceKeyOf(path);
  return { label, key, unknown: key === UNKNOWN_WORKSPACE_KEY };
}

/**
 * 跨项目态投影（纯函数）。输入是 `GET /anic/self/status` 的响应
 * （`panelState.bootstrap` 切片的窄化形态）；该响应由 `loadBootstrapState` 原样透传
 * 扩展字段（见 `host/selfBootstrap.ts` 的「保留扩展字段」注释），所以
 * `crossProjectHistory` 在**旧宿主**上缺省、在新宿主上是数组 —— 两种形态都必须给出
 * 确定结论，不许崩、不许伪造。
 *
 * 语义边界（防被读成"最近一次跨项目调用失败了"）：
 * - `present=true` 只表示「本工作区曾对别的项目发起过跨项目调用」，**不表示**成功；
 * - `target` 取**最后一条带工作区的记录**（追加序即时间序；不另读 timestamp ——
 *   旧记录的时间戳可能是坏串，按数组序取末条才稳定）；
 * - 空数组 / 字段缺失 / 形状畸形 → `present=false`（无跨项目态，不留空壳）。
 */
export interface CrossProjectView {
  present: boolean;
  count: number;
  /** 目标项目（原始路径；渲染时再经 `workspaceLabelOf` 变末两段）。 */
  target: string | null;
  /** 目标项目标签（已裁成末两段；null = 无目标）。 */
  targetLabel: string | null;
}

/** 读跨项目态（判据见 `CrossProjectView` 的语义边界）。 */
export function crossProjectViewOf(bootstrap: unknown): CrossProjectView {
  const empty: CrossProjectView = { present: false, count: 0, target: null, targetLabel: null };
  if (typeof bootstrap !== 'object' || bootstrap === null || Array.isArray(bootstrap)) return empty;
  const raw = (bootstrap as Record<string, unknown>)['crossProjectHistory'];
  if (!Array.isArray(raw) || raw.length === 0) return empty;
  let target: string | null = null;
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const entry = raw[i];
    if (typeof entry !== 'object' || entry === null) continue;
    const ws = (entry as Record<string, unknown>)['workspace'];
    if (typeof ws === 'string' && ws.trim() !== '') { target = ws.trim(); break; }
  }
  return {
    present: true,
    count: raw.length,
    target,
    targetLabel: target === null ? null : workspaceLabelOf(target),
  };
}

/** 徽标渲染输入。`bootstrap` 可选：不传 = 不显示跨项目段（未接线形态，零占位）。 */
export interface WorkspaceBadgeInput {
  workspace: string | null | undefined;
  bootstrap?: unknown;
}

const BADGE_BOX = {
  display: 'flex', flexWrap: 'wrap' as const, alignItems: 'baseline', gap: '2px 8px',
  fontSize: 10, padding: '0 8px 4px', color: token('anic-text-faint'),
} as const;

/**
 * 渲染工作区徽标。
 *
 * 锚点契约（契约测试/真机旅程据此定位；属性名是对外契约，改名即断测量）：
 * - `data-anic-workspace-badge`：容器存在；
 * - `data-anic-workspace-key`：归一化身份键（**不是**给用户看的路径，见文件头纪律）；
 * - `data-anic-workspace-unknown`：`'true'` 时表示"未识别项目"；
 * - `data-anic-workspace-cross` / `data-anic-cross-target` / `data-anic-cross-count`：
 *   跨项目段（仅当存在跨项目历史）。
 *
 * `aria-label` 给容器一个可访问名：徽标是"状态说明"而不是控件，不占 Tab 焦点；
 * 没有可访问名时读屏只会念出 `项目 · 名字` 一片碎片，听不出它是在说工作区。
 */export function renderWorkspaceBadge(input: WorkspaceBadgeInput): ReactElement {
  const badge = workspaceBadgeOf(input.workspace);
  const cross = crossProjectViewOf(input.bootstrap);
  return createElement(
    'div',
    {
      'data-anic-workspace-badge': 'true',
      'data-anic-workspace-key': badge.key,
      ...(badge.unknown ? { 'data-anic-workspace-unknown': 'true' } : {}),
      role: 'note',
      'aria-label': wsText('badgeAria', { label: badge.label }),
      style: BADGE_BOX,
    },
    createElement(
      'span',
      {
        'data-anic-workspace-label': 'true',
        // 未知态用警示色：它等价于"你现在看的东西归属不明"，比任何项目名都重要。
        style: { color: badge.unknown ? token('anic-warn-text') : token('anic-text-dim'), fontWeight: badge.unknown ? 600 : 400 },
      },
      wsText('badge', { label: badge.label }),
    ),
    // 跨项目段：标记 + 源→目标 + 次数三件同屏。缺任一件读者都只能猜
    // "这条跨项目行说的是哪两个项目、一共几次"。
    cross.present
      ? createElement(
          'span',
          {
            'data-anic-workspace-cross': 'true',
            'data-anic-cross-target': cross.targetLabel ?? '',
            'data-anic-cross-count': String(cross.count),
            style: { color: token('anic-doubt'), fontWeight: 600 },
          },
          wsText('crossProject'),
          cross.targetLabel === null ? '' : wsText('crossProjectLine', { source: badge.label, target: cross.targetLabel }),
          wsText('crossProjectCount', { count: cross.count }),
        )
      : null,
  );
}

const selConfig = (s: PanelState) => s.config;
const selBootstrap = (s: PanelState) => s.bootstrap;

interface WorkspaceBadgeProps { store: PanelDataStore }

/**
 * store 绑定薄组件（**装配层唯一需要接的一行**）。
 *
 * 为什么不把订阅写进 `renderWorkspaceBadge`：纯渲染函数吃显式输入才能被单测
 * （四种路径边界 + 跨项目三态），而订阅属于装配职责。分成两层与
 * `GraphSection → GraphInteractive` 同款（薄订阅层 / 纯渲染层）。
 */
function WorkspaceBadgeImpl({ store }: WorkspaceBadgeProps): ReactElement {
  const config = usePanelSlice(store, selConfig);
  const bootstrap = usePanelSlice(store, selBootstrap);
  // 工作区在 `GET /anic/api/config` 的响应里；未拉到时 config 为 null
  // → 徽标如实显示「未识别项目」（**不**显示空白，也不猜一个路径）。
  return renderWorkspaceBadge({ workspace: config?.workspace ?? null, bootstrap });
}

/** 工作区徽标：订阅 config + bootstrap 两切片（只有这两切片变化才重渲）。 */
export const WorkspaceBadge = memo(WorkspaceBadgeImpl);
