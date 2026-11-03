/**
 * presentationMeta 投影器契约（cycle-101 · 官方 ToolOutputDefinition.presentationMeta 对齐）。
 *
 * 三重守卫：
 *   ① buildPresentationMeta：白名单提取 + durationMs 只在 startedAt 可信时产出；
 *   ② mergePresentationMeta：防御性读取（类型不对的字段丢弃、白名单外不透传）；
 *   ③ renderMetaMarker：marker 是 JSON 的 grep 友好镜像（dsh-ops 双消费模式）。
 *   ④ 直播/回放双路径一致性：terminalResult 对 meta 通道与现场通道产出同形视图。
 */
import { describe, expect, it } from 'vitest';
import {
  buildPresentationMeta,
  mergePresentationMeta,
  renderMetaMarker,
} from '../../src/host/presentationMeta.ts';
import { terminalResult } from '../../src/host/presentation.ts';

describe('presentationMeta 投影器（cycle-101）', () => {
  it('① build：exitCode/signal/cancelled/script 全提取', () => {
    const m = buildPresentationMeta(
      { exitCode: 0, signal: 'SIGTERM', cancelled: true },
      { script: 'eval-runner' },
    );
    expect(m.exitCode).toBe(0);
    expect(m.signal).toBe('SIGTERM');
    expect(m.cancelled).toBe(true);
    expect(m.script).toBe('eval-runner');
    expect(m.durationMs).toBeUndefined(); // 未给 startedAt 不伪造耗时
  });

  it('①b durationMs：startedAt 可信才产出（≥0），否则不设', () => {
    const withDur = buildPresentationMeta({}, { startedAt: Date.now() - 1500 });
    expect(withDur.durationMs).toBeGreaterThanOrEqual(1400);
    const negative = buildPresentationMeta({}, { startedAt: Date.now() + 60_000 });
    expect(negative.durationMs).toBeUndefined(); // 时钟漂移防护
  });

  it('①c exitCode=null 保留（诚实区分 0 与没跑完）', () => {
    const m = buildPresentationMeta({ exitCode: null });
    expect(m.exitCode).toBeNull();
  });

  it('② merge：类型不对的字段丢弃、白名单外不透传', () => {
    const m = mergePresentationMeta({
      exitCode: 'zero', // 类型不对 → 丢弃
      signal: 123, // 类型不对 → 丢弃
      durationMs: -5, // 语义不对 → 丢弃
      hacked: 'field', // 白名单外 → 不透传
      script: 'ok',
    });
    expect(m).toEqual({ script: 'ok' });
    expect(mergePresentationMeta(undefined)).toBeUndefined();
    expect(mergePresentationMeta({ hacked: 1 })).toBeUndefined(); // 全无效 → undefined
  });

  it('③ marker：JSON 的 grep 友好镜像', () => {
    expect(renderMetaMarker({ exitCode: 0, durationMs: 12300 })).toBe('[exit 0 · 12.3s]');
    expect(renderMetaMarker({ exitCode: null, signal: 'SIGTERM', cancelled: true })).toBe('[exit null · SIGTERM · cancelled]');
    expect(renderMetaMarker({ exitCode: 3, durationMs: 420 })).toBe('[exit 3 · 420ms]');
    expect(renderMetaMarker({})).toBeUndefined();
  });

  it('④ 回放路径：meta 通道重建视图（exitCode 来自持久化 meta 而非现场值）', () => {
    // 模拟回放：宿主只有 { content, meta }——没有现场 exitCode 字段
    const replay = terminalResult({
      content: [{ type: 'text', text: 'done' }],
      meta: { exitCode: 2, durationMs: 900, script: 'eval-runner' },
    });
    expect(replay.card).toBe('terminal');
    expect(replay.exitCode).toBe(2);
    expect(replay.output).toContain('done');
    expect(replay.output).toContain('[exit 2 · 900ms]'); // marker 尾巴
  });

  it('④b 直播路径：现场值兜底（无 meta 时行为与 cycle-100 完全一致）', () => {
    const live = terminalResult({ exitCode: 0, stdout: 'hello', stderr: '' });
    expect(live.exitCode).toBe(0);
    expect(live.output).toBe('hello');
    expect(live.output).not.toContain('['); // 无 meta 无 marker（零行为变化）
  });

  it('④c meta 优先于现场值：两者冲突时信持久化 meta（回放事实）', () => {
    const both = terminalResult({
      exitCode: 99, // 现场（可能被重试污染）
      stdout: 'x',
      meta: { exitCode: 0 }, // 持久化事实
    });
    expect(both.exitCode).toBe(0);
  });

  it('④d 空输出只有 marker 时：marker 即 output（不静默吞掉）', () => {
    const onlyMeta = terminalResult({ stdout: '', meta: { exitCode: 1, durationMs: 50 } });
    expect(onlyMeta.output).toBe('[exit 1 · 50ms]');
  });
});
