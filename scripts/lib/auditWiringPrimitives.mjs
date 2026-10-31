/**
 * 接线审计的**判据原语**（cycle-94 · 从 `audit-wiring.mjs` 拆出，守 ≤250 行纪律）。
 *
 * ## 为什么拆（职责，不是行数）
 *
 * `audit-wiring.mjs` 混了三件事：① **判据**（什么算死导出/幽灵路由）② **编排**
 * （先扫什么再对账什么）③ **呈现**（报告与退出码）。拆开后本文件只回答
 * 「**怎么判**」——它是整个审计的**证据面**，值得被单独审阅：判据一旦改错，
 * 审计就会在无声中给出错误的"0 条断点"。
 *
 * ## 判据的三条纪律（与闭环体检同源，避免两套假绿）
 *
 * ① **去注释**：复用 `src/host/closureAudit/textScan.ts` 的 `stripComments`（单一实现），
 *    注释里提到一个名字**不是**消费 —— 实测正是这条口径把某条"引用"（只存在于
 *    一句注释里）剥掉，才暴露出它真没人用。
 * ② **不匹配自身**：审计器的输入域包含审计器自己。自检探针名一律**拼接构造**
 *    （见 `audit-wiring.mjs` 的 CANARY 段注释），否则脚本源码本身就成了"引用"。
 * ③ **测试不算生产消费**：`tests/` 里的引用只证明"能被用"，不证明"有人在用"。
 *    三类消费面因此分列：production / testOnly / selfOnly。
 *
 * ## 边界
 *
 * 零 IO 依赖注入：`texts` 是「相对路径 → 文件内容」的 Map，由调用方备好。
 * 本模块**不读盘**，因此每条判据都可被确定性单测（喂两三条假文件即可）。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 扫描域（与闭环体检一致：只读代码面，跳过产物与依赖）。 */
export const SCAN_DIRS = ['src', 'tests', 'scripts', 'bin', 'assets'];
export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cycles', 'test-results', 'coverage', '.dsh']);
export const CODE_EXT = /\.(ts|tsx|mjs|js)$/;

/** 本域（cycle-94 WS-D 的裁决范围）：P0 只在这里生效 —— 见 `audit-wiring.mjs` 头注「三级严重度」。 */
export const OWNED_PREFIXES = [
  'src/host/closureAudit/',
  'src/host/routes/closureAuditRoute.ts',
  'src/host/routes/lifecycleMetricsRoute.ts',
  'src/client/features/closure/',
  'src/client/features/diagnostics/',
];

/** 递归收集代码文件（相对根、/ 分隔，确定性排序）。 */
export function walk(dir, base, out = []) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries.sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const rel = base === '' ? name : base + '/' + name;
    let isDir = false;
    try { isDir = statSync(abs).isDirectory(); } catch { continue; }
    if (isDir) walk(abs, rel, out);
    else if (CODE_EXT.test(name)) out.push(rel);
  }
  return out;
}

/**
 * 标识符倒排索引：name → Map<file, 出现次数>。
 *
 * 先统计**次数**（而不是只记存在性）：同一文件里除声明行之外**还有出现**即
 * 「文件内自用」——那是有意义的内部接线，不是孤儿。只看存在性会把 `channelDeclaredCounts`
 * （定义 + 同文件调用）误报成死导出。
 */
export function buildOccurrences(texts) {
  const occ = new Map();
  const ID = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  for (const [rel, text] of texts) {
    for (const m of text.matchAll(ID)) {
      let perFile = occ.get(m[0]);
      if (perFile === undefined) { perFile = new Map(); occ.set(m[0], perFile); }
      perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
    }
  }
  return occ;
}

/** 导出清单：只认 `export function` / `export const` / `export async function`（见头注边界）。 */
export function collectExports(texts) {
  const out = [];
  const RE = /^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const [rel, text] of texts) {
    if (!rel.startsWith('src/')) continue;
    for (const m of text.matchAll(RE)) out.push({ name: m[1], file: rel });
  }
  return out;
}

/**
 * 三态判定一条导出。
 *
 * @returns {'dead'|'selfOnly'|'testOnly'|'used'}
 *   dead     = 全仓（去注释后）除声明行外零出现 ⇒ 客观死代码
 *   selfOnly = 只有本文件内部在用 ⇒ 导出多余但功能活着（不是缺口）
 *   testOnly = 只有 tests/scripts/bin 在用 ⇒ 测试缝 / 工具缝
 */
export function judgeExport(exp, occ) {
  const perFile = occ.get(exp.name);
  if (perFile === undefined) return 'dead';
  const others = [...perFile.keys()].filter((f) => f !== exp.file);
  const selfCount = perFile.get(exp.file) ?? 0;
  if (others.length === 0) {
    // 声明行本身占 1 次；多出来的次数才是文件内真实调用。
    return selfCount <= 1 ? 'dead' : 'selfOnly';
  }
  if (others.every((f) => !f.startsWith('src/'))) return 'testOnly';
  return 'used';
}

/**
 * 从带查询串/模板的 URL 里剥出路径本体（`/anic/api/x?limit=1` → `/anic/api/x`）。
 *
 * ⚠️ 这里**不能**直接写含反引号的正则字面量 —— 本脚本的输入域包含它自己，
 * 而 `stripComments` 不识别正则字面量（见 i18nClosure 头注同一教训）：正则里的
 * 反引号会被当成模板串开场 ⇒ 其后所有注释**不再被剥掉** ⇒ 本脚本注释里举的
 * `/anic/fixture/x` 示例会变成「幽灵路由」。实测踩到，故按仓库惯例用
 * `String.fromCharCode` 拼字符类。
 */
export const URL_STOP = new RegExp('[?#' + '$' + String.fromCharCode(96) + ']');
export function pathOf(raw) {
  const q = raw.search(URL_STOP);
  const p = q < 0 ? raw : raw.slice(0, q);
  return p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p;
}

/**
 * 生产消费面白名单（与闭环体检 `routeConsumerUniverse` **同口径**）。
 *
 * 为什么必须排除 tests/assets：测试里满是 `/anic/fixture/x`、`/anic/probe/ghost` 这类
 * **故意不存在的端点**（它们要验证「幽灵必须被点名」）。若把测试算消费面，
 * P0 会一次性冒出 20 条假幽灵 ⇒ 棘轮恒红 ⇒ 被学会忽略（本仓既有教训）。
 * 注册层自身（路由文件 / 聚合器 / 通道声明表）同样是**回声**，不是消费方。
 */
export function isProductionConsumer(rel) {
  if (rel.startsWith('src/host/routes/') || rel === 'src/host/snapshotRoute.ts') return false;
  if (rel === 'src/host/closureAudit/channelRegistry.ts') return false;
  if (rel.startsWith('tests/') || rel.startsWith('assets/')) return false;
  if (rel.startsWith('locale/') || rel.startsWith('docs/')) return false;
  return /^(src|scripts|bin)\//.test(rel);
}

/** 引用的 `/anic/...` 端点（去注释后逐行扫；引号字面量与模板前缀都认）。 */
export function collectConsumers(texts, allow) {
  const hits = new Map();
  const Q = String.fromCharCode(39, 34, 96);
  const RE = new RegExp('[' + Q + '](/anic/[A-Za-z0-9_/.\\-]*)[^' + Q + ']*', 'g');
  for (const [rel, text] of texts) {
    if (!allow(rel)) continue;
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(RE)) {
        const p = pathOf(m[1] ?? '');
        // 省略号 / 点结尾是**散文占位**（`'/anic/...'` 写在注释或提示文案里），不是端点。
        if (p === '' || p === '/anic' || p.includes('...') || p.includes('..') || p.endsWith('.')) continue;
        if (!hits.has(p)) hits.set(p, new Set());
        hits.get(p).add(rel);
      }
    }
  }
  return hits;
}

/** 工具族：`name: 'anic_...'` 的定义 + 引用面（注册层自身不算消费）。 */
export function auditTools(texts) {
  const defs = [];
  const NAME = /name:\s*['"](anic_[a-z0-9_]+)['"]/;
  for (const [rel, text] of texts) {
    if (!/^src\/host\/tools.*\.ts$/.test(rel)) continue;
    for (const line of text.split('\n')) {
      const m = NAME.exec(line);
      if (m !== null) defs.push({ id: m[1], file: rel });
    }
  }
  return defs.map((d) => {
    const inCode = [];
    const inChannel = [];
    for (const [rel, text] of texts) {
      if (rel === d.file || /^src\/host\/tools.*\.ts$/.test(rel) || rel === 'src/host/toolIds.ts') continue;
      if (!new RegExp('\\b' + d.id + '(?![A-Za-z0-9_])').test(text)) continue;
      if (rel.startsWith('src/')) inCode.push(rel); else inChannel.push(rel);
    }
    return { id: d.id, definedAt: d.file, codeConsumers: inCode.length, channelConsumers: inChannel.length };
  });
}
