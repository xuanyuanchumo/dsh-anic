/**
 * 健康度分段条（cycle-95 · 从 `graphNodeCard.ts` 拆出）。
 *
 * ## 为什么拆出来（不是"为了行数"）
 *
 * 拆分诱因确实是行数：`graphNodeCard.ts` 加入角色/深度渲染后到 289 行
 * （T3 机械守卫上限 250）。但边界选择是**职责**：卡片文件回答"一张卡片由哪几个
 * 元素组成"，本文件回答"健康度那一条怎么画"。健康度会随 testReport 口径演变，
 * 卡片几何几乎不动——两个变更原因不同的域混在一处，每次调健康度都要翻几何代码。
 *
 * ## 硬约束：只能用 `<rect>` 分段，不许用比例环
 *
 * 环需要第二个 `<circle>`，而「每节点恰好一个 circle」是 smoke 钉死的不变量
 * ⇒ 环会直接破它。`<rect>` 分段保留了"比例可读"且零不变量风险。
 *
 * ## 三态配色（passed / failures / errors）
 *
 * errors 走 `anic-warn-text` 而不是红：**跑挂了**与**断言失败**是不同的原因
 * （前者是环境/超时，后者是产品缺陷）。都涂红会让"我要修代码还是修环境"
 * 这个判断丢失。颜色之外还有 `data-anic-node-health` 三态锚点，AT 与断言都读得到。
 *
 * ## 纯函数（零 hook / 零 DOM）
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { BAR_INSET } from './graphNodeStyle.ts';

/** 健康度分段（与 `graphHealth.healthSegments` 的产出同形）。 */
export type HealthSegKind = 'passed' | 'failures' | 'errors';

/** 分段条高度（1.6px：更细在缩放后就消失）。 */
export const HEALTH_BAR_H = 1.6;

/**
 * 渲染健康度分段条。
 *
 * @param segs 已过滤的分段（空数组 ⇒ 返回空数组，调用方可直接展开）
 * @param cardW 卡片宽（世界坐标）
 * @param cardH 卡片高
 */
export function renderHealthBar(
  segs: readonly { kind: HealthSegKind; ratio: number }[],
  cardW: number,
  cardH: number,
): ReactElement[] {
  if (segs.length === 0) return [];
  /** 可用宽度：两侧各留 BAR_INSET（贴满会在圆角处露尖）。 */
  const usable = Math.max(0, cardW - BAR_INSET * 2);
  /** 逐段起点累加（世界坐标，卡片左缘 = 0）——一次遍历，不再用 slice+reduce 的 O(n²)。 */
  let acc = 0;
  return segs.map((seg, i) => {
    const segW = seg.ratio * usable;
    const segX = BAR_INSET + acc;
    acc += segW;
    return createElement('rect', {
      key: `health-${String(i)}`,
      'data-anic-node-health': seg.kind,
      x: segX,
      // 贴卡片底缘内侧（y 向上偏移一个条高）。
      y: cardH / 2 - BAR_INSET - HEALTH_BAR_H,
      width: Math.max(0.5, segW),
      height: HEALTH_BAR_H,
      fill: seg.kind === 'passed'
        ? token('anic-pass')
        : seg.kind === 'failures' ? token('anic-bad-text') : token('anic-warn-text'),
    });
  });
}
