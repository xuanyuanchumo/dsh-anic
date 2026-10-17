/**
 * 语义色调 tone 查表 + 数据行原语（B4 组件整合）。
 *
 * 提取动机（ui-domain-plan §2.2）：五个特性域各自维护一份
 * 「状态字符串 → 语义色」映射（renderDiagnostics 的 ok?pass:fail 三元、
 * renderOrgStatus 的 scoreColor/bandColor、renderFlows 的 stateColor、
 * renderInvocations 的 statusColor、renderStepTrace 的 STATUS_COLORS 表）。
 * 阈值/枚举判定留在各域（那是业务），但**判定结果到令牌的最后一跳**
 * 收敛到本表—— ToneName 是编译期封闭集合，拼错过不了 typecheck，
 * 且暗色主题覆盖只需令牌层一处生效。
 *
 * 行级原语 DataRow：diagnostics / stepTrace 等分区的 flex 基线行形状
 * （display:flex + gap + baseline + 字号）在此统一，锚点与字段仍由调用方给。
 */
import { createElement, type CSSProperties, type ReactElement } from 'react';
import { token } from '../../shared/tokens.ts';

/** 语义色调（键即语义角色；值一律经 token() 带同源 fallback）。 */
export type ToneName =
  | 'pass' | 'fail' | 'doubt' | 'warn'
  | 'ok' | 'bad' | 'ledger'
  | 'text' | 'strong' | 'dim' | 'faint'
  | 'active' | 'done' | 'failed' | 'skipped' | 'pending';

const TONE_TOKEN: Record<ToneName, Parameters<typeof token>[0]> = {
  pass: 'anic-pass',
  fail: 'anic-fail',
  doubt: 'anic-doubt',
  warn: 'anic-warn-text',
  ok: 'anic-ok-text',
  bad: 'anic-bad-text',
  ledger: 'anic-ledger-text',
  text: 'anic-text',
  strong: 'anic-text-strong',
  dim: 'anic-text-dim',
  faint: 'anic-text-faint',
  active: 'anic-status-active',
  done: 'anic-status-done',
  failed: 'anic-status-failed',
  skipped: 'anic-status-skipped',
  pending: 'anic-status-pending',
};

/** tone → 令牌引用表达式（组件内联 style 的唯一取色通道）。 */
export function toneColor(tone: ToneName): string {
  return token(TONE_TOKEN[tone]);
}

/** 数据行公共形状（diagnostics/stepTrace 的 flex 基线行）。 */
const ROW_BASE: CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'baseline',
};

export interface DataRowProps {
  /** React key（列表内唯一）。 */
  key?: string;
  /** DOM 锚点（data-* 测试定位），如 'data-anic-probe'。 */
  anchorKey?: string;
  anchor?: string;
  /** 行内主字段色（默认正文色）。 */
  tone?: ToneName;
  /** 行级附加样式（fontSize/padding 等，域特有的部分）。 */
  style?: CSSProperties;
  children: ReactElement[];
}

/** flex 基线数据行：锚点 + tone + 域特有样式的组合点。 */
export function DataRow({ key, anchorKey, anchor, tone, style, children }: DataRowProps): ReactElement {
  return createElement(
    'div',
    {
      ...(key !== undefined ? { key } : {}),
      ...(anchorKey !== undefined && anchor !== undefined ? { [anchorKey]: anchor } : {}),
      style: { ...ROW_BASE, color: toneColor(tone ?? 'text'), ...style },
    },
    ...children,
  );
}
