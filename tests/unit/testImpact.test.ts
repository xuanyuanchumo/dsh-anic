// testImpact.test.ts — cycle-97 P3-2 影响域抽样单元测试
// 钉死三个分支（fixture 实测）：
//   T-a: 反向可达闭包——测试 import 变更文件 → 进影响域；无关测试不进
//   T-b: vitest run 形态命令收窄成功（位置参数追加）
//   T-c: 包装脚本形态诚实退化（不改写，mode=full）——本仓 run-tests.mjs 场景
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const libUrl = new URL('../../assets/skill/scripts/lib/testImpact.mjs', import.meta.url);
const { computeTestImpact, buildSmokeTestCommand, collectTestFiles } = await import(libUrl.href);

describe('cycle-97 P3-2: 影响域抽样（反向可达闭包）', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anic-impact-'));
    // 夹具结构：
    //   src/core.ts（被变更）
    //   src/helper.ts（import core.ts —— 间接受影响）
    //   tests/a.test.ts（import core.ts —— 直接受影响 → 应进影响域）
    //   tests/b.test.ts（import helper.ts —— 传递可达 → 应进影响域）
    //   tests/c.test.ts（无 import —— 无关 → 不进影响域）
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src', 'core.ts'), 'export const core = 1;\n');
    writeFileSync(join(dir, 'src', 'helper.ts'), "import { core } from './core.ts';\nexport const h = core + 1;\n");
    writeFileSync(join(dir, 'tests', 'a.test.ts'), "import { core } from '../src/core.ts';\nimport { it, expect } from 'vitest';\nit('a', () => { expect(core).toBe(1); });\n");
    writeFileSync(join(dir, 'tests', 'b.test.ts'), "import { h } from '../src/helper.ts';\nimport { it, expect } from 'vitest';\nit('b', () => { expect(h).toBe(2); });\n");
    writeFileSync(join(dir, 'tests', 'c.test.ts'), "import { it, expect } from 'vitest';\nit('c', () => { expect(1).toBe(1); });\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('T-a: 影响 a/b（直连/传递）不含无关 c', () => {
    const graph = undefined; // 缺省 → buildImpactGraph 自建（含 tests/ 边）
    const impact = computeTestImpact(dir, [join(dir, 'src', 'core.ts')], graph);
    const names = [...impact.keys()].map((p) => p.replace(/\\/g, '/').split('/').pop());
    expect(names).toContain('a.test.ts');
    expect(names).toContain('b.test.ts');
    expect(names).not.toContain('c.test.ts');
  });

  it('T-b: vitest run 形态收窄为位置参数（impacted 模式）', () => {
    const graph = undefined; // 缺省 → buildImpactGraph 自建（含 tests/ 边）
    const impact = computeTestImpact(dir, [join(dir, 'src', 'core.ts')], graph);
    const built = buildSmokeTestCommand('node node_modules/vitest/vitest.mjs run', [...impact.keys()], dir);
    expect(built.mode).toBe('impacted');
    expect(built.count).toBe(2);
    expect(built.cmd).toContain('a.test.ts');
    expect(built.cmd).toContain('b.test.ts');
    // 原命令前缀保留（vitest run 形态不变，只追加过滤器）
    expect(built.cmd.startsWith('node node_modules/vitest/vitest.mjs run')).toBe(true);
  });

  it('T-c: 未知包装形态诚实退化（不改写，mode=full）', () => {
    // 注意：P4-1 后 run-tests.mjs 已支持 --files= 透传（见 T-f/T-g）；此测试
    // 钉住「其它未知包装形态」仍诚实退化的兜底分支。
    const built = buildSmokeTestCommand('node scripts/custom-runner.js', [join(dir, 'tests', 'a.test.ts')], dir);
    expect(built.mode).toBe('full');
    expect(built.count).toBe(0);
    expect(built.cmd).toBe('node scripts/custom-runner.js'); // 原样，绝无追加
  });

  it('T-f: run-tests.mjs 分片感知形态（P4-1）——追加 --only=vitest --files=', () => {
    const built = buildSmokeTestCommand('node scripts/run-tests.mjs', [join(dir, 'tests', 'a.test.ts'), join(dir, 'tests', 'b.test.ts')], dir);
    expect(built.mode).toBe('impacted');
    expect(built.count).toBe(2);
    expect(built.cmd).toContain('--only=vitest');
    expect(built.cmd).toMatch(/--files=tests\/a\.test\.ts,tests\/b\.test\.ts$/);
  });

  it('T-g: run-tests.mjs 已带 --only=vitest 时不重复追加', () => {
    const built = buildSmokeTestCommand('node scripts/run-tests.mjs --only=vitest', [join(dir, 'tests', 'a.test.ts')], dir);
    expect(built.mode).toBe('impacted');
    expect(built.cmd).toMatch(/--only=vitest/);
    expect(built.cmd.match(/--only=vitest/g)?.length).toBe(1); // 恰好一次
  });

  it('T-d: 影响域为空 → full（无证据不关闸）', () => {
    const graph = undefined; // 缺省 → buildImpactGraph 自建（含 tests/ 边）
    // 变更一个不被任何测试引用的孤立文件
    writeFileSync(join(dir, 'src', 'orphan.ts'), 'export const o = 1;\n');
    const impact = computeTestImpact(dir, [join(dir, 'src', 'orphan.ts')], graph);
    expect(impact.size).toBe(0);
    const built = buildSmokeTestCommand('node node_modules/vitest/vitest.mjs run', [...impact.keys()], dir);
    expect(built.mode).toBe('full'); // 空影响域 → 不收窄
  });

  it('T-e: collectTestFiles 只认 tests/ 下 .test.* 文件', () => {
    const files = collectTestFiles(dir);
    expect(files.length).toBe(3);
    expect(files.every((f) => f.includes('tests'))).toBe(true);
  });
});
