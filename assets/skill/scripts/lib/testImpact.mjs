// testImpact.mjs — 变更→测试影响域映射（cycle-97 P3-2，抽样的最后一环）
//
// 数学模型：反向可达闭包（reverse reachability closure）。
//   G = 运行时 import 图（importGraph.collectImportGraph 已提供）；
//   Δ = 变更文件集（merkle detectDetailedChanges 已提供）；
//   Impact(Δ) = { t ∈ tests : ∃ d ∈ Δ, t →* d }（测试文件反向可达变更文件）。
// 用途：**smoke 档**（≤5% 变更）时只跑 Impact(Δ) 内的测试文件（vitest 的
// 文件过滤参数），把「全量 74s」压到「受影响测试子集」。partial/full 档
// 仍跑全量——抽样纪律：档位越高越接近全量，宁可慢不可假绿。
// 诚实边界：
//   1. 动态 import 字符串拼接、装饰器元数据等静态分析盲区 → 影响域可能偏小
//      ⇒ smoke 档结论标注「影响域抽样」（报告元数据可见），不是全量等价；
//   2. Impact 为空（变更文件不被任何测试引用）→ 退化为 full（无证据不关闸）；
//   3. 测试文件定位用约定目录（tests/），与 vitest 默认 include 一致。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname, resolve } from 'node:path';

const TEST_EXTENSIONS = ['.test.ts', '.test.tsx', '.test.mjs', '.test.js'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
// 复用 importGraph 的语句分类与 specifier 解析（单一事实源，不抄第二份正则）
const { extractClassifiedSpecs } = await import('./importGraph.mjs');

/** 递归收集目录下匹配扩展名的文件（绝对路径）。 */
function walkFiles(dir, extensions) {
  if (!existsSync(dir)) return [];
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (extensions.some((ext) => entry.name.endsWith(ext))) files.push(full);
    }
  };
  walk(dir);
  return files;
}

/** 收集 tests/ 下全部测试文件（绝对路径）。 */
export function collectTestFiles(projectDir) {
  return walkFiles(join(projectDir, 'tests'), TEST_EXTENSIONS);
}

/**
 * 构建含测试目录的运行时 import 图（importGraph.collectImportGraph 只扫
 * src/ —— 影响域必须把 tests/ 的 import 边也纳入，否则测试→源码边不存在、
 * 闭包恒空（T-a/T-b 失败的根因）。结构与其返回形状一致：{ files, deps }。
 */
export function buildImpactGraph(projectDir) {
  const files = [
    ...walkFiles(join(projectDir, 'src'), SOURCE_EXTENSIONS),
    ...collectTestFiles(projectDir),
  ];
  const deps = new Map();
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const runtimeDeps = [];
    for (const { spec, kind } of extractClassifiedSpecs(content)) {
      if (kind !== 'runtime') continue; // type-only/re-export 不构成运行时影响路径
      const base = resolve(dirname(file), spec);
      const candidates = [base, ...SOURCE_EXTENSIONS.map((e) => base + e), ...SOURCE_EXTENSIONS.map((e) => join(base, 'index' + e))];
      for (const c of candidates) {
        if (existsSync(c)) { runtimeDeps.push(c); break; }
      }
    }
    deps.set(file, runtimeDeps);
  }
  return { files, deps };
}

/**
 * 反向可达闭包：从每个测试文件出发沿「被依赖」方向 BFS，
 * 标记能到达的源文件集合；变更文件落进哪个测试的可达集，该测试即在影响域。
 * @returns {Map<string, string[]>} 测试绝对路径 → 受影响的测试文件列表
 */
export function computeTestImpact(projectDir, changedFiles, graph) {
  const tests = collectTestFiles(projectDir);
  if (tests.length === 0 || changedFiles.length === 0) return new Map();

  const changedSet = new Set(changedFiles.map((f) => f.split(sep).join('/')));
  const impact = new Map();

  // graph 缺省时自建（含 tests/ 的完整图——见 buildImpactGraph 头注）
  const g = graph ?? buildImpactGraph(projectDir);

  // 反向索引：file → 直接依赖它的文件（谁 import 了我）
  const reverse = new Map();
  for (const [from, deps] of g.deps) {
    for (const to of deps) {
      if (!reverse.has(to)) reverse.set(to, []);
      reverse.get(to).push(from);
    }
  }

  for (const test of tests) {
    // BFS 从测试文件出发（测试 → src 源码方向）
    const visited = new Set();
    const queue = [test];
    let hits = [];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      const norm = cur.split(sep).join('/');
      if (changedSet.has(norm)) hits.push(norm);
      // 沿依赖方向走（test imports X → X imports Y → …）
      for (const dep of g.deps.get(cur) ?? []) {
        if (!visited.has(dep)) queue.push(dep);
      }
      // 反向也走（test 可能被 re-export 链接到变更文件）——完整闭包
      for (const dependent of reverse.get(cur) ?? []) {
        if (!visited.has(dependent)) queue.push(dependent);
      }
    }
    if (hits.length > 0) impact.set(test, hits);
  }
  return impact;
}

/**
 * smoke 档 test 命令构造：把影响域测试文件以 vitest 路径过滤参数追加到原命令。
 * 约束（诚实性）：只在原命令是 `vitest run` 形态时改写（可识别、可预测）；
 * 其它形态（自定义 runner）不动命令——退化为全量，并在 hint 里披露。
 * @param {string} testCmd - 原始 test_cmd
 * @param {string[]} impactedTests - 受影响测试文件绝对路径
 * @param {string} projectDir - 项目根（相对化路径）
 * @returns {{cmd: string, mode: 'impacted'|'full', count: number}}
 */
export function buildSmokeTestCommand(testCmd, impactedTests, projectDir) {
  // 边界字符类含 / ：命令是 `node scripts/run-tests.mjs` 形态，目标词前面是
  // 路径分隔符而非空白——(^|\s) 只认空白会让检测恒 false（P4-1 实测缺陷）。
  const isVitestRun = /(^|[\s/])vitest(\.mjs)?\s+run(\s|$)/.test(testCmd)
    || testCmd.includes('vitest/vitest.mjs run');
  // P4-1：run-tests.mjs 分片感知形态——`node scripts/run-tests.mjs` 支持
  // --files= 逗号分隔透传（包装脚本自证：仅 vitest 层分片、其它层显式 SKIP、
  // 汇总表打印 SHARD 声明——诚实性由包装脚本自己保证）。
  const isRunTests = /(^|[\s/])run-tests\.mjs(\s|$)/.test(testCmd);
  if ((!isVitestRun && !isRunTests) || impactedTests.length === 0) {
    return { cmd: testCmd, mode: 'full', count: 0 };
  }
  const rels = impactedTests.map((t) => relative(projectDir, t).split(sep).join('/'));
  if (isRunTests) {
    // 包装脚本形态：--files= 逗号分隔 + 强制 --only=vitest（只跑有意义的层，
    // 也避免把「分片 vitest 绿」误读成「其它层也绿」——汇总表会显式 SKIP 其它层）。
    const withOnly = /--only=vitest/.test(testCmd) ? testCmd : `${testCmd} --only=vitest`;
    return { cmd: `${withOnly} --files=${rels.join(',')}`, mode: 'impacted', count: rels.length };
  }
  // vitest 位置参数 = 文件过滤器（子串匹配）；命令形态保持单行（execSync 语义）
  return { cmd: `${testCmd} ${rels.join(' ')}`, mode: 'impacted', count: rels.length };
}
