/**
 * 闭环**流动可视化**（cycle-75 T4）——「注册 → 生产 → 消费」的流向数据与渲染。
 *
 * ## 为什么要有它（用户诉求的原话）
 *
 * 「同时要**白盒透明化、可视化流动**等可观测性」。cycle-75 之前面板只有**静止的矩阵**
 * （一堆计数 + 未消费清单），读者看得出「有多少缺口」，但看不出**缺口发生在哪一段**：
 * 是登记了没生产？还是生产了没人读？两者补救动作完全不同（补接线 vs 接消费方）。
 *
 * ## 诚实建模（关键设计，逐条对应宿主判据）
 *
 * 每族一条流，**两种形态**由数据自决，不硬编码族名：
 *
 *   `viaProduction`（该族有真产出锚点，produced > 0）
 *     registered ──► produced ──► consumed
 *           └─► notProduced        └─► producedNotConsumed
 *     其中 produced = total − declaration-only − no-write-point（与宿主 `isProduced` 同判据）
 *
 *   `directRead`（该族**没有独立写入点**，produced === 0，如实标注）
 *     registered ──► consumed      ← 词表键由 t() 纯查找：登记即可被读，不存在「生产」段
 *           └─► gap
 *
 * 恒等式：`notProduced + producedNotConsumed === registered − consumed`
 * —— 与宿主 `unconsumed` 同源，**流不能凭空造/吞缺口**（契约测试钉住）。
 *
 * ## 纪律
 *
 * - **数据驱动**：节点/边全部由输入派生，**不硬编码任何族名或 id 清单**（族会继续长）。
 * - **纯函数**：零副作用、零状态、零网络、零 React（渲染函数另导出，同为纯函数）。
 * - **空输入 ⇒ 显式空态**（`empty: true` + 渲染出可见空态），不是空白也不崩。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import type { ClosureClusterView, ClosureView } from './closureTypes.ts';

/** 流向节点阶段。 */
export type FlowStage = 'registered' | 'produced' | 'consumed' | 'notProduced' | 'producedNotConsumed';

/** 单族流向（计数全部取自投影，派生量写明来路）。 */
export interface ClusterFlow {
  cluster: string;
  unit: string;
  /**
   * `viaProduction`：该族有真产出锚点（produced > 0）；
   * `directRead`：该族无独立写入点（produced === 0，如词表 t() 纯查找）。
   */
  mode: 'viaProduction' | 'directRead';
  registered: number;
  produced: number;
  consumed: number;
  /** registered − produced（**仅 viaProduction 有意义**；directRead 恒 0——不存在生产段）。 */
  notProduced: number;
  /** produced − consumed（viaProduction）/ registered − consumed（directRead，直接读取无生产段）。 */
  producedNotConsumed: number;
  /** registered − consumed（**恒等式基准**，两种形态都成立）。 */
  gap: number;
}

export interface FlowNode {
  id: string;
  cluster: string;
  stage: FlowStage;
  count: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  count: number;
  /** 段语义（'ok' 正常推进 / 'gap' 缺口）；不给文案，文案由渲染层 t()。 */
  kind: 'ok' | 'gap';
}

export interface ClosureFlow {
  clusters: ClusterFlow[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** 消费证据分层（totals 级）：已消费里有多少是生产代码 / 计算键 / 仅通道。 */
  consumerTiers: { code: number; dynamicClaimed: number; channelOnly: number };
  /** 空输入（无族）——显式空态，不是空白。 */
  empty: boolean;
}

/** 该族的真产出锚点数：total − declaration-only − no-write-point（宿主 isProduced 同判据）。 */
function producedOf(c: ClosureClusterView): number {
  const byKind = c.producedByKind as Record<string, number | undefined>;
  const declOnly = byKind['declaration-only'] ?? 0;
  const noWritePoint = byKind['no-write-point'] ?? 0;
  const v = c.total - declOnly - noWritePoint;
  // 夹紧到 [0, total]：分类合计异常时不得造出负数或超过 total 的产出数。
  return Math.max(0, Math.min(c.total, v));
}

/**
 * 构建流向图（纯函数）。
 *
 * **不校验形状**——入参必须是已过 `isClosureView` 守卫的投影（数据腿的守门人职责
 * 在 usePanelFetch 的 guard）；本函数只做派生，避免第二套校验漂移。
 */
export function buildClosureFlow(view: ClosureView): ClosureFlow {
  const clusters: ClusterFlow[] = [];
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  for (const c of view.clusters) {
    const produced = producedOf(c);
    const mode: ClusterFlow['mode'] = produced > 0 ? 'viaProduction' : 'directRead';
    const gap = Math.max(0, c.total - c.consumed);
    // 恒等式的两种分解（**互斥且各自穷尽**）：
    //   viaProduction  gap = (total − produced) + (produced − consumed)
    //   directRead     gap = total − consumed        （无生产段，故 notProduced 恒 0）
    const notProduced = mode === 'viaProduction' ? Math.max(0, c.total - produced) : 0;
    const producedNotConsumed = mode === 'viaProduction'
      ? Math.max(0, produced - c.consumed)
      : gap;

    clusters.push({
      cluster: c.cluster, unit: c.unit, mode,
      registered: c.total, produced, consumed: c.consumed, notProduced, producedNotConsumed, gap,
    });

    const key = (stage: FlowStage): string => c.cluster + ':' + stage;
    nodes.push(
      { id: key('registered'), cluster: c.cluster, stage: 'registered', count: c.total },
      { id: key('consumed'), cluster: c.cluster, stage: 'consumed', count: c.consumed },
    );

    if (mode === 'viaProduction') {
      nodes.push(
        { id: key('produced'), cluster: c.cluster, stage: 'produced', count: produced },
        { id: key('notProduced'), cluster: c.cluster, stage: 'notProduced', count: notProduced },
        { id: key('producedNotConsumed'), cluster: c.cluster, stage: 'producedNotConsumed', count: producedNotConsumed },
      );
      edges.push(
        { from: key('registered'), to: key('produced'), count: produced, kind: 'ok' },
        { from: key('registered'), to: key('notProduced'), count: notProduced, kind: 'gap' },
        { from: key('produced'), to: key('consumed'), count: c.consumed, kind: 'ok' },
        { from: key('produced'), to: key('producedNotConsumed'), count: producedNotConsumed, kind: 'gap' },
      );
    } else {
      // directRead：登记即可被读，不存在「生产」段——**如实跳过**而不是编一个 0 产出节点。
      edges.push(
        { from: key('registered'), to: key('consumed'), count: c.consumed, kind: 'ok' },
        { from: key('registered'), to: key('producedNotConsumed'), count: gap, kind: 'gap' },
      );
    }
  }

  return {
    clusters, nodes, edges,
    consumerTiers: {
      code: view.totals.codeConsumed,
      dynamicClaimed: view.totals.dynamicClaimed,
      channelOnly: view.totals.channelOnly,
    },
    empty: clusters.length === 0,
  };
}

/** 族名（复用闭环分区的同一映射口径；未知族回落原 id——可见的漏翻，不是空白）。 */
const CLUSTER_LABEL_KEYS: Record<string, string> = {
  tools: 'closure.cluster.tools',
  i18n: 'closure.cluster.i18n',
  routes: 'closure.cluster.routes',
  skills: 'closure.cluster.skills',
};

function clusterLabel(cluster: string): string {
  const key = CLUSTER_LABEL_KEYS[cluster];
  return key !== undefined ? t(key) : cluster;
}

const ROW = { display: 'flex', flexWrap: 'wrap', gap: '2px 8px', alignItems: 'baseline', padding: '2px 10px', fontSize: 11 } as const;
const ARROW = ' → ';

/**
 * 渲染流向（纯函数）。
 *
 * 每族一行：`族 | 注册 N → 生产 M → 消费 K`，缺口段用警示色单独标出（**缺口必须可见**）。
 * `directRead` 族显式渲染「无写入点·直接读取」，不伪造生产段。
 */
export function renderClosureFlow(flow: ClosureFlow): ReactElement {
  if (flow.empty) {
    return createElement('div', { 'data-anic-flow-empty': 'true', style: { ...ROW, color: token('anic-text-dim') } },
      t('closure.flow.empty'));
  }
  const rows = flow.clusters.map((f) => {
    const head = createElement('span', { style: { color: token('anic-warn-text'), fontWeight: 600, minWidth: 52 } }, clusterLabel(f.cluster));
    if (f.mode === 'directRead') {
      return createElement('div', { key: f.cluster, 'data-anic-flow-cluster': f.cluster, 'data-anic-flow-mode': f.mode, style: { ...ROW, color: token('anic-text') } },
        head,
        createElement('span', {}, t('closure.flow.registered', { n: String(f.registered) }) + ARROW + t('closure.flow.consumed', { n: String(f.consumed) })),
        createElement('span', { 'data-anic-flow-direct': 'true', style: { color: token('anic-text-faint') } }, t('closure.flow.noWritePoint')),
        f.gap > 0
          ? createElement('span', { 'data-anic-flow-gap': String(f.gap), style: { color: token('anic-fail'), fontWeight: 600 } }, t('closure.flow.gapUnread', { n: String(f.gap) }))
          : null,
      );
    }
    return createElement('div', { key: f.cluster, 'data-anic-flow-cluster': f.cluster, 'data-anic-flow-mode': f.mode, style: { ...ROW, color: token('anic-text') } },
      head,
      createElement('span', { 'data-anic-flow-registered': String(f.registered) }, t('closure.flow.registered', { n: String(f.registered) })),
      createElement('span', { 'data-anic-flow-produced': String(f.produced) }, '→ ' + t('closure.flow.produced', { n: String(f.produced) })),
      createElement('span', { 'data-anic-flow-consumed': String(f.consumed), style: { color: token('anic-pass') } }, '→ ' + t('closure.flow.consumed', { n: String(f.consumed) })),
      f.notProduced > 0
        ? createElement('span', { 'data-anic-flow-notproduced': String(f.notProduced), style: { color: token('anic-doubt') } }, t('closure.flow.notProduced', { n: String(f.notProduced) }))
        : null,
      f.producedNotConsumed > 0
        ? createElement('span', { 'data-anic-flow-unread': String(f.producedNotConsumed), style: { color: token('anic-fail'), fontWeight: 600 } }, t('closure.flow.producedNotConsumed', { n: String(f.producedNotConsumed) }))
        : null,
    );
  });

  const tiers = createElement('div', { 'data-anic-flow-tiers': 'true', style: { ...ROW, color: token('anic-text-dim') } },
    createElement('span', { style: { color: token('anic-text-faint') } }, t('closure.flow.tiersTitle')),
    createElement('span', { 'data-anic-flow-tier': 'code' }, t('closure.flow.tierCode', { n: String(flow.consumerTiers.code) })),
    createElement('span', { 'data-anic-flow-tier': 'dynamicClaimed' }, t('closure.flow.tierDynamic', { n: String(flow.consumerTiers.dynamicClaimed) })),
    createElement('span', { 'data-anic-flow-tier': 'channelOnly' }, t('closure.flow.tierChannel', { n: String(flow.consumerTiers.channelOnly) })),
  );

  return createElement('div', { 'data-anic-closure-flow': 'true', style: { padding: '2px 0 6px' } },
    createElement('div', { style: { ...ROW, fontWeight: 600, color: token('anic-text-strong') } }, t('closure.flow.title')),
    ...rows,
    tiers,
  );
}
