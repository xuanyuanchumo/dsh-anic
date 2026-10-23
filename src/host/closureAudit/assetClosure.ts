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
import { assertScanNonEmpty, boundaryContains, collectRefs, kindOf, quoteClasses, stripComments } from './scanPrimitives.ts';

// 词表族（含 flattenKeys / keyAnchor：closureAuditScan.test.ts 直接消费）——再导出，路径零变更。
export { dynamicKeyPrefixes, flattenKeys, keyAnchor, i18nClosure, i18nGhosts } from './i18nClosure.ts';

/* ── 族 3：路由（62 条，README 契约口径）────────────────────────────── */

const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const BACKTICK = String.fromCharCode(96);

const BS = String.fromCharCode(92);

const ROUTE_FILE = /^src\/host\/(routes\/[A-Za-z0-9_]+\.ts|snapshotRoute\.ts)$/;
const NON_ROUTE_HELPERS = new Set(['src/host/routes/routeContext.ts']);

/** 该行是注册行吗（register(/reg(/path:/const X_ROUTE =）。 */
export function isRegistrationLine(line: string): boolean {
  return /register\(/.test(line) || /(^|[^A-Za-z0-9_])reg\(/.test(line) || /path\s*:/.test(line) || /^\s*(export\s+)?const\s+[A-Z_]+\s*=/.test(line);
}

/** 定义扫描：路由文件的注册行里的 /anic/... 字面量（注册代码即真相）。 */
export function scanRouteAssets(files: Map<string, string>): AssetDef[] {
  const seen = new Set<string>();
  const out: AssetDef[] = [];
  for (const rel of [...files.keys()].sort()) {
    if (!ROUTE_FILE.test(rel) || NON_ROUTE_HELPERS.has(rel)) continue;
    const lines = (files.get(rel) as string).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      if (!isRegistrationLine(line)) continue;
      const q = quoteClasses();
      for (const m of line.matchAll(new RegExp('[' + q + '](/anic/[A-Za-z0-9_/.\\-]*)[\x60' + q + ']', 'g'))) {
        const path = m[1];
        if (!path || path === '/anic/') continue;
        if (seen.has(path)) continue;
        seen.add(path);
        out.push({ id: path, definedAt: rel + ':' + String(i + 1) });
      }
    }
  }
  return out;
}

/**
 * 端点真消费面：客户端 fetch 常量 / 宿主内部调用 / CLI 脚本。
 * tests、docs 与 assets 均**不计**消费——测试只证明注册可用；
 * assets/skill 是被本仓路由包住的生产者，不是它的读取方（判定纪律④）。
 */
function routeConsumerUniverse(rel: string): boolean {
  if (ROUTE_FILE.test(rel)) return false; // ③ 注册层自身（路由文件即注册表）
  if (rel === 'src/host/routes/index.ts') return false; // ④ 投影层（聚合器回声）
  if (rel.startsWith('locale/') || rel.startsWith('docs/')) return false;
  if (rel.startsWith('tests/') || rel.startsWith('assets/')) return false;
  if (rel.endsWith('.md') || rel.endsWith('.json')) return false;
  return /^(src|scripts|bin)\//.test(rel);
}

export function routeClosure(files: Map<string, string>): ClusterAudit {
  const assets = scanRouteAssets(files);
  assertScanNonEmpty(assets.length, 'route-definitions');
  const items: ClosureItem[] = assets.map((a) => {
    const defFile = a.definedAt.split(':')[0] as string;
    const evidence = collectRefs(files,
      (line) => boundaryContains(line, a.id) && quoteClasses().split('').some((q) => line.indexOf(q) >= 0),
      (rel) => rel !== defFile && routeConsumerUniverse(rel));
    return {
      cluster: 'routes',
      id: a.id,
      definedAt: a.definedAt,
      producedAt: a.definedAt,
      consumed: evidence.length > 0,
      evidenceKind: kindOf(evidence),
      dynamic: false,
      evidence,
    };
  });
  const consumed = items.filter((it) => it.consumed).length;
  const codeConsumed = items.filter((it) => it.evidenceKind === 'code').length;
  return { cluster: 'routes', unit: 'anic http route', total: items.length, consumed, codeConsumed, unconsumed: items.length - consumed, items };
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
