// evalParallel.test.ts — cycle-97 P1/P2 并行收割器 + 抽样档位集成测试
// 钉死三个已验证行为（fixture 实测的回归防线）：
//   P1-a: --run-cmd-only 子进程模式落盘结果文件（unknown flag 曾致全灭挂起）
//   P1-b: 并行触发条件 = ≥2 命令 + 缓存未命中
//   P2-a: 抽样档位按变更比例切换（smoke ≤5% / partial ≤20% / full）
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_RUNNER = join(HERE, '..', '..', 'assets', 'skill', 'scripts', 'eval-runner.mjs');
const TMP = join(HERE, 'tmp-eval-parallel');

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 容忍并发清理 */ }
});

/** 最小可评估夹具：config 三命令全为 node -e 打印（秒级），源码 N 个文件。 */
function makeFixture(name: string, srcFileCount: number): string {
  const dir = join(TMP, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.cycles', 'intent'), { recursive: true });
  writeFileSync(join(dir, '.cycles', 'config.yml'),
    'project_name: p\n'
    + 'test_cmd: "node -e \\"process.exit(0)\\""\n'
    + 'lint_cmd: "node -e \\"process.exit(0)\\""\n'
    + 'build_cmd: "node -e \\"process.exit(0)\\""\n');
  writeFileSync(join(dir, '.cycles', 'intent', 'intent.md'), '# intent\n');
  for (let i = 0; i < srcFileCount; i++) {
    writeFileSync(join(dir, 'src', `m${i}.ts`), `export const v${i} = ${i};\n`);
  }
  return dir;
}

describe('cycle-97 P1: 并行收割器', () => {
  it('P1-a: --run-cmd-only 子进程模式落盘结果文件（旗标必须声明，否则子进程全灭）', () => {
    const dir = makeFixture('p1-child', 2);
    const out = join(dir, '.cycles', 'parallel-probe.json');
    const r = spawnSync(process.execPath, [EVAL_RUNNER, dir, '--run-cmd-only', 'test', '--run-cmd-out', out], {
      encoding: 'utf-8', timeout: 60000,
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(existsSync(out)).toBe(true);
    const payload = JSON.parse(readFileSync(out, 'utf-8'));
    expect(payload).toHaveProperty('pass');
    expect(payload).toHaveProperty('durationMs');
  });

  it('P1-b: 3 命令全量评估走并行路径且抽样/证据读数可见', () => {
    const dir = makeFixture('p1-full', 3);
    const r = spawnSync(process.execPath, [EVAL_RUNNER, dir, '--dimensions', 'E3,E4,Q3'], {
      encoding: 'utf-8', timeout: 120000,
    });
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('parallel warm-up'); // ≥2 命令 → 并行预启动
    // 元数据也进控制台（报告文件需要 cycle 目录；stdout 断言等价且更健壮）
    expect(r.stdout).toContain('sampling hint:');
    // 结果缓存（Merkle 键）落盘 = 收割器闭环
    expect(existsSync(join(dir, '.cycles', '.eval-cache.json'))).toBe(true);
  });

  it('P1-c: 单命令（E3）不触发并行（无收益），但评估照常完成', () => {
    const dir = makeFixture('p1-single', 2);
    const r = spawnSync(process.execPath, [EVAL_RUNNER, dir, '--dimensions', 'E3'], {
      encoding: 'utf-8', timeout: 120000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('parallel warm-up');
  });
});

describe('cycle-97 P2: 抽样档位', () => {
  it('P2-a: 首跑（无基线）= full', () => {
    const dir = makeFixture('p2-first', 4);
    const r = spawnSync(process.execPath, [EVAL_RUNNER, dir, '--dimensions', 'E3'], {
      encoding: 'utf-8', timeout: 120000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('full (no baseline)');
  });

  it('P2-b: 小比例变更（≤5%）= smoke 档', () => {
    const dir = makeFixture('p2-smoke', 40);
    // 基线轮
    spawnSync(process.execPath, [EVAL_RUNNER, dir, '--dimensions', 'E3'], { encoding: 'utf-8', timeout: 120000 });
    // 变更 1/41 ≈ 2.4% → smoke
    writeFileSync(join(dir, 'src', 'm0.ts'), 'export const v0 = 999;\n');
    const r = spawnSync(process.execPath, [EVAL_RUNNER, dir, '--dimensions', 'E3'], { encoding: 'utf-8', timeout: 120000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/sampling hint: smoke \(/);
  });

  it('P2-c: 大比例变更（>20%）= full 档', () => {
    const dir = makeFixture('p2-full', 10);
    spawnSync(process.execPath, [EVAL_RUNNER, dir, '--dimensions', 'E3'], { encoding: 'utf-8', timeout: 120000 });
    // 变更 5/10 = 50% → full
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, 'src', `m${i}.ts`), `export const v${i} = changed;\n`);
    const r = spawnSync(process.execPath, [EVAL_RUNNER, dir, '--dimensions', 'E3'], { encoding: 'utf-8', timeout: 120000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/sampling hint: full \(/);
  });
});
