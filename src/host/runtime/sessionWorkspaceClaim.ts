/**
 * 会话证据链解析（cycle-99 工作区隔离）——sessionId → 工作区根。
 *
 * ## 缺陷（本轮用户实测）
 *
 * 「对话工作区的技能面板要只能看对应项目工作区的可视化」——旧链在请求未带
 * X-ANIC-Workspace 头时按 `sessions.list()` **首条** cwd 取数，多会话并开时
 * 面板显示的是会话 B、数据却来自会话 A（P2 注释已记录的桌面错位是同根问题）。
 *
 * ## 方案：面板携带 sessionId（session scope 标准 props），服务端按 id 精确映射
 *
 * - 客户端（view entry props.sessionId）随请求带 `X-ANIC-Session` 头；
 * - 服务端在 `sessions.list()` 条目**含 id 字段**时按 id 匹配 → `header.cwd`；
 * - cwd 仍过 acceptClaim（命中已知工作区集或含 .cycles）——映射不绕安全边界；
 * - 条目无 id（宿主代际差异）/无 cwd/服务缺失 → null（回落既有链，宁缺勿猜）。
 *
 * 从 snapshotRoute.ts 拆出守 T3 ≤250 行；分界：本文件=「会话证据怎么读」，
 * snapshotRoute.resolveWorkspaceRoots=「优先序怎么排」。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 会话条目窄化（id 字段宿主代际相关，字段级探测不猜形状）。 */
export interface SessionEntryWithId {
  id?: unknown;
  header?: { cwd?: unknown };
}

/** 解析依赖面（宿主 ctx 的 sessions 服务 + 工作区校验回调）。 */
export interface SessionClaimDeps {
  sessions?: { list?(): unknown[] };
  /** acceptClaim 的注入点（snapshotRoute 持有实现，此处只消费）。 */
  acceptWorkspace: (claimed: string | null) => string | null;
}

/** 从请求头取 X-ANIC-Session（URL 解码容错；缺失/空白返回 null）。 */
export function sessionOfReq(req: unknown): string | null {
  if (req === null || req === undefined) return null;
  const raw = (req as { headers?: Record<string, string | string[] | undefined> }).headers?.['x-anic-session'];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val !== 'string' || val.trim() === '') return null;
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

/**
 * sessionId → 工作区根。命中 `sessions.list()` 中 id 匹配的条目取 `header.cwd`，
 * cwd 过 acceptWorkspace 校验后返回；无匹配/无 id/无 cwd/服务缺失 → null。
 */
export function workspaceOfSessionClaim(ctx: SessionClaimDeps, sessionId: string | null): string | null {
  if (sessionId === null) return null;
  try {
    for (const entry of ctx.sessions?.list?.() ?? []) {
      const e = entry as SessionEntryWithId;
      if (typeof e.id !== 'string' || e.id !== sessionId) continue;
      const cwd = e.header?.cwd;
      if (typeof cwd !== 'string' || cwd === '') return null;
      return ctx.acceptWorkspace(cwd);
    }
  } catch { /* sessions 缺失/不可用 → 回落 */ }
  return null;
}

/** acceptClaim 的最小复刻（供独立使用；与 snapshotRoute 的实现同判据，防漂移注释见彼处）。 */
export function claimAcceptable(claimed: string | null): string | null {
  if (claimed === null) return null;
  try {
    if (existsSync(join(claimed, '.cycles'))) return claimed;
  } catch { /* 越权/不存在 → 不接受 */ }
  return null;
}
