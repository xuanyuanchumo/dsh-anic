/**
 * Flows 域路由（R3 阶段 2/3）—— 流程状态流转机的观测面 + 运行面。
 *
 *  - GET  /anic/flows                       注册表列表（描述子可序列化投影）
 *  - GET  /anic/flows/status                一站式：全部流程 + 各自当前投影（面板消费）
 *  - GET  /anic/flows/state?flow=<id>       当前投影（无投影 = 从未运行过，不伪造）
 *  - POST /anic/flows/gate-check/run        运行 gate-check 流程（mode=script/native/diff）
 *  - GET  /anic/flows/macro-phase/status    宏观六相只读视图（不落盘；增补 inferred/drift）
 *  - POST /anic/flows/macro-phase/advance   宏观相位推进（mode=script 正典/native；dryRun 只算不写）
 *  - POST /anic/flows/archive/run           归档流程（--cycle/--clean/--list 语义；mode=native/script）
 *  - POST /anic/flows/hitl/run              HITL 三段修复流程（gate=all|H1-H4；mode=native/script；R3 阶段 4）
 *  - POST /anic/flows/auto-fix/run          自动修复循环流程（maxRetries/testCmd；mode=native/script；R3 阶段 5）
 *
 * 设计注记：运行入口按流程 id 静态分派（泛型运行入口等第三个流程实例再抽象——
 * 第 4 个实例已到仍维持：各流程参数域差异大，抽象的参数税大于分派税）。
 */
import { existsSync } from 'node:fs';
import { listFlows } from '../flows/registry.ts';
import { runGateFlow, type GateFlowMode } from '../flows/gateCheckFlow.ts';
import { runMacroPhaseFlow, statusMacroPhase, type MacroFlowMode } from '../flows/macroPhaseFlow.ts';
import { runArchiveFlow, type ArchiveFlowMode } from '../flows/archiveFlow.ts';
import { runHitlFlow, type HitlFlowMode, type HitlGateArg } from '../flows/hitlFlow.ts';
import { runAutoFixFlow, type AutoFixFlowMode } from '../flows/autoFixFlow.ts';
import { PHASE_IDS } from '../flows/macroPhaseEngine.ts';
import { loadFlowProjection } from '../flows/persistence.ts';
// cycle-89：流程 ↔ 循环/相位/门禁 矩阵（join key 的**消费面** —— 此前只有生产没有出口）。
import { buildFlowMatrixForWorkspace } from '../flows/flowMatrixView.ts';
import { filterByWorkspace } from '../flows/flowWorkspaceScope.ts';
import { loadFlowTracker } from '../runtime/flowTracker.ts';
// cycle-90：生命周期指标（KM 生存分析 / EWMA 控制图 / 分位数 + Gini）。
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

  // GET /anic/flows/status — 一站式观测面（D10 宿主域接线：客户端面板消费）
  // 单流程 /anic/flows/state 面板侧要发 N 次请求；本路由一次返回全部流程 + 各自投影
  //（无投影 = 从未运行过，如实为 null 不伪造 IDLE）。
  // cycle-96 WS-A：增补 macroPhase（与 macro-phase/status 同一生产者）。root=null ⇒ null。
  reg('/anic/flows/status', (req, res) => {
    const root = deps.getWorkspaceRoot(req);
    const cyclesDir = root ? `${root}/.cycles` : null;
    const flows = listFlows().map((d) => ({
      ...descriptorView(d),
      projection: cyclesDir && existsSync(cyclesDir)
        ? loadFlowProjection(cyclesDir, d.id)
        : null,
    }));
    send(res, 200, {
      flows,
      total: flows.length,
      running: flows.filter((f) => f.projection?.current === 'RUNNING').length,
      terminal: flows.filter((f) => f.projection && f.projection.current !== 'RUNNING').length,
      neverRun: flows.filter((f) => f.projection === null).length,
      macroPhase: root ? statusMacroPhase(root) : null,
    });
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
    const projection = existsSync(cyclesDir) ? loadFlowProjection(cyclesDir, flowId) : null;
    // 无投影 = 从未运行过（IDLE 的默认态不落盘 —— 投影只记已发生的事实）
    send(res, 200, { flowId, projection, descriptor: descriptorView(d) });
  });

  // GET /anic/api/flows/matrix — 流程 ↔ 循环/相位/门禁 矩阵（cycle-89）
  // joinFlows/coverageMetrics 生产了归属数据但此前无路由暴露它（空心问题）。fail-closed。
  reg('/anic/api/flows/matrix', (req, res) => {
    const root = deps.getWorkspaceRoot(req);
    if (!root) return send(res, 500, { error: 'ANIC_ROUTE_NO_WORKSPACE' });
    const cyclesDir = `${root}/.cycles`;
    // 读不到 flow-tracker → 空集合 + total 0（**如实**，不伪造）。
    const records = existsSync(cyclesDir) ? loadFlowTracker(cyclesDir).flows : [];
    send(res, 200, buildFlowMatrixForWorkspace(records, root));
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

  // GET /anic/flows/macro-phase/status — 宏观六相只读视图
  // cycle-96 WS-A：增补 inferredPhase/drift/inferenceCeiling（不新增路由）。只报 stored 时
  //「状态文件没跟上工件」不可见；技能侧此前恰好反过来（inferPhase 改盘）。
  reg('/anic/flows/macro-phase/status', (req, res) => {
    const root = deps.getWorkspaceRoot(req);
    if (!root) return send(res, 500, { error: 'ANIC_ROUTE_NO_WORKSPACE' });
    send(res, 200, statusMacroPhase(root));
  });

  // POST /anic/flows/macro-phase/advance — 宏观相位推进
  reg('/anic/flows/macro-phase/advance', (req, res) => {
    void readBody(req as RouteReq).then((body) => {
      const root = deps.getWorkspaceRoot(req);
      if (!root) return send(res, 500, { error: 'ANIC_ROUTE_NO_WORKSPACE' });
      const mode = typeof body.mode === 'string' && ['script', 'native'].includes(body.mode)
        ? body.mode as MacroFlowMode
        : 'script';
      const target = typeof body.target === 'string' ? body.target : undefined;
      if (target !== undefined && !PHASE_IDS.includes(target)) {
        return send(res, 400, { error: `ANIC_ROUTE_BAD_PHASE:${target}`, validPhases: PHASE_IDS });
      }
      if (body.dryRun === true && mode === 'script') {
        return send(res, 400, { error: 'ANIC_ROUTE_DRYRUN_NATIVE_ONLY' });
      }
      const result = runMacroPhaseFlow(root, {
        target,
        mode,
        dryRun: body.dryRun === true,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      });
      if (result.error) return send(res, 422, result);
      send(res, 200, result);
    });
  });

  // POST /anic/flows/archive/run — 归档流程（R3 阶段 3 后半）
  reg('/anic/flows/archive/run', (req, res) => {
    void readBody(req as RouteReq).then((body) => {
      const root = deps.getWorkspaceRoot(req);
      if (!root) return send(res, 500, { error: 'ANIC_ROUTE_NO_WORKSPACE' });
      const mode: ArchiveFlowMode = body.mode === 'script' ? 'script' : 'native';
      if (body.cycle !== undefined && typeof body.cycle !== 'number') {
        return send(res, 400, { error: 'ANIC_ROUTE_BAD_CYCLE: expect number' });
      }
      if (body.keep !== undefined && typeof body.keep !== 'number') {
        return send(res, 400, { error: 'ANIC_ROUTE_BAD_KEEP: expect number' });
      }
      // 无参缺省 list（只读安全缺省）；archive 需显式 cycle，clean 需显式 clean:true
      const result = runArchiveFlow(root, {
        cycle: typeof body.cycle === 'number' ? body.cycle : undefined,
        clean: body.clean === true,
        keep: typeof body.keep === 'number' ? body.keep : undefined,
        list: body.cycle === undefined && body.clean !== true,
        mode,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      });
      send(res, result.ok ? 200 : 422, result);
    });
  });

  // POST /anic/flows/hitl/run — HITL 三段修复流程（R3 阶段 4 后半）
  reg('/anic/flows/hitl/run', (req, res) => {
    void readBody(req as RouteReq).then((body) => {
      const root = deps.getWorkspaceRoot(req);
      if (!root) return send(res, 500, { error: 'ANIC_ROUTE_NO_WORKSPACE' });
      const mode: HitlFlowMode = body.mode === 'script' ? 'script' : 'native';
      const gateStr = typeof body.gate === 'string' ? body.gate : 'all';
      if (gateStr !== 'all' && !/^H[1-4]$/.test(gateStr)) {
        return send(res, 400, { error: `ANIC_ROUTE_BAD_HITL_GATE:${gateStr}` });
      }
      const gate: HitlGateArg = gateStr === 'H1' || gateStr === 'H2' || gateStr === 'H3' || gateStr === 'H4' ? gateStr : 'all';
      const result = runHitlFlow(root, {
        gate,
        mode,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      });
      // 状态码语义：pass→200 / fail→422 / circuit→409（exit 2 = 需要人类介入，BLOCKED）
      const code = result.verdict === 'pass' ? 200 : result.verdict === 'circuit' ? 409 : 422;
      send(res, code, result);
    });
  });

  // POST /anic/flows/auto-fix/run — 自动修复循环流程（R3 阶段 5，第 5 流程）
  reg('/anic/flows/auto-fix/run', (req, res) => {
    void readBody(req as RouteReq).then((body) => {
      const root = deps.getWorkspaceRoot(req);
      if (!root) return send(res, 500, { error: 'ANIC_ROUTE_NO_WORKSPACE' });
      const mode: AutoFixFlowMode = body.mode === 'script' ? 'script' : 'native';
      const maxRetries = typeof body.maxRetries === 'number' && Number.isInteger(body.maxRetries) && body.maxRetries > 0 && body.maxRetries <= 10
        ? body.maxRetries
        : undefined;
      const testCmd = typeof body.testCmd === 'string' && body.testCmd.trim() !== '' ? body.testCmd : undefined;
      const result = runAutoFixFlow(root, {
        mode,
        maxRetries,
        testCmd,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      });
      // 状态码语义：pass→200 / circuit→409（exit 2 = 重试耗尽需人类介入）/ 前置错误→400
      if (result.exitCode === 1 && result.error) return send(res, 400, result);
      send(res, result.verdict === 'pass' ? 200 : 409, result);
    });
  });

  return disposers;
}
