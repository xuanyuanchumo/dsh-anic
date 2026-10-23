// importGraph.mjs — 纯 Node 项目内相对 import 图 + 环检测（零外部依赖）
//
// 背景（D-1408，cycle-14）：eval-runner 的 checkCircularDeps 原依赖 `npx madge --circular`——
// 两处主平台致命伤：① Windows 上 npx madge 触发交互式下载提示 → 恒失败 SKIP；
// ② '… 2>/dev/null || true' 在 cmd.exe 无 true 命令 → madge 非零退出（真发现环时）
// execSync 抛错进 catch → 环被静默吞成 SKIP（fail-open）。改纯 Node 相对 import 图 + DFS 环检测。
//
// cycle-72 修「再导出/类型导入被误判为运行时环」（Lead 实测，archivist/inspector 复核）：
//   旧实现只用一个 IMPORT_RE，把**所有**相对 specifier 一视同仁地当成运行时边。后果：
//   本仓「同域拆分 + 再导出以保 250 行/文件」的正当结构被 Q5 判 FAIL——实证两对：
//     src/host/runtime/invocationFeed.ts  export { attachInvocationFeed } from './invocationFeedAttach.ts'
//     src/host/runtime/bootstrapOrchestrator.ts export { runSelfBootstrapCycleAsync } from './…Async.ts'
//   这两条都是 **re-export**（仅转发绑定，不在运行时构成环）或 **type-only**（编译期擦除）。
//   把合法纪律判成违规 = 让 Q5 变成噪声，进而使自举链的 G0-Quality 永远 FAIL（真机 EXHAUSTED 根因之一）。
//
// 修法（可解释、不掩盖真环）：边分三类，**只有 runtime 边参与环检测**：
//   runtime   —— 值 import（`import x from` / `import './y'` / 动态 `import()` / `require()`）
//   re-export —— `export { … } from './y'` / `export * from './y'`（转发绑定，非运行时环）
//   type-only —— `import type …` / `export type … from`（编译期擦除，运行时不存在该边）
//   反向保证：真实运行时相互 import（a.ts ↔ b.ts）**仍然 FAIL**——有专门的差分夹具钉死。
//
// 用法：
//   const graph = collectImportGraph(projectDir);   // { files, deps, edges, stats }
//   const cycles = findCircularDeps(graph);         // 成员数组[]，可能为空
//   graph.deps  = 运行时边（向后兼容既有消费者与测试）
//   graph.edges = 全部边（含 kind，供审计/白盒查看被排除的边）

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// 相对 import 四形态（任一捕获组命中即一条候选边）：
//   import x from './y'  /  export { x } from './y'   → from 前导
//   import './y'                                          → import 前导
//   import('./y')                                         → 动态 import
//   require('./y')                                        → CJS
const IMPORT_RE =
  /(?:\bfrom\s+['"](\.[^'"]+)['"])|(?:\bimport\s+['"](\.[^'"]+)['"])|(?:\bimport\s*\(\s*['"](\.[^'"]+)['"])|(?:\brequire\s*\(\s*['"](\.[^'"]+)['"])/g;

/** 递归收集 src/ 下全部源文件（绝对路径）。与 scanSourceLines 的 walk 同形。 */
function walkSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(full));
      continue;
    }
    if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) files.push(full);
  }
  return files;
}

/** 从文件全文提取相对 specifier 列表（向后兼容入口：只取 specifier，不分类）。 */
export function extractRelativeSpecs(content) {
  const specs = [];
  for (const m of String(content).matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * 判定一条 specifier 所属语句的形态（runtime / re-export / type-only）。
 *
 * 判据是**语句前缀关键字**（而非整个文件的全局关键字）：从匹配点向前回溯到最近的
 * 语句边界（`;`、空行或文件头，上限 800 字符），只看那段前缀。
 * 这样既能覆盖多行 import（`import {
  a
} from './x'`），
 * 又不会把文件里其它地方的 `export` 误贴到本 specifier 上。
 */
export function classifyStatement(content, index) {
  const text = String(content);
  const start = Math.max(0, index - 800);
  const before = text.slice(start, index);
  // 回溯到最近语句边界之后（分号 / 空行）——只看当前语句的前缀
  const boundary = Math.max(before.lastIndexOf(';'), before.lastIndexOf(String.fromCharCode(10) + String.fromCharCode(10)));
  const prefix = before.slice(boundary + 1);
  if (/\bimport\s+type\s/.test(prefix)) return 'type-only';
  if (/\bexport\s+type\s/.test(prefix)) return 'type-only';
  if (/\bexport\s/.test(prefix)) return 're-export';
  return 'runtime';
}

/** 提取带分类的相对 import 边（白盒可见：被排除的边也如实列出）。 */
export function extractClassifiedSpecs(content) {
  const out = [];
  for (const m of String(content).matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!spec) continue;
    out.push({ spec, kind: classifyStatement(content, m.index ?? 0) });
  }
  return out;
}

/** 相对 specifier → 真实文件绝对路径；解析失败返回 null。
 *  依次尝试：原样（自带扩展名）→ 补扩展名 → 目录 index。 */
function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => base + ext),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, 'index' + ext)),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 候选不存在——继续尝试下一个
    }
  }
  return null;
}

/**
 * 构建项目 src/ 的相对 import 图。
 *
 * 返回：`deps` = **仅 runtime 边**（环检测的唯一依据，向后兼容旧消费者）；
 *      `edges` = 全部边（含 kind，供审计/白盒）；`stats` = 三类边计数。
 */
export function collectImportGraph(projectDir) {
  const srcDir = join(projectDir, 'src');
  const files = walkSourceFiles(srcDir);
  const deps = new Map();
  const edges = new Map();
  const stats = { runtime: 0, 're-export': 0, 'type-only': 0, unresolved: 0 };
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const classified = [];
    const runtimeDeps = [];
    for (const { spec, kind } of extractClassifiedSpecs(content)) {
      const resolved = resolveRelative(file, spec);
      if (!resolved) { stats.unresolved++; continue; }
      classified.push({ to: resolved, kind, spec });
      stats[kind]++;
      if (kind === 'runtime') runtimeDeps.push(resolved);
    }
    deps.set(file, runtimeDeps);
    edges.set(file, classified);
  }
  return { root: srcDir, files, deps, edges, stats };
}

/** DFS 三色标记找环；环按排序后成员集合去重（同一组节点的不同路径只报一次）。 */
export function findCircularDeps(graph) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(graph.files.map((f) => [f, WHITE]));
  const stack = [];
  const seen = new Set();
  const cycles = [];

  const dfs = (node) => {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of graph.deps.get(node) ?? []) {
      const depColor = color.get(dep);
      if (depColor === GRAY) {
        // 回边：栈中从 dep 到当前节点构成一个环
        const members = stack.slice(stack.indexOf(dep)).sort();
        const key = members.join(String.fromCharCode(8594));
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(members);
        }
      } else if (depColor === WHITE) {
        dfs(dep);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const file of graph.files) {
    if (color.get(file) === WHITE) dfs(file);
  }
  return cycles;
}
