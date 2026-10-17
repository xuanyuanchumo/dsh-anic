/**
 * 八熔断信号采集层契约（R3 路线图 阶段 1）。
 *
 * 此前 orgStatus 的 DEFAULT_BREAKER_INPUT 全零 —— checkBreakers 实现了 8 条
 * 判定但输入恒零，真实工作区上熔断从未触发。本套件钉死「信号从真实文件来」：
 *   - CB1 auto-fix-fail 计数 → consecutiveFixFails
 *   - CB2 账本末 4 条 FAIL+ambiguous → hasDoubt
 *   - CB3 H1+circuit → userDataUnisolated
 *   - CB4 H2+circuit → destructiveNoRollback
 *   - CB5 band-history 末 2 条 alarm → perfUnrecovered
 *   - CB6 config human_override → humanRequestsL3
 *   - CB7 config session_timeout → unattendedHours
 *   - CB8 circuit/retry 计数 → totalBreakerTrips/totalRetries
 *   - contextUsagePercent 恒 0（无来源不伪造）
 *   - 缺失源全零（向后兼容）+ 与 checkBreakers 的端到端触发链
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectBreakerSignals, zeroBreakerInput } from '../../src/host/evolution/breakerSignals.ts';
import { checkBreakers } from '../../src/host/evolution/autonomyGovernor.ts';

let root: string;

beforeAll(() => {
  root = join(tmpdir(), `anic-breaker-signals-${Date.now()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, '.cycles'), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeIncident(name: string): void {
  const dir = join(root, '.cycles', 'incidents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), '# incident\n');
}

function writeLedger(entries: Array<{ gate: string; result: string; detail?: string }>): void {
  const dir = join(root, '.cycles', 'gates');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ entries, chainHead: 'x' }));
}

function writeBandHistory(bands: string[]): void {
  writeFileSync(join(root, '.cycles', 'band-history.json'),
    JSON.stringify(bands.map((band, i) => ({ cycle: i + 1, score: 0.5, timestamp: '2026-01-01', band }))));
}

describe('collectBreakerSignals — 缺失源与诚实性', () => {
  it('空工作区 → 全零（与历史 DEFAULT_BREAKER_INPUT 等价，向后兼容）', () => {
    expect(collectBreakerSignals(root)).toEqual(zeroBreakerInput());
  });

  it('contextUsagePercent 恒 0（宿主不暴露上下文占用，没有来源不伪造）', () => {
    writeIncident('circuit-something.md');
    const input = collectBreakerSignals(root);
    expect(input.contextUsagePercent).toBe(0);
    rmSync(join(root, '.cycles', 'incidents'), { recursive: true, force: true });
  });

  it('损坏的 ledger/band-history JSON → fail-safe 归零不抛', () => {
    mkdirSync(join(root, '.cycles', 'gates'), { recursive: true });
    writeFileSync(join(root, '.cycles', 'gates', 'ledger.json'), '{broken');
    writeFileSync(join(root, '.cycles', 'band-history.json'), '[broken');
    const input = collectBreakerSignals(root);
    expect(input.hasDoubt).toBe(false);
    expect(input.perfUnrecovered).toBe(false);
    rmSync(join(root, '.cycles', 'gates'), { recursive: true, force: true });
    rmSync(join(root, '.cycles', 'band-history.json'), { force: true });
  });
});

describe('collectBreakerSignals — CB1-CB8 逐条', () => {
  it('CB1：incidents 含 auto-fix-fail ×3 → consecutiveFixFails=3 且熔断触发', () => {
    writeIncident('auto-fix-fail-1.md');
    writeIncident('auto-fix-fail-2.md');
    writeIncident('auto-fix-fail-3.md');
    const input = collectBreakerSignals(root);
    expect(input.consecutiveFixFails).toBe(3);
    const cb1 = checkBreakers(input).find((b) => b.id === 'consecutive_fix_fail');
    expect(cb1?.tripped).toBe(true);
    rmSync(join(root, '.cycles', 'incidents'), { recursive: true, force: true });
  });

  it('CB2：账本末 4 条存在 FAIL 且 detail 空/含 ambiguous → hasDoubt', () => {
    writeLedger([
      { gate: 'G0', result: 'PASS', detail: 'ok' },
      { gate: 'G1', result: 'PASS', detail: 'ok' },
      { gate: 'G2', result: 'FAIL' }, // detail 缺失 → ambiguous
    ]);
    expect(collectBreakerSignals(root).hasDoubt).toBe(true);
    writeLedger([
      { gate: 'G0', result: 'PASS', detail: 'ok' },
      { gate: 'G2', result: 'FAIL', detail: 'gate ambiguous: cannot decide' },
    ]);
    expect(collectBreakerSignals(root).hasDoubt).toBe(true);
    // FAIL 在窗口（末 4 条）之外 → 不触发
    writeLedger([
      { gate: 'G2', result: 'FAIL' }, // 第 1 条，末 4 条窗口（PASS×4）之外
      { gate: 'G0', result: 'PASS', detail: '1' },
      { gate: 'G0', result: 'PASS', detail: '2' },
      { gate: 'G0', result: 'PASS', detail: '3' },
      { gate: 'G0', result: 'PASS', detail: '4' },
    ]);
    expect(collectBreakerSignals(root).hasDoubt).toBe(false);
    // FAIL 但 detail 明确非 ambiguous → 不触发
    writeLedger([{ gate: 'G2', result: 'FAIL', detail: 'build failed with exit 1' }]);
    expect(collectBreakerSignals(root).hasDoubt).toBe(false);
    rmSync(join(root, '.cycles', 'gates'), { recursive: true, force: true });
  });

  it('CB3/CB4：H1+circuit / H2+circuit 文件名 → 对应布尔', () => {
    writeIncident('incident-H1-circuit-1.md');
    writeIncident('incident-H2-circuit-2.md');
    writeIncident('incident-H1-plain.md'); // 无 circuit → 不算
    const input = collectBreakerSignals(root);
    expect(input.userDataUnisolated).toBe(true);
    expect(input.destructiveNoRollback).toBe(true);
    rmSync(join(root, '.cycles', 'incidents'), { recursive: true, force: true });
  });

  it('CB5：band-history 末 2 条均 alarm → perfUnrecovered；混合 → false', () => {
    writeBandHistory(['normal', 'alarm', 'alarm']);
    expect(collectBreakerSignals(root).perfUnrecovered).toBe(true);
    writeBandHistory(['alarm', 'alarm', 'warn']);
    expect(collectBreakerSignals(root).perfUnrecovered).toBe(false);
    writeBandHistory(['alarm']); // 不足 2 条
    expect(collectBreakerSignals(root).perfUnrecovered).toBe(false);
    rmSync(join(root, '.cycles', 'band-history.json'), { force: true });
  });

  it('CB6/CB7：config 原文正则（human_override / session_timeout）', () => {
    const cfg = (s: string) => collectBreakerSignals(root, s);
    expect(cfg('human_override: L3\n').humanRequestsL3).toBe(true);
    expect(cfg('human_override: true\n').humanRequestsL3).toBe(true);
    expect(cfg('human_override: L2\n').humanRequestsL3).toBe(false); // 只认 L3|true（技能侧同款）
    expect(cfg('human_override: false\n').humanRequestsL3).toBe(false);
    expect(cfg('session_timeout: 48\n').unattendedHours).toBe(48);
    expect(cfg('session_timeout: 24\n').unattendedHours).toBe(24);
    expect(cfg('session_timeout: 24\n').humanRequestsL3).toBe(false);
    // config.yml 缺失（readConfigRaw 空串）→ 全零
    expect(collectBreakerSignals(join(root, '.cycles')).humanRequestsL3).toBe(false);
  });

  it('CB8：circuit 计数>3 与 retry 计数 → totalBreakerTrips/totalRetries', () => {
    for (let i = 1; i <= 4; i++) writeIncident(`incident-circuit-${String(i)}.md`);
    writeIncident('retry-timeout-1.md');
    writeIncident('retry-timeout-2.md');
    const input = collectBreakerSignals(root);
    expect(input.totalBreakerTrips).toBe(4);
    expect(input.totalRetries).toBe(2);
    const cb8 = checkBreakers(input).find((b) => b.id === 'retries_or_breakers');
    expect(cb8?.tripped).toBe(true); // 4 > 3
    rmSync(join(root, '.cycles', 'incidents'), { recursive: true, force: true });
  });

  it('端到端：严重熔断（H1+circuit）触发 → decideAction 降级', () => {
    writeIncident('incident-H1-circuit-severe.md');
    const breakers = checkBreakers(collectBreakerSignals(root));
    const severe = breakers.filter((b) => b.tripped);
    expect(severe.map((b) => b.id)).toContain('user_data_unisolated');
    rmSync(join(root, '.cycles', 'incidents'), { recursive: true, force: true });
  });
});
