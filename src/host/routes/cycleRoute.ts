/**
 * Cycle 路由（F1/F8，M2-a）。
 *
 * POST /anic/cycle/init      初始化新 cycle
 * POST /anic/cycle/advance   推进节点（状态机 + 账本）
 * POST /anic/cycle/close     关闭 cycle（门禁检查 + 账本验证）
 * GET  /anic/cycle/state     当前状态机状态
 * GET  /anic/cycle/list      cycle 列表
 *
 * cycle-78 WS-A：`/anic/cycle/close` 的响应体**就是** closeCycle 的返回对象（无字段裁剪），
 * 新增的 phaseFrom/phaseTo/phaseAdvanced/phaseBlockedBy/phaseReason 自动透传给客户端；
 * 既有 ok/gatesPassed/ledgerValid/reason 保持不变（返回值只增字段）。本文件无需改逻辑。
 */
import { sendJson, type SnapshotCtx } from '../snapshotRoute.ts';
import { initCycle, advanceCycle, closeCycle, listCycles, nextCycleNumber } from '../runtime/cycleRunner.ts';
import { loadWorkflowGraph, loadState, initState } from '../runtime/stateMachine.ts';
import { type RouteReq, readBody } from './routeContext.ts';
import { join } from 'node:path';

type SendFn = (res: unknown, status: number, body: unknown, requestId?: string) => void;

interface RouteDeps {
  send: SendFn;
  /** 共享工作区解析（含 X-ANIC-Workspace 头；cycle-22 全路由带 req 统一）。 */
  getWorkspaceRoot: (req?: unknown) => string | null;
}

/** 注册 Cycle 路由（init/advance/close/state/list）。 */
export function registerCycleRoute(ctx: unknown, deps: RouteDeps): (() => void) | null {
  const c = ctx as SnapshotCtx;
  if (!c.webServer || typeof c.webServer.register !== 'function') return null;
  const { send, getWorkspaceRoot } = deps;

  const d1 = c.webServer.register({ kind: 'exact', path: '/anic/cycle/init', handler: (req: unknown, res: unknown) => {
    void readBody(req as RouteReq).then((parsed) => {
    const root = getWorkspaceRoot(req);
    if (!root) { send(res, 404, { error: 'no workspace' }); return; }
    const cyclesDir = join(root, '.cycles');
    const projectName = typeof parsed.projectName === 'string' ? parsed.projectName : undefined;
    const info = initCycle(cyclesDir, projectName);
    send(res, 200, { ok: true, ...info });
    });
  }});

  const d2 = c.webServer.register({ kind: 'exact', path: '/anic/cycle/advance', handler: (req: unknown, res: unknown) => {
    void readBody(req as RouteReq).then((parsed) => {
    const root = getWorkspaceRoot(req);
    if (!root) { send(res, 404, { error: 'no workspace' }); return; }
    const cyclesDir = join(root, '.cycles');
    const cycleNumber = Number(parsed.cycleNumber);
    const nodeId = typeof parsed.nodeId === 'string' ? parsed.nodeId : '';
    const record: { gateApproved?: boolean; gate?: string; gateName?: string; result?: 'PASS' | 'FAIL'; detail?: string } = {};
    if (typeof parsed.gateApproved === 'boolean') record.gateApproved = parsed.gateApproved;
    if (typeof parsed.gate === 'string') record.gate = parsed.gate;
    if (typeof parsed.gateName === 'string') record.gateName = parsed.gateName;
    if (parsed.result === 'PASS' || parsed.result === 'FAIL') record.result = parsed.result;
    if (typeof parsed.detail === 'string') record.detail = parsed.detail;
    if (!cycleNumber || !nodeId || !Number.isInteger(cycleNumber) || cycleNumber < 1) { send(res, 400, { error: 'cycleNumber (positive integer) and nodeId required' }); return; }
    const result = advanceCycle(cyclesDir, cycleNumber, nodeId, record);
    send(res, result.ok ? 200 : 409, result);
    });
  }});

  const d3 = c.webServer.register({ kind: 'exact', path: '/anic/cycle/close', handler: (req: unknown, res: unknown) => {
    void readBody(req as RouteReq).then((parsed) => {
    const root = getWorkspaceRoot(req);
    if (!root) { send(res, 404, { error: 'no workspace' }); return; }
    const cyclesDir = join(root, '.cycles');
    const cycleNumber = Number(parsed.cycleNumber);
    if (!cycleNumber || !Number.isInteger(cycleNumber) || cycleNumber < 1) { send(res, 400, { error: 'cycleNumber (positive integer) required' }); return; }
    const result = closeCycle(cyclesDir, cycleNumber);
    send(res, result.ok ? 200 : 409, result);
    });
  }});

  const d4 = c.webServer.register({ kind: 'exact', path: '/anic/cycle/state', handler: (req: unknown, res: unknown) => {
    const root = getWorkspaceRoot(req);
    if (!root) { send(res, 404, { error: 'no workspace' }); return; }
    const cyclesDir = join(root, '.cycles');
    const graph = loadWorkflowGraph(cyclesDir);
    if (!graph) { send(res, 200, { nodes: [], state: {} }); return; }
    let state = loadState(cyclesDir);
    if (Object.keys(state).length === 0) state = initState(graph);
    send(res, 200, { nodes: graph.nodes, edges: graph.edges, state });
  }});

  const d5 = c.webServer.register({ kind: 'exact', path: '/anic/cycle/list', handler: (req: unknown, res: unknown) => {
    const root = getWorkspaceRoot(req);
    if (!root) { send(res, 404, { error: 'no workspace' }); return; }
    const cyclesDir = join(root, '.cycles');
    const cycles = listCycles(cyclesDir);
    const next = nextCycleNumber(cyclesDir);
    send(res, 200, { cycles, nextCycleNumber: next });
  }});

  const disposers = [d1, d2, d3, d4, d5].filter((d): d is () => void => typeof d === 'function');
  return disposers.length > 0 ? () => { for (const d of disposers) d(); } : null;
}
