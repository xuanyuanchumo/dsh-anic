/**
 * 热更新路由：GET /anic/api/workflow-snapshot —— 每次请求**现场**读当前工作区的
 * `.cycles/`（与嵌入快照共用同一个构建器 src/shared/snapshotCore.ts），客户端据此实现
 * 数据热更新（无需重装插件/重启宿主）。
 *
 * 契约转录来源（结构，按 CLAUDE.md「fixtures 只做真实契约的结构转录」纪律）：
 * - 工作区解析：src/host/prerequisites.ts:86-134（registry → sessions.header.cwd → cwd，
 *   逐请求重解析、不断言快照——能力快照是一发定终身的缺陷放大器）；
 *   workspaceRegistry 用 ctx.get(name) 探测（gen2-only 可选服务，存在才用）；
 * - 路由注册：src/host/routes/statusRoutes.ts:11-25 —— ctx.effect(() =>
 *   ctx.webServer.register({kind:'exact', path, handler}))，effect 返回值即清理。
 *
 * 安全面：只读；路径来自宿主服务（registry/sessions），绝不来自用户输入
 * （与 M0-③ 结论一致：白名单只来自宿主）；响应带 no-store（数据即最新）。
 *
 * CORS（P0-8 修订）：原文写「CORS（桌面/远程 UI 跨源可见）」并据此发了
 * `Access-Control-Allow-Origin: '*'` —— 该推理是错的。**桌面端不走本服务器**
 * （Electron 用 `file://` + IPC），远程 UI 也不是本插件的场景；通配符的实际
 * 唯一受益者是**任意网页**（跨站读取工作区路径/账本/提示词）。现改为默认拒绝、
 * 显式放行，见 `src/host/cors.ts`。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildWorkflowSnapshot } from '../shared/snapshotCore.ts';
import { corsHeaders, originFromRes } from './cors.ts';

export const SNAPSHOT_ROUTE = '/anic/api/workflow-snapshot';

interface WorkspaceEntry { path?: string }
interface SessionEntry { header?: { cwd?: string } }

/** 快照路由所需的宿主面窄化形状（导出供 routes/* 复用同一窄化，不各自发明）。 */
export interface SnapshotCtx {
  effect?: (fn: () => unknown, label?: string) => unknown;
  workspaceRegistry?: { list?(): WorkspaceEntry[] };
  sessions?: { list?(): SessionEntry[] };
  webServer?: {
    register(def: {
      kind: 'exact' | 'prefix';
      path: string;
      handler: (req: unknown, res: unknown) => void;
    }): (() => void) | void;
    register(method: string, path: string, handler: (req: unknown, res: unknown) => void): (() => void) | void;
  };
}

/** 工作区根解析（registry → sessions → cwd；逐请求调用）。转录自父 prerequisites.ts。
 * 导出供 routes/index.ts 复用（工作区解析全插件唯一实现，C 域一致性）。
 *
 * P2（桌面多会话错位）：sessions.list() 首条 cwd 与"当前查看面板的会话"无关——
 * 桌面宿主多会话并开时，面板可能显示的是会话 B，路由却按首条会话 A 的 cwd 取数
 * （实测桌面端 404 body 报 Studying 工作区而用户在 dsh-anic 会话）。客户端为此
 * 可在请求头带 X-ANIC-Workspace（面板从首个成功响应的 X-ANIC-Workspace 头学到
 * 的根路径）；请求头值必须仍然存在于宿主已知的合法工作区集合（registry/sessions）
 * 或含 .cycles 目录，才被采信——头是"选择器"不是"任意路径入口"（安全面不变）。
 */
export function resolveWorkspaceRoots(ctx: SnapshotCtx, req?: unknown): string {
  // 0) 客户端声明的工作区（桌面多会话纠偏）；须过合法集校验，失败静默回落。
  const claimed = workspaceOfReq(req);
  if (claimed) {
    const known = knownRoots(ctx);
    if (known.has(claimed)) return claimed;
    // 合法集不含时也接受"确实含 .cycles 的路径"（单会话 web 宿主可能只报一个）。
    try {
      if (existsSync(join(claimed, '.cycles'))) return claimed;
    } catch { /* 越权/不存在 → 回落 */ }
  }
  try {
    const wsr = ctx.workspaceRegistry;
    if (wsr?.list) {
      const first = wsr.list().find((w) => !!w.path);
      if (first?.path) return first.path;
    }
  } catch { /* registry 缺失/未挂载 → 下一来源 */ }
  try {
    const sessions = ctx.sessions;
    if (sessions?.list) {
      const first = sessions.list().find((s) => !!s.header?.cwd);
      if (first?.header?.cwd) return first.header.cwd;
    }
  } catch { /* sessions 缺失 → cwd */ }
  return process.cwd();
}

/** 宿主已知工作区集合（registry ∪ sessions 的 cwd 集合）。 */
function knownRoots(ctx: SnapshotCtx): Set<string> {
  const set = new Set<string>();
  try {
    for (const w of ctx.workspaceRegistry?.list?.() ?? []) if (w.path) set.add(w.path);
  } catch { /* ignore */ }
  try {
    for (const s of ctx.sessions?.list?.() ?? []) if (s.header?.cwd) set.add(s.header.cwd);
  } catch { /* ignore */ }
  return set;
}

/** 从请求头取 X-ANIC-Workspace（URL 解码；缺失/空白返回 null）。 */
function workspaceOfReq(req: unknown): string | null {
  if (req === null || req === undefined) return null;
  const raw = (req as { headers?: Record<string, string | string[] | undefined> }).headers?.['x-anic-workspace'];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val !== 'string' || val.trim() === '') return null;
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

/**
 * JSON 响应（no-store + 来源受限 CORS）。导出供其余路由复用（头语义全插件唯一实现）。
 *
 * P0-8（已修）：此前无条件写 `Access-Control-Allow-Origin: '*'`，任何网页都能
 * 跨站读取本插件的全部响应体（工作区绝对路径、账本、agent 卡提示词、信任分）。
 * 现改为**默认拒绝、显式放行**：同源请求（无 Origin 头）本就不需要 CORS 头，
 * 面板由宿主同源提供，所以去掉通配符**不影响面板**；仅回环来源与显式配置的
 * 来源会被回显（回显具体 Origin + `Vary: Origin`，绝不写 `*`）。
 */
export function sendJson(res: unknown, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const r = res as { writeHead?: (code: number, headers: Record<string, string>) => void; end?: (data?: string) => void };
  if (typeof r.writeHead !== 'function' || typeof r.end !== 'function') return;
  const payload = JSON.stringify(body);
  r.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(originFromRes(res)),
    ...extraHeaders,
  });
  r.end(payload);
}

/**
 * 注册路由。返回 webServer.register 的 disposer（由 ctx.effect 承接做插件级清理；
 * disposer 不丢弃是九条红线之一）。宿主无 webServer 时静默跳过（telemetry skipped）
 * —— 插件主体（客户端标签）仍可用嵌入快照。
 */
export function registerSnapshotRoute(ctx: unknown): (() => void) | null {
  const snapshotCtx = ctx as SnapshotCtx;
  const webServer = snapshotCtx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    return null;
  }
  const disposer = webServer.register({
    kind: 'exact',
    path: SNAPSHOT_ROUTE,
    handler: (req, res) => {
      try {
        const root = resolveWorkspaceRoots(snapshotCtx, req);
        const cyclesDir = join(root, '.cycles');
        if (!existsSync(cyclesDir)) {
          sendJson(res, 404, { error: 'no .cycles in current workspace', workspace: root });
          return;
        }
        const snap = buildWorkflowSnapshot(cyclesDir);
        // 内容指纹：客户端可用作"数据是否变了"的廉价判据（展示用，不做条件请求语义）
        const digest = createHash('sha256').update(JSON.stringify({ n: snap.nodes, e: snap.edges })).digest('hex').slice(0, 16);
        sendJson(res, 200, snap, { 'X-ANIC-Snapshot-Digest': digest, 'X-ANIC-Workspace': encodeURIComponent(root) });
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    },
  });
  return typeof disposer === 'function' ? disposer : null;
}
