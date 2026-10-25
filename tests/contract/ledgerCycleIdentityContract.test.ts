/**
 * O-01 回归（cycle-78 审计日志 §6 / `.cycles/tech-debt/cycle-78-closure-and-open-items.md`）：
 * **账本去重键必须自带循环身份**。
 *
 * 被守卫缺陷：`--record` 的去重键是 `(result, detail)`，而 G1/G2/G3 的 detail 原先是
 * 循环无关字符串 ⇒ 跨循环同结论被静默 dedup——cycle-78 的 G2/G3 记录实际仍是 cycle-77
 * 的旧条目（本循环没有自己的审计条目）。修法：G1/G2/G3 detail 末尾追加 `§cycle-N`。
 *
 * 判别力（修复前会红）：
 *  - 用例 ①：修复前第二次运行只有 G0 入账（G1/G2/G3 因 detail 与 cycle-77 相同被静默
 *    dedup）⇒ 账本 5 条而非 8 条、且 G1-G3 的 detail 不含 `§cycle-2`，并出现
 *    `unchanged, not re-recorded`；
 *  - 用例 ③ 反向自检：把循环身份从真实账本 detail 里剥掉（两种形态）后，两轮
 *    (result, detail) 完全重合 ⇒ 纯 (result, detail) 旧键必跳过 4 条，证明"每轮各 4 条"
 *    正是循环身份带来的；再精确复现修复前形态（仅 G1-G3 缺身份）⇒ 只跳过 3 条。
 *
 * 纪律：不 mock——真 spawn `node gate-check.mjs`，断言落在磁盘 ledger.json 上。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runNativeGateCheck } from '../../src/host/flows/gateEngine.ts';
import { invokeSkillScript } from '../../src/host/skillInvoker.ts';
import { parseGateLines } from '../../src/host/runtime/scriptParsers.ts';
import { loadLedger } from '../../src/host/runtime/ledger.ts';
import type { LedgerEntry } from '../../src/host/runtime/ledger.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPTS_DIR = join(ROOT, 'assets', 'skill', 'scripts');
const SCRIPT = join(SCRIPTS_DIR, 'gate-check.mjs');
const HERE = fileURLToPath(new URL('.', import.meta.url));

const fixtures: string[] = [];
afterAll(() => {
  for (const d of fixtures) rmSync(d, { recursive: true, force: true });
});

const EVAL_PASS = [
  '| E1 | 意图对齐 | PASS | ok |',
  '| Q1 | 架构 | PASS | ok |', '| Q5 | 复杂度 | PASS | ok |', '| Q7 | 工程 | PASS | ok |',
  '| Q2 | 测试 | PASS | ok |', '| Q3 | 构建 | PASS | ok |', '| Q4 | 依赖 | PASS | ok |',
].join('\n');
const TASKS_DONE = '| T-01 | P0 | 任务 | 验证 | lead | 完成 |';
const TEST_SUMMARY = '| 结果 | 数量 |\n| --- | --- |\n| 通过 | 10 |\n| 失败 | 0 |\n| 错误 | 0 |';

/** 建一个全绿 cycle 目录（四门可 PASS，质量维全 PASS）。 */
function seedCycle(dir: string, cycle: string): void {
  const c = join(dir, '.cycles', 'cycles', cycle);
  mkdirSync(join(c, 'test-reports'), { recursive: true });
  writeFileSync(join(c, '项目评估报告.md'), EVAL_PASS);
  writeFileSync(join(c, '任务清单.md'), TASKS_DONE);
  writeFileSync(join(c, 'test-reports', 'test-report.md'), TEST_SUMMARY);
}

/** 全绿工作区（先只有 cycle-1；调用方按需再 seed cycle-2）。 */
function makeWorkspace(): string {
  const dir = mkdtempSync(join(HERE, 'tmp-ledger-cycle-'));
  fixtures.push(dir);
  mkdirSync(join(dir, '.cycles'), { recursive: true });
  writeFileSync(join(dir, '.cycles', 'config.yml'), 'autonomy_level: L4\nbuild_cmd: "exit 0"\n');
  seedCycle(dir, 'cycle-1');
  return dir;
}

function runGate(dir: string, extra: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, dir, '--gate', 'all', '--quality', ...extra], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function entries(dir: string): LedgerEntry[] {
  return loadLedger(join(dir, '.cycles'));
}

/**
 * 只剥 ` §cycle-N` 段（G0 的文本身份保留）——用于**精确复现修复前**的账本 detail：
 * 修复前 G1/G2/G3 没有循环身份，而 G0 的 detail 本来就含 `in cycle-N`。
 */
const stripTag = (s: string): string => s.replace(/ §cycle-\d+/g, '');
/**
 * 剥掉**两种**循环身份形态（G1-G3 的 ` §cycle-N` + G0 的 `in cycle-N`），
 * 用于反事实检验：「若 detail 完全不含循环身份，旧去重键会怎样」。
 */
const stripIdentity = (s: string): string =>
  s.replace(/ §cycle-\d+/g, '').replace(/in cycle-\d+/g, 'in cycle-N');

/** 旧实现（纯 (result, detail) 去重）在该轮会跳过几条——用给定归一化函数复算。 */
function legacySkipped(
  before: LedgerEntry[],
  round: LedgerEntry[],
  norm: (s: string) => string,
): number {
  const last = new Map<string, LedgerEntry>();
  for (const e of before) last.set(e.gate, e);
  let skipped = 0;
  for (const e of round) {
    const prev = last.get(e.gate);
    if (prev && prev.result === e.result && norm(prev.detail) === norm(e.detail)) skipped++;
    last.set(e.gate, e);
  }
  return skipped;
}

describe('O-01：账本 detail 自带循环身份，跨循环不静默去重', () => {
  it('① 两个 cycle 同结论各跑一次 ⇒ 各记 4 条，detail 含对应 §cycle-N', () => {
    const dir = makeWorkspace();
    const first = runGate(dir, ['--record']);
    expect(first.status).toBe(0);
    expect(entries(dir)).toHaveLength(4);

    seedCycle(dir, 'cycle-2'); // 数值序最新 = cycle-2
    const second = runGate(dir, ['--record']);
    expect(second.status).toBe(0);
    expect(entries(dir)).toHaveLength(8); // 跨循环不 dedup（修复前只有 5 条：仅 G0 入账）
    expect(second.stdout).not.toContain('unchanged, not re-recorded');

    const all = entries(dir);
    const run1 = all.slice(0, 4), run2 = all.slice(4);
    for (const g of ['G1', 'G2', 'G3']) {
      expect(run1.find((e) => e.gate === g)?.detail).toContain('§cycle-1');
      expect(run2.find((e) => e.gate === g)?.detail).toContain('§cycle-2');
    }
    // G0 例外：身份已在 detail 文本内（`in cycle-N`），不追加 § 段
    expect(run1.find((e) => e.gate === 'G0')?.detail).toContain('in cycle-1');
    expect(run2.find((e) => e.gate === 'G0')?.detail).toContain('in cycle-2');
  });

  it('② 同一 cycle 重复跑 ⇒ 条数不变（同循环 dedup 仍生效）', () => {
    const dir = makeWorkspace();
    expect(runGate(dir, ['--record']).status).toBe(0);
    const third = runGate(dir, ['--record']);
    expect(third.status).toBe(0);
    expect(entries(dir)).toHaveLength(4);
    expect(third.stdout).toContain('unchanged, not re-recorded');
  });

  it('③ 反向自检：剥掉循环身份后两轮完全重合 ⇒ 旧去重键必跳过 G1-G3（证明身份才让去重正确）', () => {
    const dir = makeWorkspace();
    expect(runGate(dir, ['--record']).status).toBe(0);
    const run1 = entries(dir);
    seedCycle(dir, 'cycle-2');
    expect(runGate(dir, ['--record']).status).toBe(0);
    const all = entries(dir);
    expect(all).toHaveLength(8);
    const run2 = all.slice(4);

    // (a) 循环身份是唯一差异：两种形态都归一后，两轮逐字段重合
    const normIdentity = (rows: LedgerEntry[]) =>
      rows.map((e) => `${e.gate}|${e.result}|${stripIdentity(e.detail)}`);
    expect(normIdentity(run2)).toEqual(normIdentity(run1));

    // (b) 反事实：若 detail 完全不含循环身份 ⇒ 旧键会把 4 条全判 unchanged（①必然红）
    expect(legacySkipped(run1, run2, stripIdentity)).toBe(4);
    // (c) 精确复现修复前（只有 G1-G3 缺身份）⇒ 只跳过 3 条，G0 因已含 `in cycle-N` 仍入账
    expect(legacySkipped(run1, run2, stripTag)).toBe(3);

    // 正向对照：真实 detail（带 § 段）两轮无一条重合
    expect(run2.every((e) => !run1.some((p) => p.gate === e.gate && p.detail === e.detail))).toBe(true);
  });

  it('④ native 与 script 同夹具 G0-G3 detail 逐字全等（含 §cycle-N）', () => {
    const dir = makeWorkspace();
    seedCycle(dir, 'cycle-2'); // 让两侧都判 cycle-2
    const scripted = parseGateLines(invokeSkillScript(SCRIPTS_DIR, 'gate-check', ['--gate', 'all', '--quality'], dir, 60000));
    const native = runNativeGateCheck(dir, { gate: 'all', quality: true });
    for (const g of ['G0', 'G1', 'G2', 'G3']) {
      expect(native.gates[g]?.pass, `gate ${g} pass`).toBe(scripted.gates[g]?.pass);
      expect(native.gates[g]?.detail, `gate ${g} detail`).toBe(scripted.gates[g]?.detail);
    }
    expect(native.gates.G1?.detail).toContain('§cycle-2');
    expect(native.gates.G2?.detail).toContain('§cycle-2');
    expect(native.gates.G3?.detail).toContain('§cycle-2');
  });
});
