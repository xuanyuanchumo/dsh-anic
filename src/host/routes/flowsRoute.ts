/**
 * Flows 域路由（R3 阶段 2）—— 流程状态流转机的观测面 + 运行面。
 *
 *  - GET  /anic/flows                    注册表列表（描述子可序列化投影）
 *  - GET  /anic/flows/:id/state          当前投影（无投影 = 从未运行过，不伪造）
 *  - POST /anic/flows/gate-check/run     运行 gate-check 流程（mode=script/native/diff）
 *
 * 设计注记：运行入口按流程 id 静态分派（阶段 2 只有 gate-check；FlowRegistry
 * 泛型运行入口留到阶段 3 macroPhase 接入时再抽象——「已有 ≥2 个真实实例才
 * 引入契约层」的纪律）。
 */
import { existsSync } from 'node:fs';
import { listFlows } from '../flows/registry.ts';
import { runGateFlow, type GateFlowMode } from '../flows/gateCheckFlow.ts';
import { loadFlowProjection } from '../flows/persistence.ts';
import { readBody, type RouteReq } from './routeContext.ts';

type SendFn = (res: unknown, code: number, body: unknown, requestId?: string) => void;

interface ServerContext {
  webServer?: {
    register?: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => (() => void) | void;
  };
}

interface FlowsRouteDeps {
  getWorkspaceRoot: (req?: unknown) => string | null;
}

/** 描述子的可序列化投影（GET /anic/flows 的条目形态）。 */
function descriptorView(d: ReturnType<typeof listFlows>[number]) {
  return {
    id: d.id,
    labelKey: d.labelKey,
    states: d.states,
    initial: d.initial,
    transitions: d.transitions.map((t) => ({ from: t.from, to: t.to, trigger: t.trigger, guard: t.guard ?? null })),
    persistence: d.persistence,
    engine: d.engine ?? null,
    scriptFallback: d.scriptFallback ?? null,
  };
}

export function registerFlowsRoute(ctx: ServerContext, send: SendFn, deps: FlowsRouteDeps): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];
  const ws = ctx.webServer;
  if (!ws?.register) return disposers;

  const reg = (path: string, handler: (req: unknown, res: unknown) => void): void => {
    const d = ws.register!({ kind: 'exact', path, handler });
    disposers.push(typeof d === 'function' ? d : null);
  };

  // GET /anic/flows — 注册表观测面
  reg('/anic/flows', (_req, res) => {
    send(res, 200, { flows: listFlows().map(descriptorView), total: listFlows().length });
  });

  // GET /anic/flows/state?flow=<id> — 单流程当前投影
  reg('/anic/flows/state', (req, res) => {
    const root = deps.getWorkspaceRoot(req);
    if (!root) return send(res, 500, { error: 'ANIC_ROUTE_NO_WORKSPACE' });
    const url = (req as { url?: string }).url ?? '';
    const flowId = new URLSearchParams(url.split('?')[1] ?? '').get('flow') ?? 'gate-check';
    const d = listFlows().find((f) => f.id === flowId);
    if (!d) return send(res, 404, { error: `ANIC_ROUTE_UNKNOWN_FLOW:${flowId}` });
    const cyclesDir = `${root}/.cycles`;
    const projection = existsSync(cyclesDir)
      ? loadFlowProjection(cyclesDir, flowId)
      : null;
    // 无投影 = 从未运行过（IDLE 的默认态不落盘 —— 投影只记已发生的事实）
    send(res, 200, { flowId, projection, descriptor: descriptorView(d) });
  });

  // POST /anic/flows/gate-check/run — 运行 gate-check 流程
  reg('/anic/flows/gate-check/run', (req, res) => {
    void readBody(req as RouteReq).then((body) => {
      const root = deps.getWorkspaceRoot(req);
      if (!root) return send(res, 500, { error: 'ANIC_ROUTE_NO_WORKSPACE' });
      const mode = typeof body.mode === 'string' && ['script', 'native', 'diff'].includes(body.mode)
        ? body.mode as GateFlowMode
        : 'script';
      const gate = typeof body.gate === 'string' ? body.gate : 'all';
      if (gate !== 'all' && !/^G[0-3]$/.test(gate)) {
        return send(res, 400, { error: `ANIC_ROUTE_BAD_GATE:${gate}` });
      }
      const result = runGateFlow(root, {
        gate,
        mode,
        quality: body.quality !== false, // 缺省与 anic_iterate 对齐：跑质量门
        record: body.record === true,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      });
      if (result.error) return send(res, 500, { error: `ANIC_ROUTE_FLOW_ERROR:${result.error}`, ...result });
      send(res, 200, result);
    });
  });

  return disposers;
}
