/**
 * F-06 收敛契约（cycle-77 T4-C）：自举每步超时**只有一份默认值**。
 *
 * 被守卫缺陷（实测 grep）：单一事实源 `BOOTSTRAP_STEP_TIMEOUT_MS=240000` 已存在于
 * `runtime/bootstrapBudget.ts`，但三个 runtime 编排函数仍各自写死 `timeoutMs = 60000`：
 *   - bootstrapOrchestrator.ts:66（同步编排器）
 *   - bootstrapOrchestratorAsync.ts:37（异步编排器）
 *   - bootstrapEngineIntegration.ts:99（引擎接入）
 * 生产调用方总是显式传第三参，所以 60000 此前**不可达**——但这正是最坏的形态：
 * 任何新调用方（脚本 / 测试 / 未来入口）都会静默继承 60s，而 eval-runner 要跑
 * 整条测试金字塔（≈57s）+ 多层 spawn，60s 必超 ⇒ 把「预算不足」伪装成「评估 0 分」
 * （.cycles/flow-tracker.json 里 eval-runner durationMs=60009 / TIMEOUT 的真机证据）。
 *
 * 本套件钉两件事：
 *   1. 默认解析值 == 240000（数值契约，不是文字）；
 *   2. 三个 runtime 文件静态守卫：不得再出现裸 `60000` 作默认值，必须引用同一常量
 *      （反向自检：构造违例源码必须判红，防守卫哑掉）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_STEP_TIMEOUT_MS, resolveBootstrapStepTimeout } from '../../src/host/runtime/bootstrapBudget.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** 三个曾各自写死 60000 的 runtime 文件（收敛面，逐条可查）。 */
const RUNTIME_FILES = [
  'src/host/runtime/bootstrapOrchestrator.ts',
  'src/host/runtime/bootstrapOrchestratorAsync.ts',
  'src/host/runtime/bootstrapEngineIntegration.ts',
];

/** 静态守卫：源码里不得出现「字面量 60000 作形参默认值」或独立字面量赋值。 */
function findBare60000Defaults(src: string): string[] {
  const hits: string[] = [];
  // 形参默认值：timeoutMs = 60000 / timeoutMs = 60_000
  const defaultRe = /timeoutMs\s*=\s*(60_000|60000)\b/g;
  let m: RegExpExecArray | null = defaultRe.exec(src);
  while (m !== null) {
    hits.push(m[0]);
    m = defaultRe.exec(src);
  }
  return hits;
}

describe('默认值数值契约', () => {
  it('resolveBootstrapStepTimeout(undefined) === 240000（不是 60000）', () => {
    expect(resolveBootstrapStepTimeout(undefined)).toBe(240_000);
    expect(resolveBootstrapStepTimeout(undefined)).toBe(BOOTSTRAP_STEP_TIMEOUT_MS);
    // 反向前提：旧默认值必须**不**满足（证明这条断言真能失败）
    expect(resolveBootstrapStepTimeout(undefined)).not.toBe(60_000);
  });

  it('显式传参优先语义未被收敛动作破坏', () => {
    expect(resolveBootstrapStepTimeout(12_345)).toBe(12_345);
    expect(resolveBootstrapStepTimeout(0)).toBe(BOOTSTRAP_STEP_TIMEOUT_MS);
    expect(resolveBootstrapStepTimeout('90000')).toBe(BOOTSTRAP_STEP_TIMEOUT_MS);
  });
});

describe('静态守卫：三个 runtime 编排文件不得再有第二份默认值', () => {
  it.each(RUNTIME_FILES)('%s 引用同一常量且无裸 60000 默认值', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf-8');
    // 只断言「符号被 import」与「默认值引用同一符号」——不把带 ./ 的模块路径
    // 写进测试源码：G-IND 守卫会把源码里的相对 specifier 字面量当真实 import
    // 解析，从而把**测试自己的字符串**误判成逃逸（cycle-77 实测）。
    expect(src).toMatch(/import\s*\{[^}]*\bBOOTSTRAP_STEP_TIMEOUT_MS\b[^}]*\}/);
    expect(src).toMatch(/timeoutMs\s*=\s*BOOTSTRAP_STEP_TIMEOUT_MS/);
    expect(findBare60000Defaults(src)).toEqual([]);
  });

  it('反向自检：守卫对旧违例形态必须判红（防哑守卫）', () => {
    expect(findBare60000Defaults('export function f(a: number, timeoutMs = 60000) {}')).toEqual(['timeoutMs = 60000']);
    expect(findBare60000Defaults('timeoutMs = 60_000,')).toEqual(['timeoutMs = 60_000']);
    // 正常形态不误报
    expect(findBare60000Defaults('timeoutMs = BOOTSTRAP_STEP_TIMEOUT_MS,')).toEqual([]);
  });

  it('消费面诚实：bootstrapBudget 头注如实记录「对称性已收敛」（cycle-78 WS-B）', () => {
    const budget = readFileSync(join(ROOT, 'src/host/runtime/bootstrapBudget.ts'), 'utf-8');
    // 必须如实记录 cycle-77 的 runtime 收敛（三个文件 + 单一常量）
    expect(budget).toMatch(/bootstrapEngineIntegration\.ts/);
    expect(budget).toMatch(/cycle-77/);
    // cycle-78 起该缺口**已收敛**：头注不得再声称「未在本轮收敛」（那是过时事实，
    // 与源码里已存在的 MAX_SKILL_INVOKE_TIMEOUT_MS 矛盾——注释撒谎比没注释更坏）
    expect(budget).toMatch(/已收敛/);
    expect(budget).toMatch(/MAX_SKILL_INVOKE_TIMEOUT_MS/);
    expect(budget).not.toMatch(/未在本轮收敛/);
  });

  it('同步/异步两入口 cap 已对称：skillInvoker 不再写死 120000', () => {
    const invoker = readFileSync(join(ROOT, 'src/host/skillInvoker.ts'), 'utf-8');
    // 守卫必须只看**代码**、不看注释：本文件头注要如实记录「原写死 120000 cap」的
    // 缺陷历史，若把注释也当违例，守卫会与「诚实注释」互相排斥（cycle-78 实测踩到）。
    const codeOnly = invoker.replace(/^\s*\/\/[^\n]*/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const oldCapRe = /Math\.min\(timeoutMs,\s*120000\)/;
    // 反向前提：旧违例形态在**代码**上必须被判红（证明这条断言真能失败）
    expect(oldCapRe.test(codeOnly), 'skillInvoker 仍写死 120000 cap —— 同步入口预算会被砍半').toBe(false);
    expect(oldCapRe.test('timeout: Math.min(timeoutMs, 120000),')).toBe(true);
    // 收敛形态：统一走上限纯函数（名字与 import 都要在）
    expect(invoker).toMatch(/resolveSkillInvokeTimeout/);
    expect(codeOnly).toMatch(/from\s*'\.\/runtime\/bootstrapBudget\.ts'/);
  });

  /*
   * cycle-108 回归钉（真机实测发现）：`bootstrapTrackedRunners.ts` 在 cycle-96 下沉时
   * 把 `60000` 作为**位置参数**搬了过来 —— 它不是 `timeoutMs = 60000` 形态，所以上面
   * `findBare60000Defaults` 扫不到，P0-BOOTSTRAP-STEP-TIMEOUT 在 HTTP 路由路径静默复发。
   * 证据：沙箱真机 `POST /anic/self/evaluate` → durationMs=60028 / exit=-1 /
   * outcome.state='not-run'（而工具路径用 240s 正常）。
   */
  it('tracked runners（HTTP 路由执行体）必须用单一预算常量，不得有位置参数裸 60000', () => {
    const rel = 'src/host/runtime/bootstrapTrackedRunners.ts';
    const src = readFileSync(join(ROOT, rel), 'utf-8');
    // 注释里允许出现 60000（历史记录），只看代码
    const codeOnly = src.replace(/^\s*\/\/[^\n]*/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).toMatch(/import\s*\{[^}]*\bBOOTSTRAP_STEP_TIMEOUT_MS\b[^}]*\}/);
    expect(codeOnly).toMatch(/\bBOOTSTRAP_STEP_TIMEOUT_MS\b/);
    // 反向前提：旧违例形态必须能被这条正则命中
    expect(/,\s*60000\s*,/.test('target.roots, 60000, trackerState')).toBe(true);
    expect(/,\s*60000\s*,/.test(codeOnly), '路由执行体仍把 60000 当位置参数传 —— 自举每步预算被砍到 1/4').toBe(false);
  });
});
