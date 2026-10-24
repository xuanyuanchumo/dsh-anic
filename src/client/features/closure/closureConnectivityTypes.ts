/**
 * 闭环**连通性**客户端形状（cycle-76；从 closureTypes.ts 拆出以守 T3 ≤250 行）。
 *
 * 拆分理由与宿主侧同构：`closureTypes.ts` 是「形状声明 + fail-closed 守卫」的守门人，
 * 加入连通性（cycle-76 新增观测维度）后越界。本文件只承载**连通性这一个形状与其守卫**，
 * 消费者 import 路径零变更（closureTypes.ts 再导出）。
 *
 * 职责边界：本文件**只判形状**，不判「connected 是否与 hops/orphans 逻辑一致」——
 * 那是服务端的裁决口径，客户端重复推导会在两处各长一套判据（本仓 G-SINGLE 教训）。
 */

/**
 * ★cycle-76：**连通性**视图（注册 → 生产 → 运行时可达）。
 *
 * 三态矩阵回答「写了没有、有没有人读」，本块回答**「那段代码会不会被执行」**。
 * 缺了它，一个「注册器存在、`reg()` 也在、但聚合器没调它」的**空心注册**在本面板上
 * 会显示为**完全健康**（注册了、生产了、甚至有消费方）——那正是本仓踩过的形态。
 */
export interface ClosureConnectivityView {
  connected: boolean;
  hopCount: number;
  hops: Array<{ id: string; ok: boolean; at: string | null }>;
  orphanRegistrars: string[];
  routeWired: number;
  routeTotal: number;
  toolWired: number;
  toolTotal: number;
}

/* ── 谓词（fail-closed；本文件自带最小原语，避免与 closureTypes 循环依赖）── */

function isNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function isStr(v: unknown): v is string { return typeof v === 'string'; }
function isBool(v: unknown): v is boolean { return typeof v === 'boolean'; }
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStrArray(v: unknown): v is string[] { return Array.isArray(v) && v.every((s) => isStr(s)); }

/**
 * 连通性形状守卫。
 *
 * 严格点：`hops` **非空**且每跳都带 id/ok（空链不许冒充「全通」）；
 * `orphanRegistrars` 必须是字符串数组（它是白盒面的可行动线索）；
 * `wired ≤ total`（超过即计数自相矛盾 ⇒ 半截/错乱响应）。
 */
export function isConnectivity(v: unknown): v is ClosureConnectivityView {
  if (!isObj(v)) return false;
  if (!isBool(v.connected)) return false;
  if (!isNum(v.hopCount)) return false;
  if (!Array.isArray(v.hops) || v.hops.length === 0) return false;
  for (const h of v.hops) {
    if (!isObj(h) || !isStr(h.id) || !isBool(h.ok)) return false;
    if (h.at !== null && !isStr(h.at)) return false;
  }
  if (!isStrArray(v.orphanRegistrars)) return false;
  for (const k of ['routeWired', 'routeTotal', 'toolWired', 'toolTotal']) {
    if (!isNum((v as Record<string, unknown>)[k])) return false;
  }
  return (v.routeWired as number) <= (v.routeTotal as number)
    && (v.toolWired as number) <= (v.toolTotal as number);
}
