/**
 * F-05（cycle-77）文档漂移静态守卫：`scripts/run-tests.mjs` 的头注不得写死
 * 与实现脱钩的层数 / 断言数。
 *
 * 被守卫缺陷（实测）：头注自称 `[1/3] … [3/3]` 三层、"stub 宿主 21 断言"，
 * 而实现里 `STEPS` 有 4 条离线步（`--live` 时 5 条）、汇总表打印 `[1/5]`、
 * `scripts/offline-smoke.mjs` 的 `check()` 只有 20 条。注释与实现各说一套，
 * 且增层后注释从不跟着变 —— 这是**文档漂移**而非排版问题：读者按注释判断
 * "全绿=三层通过"，实际少看到一层失败面。
 *
 * 守卫双层（都带反向自检，证明有牙）：
 *   A. 头注不含硬编码层编号 / 层数 / 断言数（findStaleClaims 纯函数）；
 *   B. 运行期层号必须由 `STEPS.length` 派生（bannerCountIsDerived）——
 *      把 `[1/5]` 写死在打印里同样会随增层漂移。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER_PATH = join(ROOT, 'scripts', 'run-tests.mjs');
const SOURCE = readFileSync(RUNNER_PATH, 'utf8');

/** 取文件头部的块注释（`/**` 到其后首个 `*\/`）；取不到返回空串。 */
function headerCommentOf(src: string): string {
  const start = src.indexOf('/**');
  if (start < 0) return '';
  const end = src.indexOf('*/', start + 3);
  return end < 0 ? '' : src.slice(start, end + 2);
}

/** 漂移模式表：每项名字会出现在失败信息里，定位是"哪类硬编码"。 */
const STALE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: '硬编码层编号（形如 [1/3]）', re: /\[\s*\d+\s*\/\s*\d+\s*\]/ },
  // 排除「任一层 / 每层 / 逐层」这类**序数/泛指**用法（不是计数声明）；
  // 只把「三层 / 共 4 层」这种对总层数的自报当漂移。
  { name: '硬编码层数（形如 三层 / 4 层）', re: /(?<![任每各逐单独上下前后末首])[一二三四五六七八九十两\d]+\s*层/ },
  { name: '硬编码断言数（形如 21 断言）', re: /\d+\s*(条|个)?\s*断言/ },
];

/** 返回头注中命中的漂移类别（空数组 = 干净）。纯函数，便于反向自检。 */
function findStaleClaims(header: string): string[] {
  return STALE_PATTERNS.filter((p) => p.re.test(header)).map((p) => p.name);
}

/** 运行期层号横幅所在行（`process.stdout.write` 里的 `=== [i/N] … ===`）。 */
function bannerLineOf(src: string): string {
  return src.split('\n').find((line) => line.includes('process.stdout.write') && line.includes('=== [')) ?? '';
}

/** 横幅层号是否由 STEPS.length 派生（写死 `[1/5]` 即为 false）。 */
function bannerCountIsDerived(src: string): boolean {
  const line = bannerLineOf(src);
  return line !== '' && line.includes('STEPS.length') && line.includes('${i + 1}');
}

/** 从 `const STEPS = [...]` 抽步 id；空 = 解析失败（防"扫描集为空"的假守卫）。 */
function stepIdsOf(src: string): string[] {
  const at = src.indexOf('const STEPS = [');
  if (at < 0) return [];
  const end = src.indexOf('];', at);
  if (end < 0) return [];
  return [...src.slice(at, end).matchAll(/\bid:\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1] ?? '');
}

describe('F-05 run-tests.mjs 自描述契约', () => {
  const header = headerCommentOf(SOURCE);

  it('前置：头注与 STEPS 确实被读到（否则守卫是空转）', () => {
    expect(header.length).toBeGreaterThan(50);
    const ids = stepIdsOf(SOURCE);
    // 解析失败会让下面的断言全部"假绿"，所以先钉住扫描集非空且覆盖已知步
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(ids).toContain('validate');
    expect(ids).toContain('vitest');
    expect(ids).toContain('smoke');
  });

  it('头注不含与实现脱钩的硬编码层数/断言数', () => {
    expect(findStaleClaims(header)).toEqual([]);
  });

  it('头注把层数与断言数指向运行期事实源（STEPS/汇总表），而不是自报数字', () => {
    expect(header).toContain('STEPS');
    expect(header).toMatch(/汇总表/);
  });

  it('运行期层号由 STEPS.length 派生（增层后自动跟随，无需改注释）', () => {
    expect(bannerCountIsDerived(SOURCE)).toBe(true);
    expect(bannerLineOf(SOURCE)).toContain('STEPS.length');
  });

  it('反向自检：构造的漂移串必须全部判红（守卫有牙）', () => {
    // A 类：三种典型硬编码各自命中，且类别名字对得上
    expect(findStaleClaims(' *   [1/3] validate-dsh   DSH 规范符合性门')).toContain('硬编码层编号（形如 [1/3]）');
    expect(findStaleClaims(' *   [4/4] j0-probe（需 start-dsh-test.mjs 环境）')).toContain('硬编码层编号（形如 [1/3]）');
    expect(findStaleClaims(' *   [3/3] offline-smoke   机制冒烟（stub 宿主 21 断言）')).toContain('硬编码断言数（形如 21 断言）');
    expect(findStaleClaims(' *   offline-smoke   机制冒烟（stub 宿主 21 断言）')).toContain('硬编码断言数（形如 21 断言）');
    expect(findStaleClaims(' *   本编排器分三层：规范门 / vitest / 冒烟')).toContain('硬编码层数（形如 三层 / 4 层）');
    expect(findStaleClaims(' *   共 4 层，逐层 fail-fast')).toContain('硬编码层数（形如 三层 / 4 层）');
    // B 类：把层号写死在打印里同样判红
    const hardcodedBanner = '  process.stdout.write(`\\n=== [1/5] ${step.label} ===\\n`);';
    expect(bannerCountIsDerived(hardcodedBanner)).toBe(false);
    expect(bannerCountIsDerived(SOURCE)).toBe(true); // 对照：真实实现必须是派生形态
  });

  it('反向自检：合格的描述性头注不被误杀（避免守卫变成"禁止写中文"的噪音）', () => {
    const ok = [
      ' *   层数与断言数由 STEPS 数组与运行期汇总表决定，此处不重复计数。',
      ' *   [i/N] 逐层打印，结尾打印汇总表。',
      ' *   离线层覆盖：规范门、单元 + 契约守卫、stub 宿主冒烟、触发评估。',
    ];
    for (const text of ok) expect(findStaleClaims(text)).toEqual([]);
  });
});
