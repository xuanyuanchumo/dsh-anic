/**
 * 账本路由（F2/F15，M2-a）。
 *
 * GET  /anic/api/ledger          账本条目列表（支持 ?limit & ?offset）
 * POST /anic/api/ledger/append   追加条目（单写者，哈希链）
 * GET  /anic/api/ledger/verify   验证整链
 */
import { sendAnicError } from './envelope.ts';
import { sendJson, type SnapshotCtx } from '../snapshotRoute.ts';
import { loadLedger, appendEntry, verifyLedger, isDuplicate } from '../runtime/ledger.ts';
import { type RouteReq, readBody } from './routeContext.ts';
import { join } from 'node:path';

type SendFn = (res: unknown, status: number, body: unknown, requestId?: string) => void;

interface RouteDeps {
  send: SendFn;
  /** 共享工作区解析（含 X-ANIC-Workspace 头；cycle-22 全路由带 req 统一）。 */
  getWorkspaceRoot: (req?: unknown) => string | null;
}

function query(req: unknown): Record<string, string> {
  const url = (req as { url?: string }).url ?? '';
  const q: Record<string, string> = {};
  const idx = url.indexOf('?');
  if (idx < 0) return q;
  for (const pair of url.slice(idx + 1).split('&')) {
    const [k, v] = pair.split('=');
    if (k) q[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
  }
  return q;
}

/** 注册账本路由（列表/追加/验证）。 */
export function registerLedgerRoute(ctx: unknown, deps: RouteDeps): (() => void) | null {
  const c = ctx as SnapshotCtx;
  if (!c.webServer || typeof c.webServer.register !== 'function') return null;
  const { send, getWorkspaceRoot } = deps;

  const d1 = c.webServer.register({ kind: 'exact', path: '/anic/api/ledger', handler: (req: unknown, res: unknown) => {
    const root = getWorkspaceRoot(req);
    if (!root) { sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable for this request'); return; }
    const cyclesDir = join(root, '.cycles');
    const entries = loadLedger(cyclesDir);
    const q = query(req);
    const off = q.offset ? parseInt(q.offset, 10) : 0;
    const lim = q.limit ? parseInt(q.limit, 10) : entries.length;
    send(res, 200, { total: entries.length, entries: entries.slice(off, off + lim) });
  }});

  const d2 = c.webServer.register({ kind: 'exact', path: '/anic/api/ledger/append', handler: (req: unknown, res: unknown) => {
    void readBody(req as RouteReq).then((parsed) => {
    const root = getWorkspaceRoot(req);
    if (!root) { sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable for this request'); return; }
    const cyclesDir = join(root, '.cycles');
    const { gate, gateName, result, detail } = parsed as { gate?: string; gateName?: string; result?: 'PASS' | 'FAIL'; detail?: string };
    if (!gate || !result) { sendAnicError(send, res, 'ANIC_ROUTE_BAD_REQUEST', 'gate and result required'); return; }
    if (result !== 'PASS' && result !== 'FAIL') { sendAnicError(send, res, 'ANIC_ROUTE_BAD_REQUEST', 'result must be PASS or FAIL'); return; }
    // 幂等查重
    if (isDuplicate(cyclesDir, gate, result)) {
      sendAnicError(send, res, 'ANIC_GATE_FAILED', `last entry is already ${gate}/${result} (idempotent duplicate reject)`);
      return;
    }
    const entry = appendEntry(cyclesDir, { gate, gateName: gateName ?? gate, result, detail: detail ?? '' });
    send(res, 200, { ok: true, entry });
    });
  }});

  const d3 = c.webServer.register({ kind: 'exact', path: '/anic/api/ledger/verify', handler: (req: unknown, res: unknown) => {
    const root = getWorkspaceRoot(req);
    if (!root) { sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable for this request'); return; }
    const cyclesDir = join(root, '.cycles');
    const result = verifyLedger(cyclesDir);
    send(res, 200, result);
  }});

  const disposers = [d1, d2, d3].filter((d): d is () => void => typeof d === 'function');
  return disposers.length > 0 ? () => { for (const d of disposers) d(); } : null;
}
