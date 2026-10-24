/**
 * 闭环体检**连通性**维度（cycle-76）：注册 → 生产 → **运行时可达**。
 *
 * ## 为什么需要这一维（用户诉求「确保**连通性逻辑性**」）
 *
 * cycle-75 把 `produced` 修正成「存在**真注册调用点**」，但那仍然只证明
 * 「某处写了 `reg({path})`」——**不证明那段代码会被执行**。一个注册器若没被聚合器调用，
 * 里面所有 `reg()` 都是**空心注册**：注册了、生产了、甚至有消费方，但运行时永远不到。
 *
 * 这正是本仓反复踩的形态换了个位置：`headless 下整条 fiber pending` 是「注册了但没激活」，
 * 而这里更隐蔽——**代码静态存在、测试全绿、面板显示正常**，只是那行永不执行。
 *
 * ## 判定链（逐跳可判，任一断即不可达）
 *
 * ```
 * src/index.ts apply
 *   ├─ wireRoutes()                    ──► src/host/anicRoutesPlugin.ts
 *   │     └─ registerAnicRoutes() 或 ctx.plugin(anicRoutesPlugin) ──► src/host/routes/index.ts
 *   │           └─ registerXxxRoute()  ──► 各路由文件
 *   │                 └─ reg({path})   ──► 端点（本维度的末梢）
 *   ├─ registerAnicTools()             ──► src/host/tools.ts
 *   │     └─ registerXxxTools()        ──► tools*.ts 网关
 *   └─ registerRuntimeSkill()          ──► src/host/skillRegistration.ts
 * ```
 *
 * `wireRoutes` 的**两条路径都要认**（cycle-74 P0 修复后它优先走子 fiber
 * `ctx.plugin(anicRoutesPlugin, …)`，服务缺席时回落直连）——只认一条会把正确实现判成孤儿。
 *
 * ## 纪律
 *
 * 纯只读、纯函数；去注释后判定；**空扫描集响亮抛错**（空集恒绿是假守卫）；
 * 判定只读**单一注册表**（不手写第二份注册器清单）。
 */
import { stripComments as stripCommentsLocal } from './scanPrimitives.ts';

/** 一条调用链跳。 */
export interface ChainHop {
  /** 稳定的机器可读 id（供断言与面板分组）。 */
  id: string;
  from: string;
  to: string;
  /** 调用点 file:line；未接通为 null。 */
  at: string | null;
  ok: boolean;
}

/** 注册器及其接线状态。 */
export interface RegistrarState {
  name: string;
  file: string;
  /** 是否被其上级聚合器调用。 */
  wired: boolean;
}

export interface ConnectivityReport {
  hops: ChainHop[];
  routeRegistrars: RegistrarState[];
  toolRegistrars: RegistrarState[];
  /** 存在但**无人调用**的注册器 —— 空心链根因。 */
  orphanRegistrars: string[];
  /** 全部跳都通 + 无孤儿。 */
  connected: boolean;
  /** 被检查的链跳数（供「扫描集非空」断言）。 */
  hopCount: number;
}

const ENTRY = 'src/index.ts';
const ROUTES_PLUGIN = 'src/host/anicRoutesPlugin.ts';
const ROUTES_AGGREGATOR = 'src/host/routes/index.ts';
const TOOLS_HUB = 'src/host/tools.ts';
const TOOLS_FILE_RE = /^src\/host\/tools.*\.ts$/;

/**
 * 去注释（保留换行 ⇒ 行号与磁盘一致）。
 *
 * **复用 scanPrimitives 的单一实现**：去注释是判定口径的一部分，本模块自写一份
 * 会让「路由族的消费判定」与「连通性判定」在边界情形上分叉（本仓 G-SINGLE 纪律）。
 */
const strip = stripCommentsLocal;

/** 索引 → 行号（1 起）。 */
function lineAt(text: string, idx: number): number {
  let n = 1;
  const end = Math.min(idx, text.length);
  for (let i = 0; i < end; i += 1) if (text[i] === '\n') n += 1;
  return n;
}

/**
 * 找 `name(` 的**调用点**（排除 `function name(` 的定义行，并**自带去注释**）。
 *
 * 为什么排除定义：`export function registerXxxRoute(` 与 `registerXxxRoute(ctx)`
 * 都含 `name(`，不排除会把「自己定义自己」当成「自己被接线」——那正是假绿的形态。
 *
 * 为什么内部去注释（而不是要求调用方先 strip）：本函数是**导出的公开原语**，
 * 契约测试与外部消费者都会直接调；漏做一次 strip 就会把
 * `// wireRoutes(ctx) 在注释里` 判成真接线（本测试 ② 实测抓到的形态）。
 * 去注释保留换行 ⇒ 行号仍与磁盘一致。
 */
export function callLine(text: string, name: string): number | null {
  const src = strip(text);
  const re = new RegExp('(^|[^A-Za-z0-9_$])' + name + '\\s*\\(', 'g');
  for (const m of src.matchAll(re)) {
    const idx = (m.index ?? 0) + m[0].indexOf(name);
    const before = src.slice(Math.max(0, idx - 40), idx);
    if (/function\s+$/.test(before)) continue; // 定义行，不是调用
    return lineAt(src, idx);
  }
  return null;
}

/** 某文件里是否 `export function <name>`。 */
function exportsFunction(text: string, name: string): boolean {
  return new RegExp('export\\s+function\\s+' + name + '\\s*\\(').test(text);
}

/** 判定链跳（未找到文件或未找到调用 ⇒ ok=false，不静默当通过）。 */
function hop(id: string, from: string, to: string, files: Map<string, string>, fromRel: string, callee: string): ChainHop {
  const raw = files.get(fromRel);
  if (raw === undefined) return { id, from, to, at: null, ok: false };
  const line = callLine(strip(raw), callee);
  return { id, from, to, at: line === null ? null : fromRel + ':' + String(line), ok: line !== null };
}

/**
 * 构建连通性报告。
 *
 * 只读单一注册表：路由注册器从**各路由文件的 `export function register*Route`** 枚举，
 * 工具网关注册器从 **`tools*.ts` 的 `export function register*`** 枚举——不手写清单。
 */
export function buildConnectivity(files: Map<string, string>): ConnectivityReport {
  const hops: ChainHop[] = [];

  // ── 链 1：入口 → 路由子插件/聚合器（两条路径必须**任一**可达）──
  const entryRaw = files.get(ENTRY);
  const entryWired = entryRaw !== undefined && callLine(strip(entryRaw), 'wireRoutes') !== null;
  const pluginRaw = files.get(ROUTES_PLUGIN);
  const pluginText = pluginRaw === undefined ? '' : strip(pluginRaw);
  const pluginToAgg = callLine(pluginText, 'registerAnicRoutes');
  // cycle-74 P0 的另一条路径：ctx.plugin(anicRoutesPlugin, …)（子 fiber）。
  const subFiber = callLine(pluginText, 'plugin');
  const routesToAgg = pluginToAgg !== null || subFiber !== null;
  hops.push({
    id: 'entry→routes',
    from: ENTRY, to: ROUTES_PLUGIN,
    at: entryWired ? ENTRY + ':' + String(callLine(strip(entryRaw as string), 'wireRoutes')) : null,
    ok: entryWired,
  });
  hops.push({
    id: 'routes→aggregator',
    from: ROUTES_PLUGIN, to: ROUTES_AGGREGATOR,
    at: pluginToAgg !== null
      ? ROUTES_PLUGIN + ':' + String(pluginToAgg)
      : (subFiber !== null ? ROUTES_PLUGIN + ':' + String(subFiber) + '(sub-fiber)' : null),
    ok: routesToAgg,
  });

  // ── 链 2：聚合器 → 每个路由注册器 ──
  const aggRaw = files.get(ROUTES_AGGREGATOR);
  const aggText = aggRaw === undefined ? '' : strip(aggRaw);
  const routeRegistrars: RegistrarState[] = [];
  for (const rel of [...files.keys()].sort()) {
    if (!/^src\/host\/(routes\/[A-Za-z0-9_]+\.ts|snapshotRoute\.ts)$/.test(rel)) continue;
    if (rel === ROUTES_AGGREGATOR || rel === 'src/host/routes/routeContext.ts') continue;
    const text = strip(files.get(rel) as string);
    for (const m of text.matchAll(/export\s+function\s+(register[A-Za-z0-9_]*Route)\s*\(/g)) {
      const name = m[1] as string;
      if (!exportsFunction(text, name)) continue;
      routeRegistrars.push({ name, file: rel, wired: callLine(aggText, name) !== null });
    }
  }
  if (routeRegistrars.length === 0) throw new Error('closure connectivity: no route registrars found (scan empty)');
  const routeWiredCount = routeRegistrars.filter((r) => r.wired).length;
  hops.push({
    id: 'aggregator→registrars',
    from: ROUTES_AGGREGATOR, to: 'route files',
    at: routeWiredCount > 0 ? ROUTES_AGGREGATOR : null,
    ok: routeWiredCount === routeRegistrars.length,
  });

  // ── 链 3：入口 → 工具 hub → 各网关注册器 ──
  hops.push(hop('entry→tools', ENTRY, TOOLS_HUB, files, ENTRY, 'registerAnicTools'));
  const hubRaw = files.get(TOOLS_HUB);
  const hubText = hubRaw === undefined ? '' : strip(hubRaw);
  const toolRegistrars: RegistrarState[] = [];
  for (const rel of [...files.keys()].sort()) {
    if (!TOOLS_FILE_RE.test(rel) || rel === TOOLS_HUB) continue;
    const text = strip(files.get(rel) as string);
    for (const m of text.matchAll(/export\s+function\s+(register[A-Za-z0-9_]*)\s*\(/g)) {
      const name = m[1] as string;
      toolRegistrars.push({ name, file: rel, wired: callLine(hubText, name) !== null });
    }
  }
  if (toolRegistrars.length === 0) throw new Error('closure connectivity: no tool gateways found (scan empty)');
  const toolWiredCount = toolRegistrars.filter((r) => r.wired).length;
  hops.push({
    id: 'tools→gateways',
    from: TOOLS_HUB, to: 'tools*.ts gateways',
    at: toolWiredCount > 0 ? TOOLS_HUB : null,
    ok: toolWiredCount === toolRegistrars.length,
  });

  // ── 链 4：入口 → 技能挂载 ──
  hops.push(hop('entry→skill', ENTRY, 'src/host/skillRegistration.ts', files, ENTRY, 'registerRuntimeSkill'));

  const orphanRegistrars = [
    ...routeRegistrars.filter((r) => !r.wired).map((r) => r.name),
    ...toolRegistrars.filter((r) => !r.wired).map((r) => r.name),
  ].sort();

  return {
    hops,
    routeRegistrars,
    toolRegistrars,
    orphanRegistrars,
    connected: hops.every((h) => h.ok) && orphanRegistrars.length === 0,
    hopCount: hops.length,
  };
}

/** 连通性是否可判（报告齐备且跳数达标）——供口径守卫。 */
export function assertConnectivityComplete(rep: ConnectivityReport): void {
  if (rep.hopCount < 4) throw new Error('closure connectivity: expected >= 4 chain hops, got ' + String(rep.hopCount));
  if (rep.routeRegistrars.length === 0) throw new Error('closure connectivity: route registrar scan empty');
  if (rep.toolRegistrars.length === 0) throw new Error('closure connectivity: tool registrar scan empty');
}
