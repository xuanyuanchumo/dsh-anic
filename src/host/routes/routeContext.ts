/**
 * 共享路由上下文 — 把 makeSend / getWorkspaceRoot / loadFlows 提取到一处，
 * routes/index.ts 不再内联这些逻辑（M9 结构优化：单一职责）。
 */
import { join } from 'node:path';
import { resolveWorkspaceRoots, sendJson, type SnapshotCtx } from '../snapshotRoute.ts';
import { loadWorkspaceConfig } from '../config.ts';
import { setConfiguredOrigins } from '../cors.ts';
import { resolveFlows } from '../../shared/flows.ts';

export type SendFn = (res: unknown, status: number, body: unknown, requestId?: string) => void;

/** 最小路由请求类型——消除路由 handler 中的 `any`（P1-7）。 */
export interface RouteReq {
  url?: string;
  body?: string | Record<string, unknown>;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** 流式请求面（真实宿主 Node IncomingMessage）；桩宿主直接给 body。 */
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

/** 解析请求体——字符串 JSON.parse，对象直接返回，空返回 {}（P1-7 辅助）。 */
export function parseBody(req: RouteReq): Record<string, unknown> {
  const b = req.body;
  if (typeof b === 'string') {
    try { return JSON.parse(b) as Record<string, unknown>; } catch { return {}; }
  }
  if (b && typeof b === 'object') return b;
  return {};
}

/**
 * 读 POST 请求体（真实宿主修复，P0-BODY）。
 *
 * 真实宿主的 webServer handler 收到的是 Node IncomingMessage —— body 以
 * 'data'/'end' 事件流式到达，`req.body` 永远是 undefined（dsh-host-webserver
 * 无 body 解析层，逐字验证过 lib 源码）。旧 parseBody 只读 req.body，导致
 * 全部 11 个 POST 体参数在真实宿主被静默丢弃（测试桩直接挂 body 故全绿）。
 *
 * 双形态兼容：
 *  - 桩宿主：req.body 已存在 → 同步路径立即解析（既有测试零改动）。
 *  - 真实宿主：req.on 可用 → 收集 data 块到 end/error/close 或上限。
 *    reviewRoute 的 `for await (chunk of req)` 是同一语义的仓库内先例。
 */
export const BODY_LIMIT_BYTES = 1_000_000;

export function readBody(req: RouteReq, limitBytes = BODY_LIMIT_BYTES): Promise<Record<string, unknown>> {
  if (req.body !== undefined) return Promise.resolve(parseBody(req));
  const on = req.on;
  if (typeof on !== 'function') return Promise.resolve({});
  // 绑定接收者再调用——直接抽出方法会丢 this（EventEmitter 读 _events 崩溃）
  const emitTo = (event: string, listener: (...args: unknown[]) => void): void => { on.call(req, event, listener); };
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(parseBody({ body: Buffer.concat(chunks).toString('utf-8') }));
    };
    emitTo('data', (chunk?: unknown) => {
      const buf = chunk instanceof Buffer ? chunk : Buffer.from(String(chunk ?? ''), 'utf-8');
      chunks.push(buf);
      total += buf.length;
      if (total >= limitBytes) finish();
    });
    emitTo('end', finish);
    emitTo('error', finish);
    emitTo('close', finish);
  });
}

export interface RouteContext {
  ctx: SnapshotCtx;
  send: SendFn;
  /** req 可选：带 X-ANIC-Workspace 头时优先采信（桌面多会话纠偏，见 snapshotRoute P2 注）。 */
  getWorkspaceRoot: (req?: unknown) => string | null;
  loadFlows: () => { selfInit: boolean };
}

/** 构造带请求头注入的发送函数。 */
export function makeSend(): SendFn {
  return (res, status, body, requestId) => {
    sendJson(res, status, body, requestId ? { 'X-ANIC-Request-Id': requestId } : undefined);
  };
}

/** 从宿主上下文构建共享路由上下文（send/workspace/flows）。 */
export function buildRouteContext(ctx: unknown): RouteContext {
  const c = ctx as SnapshotCtx;
  const send = makeSend();
  const getWorkspaceRoot = (req?: unknown): string | null => {
    try { return resolveWorkspaceRoots(c, req); } catch { return null; }
  };
  const loadFlows = (): { selfInit: boolean } => {
    try {
      const root = getWorkspaceRoot();
      if (!root) return { selfInit: true };
      const cfg = loadWorkspaceConfig(join(root, '.cycles'));
      const resolved = resolveFlows({ workspace: cfg.values.flowOverrides });
      return { selfInit: resolved.flows['flow.selfInit']?.enabled ?? true };
    } catch { return { selfInit: true }; }
  };
  // P0-8：把工作区层 `anic.allowedOrigins` 写进 CORS 允许集（注册期一次）。
  // 工作区尚未就绪时不写 —— 缺省回环策略仍然生效（fail-safe）。
  try {
    const root = getWorkspaceRoot();
    if (root) setConfiguredOrigins(loadWorkspaceConfig(join(root, '.cycles')).values.allowedOrigins);
  } catch { /* 配置不可读 → 保持缺省回环策略 */ }
  return { ctx: c, send, getWorkspaceRoot, loadFlows };
}
