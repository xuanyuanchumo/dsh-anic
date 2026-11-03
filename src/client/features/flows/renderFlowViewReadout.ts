/**
 * FlowTracker 有界视图读数条（cycle-101 · dsh-context 模式的面板消费端）。
 *
 * ## 为什么需要它
 *
 * `projectFlowTrackerView` 在 Host 侧产出了有界视图（字段白名单 + 保留钳制 +
 * dropped/floor 水位 + 状态分布），但**客户端零消费** —— 生产了不消费 = 白盒
 * 断链（objectiveConformance「注册·生产·消费」三元组的消费端缺失）。本文件
 * 是有界视图的消费端：把 `totalEver / kept / dropped / floor / 失败率 /
 * 平均时长` 六个读数直接上屏，让「我看到的是全部还是被裁过的窗口」一眼可判。
 *
 * ## 为什么是独立文件而不是塞进 renderFlows
 *
 * renderFlows 消费 HTTP 流程注册表面（GET /anic/flows/status）；本文件消费的是
 * 有界视图端点（GET /anic/api/flows/view）。两条链失败通道独立（与 cycle-89
 * 两失败通道同纪律），合文件会让一次失败被另一次的成功抹掉，且 renderFlows
 * 已接近 T3 上限。
 *
 * ## 纯函数范式
 *
 * 不持状态、不发请求、不读时钟 —— 数据由面板统一 fetch 后经 props 注入。
 * 样式纪律：**颜色走 token()，尺寸用字面数字**（仓内既有约定，见
 * renderLifecycleMetrics 的 `fontSize: 10` + `token('anic-warn-text')`）。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';

/** Host 侧 FlowTrackerView 的客户端镜像（与 src/host/flowTrackerProjection.ts 对齐）。 */
export interface FlowViewJson {
  stateVersion: number;
  totalEver: number;
  totalRecords: number;
  kept: number;
  dropped: number;
  floorStartedAt: string | null;
  head: Array<{
    flowId: string;
    script: string;
    status: string;
    exitCode: number | null;
    durationMs: number | null;
    cycle: string | null;
    phase: string | null;
    gate: string | null;
  }>;
  stats: Record<string, { total: number; done: number; failed: number; timeout: number; successRate: number }>;
}

/** 状态分布读数（Host projectStatusDistribution 的客户端镜像）。 */
export interface FlowDistributionJson {
  byStatus: Record<string, number>;
  failureRate: number;
  avgDurationMs: number;
}

/** 读数徽章（标签 + 值 + 语义色）。 */
function readoutBadge(label: string, value: string, color: string, testId: string): ReactElement {
  return createElement(
    'span',
    {
      key: testId,
      'data-anic-flow-readout': testId,
      style: {
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 4,
        padding: '1px 6px',
        borderRadius: 4,
        border: `1px solid ${token('anic-border')}`,
        fontSize: 11,
        whiteSpace: 'nowrap',
      },
    },
    createElement('span', { style: { opacity: 0.7 } }, label),
    createElement('strong', { style: { color } }, value),
  );
}

/** 百分比格式化（0.9234 → "92.3%"；NaN/越界归一，绝不输出 "NaN%"）。 */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  const clamped = Math.max(0, Math.min(1, rate));
  return `${(clamped * 100).toFixed(1)}%`;
}

/** 时长格式化（毫秒 → "1.2s" / "840ms"；负数与非有限值归一）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** 状态 → 语义色（失败/超时红、完成绿、其余次要）。 */
function statusColor(status: string): string {
  if (status === 'FAILED' || status === 'TIMEOUT') return token('anic-gate-fail');
  if (status === 'DONE') return token('anic-gate-pass');
  return token('anic-text-faint');
}

/**
 * 渲染读数条。view 缺失（未装/无 .cycles）时返回 null —— 不渲染空壳，
 * 由上层保留「无数据」语义（避免把「没有」画成「0」）。
 */
export function renderFlowViewReadout(
  view: FlowViewJson | null | undefined,
  dist: FlowDistributionJson | null | undefined,
): ReactElement | null {
  if (!view) return null;
  const badges: ReactElement[] = [
    // 总量：历史一共跑过多少次（不是窗口内条数——两者差 dropped）
    readoutBadge(t('flows.readout.total'), String(view.totalEver), token('anic-text-strong'), 'total'),
    readoutBadge(t('flows.readout.kept'), String(view.kept), token('anic-text-strong'), 'kept'),
  ];
  // 被裁条数：>0 才显示（0 时显示会让人误以为有东西被裁了）
  if (view.dropped > 0) {
    badges.push(readoutBadge(t('flows.readout.dropped'), String(view.dropped), token('anic-warn-text'), 'dropped'));
  }
  // floor 水位：被裁到哪儿（诚实读数，不是错误）
  if (view.floorStartedAt) {
    badges.push(readoutBadge(
      t('flows.readout.floor'),
      view.floorStartedAt.slice(0, 19).replace('T', ' '),
      token('anic-text-faint'),
      'floor',
    ));
  }
  if (dist) {
    badges.push(readoutBadge(
      t('flows.readout.failureRate'),
      formatRate(dist.failureRate),
      dist.failureRate > 0.2 ? token('anic-gate-fail') : token('anic-gate-pass'),
      'failureRate',
    ));
    badges.push(readoutBadge(t('flows.readout.avgDuration'), formatDuration(dist.avgDurationMs), token('anic-text-strong'), 'avgDuration'));
    // 状态分布（只显示出现过的状态，按计数降序——读者先看大头）
    for (const [status, count] of Object.entries(dist.byStatus).sort((a, b) => b[1] - a[1])) {
      badges.push(readoutBadge(status, String(count), statusColor(status), `status-${status}`));
    }
  }
  return createElement(
    'div',
    {
      'data-anic-flow-readout-bar': '1',
      role: 'group',
      'aria-label': t('flows.readout.ariaLabel'),
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        marginBottom: 6,
      },
    },
    ...badges,
  );
}
