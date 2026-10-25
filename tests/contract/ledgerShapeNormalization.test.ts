/**
 * 账本形状归一 + 流程层 cap 统一契约（cycle-79 O-03 / O-04）。
 *
 * **O-03**：技能调用上限 `MAX_SKILL_INVOKE_TIMEOUT_MS=240000` 已是单一事实源，但 4 条
 * 流程层各自写死 `Math.min(…, 120000)`——同一语义两套上限（慢机被 SIGTERM 掐断会被
 * 误读成流程失败）。修法：cap 引用常量，默认值保持各流程原语义不变。
 * **O-04**：`loadLedger` 只认包裹 `{entries:[…]}`；裸数组账本上 `.entries` 命中
 * `Array.prototype.entries`（函数）⇒ `--list` 打印「No gate entries recorded」、
 * `--verify` 打印「Total entries: 0, Valid: YES」——**把坏形状静默说成健康**。
 * 本套件真 spawn `gate-ledger.mjs`（真 IO）；反向自检取旧实现（HEAD 或源码变异）
 * 复现「0 条 + Valid: YES」，证明修的是真 fail-open。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS_DIR = join(ROOT, 'assets/skill/scripts');
const GATE_LEDGER = join(SCRIPTS_DIR, 'gate-ledger.mjs');

let ws: string;

beforeEach(() => {
  ws = join(tmpdir(), `anic-ledger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(ws, '.cycles', 'gates'), { recursive: true });
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const ledgerFile = (): string => join(ws, '.cycles', 'gates', 'ledger.json');

/** 用 lib 的真实 hash 实现造 2 条合法链（避免手算 sha256 造成假 CHAIN_BREAK）。 */
async function seedValidLedger(): Promise<{ entries: unknown[]; chainHead: string | null }> {
  const lib = await import('../../assets/skill/scripts/lib/ledger.mjs') as {
    appendEntry: (dir: string, gate: string, result: string, detail: string) => unknown;
    readLedger: (dir: string) => { entries: unknown[]; chainHead: string | null };
  };
  lib.appendEntry(ws, 'G0', 'PASS', 'ok');
  lib.appendEntry(ws, 'G1', 'FAIL', 'ambiguous');
  return lib.readLedger(ws);
}

function run(args: string[], script = GATE_LEDGER, dir = ws): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [script, dir, ...args], { encoding: 'utf-8', timeout: 20000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('① 包裹账本：--list 条数正确，--verify Valid: YES', () => {
  it('2 条合法链全字段校验通过', async () => {
    await seedValidLedger();
    const list = run(['--list']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('Gate Ledger (2 entries):');
    const verify = run(['--verify']);
    expect(verify.code).toBe(0);
    expect(verify.out).toContain('Total entries: 2');
    expect(verify.out).toContain('Valid: YES');
    expect(verify.out).toContain('All entries verified');
  });
});

describe('② 裸数组同数据：不静默 0 条，verify 结论与包裹一致', () => {
  it('--list 读到 2 条并披露归一动作；--verify 同样 Valid: YES', async () => {
    const { entries } = await seedValidLedger();
    writeFileSync(ledgerFile(), JSON.stringify(entries)); // 裸数组（宿主侧同样接受的形状）
    const list = run(['--list']);
    expect(list.code).toBe(0);
    expect(list.out, '裸数组被静默当成 0 条 = 旧 fail-open 复现').toContain('Gate Ledger (2 entries):');
    expect(list.out).toContain('ledger stored as a bare array');
    const verify = run(['--verify']);
    expect([
      verify.code, verify.out.includes('Total entries: 2'), verify.out.includes('Valid: YES'),
      verify.out.includes('chain head reconstructed from the last entry hash'),
    ]).toEqual([0, true, true, true]);
  });

  it('裸数组上追加后链条仍连贯（写路径不被误拒、不覆盖）', async () => {
    const { entries } = await seedValidLedger();
    writeFileSync(ledgerFile(), JSON.stringify(entries));
    const add = run(['--gate', 'G2', '--result', 'PASS']);
    expect(add.code, `裸数组追加失败：${add.out}`).toBe(0);
    expect(add.out).toContain('Gate G2 PASS recorded.');
    const verify = run(['--verify']);
    expect([verify.code, verify.out.includes('Total entries: 3'), verify.out.includes('Valid: YES')]).toEqual([0, true, true]);
  });
});

describe('③ 坏 JSON / 形状不认识 / 缺失：明确不可用，不崩不假绿', () => {
  it('坏 JSON：--verify 与 --list 均 [SKIP] + 原因 + exit 1（绝不打印 Valid: YES）', () => {
    writeFileSync(ledgerFile(), '[broken');
    const verify = run(['--verify']);
    expect(verify.code).toBe(1);
    expect(verify.out).toContain('[SKIP] ledger unavailable — ledger unparsable');
    expect(verify.out).not.toContain('Valid: YES');
    const list = run(['--list']);
    expect(list.code).toBe(1);
    expect(list.out).toContain('[SKIP] ledger unavailable');
    expect(list.out).not.toContain('No gate entries recorded');
  });

  it('形状不认识（对象但无 entries）：[SKIP] + shape not recognized；坏账本上追加被拒绝且不覆盖', () => {
    writeFileSync(ledgerFile(), JSON.stringify({ foo: 1 }));
    const verify = run(['--verify']);
    expect(verify.code).toBe(1);
    expect(verify.out).toContain('[SKIP] ledger unavailable — ledger shape not recognized');
    // 写路径：不可读时拒绝写入（否则整份历史被覆盖），且原文件一字不动
    writeFileSync(ledgerFile(), '[broken');
    const add = run(['--gate', 'G2', '--result', 'PASS']);
    expect(add.code).toBe(1);
    expect(add.out).toContain('Refusing to append gate entry');
    expect(readFileSync(ledgerFile(), 'utf-8')).toBe('[broken');
  });

  it('账本缺失 = 还没记录过（合法空账本，exit 0 + 空账本说明）', () => {
    rmSync(ledgerFile(), { force: true });
    const verify = run(['--verify']);
    expect([verify.code, verify.out.includes('Total entries: 0'), verify.out.includes('ledger is empty')]).toEqual([0, true, true]);
  });
});

describe('④ 反向自检：旧实现（无形状归一）在裸数组夹具上必须复现 0 条 + Valid: YES', () => {
  /** 旧实现源码：优先 `git show HEAD`（修复尚未提交时 HEAD 就是旧版）；
   * HEAD 已含修复（提交后）则**源码变异**重建旧实现——历史锚点会随每次 commit 腐烂，
   * 变异是与 git 历史无关的稳定锚点（cycle-79 实测：cycle-78 的 HEAD 版反向自检
   * 在 ad14e22 提交后由绿转红，缺陷其实早已修好）。 */
  const legacySources = (): { lib: string; cli: string; origin: 'git-head' | 'mutated' } => {
    const show = (rel: string): string => {
      const r = spawnSync('git', ['show', `HEAD:assets/skill/scripts/${rel}`], { cwd: ROOT, encoding: 'utf-8', timeout: 20000 });
      return r.status === 0 ? (r.stdout ?? '') : '';
    };
    const headLib = show('lib/ledger.mjs');
    const headCli = show('gate-ledger.mjs');
    if (headLib && headCli && !headLib.includes('export function readLedger')) {
      return { lib: headLib, cli: headCli, origin: 'git-head' };
    }
    // 变异：把 readLedger 退回「只认包裹形态」（裸数组的 .entries 命中原型方法）
    const curLib = readFileSync(join(SCRIPTS_DIR, 'lib', 'ledger.mjs'), 'utf-8');
    const start = curLib.indexOf('export function readLedger(projectDir) {');
    const end = curLib.indexOf('/** 兼容旧签名');
    expect(start, 'readLedger 未找到——反向自检锚点失效').toBeGreaterThan(-1);
    expect(end, 'readLedger 尾部锚点失效').toBeGreaterThan(start);
    const legacyFn = `export function readLedger(projectDir) {
  const ledgerPath = ledgerPathFor(projectDir);
  if (!existsSync(ledgerPath)) return { ok: true, shape: 'missing', entries: [], chainHead: null, reason: null };
  const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
  return { ok: true, shape: 'wrapped', entries: parsed.entries, chainHead: parsed.chainHead ?? null, reason: null };
}

`;
    return {
      lib: curLib.slice(0, start) + legacyFn + curLib.slice(end),
      cli: readFileSync(GATE_LEDGER, 'utf-8'),
      origin: 'mutated',
    };
  };

  it('旧代码 fail-open 实锤；且旧代码在包裹夹具上正常（证明差异只在形状归一）', async () => {
    const legacy = legacySources();
    expect(['git-head', 'mutated'], '旧实现来源必须是 HEAD 或变异副本').toContain(legacy.origin);
    const legacyDir = join(tmpdir(), `anic-ledger-legacy-${Date.now()}`);
    mkdirSync(legacyDir, { recursive: true });
    cpSync(SCRIPTS_DIR, join(legacyDir, 'scripts'), { recursive: true });
    writeFileSync(join(legacyDir, 'scripts', 'lib', 'ledger.mjs'), legacy.lib);
    const legacyCli = join(legacyDir, 'scripts', 'gate-ledger.mjs');
    writeFileSync(legacyCli, legacy.cli);

    try {
      // 裸数组夹具（新实现：2 条正常；旧实现：0 条 + Valid: YES）
      const { entries } = await seedValidLedger();
      writeFileSync(ledgerFile(), JSON.stringify(entries));
      const legacyList = run(['--list'], legacyCli);
      expect(legacyList.out, '旧实现应把裸数组说成空账本（fail-open 复现）').toContain('No gate entries recorded.');
      const legacyVerify = run(['--verify'], legacyCli);
      expect(legacyVerify.out).toContain('Total entries: 0');
      expect(legacyVerify.out).toContain('Valid: YES');
      expect(legacyVerify.code).toBe(0);

      // 对照：同一批条目写成包裹形态，旧实现能正常读 2 条 ⇒ 差异确实只在形状归一
      writeFileSync(ledgerFile(), JSON.stringify({ entries, chainHead: null }));
      expect(run(['--list'], legacyCli).out).toContain('Gate Ledger (2 entries):');
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe('⑤ 静态守卫：4 条流程的 cap 必须引用单一常量，且无裸 120000 cap', () => {
  const CASES: Array<{ file: string; defaultMs: string }> = [
    { file: 'src/host/flows/archiveFlow.ts', defaultMs: '60000' },
    { file: 'src/host/flows/gateCheckFlow.ts', defaultMs: '120000' },
    { file: 'src/host/flows/hitlFlow.ts', defaultMs: '60000' },
    { file: 'src/host/flows/macroPhaseFlow.ts', defaultMs: '120000' },
  ];

  /** 去注释（守卫只看代码：注释里必须允许出现「原先写死 120000」这类历史说明）。 */
  const codeOnly = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  /** cap 位（Math.min 第二参）的表达式；默认值位（?? 右）不参与判定。 */
  const capExprRe = /Math\.min\(\s*opts\.timeoutMs\s*\?\?\s*(\d+)\s*,\s*([^)]+?)\s*\)/;
  /** 裸数字 cap 检测器（只判 cap 位，不误伤 `?? 120000` 默认值）。 */
  const bareCapRe = /Math\.min\([^)]*,\s*120_?000\s*\)/;

  it.each(CASES)('$file：cap = MAX_SKILL_INVOKE_TIMEOUT_MS，默认值保持 $defaultMs', ({ file, defaultMs }) => {
    const code = codeOnly(readFileSync(join(ROOT, file), 'utf-8'));
    // 符号被 import（不写模块路径字面量：静态 import 图扫描器会把测试里的字符串当真实边）
    expect(code).toMatch(/import\s*\{[^}]*\bMAX_SKILL_INVOKE_TIMEOUT_MS\b[^}]*\}/);
    const m = capExprRe.exec(code);
    expect(m, `${file} 未找到 Math.min(opts.timeoutMs ?? …) 形态`).toBeTruthy();
    expect(m?.[1], `${file} 默认值被改动（应保持 ${defaultMs}）`).toBe(defaultMs);
    expect(m?.[2], `${file} cap 仍写裸数字（应引用常量）`).toBe('MAX_SKILL_INVOKE_TIMEOUT_MS');
    expect(bareCapRe.test(code), `${file} 仍存在裸 120000 cap`).toBe(false);
  });

  it('反向自检：守卫对旧形态必须判红（防哑守卫）', () => {
    const oldArchive = 'const timeoutMs = Math.min(opts.timeoutMs ?? 60000, 120000);';
    expect(bareCapRe.test(oldArchive)).toBe(true);
    expect(capExprRe.exec(oldArchive)?.[2]).toBe('120000');
    // 正常形态不误报；`?? 120000` 作为默认值合法（gateCheck/macroPhase 原语义）
    const fixed = 'const timeoutMs = Math.min(opts.timeoutMs ?? 120000, MAX_SKILL_INVOKE_TIMEOUT_MS);';
    expect(bareCapRe.test(fixed)).toBe(false);
    expect(capExprRe.exec(fixed)?.[2]).toBe('MAX_SKILL_INVOKE_TIMEOUT_MS');
  });

  it('常量本身仍是 240000（与技能调用入口同一事实源）', async () => {
    const budget = await import('../../src/host/runtime/bootstrapBudget.ts') as {
      MAX_SKILL_INVOKE_TIMEOUT_MS: number;
      BOOTSTRAP_STEP_TIMEOUT_MS: number;
    };
    expect(budget.MAX_SKILL_INVOKE_TIMEOUT_MS).toBe(240_000);
    expect(budget.MAX_SKILL_INVOKE_TIMEOUT_MS).toBe(budget.BOOTSTRAP_STEP_TIMEOUT_MS);
    // 反向前提：旧 cap 值必须**不**成立（证明这条断言真能失败）
    expect(budget.MAX_SKILL_INVOKE_TIMEOUT_MS).not.toBe(120_000);
  });

  it('账本形状归一实现存在且被 CLI 使用（existsSync 兜底，防文件被误删后静默变绿）', () => {
    expect(existsSync(join(SCRIPTS_DIR, 'lib', 'ledger.mjs'))).toBe(true);
    const lib = readFileSync(join(SCRIPTS_DIR, 'lib', 'ledger.mjs'), 'utf-8');
    const cli = readFileSync(GATE_LEDGER, 'utf-8');
    expect(lib).toMatch(/export function readLedger/);
    expect(lib).toContain('Array.isArray(parsed)'); // 先判数组，避免 Array.prototype.entries 遮蔽
    expect(cli).toMatch(/readLedger/);
    expect(cli).toContain('[SKIP] ledger unavailable');
  });
});
