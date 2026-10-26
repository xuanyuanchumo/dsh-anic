/**
 * F-04 回归（来源：`.cycles/tech-debt/cycle-72-债务台账.md` §4「质量维不入账」）。
 *
 * 被守卫缺陷：`gate-check.mjs` 的 `--record` 落账**早于**质量检查 —— G0 基本判定 PASS
 * 而 Q5 质量维 FAIL 时，账本留下一条 `G0 PASS`，与最终裁决（exit 1 / FAILED）矛盾，
 * 账本读侧因此 fail-open（引用者误判「上次 G0 全过」）。
 *
 * 判别力（修复前会红，修复后必须绿）：
 *  - 用例 A：修复前账本条目 result=PASS 且 detail 无 Q 段 → 两条断言同时红；
 *  - 用例 B：修复前 detail 无逐维裁决段 → 红；
 *  - 用例 C/D 是**反向前提**（去重语义、不带 --quality 的旧行为不能被这次修复破坏），
 *    修复前也绿，故它们不是"新能力"，而是"没放宽/没回退"的守卫。
 *
 * 纪律：不 mock 账本写盘——真 spawn `node gate-check.mjs`，断言落到磁盘的 ledger.json。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runNativeGateCheck } from '../../src/host/flows/gateEngine.ts';
import { recordNative, runNativeSide } from '../../src/host/flows/gateCheckRunners.ts';
import { loadLedger } from '../../src/host/runtime/ledger.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'assets', 'skill', 'scripts', 'gate-check.mjs');
const HERE = fileURLToPath(new URL('.', import.meta.url));

/** 夹具登记表（afterAll 统一清理，防 tests/contract 下留垃圾目录）。 */
const fixtures: string[] = [];
afterAll(() => {
  for (const d of fixtures) rmSync(d, { recursive: true, force: true });
});

/** 构造临时项目：G0 只需 cycle-1/项目评估报告.md 的维度行 + .cycles/config.yml。 */
function makeWorkspace(q1: string, q5: string): string {
  const dir = mkdtempSync(join(HERE, 'tmp-gate-ledger-'));
  fixtures.push(dir);
  mkdirSync(join(dir, '.cycles', 'cycles', 'cycle-1'), { recursive: true });
  writeFileSync(join(dir, '.cycles', 'config.yml'), 'autonomy_level: L4\nbuild_cmd: "exit 0"\n');
  writeFileSync(
    join(dir, '.cycles', 'cycles', 'cycle-1', '项目评估报告.md'),
    `| E1 | 意图对齐 | PASS | ok |\n| Q1 | 架构 | ${q1} | ok |\n| Q5 | 复杂度 | ${q5} | note |\n`,
  );
  return dir;
}

/** 真跑脚本（不做任何 mock）：返回退出码 + 双流。 */
function runGate(dir: string, extra: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, dir, '--gate', 'G0', ...extra], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 读磁盘账本（不经脚本内部函数——落盘事实才是证据）。 */
function entryOf(dir: string): { gate: string; result: string; detail: string }[] {
  return loadLedger(join(dir, '.cycles')).map((e) => ({ gate: e.gate, result: e.result, detail: e.detail }));
}
function lastG0(dir: string) {
  return entryOf(dir).filter((e) => e.gate === 'G0').at(-1);
}

describe('F-04：脚本 --record 必须记「含质量维的最终裁决」', () => {
  it('用例 A：Q5 FAIL ⇒ exit≠0，账本 G0 result=FAIL 且 detail 含 Q5:FAIL（核心断言）', () => {
    const dir = makeWorkspace('PASS', 'FAIL');
    const r = runGate(dir, ['--quality', '--record']);

    expect(r.status).not.toBe(0); // 退出码语义不变：有 FAIL 即 exit 1
    expect(r.stdout).toContain('[PASS] G0: Evaluation report found in cycle-1');
    expect(r.stdout).toContain('[FAIL] G0-Quality: Quality dimensions failed: Q5');

    const g0 = lastG0(dir);
    expect(g0, '账本必须有一条 G0').toBeDefined();
    // 修复前：result=PASS（与最终裁决矛盾）—— 这条断言就是缺口的判别器
    expect(g0?.result).toBe('FAIL');
    expect(g0?.detail).toContain('Q1:PASS');
    expect(g0?.detail).toContain('Q5:FAIL');
    // stdout 与账本必须同源：落账行也必须是 FAIL
    expect(r.stdout).toContain('[LEDGER] G0 FAIL recorded');
  });

  it('用例 B：Q1/Q5 全 PASS ⇒ 账本 G0 PASS 且 detail 含逐维裁决', () => {
    const dir = makeWorkspace('PASS', 'PASS');
    const r = runGate(dir, ['--quality', '--record']);

    expect(r.status).toBe(0);
    const g0 = lastG0(dir);
    expect(g0?.result).toBe('PASS');
    expect(g0?.detail).toContain('Evaluation report found in cycle-1 (3 dimension rows)');
    expect(g0?.detail).toContain('[Q1:PASS,Q5:PASS]');
  });

  it('用例 C：重复运行同结论不重复落账（去重语义保留）', () => {
    const dir = makeWorkspace('PASS', 'PASS');
    const first = runGate(dir, ['--quality', '--record']);
    expect(first.status).toBe(0);
    expect(entryOf(dir)).toHaveLength(1);

    const second = runGate(dir, ['--quality', '--record']);
    expect(second.status).toBe(0);
    expect(entryOf(dir)).toHaveLength(1); // 未被重复污染
    expect(second.stdout).toContain('[LEDGER] G0 unchanged, not re-recorded');
  });

  it('用例 D：不带 --quality ⇒ detail 不含 Q 段、结论仍 PASS（旧行为零变化）', () => {
    const dir = makeWorkspace('PASS', 'PASS');
    const r = runGate(dir, ['--record']);

    expect(r.status).toBe(0);
    const g0 = lastG0(dir);
    expect(g0?.result).toBe('PASS');
    expect(g0?.detail).toBe('Evaluation report found in cycle-1 (3 dimension rows)');
    expect(g0?.detail).not.toContain('Q1:');
    expect(g0?.detail).not.toContain('[Q');
  });
});

describe('F-04 原生侧同族修复：recordNative 必须消费质量维裁决', () => {
  it('Q5 FAIL ⇒ 原生入账 result=FAIL 且 detail 带 Q5:FAIL，与脚本侧 detail 逐字节一致', () => {
    // 脚本侧（正典）与原生侧各跑一个同构夹具，两侧账本 detail 必须全等——
    // 否则同一门在 script/native 之间会因 detail 不同而双录（去重语义失效）。
    const scripted = makeWorkspace('PASS', 'FAIL');
    runGate(scripted, ['--quality', '--record']);
    const canonical = lastG0(scripted);

    const nativeDir = makeWorkspace('PASS', 'FAIL');
    const native = runNativeGateCheck(nativeDir, { gate: 'G0', quality: true });
    expect(native.allPass).toBe(false);
    recordNative(join(nativeDir, '.cycles'), native.gates, native.quality);
    const entry = lastG0(nativeDir);

    expect(entry?.result).toBe('FAIL');
    expect(entry?.detail).toBe(canonical?.detail);
    expect(entry?.detail).toContain('Q5:FAIL');
  });

  it('runNativeSide + recordNative(cyclesDir, gates) 两参调用（= gateCheckFlow 真实形态）也带 Q 段', () => {
    const dir = makeWorkspace('PASS', 'FAIL');
    const side = runNativeSide(dir, 'G0', true);
    // gateCheckFlow.ts 的原调用形态：只传 gates（质量裁决经同跑关联表合流）
    recordNative(join(dir, '.cycles'), side.gates);
    const entry = lastG0(dir);
    expect(entry?.result).toBe('FAIL');
    expect(entry?.detail).toContain('[Q1:PASS,Q5:FAIL]');
  });
});

describe('O-01 交叉面：循环身份段与质量段的拼接顺序（G1/G2/G3）', () => {
  it('--gate all 全绿：detail = `<门 detail> §cycle-1 [Qx:PASS]`（身份在前、质量段在后）', () => {
    // 全绿夹具：四门可过 + 四门质量维全 PASS
    const dir = mkdtempSync(join(HERE, 'tmp-gate-ledger-'));
    fixtures.push(dir);
    const c = join(dir, '.cycles', 'cycles', 'cycle-1');
    mkdirSync(join(c, 'test-reports'), { recursive: true });
    writeFileSync(join(dir, '.cycles', 'config.yml'), 'autonomy_level: L4\nbuild_cmd: "exit 0"\n');
    writeFileSync(join(c, '项目评估报告.md'), [
      '| E1 | 意图对齐 | PASS | ok |',
      '| Q1 | 架构 | PASS | ok |', '| Q5 | 复杂度 | PASS | ok |', '| Q7 | 工程 | PASS | ok |',
      '| Q2 | 测试 | PASS | ok |', '| Q3 | 构建 | PASS | ok |', '| Q4 | 依赖 | PASS | ok |',
    ].join('\n'));
    writeFileSync(join(c, '任务清单.md'), '| T-01 | P0 | 任务 | 验证 | lead | 完成 |');
    writeFileSync(join(c, 'test-reports', 'test-report.md'), '| 结果 | 数量 |\n| --- | --- |\n| 通过 | 10 |\n| 失败 | 0 |\n| 错误 | 0 |');

    const r = spawnSync(process.execPath, [SCRIPT, dir, '--gate', 'all', '--quality', '--record'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    const byGate = new Map(entryOf(dir).map((e) => [e.gate, e.detail]));
    expect(byGate.get('G1')).toBe('All 1 tasks completed §cycle-1 [Q7:PASS]');
    expect(byGate.get('G2')).toBe('Zero failures, zero errors (test-report.md) §cycle-1 [Q2:PASS]');
    expect(byGate.get('G3')).toBe('Build passed: exit 0 §cycle-1 [dist=absent] [Q3:PASS,Q4:PASS]');
    // G0 例外：循环身份在 detail 文本内，无 § 段
    expect(byGate.get('G0')).toBe('Evaluation report found in cycle-1 (7 dimension rows) [Q1:PASS,Q5:PASS]');
  });
});
