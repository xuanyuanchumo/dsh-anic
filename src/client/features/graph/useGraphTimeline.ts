/**
 * 时间轴回放的 **hook 外壳**（cycle-99 · 图谱交互增强 ④）——与 useGraphPathMode
 * 同构：状态 + 动作在此，纯函数逻辑全在 graphTimeline.ts。
 *
 * ## 为什么状态在这里而不是 GraphInteractive
 *
 * GraphInteractive.ts 贴 250 行硬限。时间轴的 useState/useCallback/useEffect
 * 内联进去必须删注释腾行数——那是 objectiveConformance ⑪ 想拦的退化。
 *
 * ## 自动播放为什么用 setInterval + useRef 而不是 requestAnimationFrame
 *
 * 回放步进是**秒级**（每步 900ms），rAF 是 60fps 的帧循环——拿它做秒级节拍
 * 既浪费又在后台标签页里语义不明。stub 桩支持 useEffect/useRef/useState/
 * useCallback（七个内置 hook 之内）。`prefersReducedMotion()` 为真时 play()
 * 直接不启动（reduced-motion 纪律与 FAIL_PULSE_STYLE 同款）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './graphInteractiveParts.ts';
import type { TimelineStep } from './graphTimeline.ts';

/** 回放步进间隔（ms）。900ms =「能看清每步点亮了什么」的下限节奏。 */
export const PLAY_INTERVAL_MS = 900;

/** 时间轴 hook 的对外形状（组件只装配）。 */
export interface GraphTimeline {
  /** 时间轴步列表（空 = 无可回放链，控件整条不渲染）。 */
  steps: readonly TimelineStep[];
  /** 当前步（-1 = 未启用回放）。 */
  index: number;
  /** 是否正在自动播放。 */
  playing: boolean;
  /** 步进到 k（slider onInput / 步进按钮走这条；越界自动钳制到末步）。 */
  seek: (k: number) => void;
  /** 启动/暂停自动播放（reduced-motion 下 play 是 no-op）。 */
  togglePlay: () => void;
  /** 退出回放（Escape / 关闭按钮）：index 归 -1、播放停止。 */
  exit: () => void;
}

/**
 * 时间轴回放 hook。`steps` 来自 buildTimeline（纯函数，数据 tick 时重算）。
 */
export function useGraphTimeline(steps: readonly TimelineStep[]): GraphTimeline {
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const stepsRef = useRef<readonly TimelineStep[]>(steps);
  stepsRef.current = steps;

  // 播放节拍：playing && index 未到末步时每 PLAY_INTERVAL_MS 步进一格；
  // 到末步自动停（playing=false，停在最后一帧——"放完了"比"循环闪"可读）。
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const total = stepsRef.current.length;
      setIndex((cur) => {
        const next = cur + 1;
        if (next >= total - 1) setPlaying(false);
        return Math.min(next, Math.max(0, total - 1));
      });
    }, PLAY_INTERVAL_MS);
    return (): void => { clearInterval(timer); };
  }, [playing]);

  const seek = useCallback((k: number): void => {
    const total = stepsRef.current.length;
    setIndex(Math.max(0, Math.min(k, total - 1)));
  }, []);

  const togglePlay = useCallback((): void => {
    setPlaying((cur) => {
      if (cur) return false; // 暂停
      if (prefersReducedMotion()) return false; // reduced-motion：不自动播放
      // 从末步再按播放 = 重新从第 0 步开始（常见预期）。
      setIndex((i) => (i >= stepsRef.current.length - 1 ? 0 : i < 0 ? 0 : i));
      return true;
    });
  }, []);

  const exit = useCallback((): void => {
    setPlaying(false);
    setIndex(-1);
  }, []);

  return { steps, index, playing, seek, togglePlay, exit };
}
