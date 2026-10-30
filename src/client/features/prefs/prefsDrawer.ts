/**
 * ⚙ 配置抽屉（C1 域，docs/anic/11 §C 的 M1 客户端切片）。
 *
 * 三层开关的用户层落点：读/写**用户层**（localStorage PREFS_KEY，client 集成层
 * 负责——shared/flows.ts 不接触 DOM）。工作区层（config.yml anic 段）与部署层
 * （bundle config）由宿主经 resolveFlows 合并；抽屉展示合并后的生效值与来源层
 * （INV-30：全部开关状态可观测）。开关 hover 显示关闭形态契约（degradation）。
 */
import { createElement, type ReactElement } from 'react';
import { FLOWS, PREFS_KEY, isUserWritable, parseRawPrefs, resolveFlows, type FlowLayer } from '../../../shared/flows.ts';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

export interface FlowOverrideInput {
  /** 工作区层（host/config.ts 的 anic 段解析结果，键 = 'flow.xxx'） */
  workspace?: Record<string, unknown>;
  /** 部署层（bundle config 注入，M2-a 槽位；M1 常为空） */
  deployment?: Record<string, unknown>;
}

function readUserPrefsRaw(): Record<string, unknown> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null;
    return parseRawPrefs(raw).prefs.flows;
  } catch {
    return {};
  }
}

/** 用户层读取（面板/集成分区门控共用；storage 不可用 = 无偏好，走默认）。 */
export function readPrefsRaw(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null;
  } catch {
    return null;
  }
}

/** 用户层写入（客户端唯一写入口；读取端 parseRawPrefs fail-safe 兜底）。 */
export function writeUserPrefs(flows: Record<string, boolean>): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ version: 1, flows }));
  } catch { /* 隐私模式写失败：下次读取回默认（诚实降级，不报错打扰） */ }
}

/** 来源层标签（经 t()，i18n 单点）。 */
function sourceLabelOf(layer: FlowLayer | null): string {
  if (layer === 'user') return t('prefs.sourceUser');
  if (layer === 'workspace') return t('prefs.sourceWorkspace');
  if (layer === 'deployment') return t('prefs.sourceDeployment');
  return t('prefs.sourceDefault');
}

/**
 * 抽屉容器 id 的**基础名**（B5.1 修因：多实例碰撞）。
 *
 * 历史形态是固定字符串 'anic-prefs-drawer'：同一页面挂两个 ANIC 面板实例时，
 * 两个抽屉容器同 id，工具栏的 `aria-controls` 只能解析到其一——AT 读出的
 * 关联**静默错位**，没有任何报错。
 *
 * 现改为「基础名 + 面板实例序号」：调用方（WorkflowGraphPanel）同步生成实例
 * 唯一 id 传入，抽屉渲染器只消费。为什么不用 React 的 useId()：offline-smoke
 * 的 stub React 只提供 useState/useRef/useCallback/useEffect（scripts 层的
 * 宿主契约），useId 会让 smoke 的函数组件展开直接 TypeError。useRef 惰性
 * 初始化在首渲染同步求值，与 useId 同样满足「实例唯一、同源两用」：
 * 同一个 id 值同时写进 aria-controls（工具栏）与容器 id（抽屉）。
 */
export const PREFS_PANEL_ID_BASE = 'anic-prefs-drawer';

/** 实例 id：基础名 + 面板实例序号（面板组件首渲染时生成一次）。 */
export function prefsPanelIdOf(instanceSeq: number): string {
  return `${PREFS_PANEL_ID_BASE}-${String(instanceSeq)}`;
}

/** 纯渲染 + 回调：抽屉（smoke 可断言 data-anic-prefs 抽屉结构）。panelId 由面板实例生成（B5.1）。 */
export function renderPrefsDrawer(input: FlowOverrideInput, onChange: (flows: Record<string, boolean>) => void, panelId: string): ReactElement {
  const user = readUserPrefsRaw();
  const resolved = resolveFlows({ user, workspace: input.workspace, deployment: input.deployment });

  const rows = FLOWS.map((f) => {
    const state = resolved.flows[f.id] ?? { enabled: true, source: null as FlowLayer | null };
    const sourceLabel = sourceLabelOf(state.source);
    // cycle-90：该开关是否支持**用户层**写入（`layers` 不含 'user' ⇒ 不可写）。
    //
    // 实测反例：`flow.selfInit` 的 layers 是 workspace/deployment，但此前 checkbox
    // **可点**且点击会写进用户层 —— 而用户层写入本应被拒（`resolveFlows` 已修）。
    // 于是用户点一下、界面变了、而真相没变 ——「面板在骗人」。
    //
    // 现在：不可写 ⇒ checkbox **禁用** + title 换成专门文案（`panel.selfInitOffTitle`）。
    // 该文案说明「为什么不能点」（只支持工作区/部署层），而不只是「禁用」。
    const writable = isUserWritable(f.id);
    const title = writable ? f.degradation : t('panel.selfInitOffTitle');
    return createElement(
      'label',
      { key: f.id, 'data-anic-flow-row': f.id, 'data-anic-flow-writable': writable ? 'true' : 'false', style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '3px 0', cursor: writable ? 'pointer' : 'default' }, title },
      createElement('input', {
        type: 'checkbox',
        'data-anic-flow-toggle': f.id,
        checked: state.enabled,
        disabled: !writable,
        // cycle-41（a11y 收紧）：包裹 label 已提供可达名（既有模式正确）；
        // 显式 aria-label 让名字不依赖 label 包裹结构的解析——自动化检测器
        // （不解析 label 关联的那类）与未来 DOM 重构都稳妥。
        'aria-label': t(f.labelKey),
        onChange: () => {
          // 双保险：即便 UI 层被绕过（自动化/脚本直接写 prefs），
          // 也不把不可写开关的改动写进用户层。resolveFlows 侧同样会拒（fail-closed）。
          if (!writable) return;
          const next: Record<string, boolean> = { ...user, [f.id]: !state.enabled } as Record<string, boolean>;
          writeUserPrefs(next);
          onChange(next);
        },
      }),
      createElement('span', { style: { flex: 1, color: token('anic-text'), opacity: writable ? 1 : 0.6 } }, t(f.labelKey)),
      // 不可写开关的**说明行**（`panel.selfInitOff`）：告诉用户「它已按某层关闭 /
      // 你不能在这里改」，而不是只留一个灰掉的 checkbox（那读起来像 bug）。
      writable
        ? null
        : createElement(
          'span',
          { 'data-anic-flow-off-note': f.id, style: { fontSize: 10, color: token('anic-text-faint') } },
          t('panel.selfInitOff'),
        ),
      createElement('span', { style: { fontSize: 10, color: token('anic-text-faint') } }, t('prefs.sourceLine', { source: sourceLabel, layers: f.layers.join('/') })),
    );
  });

  return createElement(
    'div',
    {
      'data-anic-prefs': 'drawer',
      id: panelId,
      // role="region" + aria-label：抽屉是一块有名字的地标，AT 可直接跳入。
      // 它不是 modal（不做焦点陷阱、不遮挡主体），因此不用 role="dialog"/
      // aria-modal —— 那会谎报"模式化"，让 AT 以为外部内容 inert。
      role: 'region',
      'aria-label': t('prefs.ariaLabel'),
      style: { padding: '8px 10px', borderTop: `1px solid ${token('anic-border')}`, background: token('anic-surface') },
    },
    createElement('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4, color: token('anic-text') } }, t('prefs.title')),
    ...rows,
    resolved.warnings.length > 0
      ? createElement('div', { 'data-anic-flow-warnings': 'true', style: { fontSize: 10, color: token('anic-warn-text'), marginTop: 6 } },
          t('prefs.warnings', { count: String(resolved.warnings.length) }))
      : null,
    createElement('div', { style: { fontSize: 10, color: token('anic-text-faint'), marginTop: 6 } },
      t('prefs.hint')),
  );
}
