/**
 * 自举失败根因契约（cycle-72 P0-BOOTSTRAP-NO-ROOTCAUSE）——task-10 的回归钉。
 *
 * 被守卫缺陷（真机实证 2026-10-23）：anic_bootstrap_cycle 返回 EXHAUSTED / converged=false，
 * 但状态文件里除了裸的 evalScore 0 / gateVerdict FAIL 之外**没有任何根因**——「为什么没收敛」
 * 只能靠外侧读 gate-check 的 stdout/stderr 才能拼出（真机真根因：Q5 循环依赖误判 → G0-Quality FAIL；
 * 随后 auto-fix-report.md 顶替正典报告 → G2 FAIL）。
 *
 * 本用例钉死三件事：
 *   1. 未收敛 → 状态里**可区分**且**带根因**（EXHAUSTED ≠ CONVERGED，reasons 非空）；
 *   2. 收敛 → 旧根因被**清除**（避免陈旧失败理由被当成当前状态读取）；
 *   3. 摘录器**不编造**：只摘脚本自己打印的失败行，拿不到就诚实为空。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import {
  advanceBootstrap,
  initialBootstrapState,
  extractFailureReasons,
  hasFailureReasons,
  saveBootstrapState,
  loadBootstrapState,
} from '../../src/host/selfBootstrap.ts';
describe('自举失败根因：未收敛必须可解释（非裸 0 分）', () => {
  it('轮次耗尽（EXHAUSTED）时 lastFailure 非空且有理由', () => {
    const reasons = ['[FAIL] G0-Quality: Quality dimensions failed: Q5'];
    const s = advanceBootstrap(initialBootstrapState(1), 0, 'FAIL', null, reasons);
    expect(s.status).toBe('EXHAUSTED');
    expect(s.lastFailure).toBeDefined();
    expect(s.lastFailure?.round).toBe(1);
    expect(s.lastFailure?.gateVerdict).toBe('FAIL');
    expect(s.lastFailure?.reasons).toEqual(reasons);
    expect(hasFailureReasons(s.lastFailure)).toBe(true);
  });

  it('轮次未耗尽（FIXING）时同样带根因（不是只有终态才记）', () => {
    const s = advanceBootstrap(initialBootstrapState(3), 0, 'FAIL', 'fix-1', ['[FAIL] G2: x']);
    expect(s.status).toBe('FIXING');
    expect(s.lastFailure?.reasons).toEqual(['[FAIL] G2: x']);
  });

  it('收敛 → 旧根因被清除（陈旧的失败理由不得被读成当前状态）', () => {
    let s = advanceBootstrap(initialBootstrapState(3), 0, 'FAIL', null, ['[FAIL] G2: x']);
    expect(s.lastFailure).toBeDefined();
    s = advanceBootstrap(s, 1, 'PASS', null, []);
    expect(s.status).toBe('CONVERGED');
    expect(s.lastFailure).toBeUndefined();
  });

  it('拿不到理由时诚实为空（不编造、不把空数组伪装成 PASS）', () => {
    const s = advanceBootstrap(initialBootstrapState(1), 0, 'unknown', null, []);
    expect(s.status).toBe('EXHAUSTED');
    expect(s.lastFailure?.reasons).toEqual([]);
    expect(hasFailureReasons(s.lastFailure)).toBe(false);
  });
});

describe('extractFailureReasons：只摘脚本自己打印的失败行', () => {
  it('摘 [FAIL] 行与 dimension(s) failed 行，忽略其余', () => {
    const out = extractFailureReasons({
      stdout: '[PASS] G1: All 27 tasks completed' + String.fromCharCode(10) + '[FAIL] G0-Quality: Quality dimensions failed: Q5',
      stderr: '1 dimension(s) failed: Q5',
    });
    expect(out).toContain('[FAIL] G0-Quality: Quality dimensions failed: Q5');
    expect(out).toContain('1 dimension(s) failed: Q5');
    expect(out.some((l) => l.includes('[PASS]'))).toBe(false);
  });

  it('去重 + 有界（同一失败行重复出现只记一条）', () => {
    const dup = '[FAIL] G2: Test report summary not recognized';
    const out = extractFailureReasons({ stdout: [dup, dup, dup].join(String.fromCharCode(10)), stderr: '' });
    expect(out.filter((l) => l === dup)).toHaveLength(1);
  });

  it('无结果 / 无可识别失败行 → 空数组（诚实为空）', () => {
    expect(extractFailureReasons(undefined)).toEqual([]);
    expect(extractFailureReasons({ stdout: 'All gates PASSED.', stderr: '' })).toEqual([]);
  });

  it('超长失败行被截断（状态文件不得被整份日志撑爆）', () => {
    const long = '[FAIL] ' + 'x'.repeat(1000);
    const out = extractFailureReasons({ stdout: long, stderr: '' });
    expect(out).toHaveLength(1);
    expect(out[0].length).toBeLessThan(400);
  });
});

describe('状态文件往返：lastFailure 落盘后可被读回', () => {
  it('save → load 往返保留 lastFailure（含 reasons）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anic-boot-failure-'));
    const s = advanceBootstrap(initialBootstrapState(1), 0, 'FAIL', null, ['[FAIL] G2: x']);
    saveBootstrapState(dir, s);
    const back = loadBootstrapState(dir);
    expect(back.status).toBe('EXHAUSTED');
    expect(back.lastFailure?.reasons).toEqual(['[FAIL] G2: x']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('坏 lastFailure 形状不采信（回落 undefined，不伪造根因）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anic-boot-bad-'));
    writeFileSync(
      join(dir, 'self-bootstrap.json'),
      JSON.stringify({ status: 'EXHAUSTED', round: 1, lastFailure: { round: 'x' } }),
      'utf-8',
    );
    const back = loadBootstrapState(dir);
    expect(back.status).toBe('EXHAUSTED');
    expect(back.lastFailure).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
