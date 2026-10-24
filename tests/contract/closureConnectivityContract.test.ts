/**
 * 闭环**连通性**契约（cycle-76 · 用户诉求「确保**连通性逻辑性**」）。
 *
 * ## 被守卫的盲区
 *
 * cycle-75 把 `produced` 修正为「存在**真注册调用点**」，但仍只证明「某处写了 `reg({path})`」，
 * **不证明那段代码会被执行**。一个注册器若没被聚合器调用，里面所有 `reg()` 都是**空心注册**：
 * 注册了、生产了、甚至有消费方，三态矩阵**全绿**，运行时却永远到不了。
 *
 * 与本仓既有事故同族：`headless 下整条 fiber pending` 是「注册了但没激活」；
 * 这条更隐蔽——**代码静态存在、测试全绿、面板显示健康**，只是那行永不执行。
 *
 * ## 判定链（任一断即不可达）
 *
 * ```
 * src/index.ts apply
 *   ├─ wireRoutes()  ──► anicRoutesPlugin ──► registerAnicRoutes()
 *   │                                        └─ registerXxxRoute() ──► reg({path})
 *   ├─ registerAnicTools() ──► tools.ts ──► registerXxxTools() ──► tools*.ts 网关
 *   └─ registerRuntimeSkill()
 * ```
 *
 * ## 判据（两态必须可分 —— 否则守卫恒真）
 *
 * ① 真机：全跳通 + 零孤儿（当前代码事实）；
 * ② `callLine` **不得把定义行当调用**（`export function foo(` ≠ `foo(`）——否则「自己定义自己」
 *    就成了「自己被接线」，正是假绿形态；
 * ③ 三处定向变异（注释掉聚合器注册器 / 打断入口 / 注释掉工具 hub 调用）**各自必须变红**；
 * ④ 扫描集空 ⇒ 响亮抛错（空集恒绿是假守卫）；
 * ⑤ 投影：连通性进投影且**不含本地绝对路径**；
 * ⑥ 客户端守卫：在场则严格（`routeWired ≤ routeTotal`、`hops` 非空），**缺席则放行**（向前兼容）；
 * ⑦ 渲染：连通/断链两态可辨、孤儿点名、缺席不渲染。
 *
 * 纪律：只读（R-31）；变异只在**内存副本**上做，绝不写盘。
 */
import { describe, it, expect } from 'vitest';
import { buildConnectivity, assertConnectivityComplete, callLine } from '../../src/host/closureAudit/connectivity.ts';
import { runClosureAudit, toClosureView } from '../../src/host/closureAudit/registryClosure.ts';
import { buildFileIndex, buildTextMap } from '../../src/host/closureAudit/scanPrimitives.ts';
import { isClosureView } from '../../src/client/features/closure/closureTypes.ts';
import { renderClosure } from '../../src/client/features/closure/renderClosure.ts';

const ROOT = process.cwd();
const FILES = buildTextMap(ROOT, buildFileIndex(ROOT));

/**
 * 真机视图**只算一次**（全仓扫描 ~7-15s，重复算会让本文件跑 45s+）。
 *
 * 这是**纯函数 + 只读**的产物（runClosureAudit 不写工作区、无全局状态），
 * 模块级缓存不引入测试间依赖；变异测试另建内存副本，不共享此对象。
 */
let cachedView: ReturnType<typeof toClosureView> | null = null;
function realView(): ReturnType<typeof toClosureView> {
  if (cachedView === null) cachedView = toClosureView(runClosureAudit(ROOT));
  return cachedView;
}

/** 复制一份可变夹具（变异只在副本上做——绝不写盘）。 */
function copy(): Map<string, string> {
  return new Map(FILES);
}
/** 把某文件里的一处片段替换成块注释（模拟「有人删了接线」）。 */
function commentOut(files: Map<string, string>, rel: string, snippet: string): void {
  const raw = files.get(rel);
  if (raw === undefined) throw new Error('fixture missing: ' + rel);
  if (!raw.includes(snippet)) throw new Error('snippet not found in ' + rel + ': ' + snippet);
  files.set(rel, raw.replace(snippet, '/* ' + snippet + ' */'));
}

/* ── 渲染树取词器（同既有契约手法，不依赖 DOM）── */
function walk(node: unknown, out: { anchors: string[]; texts: string[] }): void {
  if (node === null || node === undefined || node === false || node === true) return;
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return; }
  if (Array.isArray(node)) { for (const c of node) walk(c, out); return; }
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('data-anic') && typeof v === 'string') out.anchors.push(k + '=' + v);
  }
  walk(props['children'], out);
}
function probe(node: unknown): { anchors: string[]; text: string } {
  const out = { anchors: [] as string[], texts: [] as string[] };
  walk(node, out);
  return { anchors: out.anchors, text: out.texts.join(' | ') };
}

describe('cycle-76 闭环连通性（注册 → 生产 → 运行时可达）', () => {
  it('① 真机：六跳全通、零孤儿、注册器全部接线', () => {
    const rep = buildConnectivity(FILES);
    assertConnectivityComplete(rep);
    expect(rep.hopCount).toBeGreaterThanOrEqual(4);
    for (const h of rep.hops) expect(h.ok, '断链: ' + h.id + ' @ ' + String(h.at)).toBe(true);
    expect(rep.routeRegistrars.length).toBeGreaterThan(10);
    expect(rep.routeRegistrars.every((r) => r.wired)).toBe(true);
    expect(rep.toolRegistrars.length).toBeGreaterThan(5);
    expect(rep.toolRegistrars.every((r) => r.wired)).toBe(true);
    expect(rep.orphanRegistrars).toEqual([]);
    expect(rep.connected).toBe(true);
  });

  it('② callLine 不把定义行当调用（否则「自己定义自己」= 假绿）', () => {
    const text = 'export function wireRoutes(ctx) {\n  return 1;\n}\n// wireRoutes(ctx) 在注释里\n';
    expect(callLine(text, 'wireRoutes')).toBeNull();
    expect(callLine('export function f() {}\nf(1);', 'f')).toBe(2);
    // 注释里的调用不算（去注释后再判）——这里验函数本身：定义行被排除，注释行由调用方去注释
    expect(callLine('const x = f(1);', 'f')).toBe(1);
  });

  it('④ 扫描集空 ⇒ 响亮抛错（空集恒绿是假守卫）', () => {
    const empty = new Map<string, string>();
    expect(() => buildConnectivity(empty)).toThrow(/scan empty|no route registrars/);
  });

  it('③-变异A：注释掉聚合器里的一个注册器调用 ⇒ 必成孤儿', () => {
    const files = copy();
    commentOut(files, 'src/host/routes/index.ts', 'registerClosureAuditRoute(c, { send })');
    const rep = buildConnectivity(files);
    expect(rep.connected).toBe(false);
    expect(rep.orphanRegistrars).toContain('registerClosureAuditRoute');
    // 该跳也必须红（聚合器→注册器）
    expect(rep.hops.find((h) => h.id === 'aggregator→registrars')?.ok).toBe(false);
  });

  it('③-变异B：打断入口 wireRoutes ⇒ entry→routes 必断', () => {
    const files = copy();
    const raw = files.get('src/index.ts') as string;
    files.set('src/index.ts', raw.replace(/wireRoutes\(ctx,/g, '/* wireRoutes(ctx, */'));
    const rep = buildConnectivity(files);
    expect(rep.hops.find((h) => h.id === 'entry→routes')?.ok).toBe(false);
    expect(rep.connected).toBe(false);
  });

  it('③-变异C：注释掉工具 hub 的网关注册器 ⇒ 孤儿点名', () => {
    const files = copy();
    commentOut(files, 'src/host/tools.ts', 'registerHitlTools(');
    const rep = buildConnectivity(files);
    expect(rep.connected).toBe(false);
    expect(rep.orphanRegistrars).toContain('registerHitlTools');
    expect(rep.hops.find((h) => h.id === 'tools→gateways')?.ok).toBe(false);
  });

  it('③-变异D：注释掉入口 registerRuntimeSkill ⇒ entry→skill 必断', () => {
    const files = copy();
    const raw = files.get('src/index.ts') as string;
    files.set('src/index.ts', raw.replace(/registerRuntimeSkill\(ctx\)/g, '/* registerRuntimeSkill(ctx) */'));
    const rep = buildConnectivity(files);
    expect(rep.hops.find((h) => h.id === 'entry→skill')?.ok).toBe(false);
    expect(rep.connected).toBe(false);
  });

  it('⑤ 投影：连通性进投影且不含本地绝对路径', () => {
    const view = realView();
    expect(view.connectivity).toBeDefined();
    const c = view.connectivity as NonNullable<typeof view.connectivity>;
    expect(c.connected).toBe(true);
    expect(c.hops.length).toBeGreaterThanOrEqual(4);
    expect(c.routeWired).toBe(c.routeTotal);
    expect(c.toolWired).toBe(c.toolTotal);
    expect(c.orphanRegistrars).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(String.fromCharCode(58, 92)); // ":\"
  }, 120_000);

  it('⑥ 客户端守卫：在场则严格，缺席则放行（向前兼容）', () => {
    const view = realView();
    expect(isClosureView(view)).toBe(true);
    // 缺席（旧服务端）⇒ 仍须可用
    const without = { ...view } as Record<string, unknown>;
    delete without.connectivity;
    expect(isClosureView(without)).toBe(true);
    // 接线数超过总数 ⇒ 自相矛盾，必须拒收
    const bad = { ...view, connectivity: { ...(view.connectivity as object), routeWired: 999 } };
    expect(isClosureView(bad)).toBe(false);
    // 空 hops ⇒ 不许冒充「全通」
    const emptyHops = { ...view, connectivity: { ...(view.connectivity as object), hops: [] } };
    expect(isClosureView(emptyHops)).toBe(false);
  });

  it('⑦ 渲染：连通/断链两态可辨、孤儿点名、缺席不渲染', () => {
    const view = realView();
    const ok = probe(renderClosure(view));
    expect(ok.anchors).toContain('data-anic-closure-connectivity=ok');

    const broken = probe(renderClosure({
      ...view,
      connectivity: {
        ...(view.connectivity as NonNullable<typeof view.connectivity>),
        connected: false,
        orphanRegistrars: ['registerFakeRoute'],
        hops: (view.connectivity as NonNullable<typeof view.connectivity>).hops.map((h) => ({ ...h, ok: false })),
      },
    }));
    expect(broken.anchors).toContain('data-anic-closure-connectivity=broken');
    expect(broken.anchors.some((a) => a.startsWith('data-anic-conn-orphan-list='))).toBe(true);
    expect(broken.text).toContain('registerFakeRoute');

    // 缺席 ⇒ 不渲染该行（向前兼容，不是失败）
    const without = { ...view } as Record<string, unknown>;
    delete without.connectivity;
    const absent = probe(renderClosure(without as typeof view));
    expect(absent.anchors.some((a) => a.startsWith('data-anic-closure-connectivity='))).toBe(false);
  });
});
