#!/usr/bin/env node
/**
 * dsh-anic 覆盖证据链执行器（cycle-79 WS-2）：`node scripts/coverage.mjs`。
 *
 * 被守卫缺陷：`.cycles/config.yml` 的 `gates.G2.coverage_threshold`（lines 80 / branches 65）
 * 长期只有声明、没有测量——`@vitest/coverage-v8` 从未安装（require.resolve 直接失败），
 * G2 实际只查测试报告与 journey 覆盖。"声明阈值却不测量"= 装饰性声明（与
 * "没有证据 ≠ 通过"纪律冲突）。本脚本把测量面接上，并把结果落到循环工件目录。
 *
 * 职责（单一）：解析 vitest → 跑 `--coverage` → 读 json-summary → 打印四指标与最差文件 →
 * **现场阈值判定**（数字最新鲜的这一刻由脚本把关，退出码 1 表示未达标）。
 *   - 报告目录**不在此硬编码**：从 vitest.config.ts 的 `reportsDirectory` 正则提取，
 *     避免"脚本写一份、配置写一份"的漂移（coverageEvidenceContract 同时钉两处一致）。
 *   - 阈值**不在此硬编码**：读 `.cycles/config.yml` 的 `gates.G2.coverage_threshold`
 *     （唯一声明源）；读不到 = 配置形状漂移 → exit 2，绝不猜值或放宽。
 *   - 测试失败时仍打印已产出的摘要（如实反映当时状态），退出码沿用 vitest 的。
 *   - 摘要缺失 → 退出 3（响亮失败，绝不打印假数字）。
 *
 * 与契约测试的分工（重要）：`coverageEvidenceContract` 在测试**进行中**运行，此时本轮摘要
 * 还没生成（vitest 的 clean 在 start() 阶段），所以它守护的是"上一次已落盘的证据"；而
 * "本轮数字是否达标"只能在本次运行结束后判定——那就是本脚本第 4 步。两者合起来才完整。
 *
 * 用法：
 *   node scripts/coverage.mjs                        # 全量测试 + coverage + 阈值判定
 *   node scripts/coverage.mjs tests/unit/x.test.ts   # 透传给 vitest 的过滤参数（局部测量，不判阈值意义有限）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(PLUGIN_ROOT, 'vitest.config.ts');
const require = createRequire(join(PLUGIN_ROOT, 'package.json'));

/** 向上找最近一个含 vitest.mjs 的 node_modules（本仓自带；缺失时给出可执行提示）。 */
function findVitest() {
  let cur = PLUGIN_ROOT;
  for (let i = 0; i < 6; i++) {
    const candidate = join(cur, 'node_modules', 'vitest', 'vitest.mjs');
    if (existsSync(candidate)) return candidate;
    const next = dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return null;
}

/** 从 vitest.config.ts 提取 reportsDirectory（唯一事实源在配置里，脚本不重复声明）。 */
function reportsDirectoryOf(configPath) {
  if (!existsSync(configPath)) return null;
  const m = /reportsDirectory:\s*'([^']+)'/.exec(readFileSync(configPath, 'utf8'));
  if (!m?.[1]) return null;
  return isAbsolute(m[1]) ? m[1] : join(PLUGIN_ROOT, m[1]);
}

/** 百分比展示：istanbul 的 pct 可能是数字或 'Unknown'（无计量项），统一成两位小数。 */
function pct(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : String(value);
}

/** 打印 json-summary 的四指标 + 覆盖最差 5 个文件（line pct 升序，同值按路径）。 */
function printSummary(summaryPath) {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const total = summary.total;
  if (!total) {
    console.error(`[coverage] ${summaryPath} 缺少 total 字段——摘要格式异常。`);
    process.exit(3);
  }
  console.log('\n=== coverage 四指标（真实测量，来源 coverage-summary.json）===');
  for (const key of ['lines', 'statements', 'functions', 'branches']) {
    const m = total[key];
    console.log(`  ${key.padEnd(10)} ${pct(m?.pct).padStart(8)}   (${String(m?.covered ?? '?')}/${String(m?.total ?? '?')})`);
  }
  const files = Object.entries(summary)
    .filter(([k]) => k !== 'total')
    .map(([file, m]) => {
      const linePct = typeof m.lines?.pct === 'number' ? m.lines.pct : 100;
      const branchPct = typeof m.branches?.pct === 'number' ? m.branches.pct : 100;
      return { file: relative(PLUGIN_ROOT, file).replace(/\\/g, '/'), linePct, branchPct };
    });
  console.log('\n=== 覆盖最差 5 文件（lines 升序）===');
  for (const f of files.sort((a, b) => a.linePct - b.linePct || a.file.localeCompare(b.file)).slice(0, 5)) {
    console.log(`  lines ${f.linePct.toFixed(2).padStart(6)}%  branches ${f.branchPct.toFixed(2).padStart(6)}%  ${f.file}`);
  }
  console.log(`\n  （共 ${files.length} 个源码文件计入分母）`);
  return {
    lines: typeof total.lines?.pct === 'number' ? total.lines.pct : null,
    branches: typeof total.branches?.pct === 'number' ? total.branches.pct : null,
  };
}

/** 读 gates.G2.coverage_threshold 的声明值（唯一声明源；与契约测试读同一文件同一形状）。 */
function readThresholds() {
  const configPath = join(PLUGIN_ROOT, '.cycles', 'config.yml');
  if (!existsSync(configPath)) return null;
  const m = /coverage_threshold:\s*\n\s*(?:#.*\n\s*)*lines:\s*(\d+)\s*\n\s*(?:#.*\n\s*)*branches:\s*(\d+)/
    .exec(readFileSync(configPath, 'utf8'));
  return m ? { lines: Number(m[1]), branches: Number(m[2]) } : null;
}

/**
 * 在**本次运行结束后**现场判定阈值（此时数字才是新鲜的）。
 * 契约测试在测试过程中跑，只能看到"上一次完成的证据"，所以最新鲜这一关必须在这里守。
 */
function thresholdVerdict(metrics, thresholds) {
  console.log('\n=== 阈值判定（声明源 .cycles/config.yml → gates.G2.coverage_threshold）===');
  let passed = true;
  for (const key of ['lines', 'branches']) {
    const actual = metrics[key];
    const limit = thresholds[key];
    const ok = typeof actual === 'number' && actual >= limit;
    if (!ok) passed = false;
    console.log(`  ${key.padEnd(9)} ${pct(actual).padStart(8)} ${ok ? '≥' : '<'} ${String(limit)}%  ${ok ? '✅ PASS' : '❌ FAIL'}`);
  }
  return passed;
}

// 1) 前置：vitest 与 v8 provider 都必须可用；缺一即停，绝不用假数据顶替
const vitestMjs = findVitest();
if (!vitestMjs) {
  console.error('[coverage] 找不到 vitest —— 请先在插件根 `pnpm install`。');
  process.exit(2);
}
try {
  require.resolve('@vitest/coverage-v8/package.json');
} catch {
  console.error('[coverage] 缺少 @vitest/coverage-v8 —— 先 `pnpm add -D @vitest/coverage-v8@3.2.7`（须与 vitest 同版本）。');
  process.exit(2);
}
const reportsDir = reportsDirectoryOf(CONFIG);
if (!reportsDir) {
  console.error(`[coverage] 无法从 ${CONFIG} 解析 reportsDirectory —— 配置形状变了，先修配置再测量。`);
  process.exit(2);
}

// 2) 跑真实测量（stdio inherit：测试输出与 coverage text-summary 都直达终端）
// cycle-79：注入 DSH_ANIC_COVERAGE=1 —— v8 插桩会让「性能预算棘轮」实测从 ~535ms 涨到 ~2.7s
// （覆盖统计开销，不是算法回退）。该标志让**仅插桩运行**放宽预算；常规测试仍守 2500ms。
const extra = process.argv.slice(2);
const res = spawnSync(
  process.execPath,
  [vitestMjs, 'run', '--coverage', '--config', CONFIG, '--root', PLUGIN_ROOT, ...extra],
  { stdio: 'inherit', cwd: PLUGIN_ROOT, windowsHide: true, env: { ...process.env, DSH_ANIC_COVERAGE: '1' } },
);

// 3) 读机器可读摘要（契约测试读同一份文件；缺失即响亮失败）
const summaryPath = join(reportsDir, 'coverage-summary.json');
if (!existsSync(summaryPath)) {
  console.error(`[coverage] 未生成 ${summaryPath}（vitest 退出码 ${String(res.status ?? '?')}）——无证据即失败。`);
  process.exit(3);
}
const metrics = printSummary(summaryPath);

// 4) 现场阈值判定：声明值读不到 = 配置形状漂移，停下修配置（不猜、不放宽）
const thresholds = readThresholds();
if (!thresholds) {
  console.error('[coverage] 无法从 .cycles/config.yml 读 gates.G2.coverage_threshold —— 阈值语义丢失，先修配置。');
  process.exit(2);
}
const thresholdsPassed = thresholdVerdict(metrics, thresholds);
if (!thresholdsPassed) console.error('\n[coverage] 覆盖低于声明阈值：按纪律**不许下调阈值**，先补测试或登记技术债（见 docs/agents/测试指南.md §9）。');
process.exit(thresholdsPassed ? (res.status ?? 1) : 1);
