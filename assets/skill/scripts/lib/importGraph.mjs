// importGraph.mjs — 纯 Node 项目内相对 import 图 + 环检测（零外部依赖）
//
// 背景（D-1408，cycle-14）：eval-runner 的 checkCircularDeps 原依赖
// `npx madge --circular`——两处主平台致命伤：
//   ① Windows（DSH 宿主主平台）上 npx madge 触发交互式下载提示 → 恒
//     超时/失败 → SKIP，质量门永远缺证据；
//   ② POSIX shell-ism '… 2>/dev/null || true'：cmd.exe 无 true 命令——
//     madge 非零退出（真正发现环时！）execSync 抛错进 catch → 环被静默
//     吞成 SKIP（fail-open：最需要报警的时刻恰好失明）。
//
// 本模块与 scanSourceLines 同哲学（纯 Node、可移植、无网络无脚手架）：
// walk src/ 收集源文件 → 正则提取相对 import 四形态 → 解析为绝对路径 →
// DFS 三色标记找回边环 → 环按成员集合排序去重。
// bare specifier（node_modules）不进入本图——质量门关注项目内部模块边界环。
//
// 用法：
//   const graph = collectImportGraph(projectDir);   // { files, deps }
//   const cycles = findCircularDeps(graph);         // 成员数组[]，可能为空

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// 相对 import 四形态（任一捕获组命中即一条边）：
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

/** 从文件全文提取相对 specifier 列表。 */
export function extractRelativeSpecs(content) {
  const specs = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) specs.push(spec);
  }
  return specs;
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

/** 构建项目 src/ 的相对 import 图。 */
export function collectImportGraph(projectDir) {
  const srcDir = join(projectDir, 'src');
  const files = walkSourceFiles(srcDir);
  const deps = new Map();
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const resolved = extractRelativeSpecs(content)
      .map((spec) => resolveRelative(file, spec))
      .filter(Boolean);
    deps.set(file, resolved);
  }
  return { root: srcDir, files, deps };
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
        const key = members.join('\u2192');
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
