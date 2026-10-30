/**
 * 门禁脚本白名单的**跨层对账**（cycle-89）。
 *
 * ## 被守卫的风险
 *
 * 门禁脚本白名单在**三个地方**各有一份声明：
 *
 * | 位置 | 层 | 用途 |
 * |---|---|---|
 * | `src/host/runtime/flowAttribution.ts` 的 `GATE_SCRIPT_NAMES` | Host runtime | **写入侧**：判定「这次流程算不算在跑门禁」 |
 * | `src/host/flows/flowGateSemantics.ts` 的 `GATE_SCRIPT_NAMES` | Host flows | **指标侧**：判定「这条记录算不算门禁证据」 |
 * | `src/client/features/flows/flowMatrixTypes.ts` 的 `GATE_EVIDENCE_SCRIPTS` | Client | **消费侧**：判定「哪个 gate 该显示证据」 |
 *
 * 它们**必须**是同一张表，但 runtime 与 client 是**两条独立发版链**
 * （client 不能 import host）—— 所以「同语义、两实现」是刻意的，
 * 而**漂移**是真实风险：改了 runtime 的门禁脚本名而没改指标侧，
 * 归属数据照写、指标口径静默偏 —— 「门禁证据覆盖」再次假绿，
 * 而且**没有任何报错**。
 *
 * ## 本契约的职责
 *
 * 把三份声明**钉成同一张表**：任一处漂移 → 本文件红。
 *
 * 这不是重复实现，是**用测试代替共享代码**来解决发版链隔离。
 */
import { describe, expect, it } from 'vitest';
import { GATE_EVIDENCE_SCRIPT_NAMES as RUNTIME_GATE_SCRIPTS } from '../../src/host/runtime/flowAttribution.ts';
import { GATE_SCRIPT_NAMES as METRIC_GATE_SCRIPTS, isGateEvidence } from '../../src/host/flows/flowGateSemantics.ts';
import { GATE_EVIDENCE_SCRIPTS as CLIENT_GATE_SCRIPTS } from '../../src/client/features/flows/flowMatrixTypes.ts';
import type { FlowRecord } from '../../src/host/runtime/flowTracker.ts';

/** 造一条记录。 */
function rec(script: string, gate?: string): FlowRecord {
  const r: FlowRecord = {
    flowId: 'f', script, workspace: 'D:/w', args: [], status: 'DONE', startedAt: '2026-10-30T00:00:00.000Z',
  };
  if (gate !== undefined) r.gate = gate;
  return r;
}

describe('门禁白名单：runtime ↔ 指标侧 ↔ 客户端 三方对账', () => {
  it('**runtime 与指标侧的白名单完全一致**', () => {
    expect([...RUNTIME_GATE_SCRIPTS].sort()).toEqual([...METRIC_GATE_SCRIPTS].sort());
  });

  it('**指标侧与客户端的白名单完全一致**', () => {
    expect([...METRIC_GATE_SCRIPTS].sort()).toEqual([...CLIENT_GATE_SCRIPTS].sort());
  });

  it('**三处都含 gate-check 与 hitl-audit**（当前闭合集合的两个门禁执行器）', () => {
    for (const set of [RUNTIME_GATE_SCRIPTS, METRIC_GATE_SCRIPTS]) {
      expect(set.has('gate-check')).toBe(true);
      expect(set.has('hitl-audit')).toBe(true);
    }
    expect(CLIENT_GATE_SCRIPTS).toContain('gate-check');
    expect(CLIENT_GATE_SCRIPTS).toContain('hitl-audit');
  });

  it('**非门禁脚本不在白名单里**（否则无关流程会被算成门禁证据）', () => {
    for (const script of ['workflow-state', 'eval-runner', 'init-cycle', 'band-detector', 'quick-validate', 'archive-cycle']) {
      expect(RUNTIME_GATE_SCRIPTS.has(script), `${script} 不该在 runtime 白名单`).toBe(false);
      expect(METRIC_GATE_SCRIPTS.has(script), `${script} 不该在指标白名单`).toBe(false);
      expect(CLIENT_GATE_SCRIPTS).not.toContain(script);
    }
  });
});

describe('指标侧判据：字段存在 ≠ 有门禁证据', () => {
  it('**实测反例：workflow-state 带 gate G3 也不算证据**', () => {
    expect(isGateEvidence(rec('workflow-state', 'G3'))).toBe(false);
  });

  it('门禁脚本 + 有 gate → 算证据', () => {
    expect(isGateEvidence(rec('gate-check', 'G2'))).toBe(true);
    expect(isGateEvidence(rec('hitl-audit', 'H1'))).toBe(true);
  });

  it('门禁脚本但**缺 gate** → 不算证据（缺门就是没证据）', () => {
    expect(isGateEvidence(rec('gate-check'))).toBe(false);
  });
});
