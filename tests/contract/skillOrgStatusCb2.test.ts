/**
 * 技能侧 CB2 契约（cycle-78 WS-G）：账本形状归一 —— 裸数组不得让 org-status 崩溃。
 *
 * 被守卫缺陷（**崩溃**，比 fail-open 更坏）：`org-status.mjs` 的 CB2 检查 / CB2 诊断 /
 * review 汇总三处各自直接 `ledger.entries.slice(-4)` / `.filter(...)`，而宿主侧
 * `ledgerHasDoubt` 两种形状（`{entries:[…]}` 包裹 / 裸数组）都接受。裸数组时
 * `entries` undefined ⇒ 未捕获 TypeError ⇒ **整个 org-status 崩溃**（实测
 * `TypeError: ledger.entries.slice is not a function`，CB1…CB8 一行都打印不出来）。
 *
 * 修法（与宿主侧同口径）：`loadLedgerEntries` 归一（包裹 / 裸数组 / 其他形状），
 * CB2 检查、CB2 诊断、review 汇总**共用同一函数**；不可用时 CB2 输出 `[SKIP]` 并点名
 * 原因（反 fail-open：不静默当「无 DOUBT」；也反误报：采集失败不升级成熔断）。
 *
 * 本套件真 spawn `auto-fallback` / `review` 子命令，断言真实输出行。
 * ⑥ 反向自检用 `git show HEAD:…` 复制**旧实现**：裸数组夹具必须复现 TypeError
 * （证明修的是真缺陷，而包裹夹具上旧版照常触发 ⇒ 夹具本身有区分力）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS_DIR = join(ROOT, 'assets/skill/scripts');
const ORG_STATUS = join(SCRIPTS_DIR, 'org-status.mjs');

let ws: string;

beforeEach(() => {
  ws = join(tmpdir(), `anic-cb2-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(ws, '.cycles', 'gates'), { recursive: true });
  // L3：CB2 触发后 Phase 3 回退到 L2（exit 2），能观察「真触发」
  writeFileSync(join(ws, '.cycles', 'config.yml'), 'autonomy_level: L3\n');
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

/** 账本条目（与 gate-ledger.mjs 写盘形状一致；hash 只需在场，本套件不验链）。 */
function entry(gate: string, result: 'PASS' | 'FAIL', detail = 'ok'): Record<string, unknown> {
  return { gate, gateName: gate, result, detail, timestamp: '2026-01-01T00:00:00.000Z', previousHash: 'p', hash: 'h' };
}

const DOUBT_ENTRIES = [entry('G0', 'PASS'), entry('G1', 'FAIL', 'ambiguous'), entry('G2', 'PASS'), entry('G3', 'FAIL', 'ambiguous')];
const CLEAN_ENTRIES = [entry('G0', 'PASS'), entry('G1', 'PASS')];

function writeLedger(raw: unknown): void {
  writeFileSync(join(ws, '.cycles', 'gates', 'ledger.json'), typeof raw === 'string' ? raw : JSON.stringify(raw));
}

/** 跑脚本子命令，返回 exit code 与合并输出（stdout+stderr，便于断言真实文本）。 */
function run(cmd: 'auto-fallback' | 'review', script = ORG_STATUS): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [script, ws, cmd], { encoding: 'utf-8', timeout: 20000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** CB2 判定行（三态：TRIGGERED / OK / SKIP）。 */
function cb2Line(out: string): string {
  return /^\s*\[(?:TRIGGERED|OK|SKIP)\] CB2:.*$/m.exec(out)?.[0]?.trim() ?? '';
}

function detailLine(out: string): string {
  return /^\s*Detail: .*$/m.exec(out)?.[0]?.trim() ?? '';
}

/** 崩溃探针：旧实现的裸数组形态会在 stderr 抛 TypeError。 */
function crashed(out: string): boolean {
  return /TypeError|ReferenceError/.test(out);
}

describe('① 包裹形态 + 最近 4 条含 FAIL/ambiguous → CB2 触发', () => {
  it('[TRIGGERED] CB2 + detail 计数 + 降级（exit 2）', () => {
    writeLedger({ entries: DOUBT_ENTRIES, chainHead: 'x' });
    const r = run('auto-fallback');
    expect(cb2Line(r.out), `CB2 未触发：\n${r.out}`).toBe('[TRIGGERED] CB2: 门禁自动判定存疑且无法自动定论');
    expect(detailLine(r.out)).toBe('Detail: 2 ambiguous gate results');
    expect(r.code).toBe(2);
  });
});

describe('② 裸数组同数据 → 不得崩溃，CB2 结论与 ① 一致', () => {
  it('auto-fallback：无 TypeError，且与包裹形态同结论同计数', () => {
    writeLedger(DOUBT_ENTRIES);
    const r = run('auto-fallback');
    expect(crashed(r.out), `裸数组账本导致崩溃（旧缺陷复现）：\n${r.out}`).toBe(false);
    expect(cb2Line(r.out)).toContain('[TRIGGERED] CB2');
    expect(detailLine(r.out)).toBe('Detail: 2 ambiguous gate results');
    expect(r.code).toBe(2);
  });

  it('review：裸数组账本不崩，Gate Summary 统计正确', () => {
    writeLedger(DOUBT_ENTRIES);
    const r = run('review');
    expect(crashed(r.out), `review 在裸数组账本上崩溃：\n${r.out}`).toBe(false);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Passed: 2');
    expect(r.out).toContain('Failed: 2');
    expect(r.out).not.toContain('ledger unavailable');
  });
});

describe('③ 包裹形态无 doubt → 不触发', () => {
  it('[OK] CB2 + exit 0', () => {
    writeLedger({ entries: CLEAN_ENTRIES, chainHead: 'x' });
    const r = run('auto-fallback');
    expect(cb2Line(r.out)).toBe('[OK] CB2: 门禁自动判定存疑且无法自动定论');
    expect(r.out).toContain('No circuit breaker conditions triggered');
    expect(r.code).toBe(0);
  });
});

describe('④⑤ 账本缺失 / 坏 JSON / 形状不认识 → 明确 [SKIP] 并点名原因（不崩不误报）', () => {
  it('缺失：SKIP + ledger missing，exit 0，不触发熔断', () => {
    const r = run('auto-fallback');
    expect(cb2Line(r.out)).toBe('[SKIP] CB2: 门禁自动判定存疑且无法自动定论');
    expect(detailLine(r.out)).toContain('ledger unavailable — ledger missing (.cycles/gates/ledger.json)');
    expect(r.out).toContain('No circuit breaker conditions triggered');
    expect(r.code).toBe(0);
  });

  it('坏 JSON：SKIP + unparsable（点名解析原因），进程不崩', () => {
    writeLedger('[broken');
    const r = run('auto-fallback');
    expect(cb2Line(r.out)).toContain('[SKIP] CB2');
    expect(detailLine(r.out)).toContain('ledger unavailable — ledger unparsable');
    expect(crashed(r.out)).toBe(false);
    expect(r.code).toBe(0);
  });

  it('形状不认识（对象但无 entries）：SKIP + shape not recognized', () => {
    writeLedger({ foo: [] });
    const r = run('auto-fallback');
    expect(cb2Line(r.out)).toContain('[SKIP] CB2');
    expect(detailLine(r.out)).toContain('ledger shape not recognized');
    expect(r.code).toBe(0);
  });

  it('review 在账本缺失时如实标注（不伪装成 0/0 正常统计）', () => {
    const r = run('review');
    expect(r.code).toBe(0);
    expect(r.out).toContain('(ledger unavailable — ledger missing (.cycles/gates/ledger.json))');
  });
});

describe('⑥ 反向自检：把形状归一退回「直接取 .entries」→ 裸数组必崩溃（证明修的是真缺陷）', () => {
  it('回退副本裸数组 → TypeError 且无 CB 输出；回退副本包裹形态照常触发 ⇒ 夹具可区分', () => {
    // 为什么用「源码变异」而不是 `git show HEAD`：cycle-78 修复已随 ad14e22 提交，
    // HEAD 现在是**已修**版本——历史锚点会随每次 commit 腐烂（本轮实测从绿变红）。
    // 变异副本与 git 历史无关：把归一里「先判数组」的三元表达式退回旧形态
    // `parsed.entries`（裸数组上即 Array.prototype.entries 函数），即复现原始崩溃。
    const legacyDir = join(tmpdir(), `anic-cb2-legacy-${Date.now()}`);
    mkdirSync(legacyDir, { recursive: true });
    cpSync(SCRIPTS_DIR, join(legacyDir, 'scripts'), { recursive: true });
    const legacyScript = join(legacyDir, 'scripts', 'org-status.mjs');
    const src = readFileSync(legacyScript, 'utf-8');
    // 锚点用 \r?\n：技能脚本在工作区是 CRLF（git autocrlf），LF-only 锚点会恒 false
    const normalization = /  const entries = Array\.isArray\(parsed\)\r?\n    \? parsed\r?\n    : \(parsed && typeof parsed === 'object' && Array\.isArray\(parsed\.entries\) \? parsed\.entries : null\);/;
    expect(normalization.test(src), 'loadLedgerEntries 归一形态已变——请同步本反向自检锚点').toBe(true);
    writeFileSync(legacyScript, src.replace(normalization, '  const entries = parsed.entries; // LEGACY: 无形状归一'));

    try {
      // 同一裸数组夹具：回退版必崩（在函数上找 .slice）
      writeLedger(DOUBT_ENTRIES);
      const legacy = run('auto-fallback', legacyScript);
      expect(crashed(legacy.out), `回退版未崩溃，说明夹具没有区分力：\n${legacy.out}`).toBe(true);
      expect(legacy.out).toContain('is not a function');
      expect(cb2Line(legacy.out), '回退版崩溃前不应有 CB2 结论').toBe('');

      // 对照：回退版在包裹形态上照常触发 ⇒ 差异只在「账本形状归一」
      writeLedger({ entries: DOUBT_ENTRIES, chainHead: 'x' });
      expect(cb2Line(run('auto-fallback', legacyScript).out)).toContain('[TRIGGERED] CB2');

      // 新实现同裸数组夹具不崩且结论一致
      writeLedger(DOUBT_ENTRIES);
      const fixed = run('auto-fallback');
      expect(crashed(fixed.out)).toBe(false);
      expect(cb2Line(fixed.out)).toContain('[TRIGGERED] CB2');
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
