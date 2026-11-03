/**
 * 闭环体检：路由族（注册↔生产↔消费 三态）。
 *
 * 词表族（i18n 键）已拆至 ./i18nClosure.ts（cycle-72 T3：单文件 ≤250 行）；本文件保留路由族并
 * **再导出**词表族入口，消费者 import 路径零变更（registryClosure.ts / closureAuditScan.test.ts）。
 *
 * 族定义与判定纪律见 scanPrimitives.ts 头注（单一注册表 / 去注释保行号 / 精确边界 /
 * 测试引用不计生产消费 / 未消费不硬算）。
 *
 * 路由族 produced 语义：注册行本身即生产锚点（注册即挂 handler，routeContext/send 在注册期接线）。
 */
import type { AssetDef, ClusterAudit, ClosureItem } from './scanPrimitives.ts';
import { assertScanNonEmpty, boundaryContains, collectRefs, kindOf, quoteClasses, stripComments, tallyProduced } from './scanPrimitives.ts';
// 机械部件（行号/正则/常量表/括号配平）拆至 routeScanPrimitives.ts（T3 ≤250 行）。
import { NON_ROUTE_HELPERS, ROUTE_FILE, balancedBraces, constTable, lineAt, pathLiteralRe } from './routeScanPrimitives.ts';
// cycle-76：倒排索引证据查询（O(1) 查表替代逐项全仓扫描）。
import type { EvidenceIndex } from './evidenceIndex.ts';
import { evidenceFor } from './evidenceIndex.ts';

// 词表族（含 flattenKeys / keyAnchor：closureAuditScan.test.ts 直接消费）——再导出，路径零变更。
export { dynamicKeyPrefixes, flattenKeys, keyAnchor, i18nClosure, i18nGhosts } from './i18nClosure.ts';

/* ── 族 3：路由（cycle-75 「真注册点」双向真值重写）──────────────────── */

/**
 * 路由**真值**双锚点（cycle-75 接口冻结 §1.2）。
 *
 * 上一版缺陷（Lead 实测）：把路由文件里**任意** `/anic/...` 字面量当注册——
 * JSDoc 头注、错误消息、响应字段全被算成注册，一次报 63 条（真值 55，另 10 条
 * 代码里根本不存在 = 幽灵注册）。而 produced 只看 `routes/index.ts` 是否含 id 子串，
 * 真实注册发生在各路由文件**内部**（index.ts 只调注册器）⇒ produced 恒为 1/63。
 * registered / produced / unconsumed 三个数没有一个可信。
 *
 * 本版判据（每条都能被反向自检证伪）：
 *   declaredAt  该 path 在同文件里被 `const X = '/anic/...'` 声明过（可空）。
 *   producedAt  **真注册调用点**，三种形态必须全覆盖（漏一种即漏报）：
 *     A. `webServer.register({ kind, path: '<literal>' | IDENT, handler })`
 *     B. `reg('<literal>', handler)` / `reg('GET', '<literal>', handler)`
 *        —— `\breg\(` 天然不匹配 `register(`（其后是 i 不是 `(`）。
 *     C. 孤立声明：`const X = '/anic/...'` 但本文件无注册调用 ⇒ producedAt=null。
 *   path 为 IDENT 时回溯同文件 `const IDENT = '<literal>'`（snapshotRoute 形态）。
 *
 * `routes/index.ts` 是**聚合器**，不是生产点——注册在此判定的定义之外。
 */
export interface RouteDef {
  id: string;
  /** 声明处 file:line；无 = null。 */
  declaredAt: string | null;
  /** 真注册调用点 file:line；无 = null（声明了但没接线 ⇒ 产出缺口）。 */
  producedAt: string | null;
}

/** 定义 + 生产扫描（单一实现）。 */
export function scanRouteDefs(files: Map<string, string>): RouteDef[] {
  const acc = new Map<string, RouteDef>();
  /** 合并：声明处取首次非空，注册点取首次非空（一个 path 只应有一个真注册点）。 */
  const put = (id: string, declaredAt: string | null, producedAt: string | null): void => {
    const cur = acc.get(id);
    if (!cur) { acc.set(id, { id, declaredAt, producedAt }); return; }
    if (cur.declaredAt === null && declaredAt !== null) cur.declaredAt = declaredAt;
    if (cur.producedAt === null && producedAt !== null) cur.producedAt = producedAt;
  };

  for (const rel of [...files.keys()].sort()) {
    if (!ROUTE_FILE.test(rel) || NON_ROUTE_HELPERS.has(rel)) continue;
    // 判定纪律⑥：去注释后再扫——注释里的示例路径不是注册，也不是消费。
    const text = stripComments(files.get(rel) as string);
    const consts = constTable(text);
    const declAt = (id: string): string | null => {
      for (const [name, val] of consts) {
        if (val !== id) continue;
        const at = text.indexOf('const ' + name);
        if (at >= 0) return rel + ':' + String(lineAt(text, at));
      }
      return null;
    };

    // ── 形态 A：webServer.register({ ... path: <literal|IDENT> ... }) ──
    // 用**括号配平**取实参（不是固定窗口——见 balancedBraces 头注的实测缺陷）。
    const regCallRe = /(?:webServer\s*\.\s*)?register\s*\(\s*\{/g;
    for (const m of text.matchAll(regCallRe)) {
      const at = m.index ?? 0;
      const braceAt = at + m[0].length - 1; // 指向 '{'
      const { body, from } = balancedBraces(text, braceAt);
      const lit = pathLiteralRe().exec(body);
      if (lit && lit[1]) {
        put(lit[1], declAt(lit[1]), rel + ':' + String(lineAt(text, from + (lit.index ?? 0))));
        continue;
      }
      const ident = /path\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
      const resolved = ident && ident[1] ? consts.get(ident[1]) : undefined;
      if (resolved) put(resolved, declAt(resolved), rel + ':' + String(lineAt(text, from)));
    }

    // ── 形态 B：reg/register('<verb>', <literal|IDENT>, handler) 或 reg(<literal>, handler) ──
    // 覆盖两种帮助封装（本仓实测各一处）：
    //   flowsRoute/evolutionRoute/nativeRoute/…：`reg('<path>', handler)` / `reg('GET','<path>',h)`
    //   reviewRoute：`register('POST', REVIEW_ROUTE, handler)` ← 裸 register + 常量
    //   cycle-101：`deps.reg(FLOWS_VIEW_ROUTE, handler)` ← 注入对象的 reg 方法
    //   （前置字符集补 `.`：`deps.reg(` 与裸 `reg(` 同一语义，只是帮助函数来自依赖对象）
    // `[^)]` 窗口在 `handler` 参数列表处截断，但路径总在其之前，足够。
    const regFnRe = /[\s,(;{=.](?:reg|register)\s*\(([^)]{0,300}?)\)/g;
    for (const m of text.matchAll(regFnRe)) {
      const args = m[1];
      // 形态 A 的 `register({ … })` 由上方分支处理；此处跳过对象形态防重复计数。
      if (!args || args.includes('{')) continue;
      const argStart = (m.index ?? 0) + m[0].lastIndexOf('(') + 1;
      const lit = pathLiteralRe().exec(args);
      if (lit && lit[1]) {
        put(lit[1], declAt(lit[1]), rel + ':' + String(lineAt(text, argStart)));
        continue;
      }
      // 常量溯源：两种形态都要认 ——
      //   `register('POST', REVIEW_ROUTE, handler)` （逗号包围，IDENT 在中段）
      //   `reg(FLOWS_VIEW_ROUTE, handler)`           （IDENT 在首位，后接逗号）
      // cycle-101 之前只认第一种，于是「首位常量」的路由被记成「无注册点」（假缺口）。
      const ident = /,\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/.exec(args);
      // 首位常量形态（`reg(FLOWS_VIEW_ROUTE, handler)`）：仅当 args **以** IDENT+逗号
      // 开头才认。不放进上面的 `??` 兜底 —— 那样会把 `'<path>', handler` 之类
      // 的字符串首参也当成常量（cycle-101 变异测试实测：会报出幽灵注册点）。
      const leading = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/.exec(args);
      const resolved = ident && ident[1] ? consts.get(ident[1]) : undefined;
      const resolvedLeading = !resolved && leading && leading[1] ? consts.get(leading[1]) : undefined;
      const finalResolved = resolved ?? resolvedLeading;
      if (finalResolved) put(finalResolved, declAt(finalResolved), rel + ':' + String(lineAt(text, argStart)));
    }

    // ── 形态 C：声明存在但本文件无注册调用（如实入账为产出缺口）──
    for (const [, id] of consts) put(id, declAt(id), null);
  }
  return [...acc.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 真注册点全表：id → 注册调用点 file:line（列表，供 produced 证据）。 */
export function routeRegisterSites(files: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of scanRouteDefs(files)) {
    if (d.producedAt === null) continue;
    const cur = out.get(d.id) ?? [];
    cur.push(d.producedAt);
    out.set(d.id, cur);
  }
  return out;
}

/*
 * ★cycle-94：`scanRouteAssets`（兼容包装）**已删除**。
 *
 * 它声称"既有消费者按 AssetDef 形态取用"，但实测**没有这样的消费者**——
 * 全仓零文本证据（`scripts/audit-wiring.mjs` 的判据是去注释后的真实引用）。
 * 同文件内的真实读者用的是 `scanRouteDefs`，它给出的形态已带 `definedAt`。
 *
 * 删除理由与 `classifyUnconsumed` 同型：**没有人用的兼容层是最贵的兼容层**——
 * 它把"两种形态"这个复杂度永久留在仓库里，却没有任何当前收益。
 * 真需要 `AssetDef` 形态时，对 `scanRouteDefs` 的返回值映射一行就够，不必预置。
 */

/**
 * 端点真消费面：客户端 fetch 常量 / 宿主内部调用 / CLI 脚本。
 * tests、docs 与 assets 均**不计**消费——测试只证明注册可用；
 * assets/skill 是被本仓路由包住的生产者，不是它的读取方（判定纪律④）。
 */
function routeConsumerUniverse(rel: string): boolean {
  if (ROUTE_FILE.test(rel)) return false; // ③ 注册层自身（路由文件即注册表）
  if (rel === 'src/host/routes/index.ts') return false; // ④ 投影层（聚合器回声）
  /*
   * ⑤ ★cycle-78：通道声明表是**声明面**（哪条路由由外部通道独占、谁维护），
   * 不是调用方。若不排除，46 条通道独占路由会因「在自己的声明表里露过一次名」
   * 而全部被判成生产代码消费——声明白盒化反而把缺口洗成健康的绿，
   * 正是守卫纪律②「不匹配自身」要防的自指污染。
   */
  if (rel === 'src/host/closureAudit/channelRegistry.ts') return false;
  if (rel.startsWith('locale/') || rel.startsWith('docs/')) return false;
  if (rel.startsWith('tests/') || rel.startsWith('assets/')) return false;
  if (rel.endsWith('.md') || rel.endsWith('.json')) return false;
  return /^(src|scripts|bin)\//.test(rel);
}

/**
 * 路由族闭环（cycle-76：支持传入**倒排索引**；缺省回落逐项全扫，外部行为不变）。
 */
export function routeClosure(files: Map<string, string>, index?: EvidenceIndex): ClusterAudit {
  const defs = scanRouteDefs(files);
  assertScanNonEmpty(defs.length, 'route-definitions');
  const sites = routeRegisterSites(files);
  const items: ClosureItem[] = defs.map((d) => {
    const defFile = (d.producedAt ?? d.declaredAt ?? '').split(':')[0] as string;
    // 倒排表按「最大化取 token」建 ⇒ 按 id 精确查表与 boundaryContains 等价。
    const evidence = index !== undefined
      ? evidenceFor(index.route, d.id, (rel) => rel !== defFile && routeConsumerUniverse(rel))
      : collectRefs(files,
          (line) => boundaryContains(line, d.id) && quoteClasses().split('').some((q) => line.indexOf(q) >= 0),
          (rel) => rel !== defFile && routeConsumerUniverse(rel));
    const produced = d.producedAt !== null;
    return {
      cluster: 'routes',
      id: d.id,
      // definedAt = 声明处优先（「这资产在哪定义的」），无声明则退注册点。
      definedAt: d.declaredAt ?? d.producedAt ?? '?',
      producedAt: d.producedAt,
      producedKind: produced ? 'register-call' : 'declaration-only',
      producedEvidence: produced ? (sites.get(d.id) ?? [d.producedAt as string]) : [],
      consumed: evidence.length > 0,
      evidenceKind: kindOf(evidence),
      dynamic: false,
      evidence,
    };
  });
  const consumed = items.filter((it) => it.consumed).length;
  const codeConsumed = items.filter((it) => it.evidenceKind === 'code').length;
  return {
    cluster: 'routes', unit: 'anic http route', total: items.length, consumed, codeConsumed,
    producedByKind: tallyProduced(items), unconsumed: items.length - consumed, items,
  };
}

/** 幽灵端点消费：代码面引用了 /anic/... 但没有对应注册（路由删了消费者还在）。 */
export function routeGhosts(files: Map<string, string>, registered: readonly string[]): string[] {
  const known = new Set(registered);
  const ghosts = new Set<string>();
  for (const [rel, raw] of files) {
    if (!routeConsumerUniverse(rel)) continue;
    if (ROUTE_FILE.test(rel)) continue;
    // 去注释：注释里的示例路径（如 cors.ts 的 `/anic/api/...`）不是消费。
    for (const line of stripComments(raw).split('\n')) {
      const q = quoteClasses();
      for (const m of line.matchAll(new RegExp('[' + q + '](/anic/[A-Za-z0-9_/.\\-]+)[' + q + ']', 'g'))) {
        const p = m[1];
        if (!p || p === '/anic/' || known.has(p)) continue;
        ghosts.add(p);
      }
    }
  }
  // 路由不以此形态出现，保留显式过滤以防未来写入（一致性）。
  return [...ghosts].filter((g) => !g.endsWith('.')).sort();
}
