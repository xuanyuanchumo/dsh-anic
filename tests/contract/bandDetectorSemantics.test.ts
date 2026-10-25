/**
 * band-detector 语义分层契约（cycle-78 WS-B「可观测性诚实化」）——真跑脚本，非静态断言。
 *
 * 被守卫缺陷（本轮实测取证）：band-detector.mjs 原先在 `WARNING` / WE 违例时也
 * `exit 1`（本机 3674 分 / 10 热点 / 65 条 WE 违规 → exit 1）。后果：FlowTracker 把
 * 「报告送达且有告警」记成 FAILED（flowStats `band-detector 1/1 failed`），
 * `analyzeSkillHealth` 据此长期输出 degraded 建议。WE 规则 7/8 在近常数过程
 * （σ≈0.16）上必然常亮——**报告内容不该等于执行成败**。
 *
 * 修法语义（本套件逐条钉死）：
 *   默认（报告模式）成功产出报告 → exit 0（告警只是报告数据）；
 *   `--strict`（门禁模式）OVER_BUDGET / WARNING / 任意 WE 违例 → exit 1；
 *   执行失败（目录不存在 / 配置缺失 / 历史快照损坏）→ 非零且 stderr 点名原因；
 *   版本四锚 2.6.0（quick-validate 真跑）；
 *   同步入口超时 cap = 240000（纯函数直断言，不靠字符串匹配）。
 *
 * 反向自检：把脚本副本的报告模式改回 `exit 1`，① 必须变红——证明断言不是永真。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  BOOTSTRAP_STEP_TIMEOUT_MS,
  MAX_SKILL_INVOKE_TIMEOUT_MS,
  resolveSkillInvokeTimeout,
} from '../../src/host/runtime/bootstrapBudget.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS_DIR = join(ROOT, 'assets/skill/scripts');
const BAND = join(SCRIPTS_DIR, 'band-detector.mjs');
const CLEANUP: string[] = [];

afterAll(() => {
  for (const d of CLEANUP) rmSync(d, { recursive: true, force: true });
});

/** 跑脚本，返回原始结果（exitCode/stdout/stderr）。 */
function run(script: string, args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8', timeout: 20000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * 造夹具：6 个重文件（score 300/个）+ 20 个轻文件（score 2/个）。
 * total 1840 / 26 文件 → avg 70.77，2×avg ≈ 141.5 ⇒ 6 个重文件是热点（>5 → WARNING）；
 * budget 400 ⇒ 上带 460，无文件超预算（证明 WARNING 与本轮语义无关地独立触发）。
 * 历史 14 条近常数 + 1 条尖峰 ⇒ WE 规则必然报警（近常数过程规则 7/8 常亮的真实形态）。
 */
function seedFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anic-band-'));
  CLEANUP.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.cycles'), { recursive: true });
  const heavy = Array.from({ length: 100 }, (_, i) => `export function f${i}() { if (a) { return 1; } return 0; }`).join('\n') + '\n';
  for (let i = 0; i < 6; i++) writeFileSync(join(dir, 'src', `heavy${i}.ts`), heavy);
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, 'src', `light${i}.ts`), 'export function l(){return 1;}\n');
  writeFileSync(join(dir, '.cycles', 'config.yml'), 'project:\n  name: "fixture"\ncomplexity_budget: 400\n');
  const hist = Array.from({ length: 14 }, () => ({ timestamp: '2026-01-01T00:00:00.000Z', totalScore: 1840, avgScore: 70.77, fileCount: 26, overBudgetCount: 0 }));
  hist.push({ timestamp: '2026-01-01T00:00:00.000Z', totalScore: 18400, avgScore: 707.7, fileCount: 26, overBudgetCount: 0 });
  writeFileSync(join(dir, '.cycles', 'band-history.json'), JSON.stringify(hist, null, 2));
  return dir;
}

/** 干净夹具：单文件、无历史、预算宽裕 ⇒ 无任何告警（strict 模式也应 exit 0）。 */
function seedCleanFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anic-band-clean-'));
  CLEANUP.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.cycles'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export function a(){return 1;}\n');
  writeFileSync(join(dir, '.cycles', 'config.yml'), 'complexity_budget: 400\n');
  return dir;
}

describe('① 默认报告模式：告警是报告数据，成功产出即 exit 0', () => {
  it('WARNING/热点/WE 违规同时存在时仍 exit 0，且报告面完整', () => {
    const dir = seedFixture();
    const r = run(BAND, [dir]);
    expect(r.code, `默认模式退出码应为 0，实测 ${String(r.code)}；stderr=${r.err}`).toBe(0);
    expect(r.out).toContain('Complexity Band Detection Report');
    expect(r.out).toContain('Status: WARNING');
    expect(r.out).toMatch(/COMPLEXITY HOTSPOTS \(top 6\)/);
    expect(r.out).toMatch(/WESTERN ELECTRIC RULE VIOLATIONS \((\d+)\)/);
    expect(Number(/WESTERN ELECTRIC RULE VIOLATIONS \((\d+)\)/.exec(r.out)?.[1])).toBeGreaterThan(0);
    // 模式汇总行必须点名「告警清单」——可观测性靠它，不靠退出码猜
    expect(r.out).toMatch(/Mode: report \(default\) \| alarms: WARNING\(6 hotspots\), WE_VIOLATIONS\(\d+\)/);
    expect(r.out).toContain('Report mode: alarms surfaced as report data, exit 0');
    // 反向前提：默认模式**不得**打印严格门禁失败
    expect(r.err).not.toContain('STRICT GATE FAILED');
  });
});

describe('② --strict 门禁模式：同一夹具必须 exit 1 并点名告警', () => {
  it('OVER_BUDGET/WARNING/WE 违例任一命中 → exit 1', () => {
    const dir = seedFixture();
    const r = run(BAND, [dir, '--strict']);
    expect(r.code, `strict 模式退出码应为 1，实测 ${String(r.code)}`).toBe(1);
    expect(r.err).toMatch(/STRICT GATE FAILED: .*(WARNING|WE_VIOLATIONS)/);
    // 报告文本面不因门禁模式消失（CI 在失败时仍要看到完整报告）
    expect(r.out).toContain('Complexity Band Detection Report');
    expect(r.out).toContain('Status: WARNING');
  });

  it('无告警的干净夹具 → strict 仍 exit 0（门禁不是恒红）', () => {
    const dir = seedCleanFixture();
    const r = run(BAND, [dir, '--strict']);
    expect(r.code, `无告警时 strict 应 0，实测 ${String(r.code)}；stderr=${r.err}`).toBe(0);
    expect(r.out).toMatch(/alarms: none/);
  });
});

describe('③ 执行失败：非零退出且 stderr 点名原因（与告警语义分离）', () => {
  it('项目目录不存在 → exit 1，stderr 点名路径', () => {
    const missing = join(tmpdir(), 'anic-band-does-not-exist-xyz');
    const r = run(BAND, [missing]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('project directory not found');
    expect(r.err).toContain('anic-band-does-not-exist-xyz');
  });

  it('配置缺失 → exit 1，stderr 点名 .cycles/config.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anic-band-nocfg-'));
    CLEANUP.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    const r = run(BAND, [dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/No \.cycles\/config\.yml found/);
  });

  it('历史快照损坏 → exit 1 且点名文件（原先静默清空统计基线）', () => {
    const dir = seedFixture();
    writeFileSync(join(dir, '.cycles', 'band-history.json'), '{ this is not json');
    const r = run(BAND, [dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/cannot parse .*band-history\.json/);
  });

  it('历史快照非数组 → exit 1 且点名期望形状', () => {
    const dir = seedFixture();
    writeFileSync(join(dir, '.cycles', 'band-history.json'), '{"snapshots":[]}');
    const r = run(BAND, [dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/expected a JSON array of snapshots/);
  });
});

describe('④ 反向自检：把报告模式改回 exit 1，① 必须变红', () => {
  it('脚本副本返回 1 → 退出码断言能感知（证明 ① 不是永真）', () => {
    // 复制整个 scripts 目录（脚本 import ./lib/*，单文件复制会断 import 图）
    const copyRoot = mkdtempSync(join(tmpdir(), 'anic-band-mut-'));
    CLEANUP.push(copyRoot);
    cpSync(SCRIPTS_DIR, join(copyRoot, 'scripts'), { recursive: true });
    const mutated = join(copyRoot, 'scripts', 'band-detector.mjs');
    const original = readFileSync(mutated, 'utf-8');
    // 旧缺陷形态：报告模式也当失败（注意只改默认分支，不动 --strict）。
    // 用「在该行后注入 exit(1)」而不是替换 return 语句——脚本是 CRLF 文件，
    // 跨行字面量锚点会随换行风格失效（本轮踩过：LF 锚点在 CRLF 文件上恒 false）。
    const anchorRe = /(console\.log\(`Report mode: [^`]*`\);)/;
    expect(anchorRe.test(original), '报告模式打印点已被重构——请同步本反向自检的锚点').toBe(true);
    const mutatedSrc = original.replace(anchorRe, '$1\n  process.exit(1);');
    expect(mutatedSrc, '变异未生效即反向自检无效').not.toBe(original);
    writeFileSync(mutated, mutatedSrc);

    const dir = seedFixture();
    // 对照组：未变异脚本同夹具 exit 0（① 的断言输入）
    expect(run(BAND, [dir]).code).toBe(0);
    // 变异组：旧语义 exit 1 —— 若 ① 的断言对变异无感，这条就会与 ① 同步为 0
    const r = run(mutated, [dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Report mode: alarms surfaced as report data');
  });
});

describe('⑤ 技能版本四锚 2.6.0（quick-validate 真跑）', () => {
  it('版本一致跨 4 锚点且校验 PASS', () => {
    const r = run(join(SCRIPTS_DIR, 'quick-validate.mjs'), [join(ROOT, 'assets/skill')]);
    expect(r.code, `quick-validate 应 PASS：${r.out}\n${r.err}`).toBe(0);
    expect(r.out).toMatch(/Version consistent across 4 anchors: 2\.6\.0/);
    expect(r.out).toContain('VALIDATION PASSED');
  });
});

describe('⑥ 超时 cap 收敛：同步入口上限 = 自举每步预算（纯函数直断言）', () => {
  it('MAX_SKILL_INVOKE_TIMEOUT_MS 与 BOOTSTRAP_STEP_TIMEOUT_MS 同源同值', () => {
    expect(MAX_SKILL_INVOKE_TIMEOUT_MS).toBe(BOOTSTRAP_STEP_TIMEOUT_MS);
    expect(MAX_SKILL_INVOKE_TIMEOUT_MS).toBe(240_000);
  });

  it('resolveSkillInvokeTimeout：显式请求按上限收口（cycle-77 F-06 的 120000 不对称已收敛）', () => {
    expect(resolveSkillInvokeTimeout(300_000)).toBe(240_000); // 超上限 → 收到 240000
    expect(resolveSkillInvokeTimeout(240_000)).toBe(240_000);
    expect(resolveSkillInvokeTimeout(120_000)).toBe(120_000); // 旧 cap 值原样通过（不再被砍）
    expect(resolveSkillInvokeTimeout(30_000)).toBe(30_000);
    // 反向前提：旧 cap 语义（300000 → 120000）必须**不成立**
    expect(resolveSkillInvokeTimeout(300_000)).not.toBe(120_000);
  });

  it('非法值不落入 spawnSync 的「永不超时」陷阱', () => {
    expect(resolveSkillInvokeTimeout(Number.NaN)).toBe(240_000);
    expect(resolveSkillInvokeTimeout(Number.POSITIVE_INFINITY)).toBe(240_000);
    expect(resolveSkillInvokeTimeout(0)).toBe(240_000);
    expect(resolveSkillInvokeTimeout(-5)).toBe(240_000);
  });
});
