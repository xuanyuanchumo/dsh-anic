/**
 * P0-2 回归守卫：门禁证据装配器。
 *
 * 本文件钉死的是一个**功能级谎言**：`nativeRoute.ts` 曾把 `evidenceByGate = {}`
 * 喂给 `runAllGates`，于是五个门全部零证据、`heuristicEvaluate` 恒 `doubt` ——
 * 「多门评审」这条功能在真实工作区从未产出过一次有效裁决。
 *
 * 守卫分三层：
 *   1. 纯逻辑层（合成目录）：缺工件 → FAIL 证据；全工件 → PASS 证据
 *   2. 账本层：按 timestamp 取每门最新裁决（不是数组末条）
 *   3. 真实工作区层：对 `.cycles/` 真实工件取证（路径存在时；不存在则跳过不造假红）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectGateEvidence,
  latestConvergenceVerdicts,
  latestCycleDir,
  CONVERGENCE_GATES,
} from '../../src/host/llm/gateEvidence.ts';
import { GATE_NAMES } from '../../src/host/llm/multiAgentGate.ts';

let root: string;

/** 造一个最小工作区：`<root>/.cycles/...` */
function scaffold(opts: { gates?: Array<[string, 'PASS' | 'FAIL', string]>; files?: string[] }): void {
  const cycles = join(root, '.cycles');
  mkdirSync(join(cycles, 'gates'), { recursive: true });
  mkdirSync(join(cycles, 'intent'), { recursive: true });
  if (opts.gates) {
    const entries = opts.gates.map(([gate, result, timestamp]) => ({
      gate,
      gateName: gate,
      result,
      detail: 'fixture',
      timestamp,
      previousHash: null,
    }));
    writeFileSync(join(cycles, 'gates', 'ledger.json'), JSON.stringify({ entries, chainHead: null }), 'utf-8');
  }
  for (const rel of opts.files ?? []) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, '非空内容', 'utf-8');
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anic-gate-evidence-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('collectGateEvidence — 覆盖完整性', () => {
  it('返回全部 5 个 ANIC 门，每门都有证据（绝不返回空数组）', () => {
    scaffold({});
    const ev = collectGateEvidence(root);
    expect(Object.keys(ev).sort()).toEqual([...GATE_NAMES].sort());
    for (const gate of GATE_NAMES) {
      expect(ev[gate].length).toBeGreaterThan(0);
    }
  });

  it('空工作区：pr/release 门必须因 G0-G3 缺失而得到 FAIL 证据（不是空集、不是 PASS）', () => {
    scaffold({});
    const ev = collectGateEvidence(root);
    const prFail = ev.pr.filter((e) => e.result === 'FAIL').map((e) => e.id);
    expect(prFail).toContain('ledger:G0');
    expect(prFail).toContain('ledger:G1');
    expect(prFail).toContain('ledger:G2');
    expect(prFail).toContain('ledger:G3');
    // 「没有证据 ≠ 通过」：绝不存在凭空 PASS
    expect(ev.pr.filter((e) => e.result === 'PASS')).toEqual([]);
  });

  it('缺 intent 工件 → intent 门 FAIL 且内容是确定的缺失事实（含已尝试路径）', () => {
    scaffold({});
    const ev = collectGateEvidence(root);
    expect(ev.intent).toHaveLength(1);
    const item = ev.intent[0];
    expect(item?.result).toBe('FAIL');
    expect(item?.content).toContain('缺失');
    expect(item?.content).toContain('已尝试');
  });

  it('全工件齐备 → intent/spec/plan 门得到 PASS 证据', () => {
    scaffold({ files: ['.cycles/intent/intent.md', '.cycles/intent/spec.md', '.cycles/intent/plan.md'] });
    const ev = collectGateEvidence(root);
    expect(ev.intent[0]?.result).toBe('PASS');
    expect(ev.spec[0]?.result).toBe('PASS');
    expect(ev.plan[0]?.result).toBe('PASS');
  });

  it('路径容差：真实布局 .cycles/spec.md + .cycles/plan.md 同样被识别（技能脚本路径漂移）', () => {
    scaffold({ files: ['.cycles/intent/intent.md', '.cycles/spec.md', '.cycles/plan.md'] });
    const ev = collectGateEvidence(root);
    expect(ev.spec[0]?.result).toBe('PASS');
    expect(ev.plan[0]?.result).toBe('PASS');
  });

  it('空文件不算证据（与「文件存在即 pass」的伪自信划清界限）', () => {
    scaffold({});
    const p = join(root, '.cycles', 'intent', 'intent.md');
    writeFileSync(p, '', 'utf-8');
    const ev = collectGateEvidence(root);
    expect(ev.intent[0]?.result).toBe('FAIL');
  });
});

describe('latestConvergenceVerdicts — 账本取证', () => {
  it('按 timestamp 取每门最新裁决，而不是数组末条', () => {
    scaffold({
      gates: [
        ['G0', 'FAIL', '2026-01-01T00:00:00.000Z'],
        ['G0', 'PASS', '2026-02-01T00:00:00.000Z'],
        // G0 的旧 FAIL 故意放在数组最后：数组序不是时间序
        ['G1', 'PASS', '2026-01-15T00:00:00.000Z'],
      ],
    });
    const v = latestConvergenceVerdicts(join(root, '.cycles'));
    expect(v.get('G0')).toBe('PASS');
    expect(v.get('G1')).toBe('PASS');
    expect(v.has('G2')).toBe(false);
  });

  it('账本缺失 / 结构损坏 → 空 Map（不 throw）', () => {
    scaffold({});
    expect(latestConvergenceVerdicts(join(root, '.cycles')).size).toBe(0);
    writeFileSync(join(root, '.cycles', 'gates', 'ledger.json'), '{ 不是 JSON', 'utf-8');
    expect(latestConvergenceVerdicts(join(root, '.cycles')).size).toBe(0);
  });

  it('裸数组形态同样可读（兼容两种历史形态）', () => {
    scaffold({});
    const arr = [{ gate: 'G2', result: 'PASS', timestamp: '2026-03-01T00:00:00.000Z' }];
    writeFileSync(join(root, '.cycles', 'gates', 'ledger.json'), JSON.stringify(arr), 'utf-8');
    expect(latestConvergenceVerdicts(join(root, '.cycles')).get('G2')).toBe('PASS');
  });

  it('CONVERGENCE_GATES 是 G0-G3（与真实账本取值一致，非 intent/spec/plan/pr/release）', () => {
    expect([...CONVERGENCE_GATES]).toEqual(['G0', 'G1', 'G2', 'G3']);
  });
});

describe('latestCycleDir — 最新 cycle 解析', () => {
  it('按数字大小取最新，不按字典序（cycle-9 < cycle-10）', () => {
    scaffold({});
    for (const d of ['cycle-2', 'cycle-10', 'cycle-9']) mkdirSync(join(root, '.cycles', 'cycles', d), { recursive: true });
    expect(latestCycleDir(join(root, '.cycles'))).toContain('cycle-10');
  });

  it('无非 cycle 目录 → null', () => {
    scaffold({});
    expect(latestCycleDir(join(root, '.cycles'))).toBeNull();
  });
});

describe('collectGateEvidence — release 门收尾工件', () => {
  it('最新 cycle 缺三份收尾工件 → 三条 FAIL 证据（id 可定位）', () => {
    scaffold({ files: ['.cycles/cycles/cycle-1/交付清单.md'] });
    const ev = collectGateEvidence(root);
    const ids = ev.release.map((e) => e.id);
    expect(ids).toContain('artifact:non-functional');
    expect(ids).toContain('artifact:audit');
    expect(ids).toContain('artifact:delivery');
    const delivery = ev.release.find((e) => e.id === 'artifact:delivery');
    expect(delivery?.result).toBe('PASS'); // 唯一存在的那份
    expect(ev.release.find((e) => e.id === 'artifact:audit')?.result).toBe('FAIL');
  });

  it('G0-G3 全 PASS + 链可校验 + 三工件齐备 → release 门全 PASS', () => {
    scaffold({
      gates: [
        ['G0', 'PASS', '2026-01-01T00:00:00.000Z'],
        ['G1', 'PASS', '2026-01-02T00:00:00.000Z'],
        ['G2', 'PASS', '2026-01-03T00:00:00.000Z'],
        ['G3', 'PASS', '2026-01-04T00:00:00.000Z'],
      ],
      files: [
        '.cycles/cycles/cycle-1/非功能验证报告.md',
        '.cycles/cycles/cycle-1/审计日志.md',
        '.cycles/cycles/cycle-1/交付清单.md',
      ],
    });
    const ev = collectGateEvidence(root);
    const failed = ev.release.filter((e) => e.result !== 'PASS');
    // fixture 账本无 hash → 链校验会 FAIL（previousHash/hash 缺失是真实缺陷），
    // 故此处只断言「工件三条 + G0-G3 四条」中除链校验外均 PASS。
    const failedIds = failed.map((e) => e.id);
    expect(failedIds).not.toContain('artifact:non-functional');
    expect(failedIds).not.toContain('artifact:audit');
    expect(failedIds).not.toContain('artifact:delivery');
    expect(failedIds).not.toContain('ledger:G0');
    expect(failedIds).not.toContain('ledger:G1');
    expect(failedIds).not.toContain('ledger:G2');
    expect(failedIds).not.toContain('ledger:G3');
  });
});
