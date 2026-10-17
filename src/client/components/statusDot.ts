/**
 * 状态圆点 + 脉冲动画样式（B4 组件整合）。
 *
 * 提取自两处逐字重复的「@keyframes + prefers-reduced-motion 逃逸」块：
 * gateColors.ts 的 FAIL_PULSE_STYLE（图区 FAIL 节点脉冲）与
 * renderInvocations.ts 的 LIVE_PULSE_STYLE（实时调用 in-flight 脉冲）。
 * 两份样式曾分属两个特性域，纪律相同（动画最小化全局逃逸）却各写一份——
 * 收敛到这里后，第三处需要脉冲的分区（如 cycle 时间线的当前格）直接复用。
 *
 * 注意：CSS 文本必须与提取前**逐字节一致**——invocationsRender.test.ts 断言
 * '@keyframes anic-live-pulse'、'prefers-reduced-motion'、'animation:none'
 * 出现在渲染输出里；graphA11y 走 renderGraph 的 <style> 注入 FAIL 块。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../shared/tokens.ts';

/** 图区 FAIL 节点脉冲（原 gateColors.ts，逐字迁移）。 */
export const FAIL_PULSE_STYLE = `
@keyframes anic-fail-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.anic-fail-node {
  animation: anic-fail-pulse 1.5s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .anic-fail-node {
    animation: none;
  }
}
`;

/** 实时调用 in-flight 脉冲（原 renderInvocations.ts，逐字迁移）。 */
export const LIVE_PULSE_STYLE = `@keyframes anic-live-pulse{0%,100%{opacity:1}50%{opacity:.35}}.anic-live-dot{animation:anic-live-pulse 1.2s ease-in-out infinite}@media (prefers-reduced-motion: reduce){.anic-live-dot{animation:none}}`;

/** 两块合并注入（消费方一次 <style> 搞定，避免两个 style 元素）。 */
export const PULSE_STYLES = `${FAIL_PULSE_STYLE}\n${LIVE_PULSE_STYLE}`;

/**
 * 状态圆点原语：固定尺寸圆形色点，可选脉冲类。
 *
 * 消费点：renderStepTrace（10px 带描边）、renderInvocations（7px 脉冲）、
 * cycle 时间线（当前格指示）。颜色一律由调用方经 token() 传入——本组件
 * 不持颜色表（语义映射属各域，令牌引用是唯一纪律）。
 */
export interface StatusDotProps {
  color: string;
  size?: number;
  /** in-flight 类脉冲（挂 anic-live-dot 类，prefers-reduced-motion 自动逃逸）。 */
  pulse?: boolean;
  /** 是否带 1px 强边框（步骤流程的圆点形态）。 */
  border?: boolean;
  /** DOM 锚点（测试/无障碍定位用），如 'data-anic-invocation-dot'。 */
  anchorKey?: string;
  anchor?: string;
}

export function StatusDot({ color, size = 10, pulse = false, border = false, anchorKey, anchor }: StatusDotProps): ReactElement {
  return createElement('span', {
    ...(anchorKey !== undefined && anchor !== undefined ? { [anchorKey]: anchor } : {}),
    className: pulse ? 'anic-live-dot' : undefined,
    style: {
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: color,
      ...(border ? { border: `1px solid ${token('anic-border-strong')}` } : {}),
    },
  });
}
