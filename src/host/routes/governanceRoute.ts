/**
 * M5-a Governance 路由 — 归档/预算/清扫/孤儿检查。
 *
 * 【P0-GOV-ROOT 修复（cycle-8 真实宿主发现）】本文件原有一个本地 resolveRoot，
 * 直接读 ctx.workspaceRegistry 属性 —— 真实 Cordis fiber 里该服务不在静态
 * inject（postmortem-0001 R2：cannot get property without inject），属性访问
 * 本身抛异常 → webserver 统一 catch → 全部 4 条治理路由自 M5-a 起在真实宿主
 * 恒 400 空体（快照路由同款访问有 try/catch 故从未暴露）。修法：改用
 * buildRouteContext 的共享 getWorkspaceRoot（cycle-3 硬化版，含
 * X-ANIC-Workspace 桌面多会话纠偏），本地解析函数整体删除。
 */

import { sendAnicError } from './envelope.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readBody, type RouteReq } from './routeContext.ts';
import { runArchiveFlow } from '../flows/archiveFlow.ts';
import { checkBudget, type BudgetThresholds } from '../governance/budget.ts';
import { workspaceFlowEnabled } from '../runtime/workspaceFlow.ts';
import { sweepCycles, type SweepOptions } from '../governance/sweep.ts';
import { pruneCheck } from '../governance/prune.ts';

type SendFn = (res: unknown, code: number, body: unknown, requestId?: string) => void;

interface ServerContext {
  webServer?: {
    register?: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => (() => void) | void;
  };
}

export interface GovernanceRouteDeps {
  send: SendFn;
  /** 共享工作区解析（含 X-ANIC-Workspace 头；P0-GOV-ROOT 修复的核心） */
  getWorkspaceRoot: (req?: unknown) => string | null;
}

/** 注册治理路由（归档/预算/清扫/孤儿检查）。 */
export function registerGovernanceRoute(ctx: ServerContext, deps: GovernanceRouteDeps): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];
  const ws = ctx.webServer;
  if (!ws?.register) return disposers;
  const { send, getWorkspaceRoot } = deps;

  const reg = (path: string, handler: (req: unknown, res: unknown) => void): void => {
    const d = ws.register!({ kind: 'exact', path, handler });
    disposers.push(typeof d === 'function' ? d : null);
  };

  // POST /anic/governance/archive — 归档（R3 阶段 3 后半：委托 archive 流程引擎，技能语义）
  // P0-BODY 残留修复：原直接读 req.body（真实宿主恒 undefined）——改 readBody 流式兼容。
  reg('/anic/governance/archive', (req, res) => {
    const root = getWorkspaceRoot(req);
    if (!root) return sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable for this request');
    const cyclesDir = join(root, '.cycles');
    if (!existsSync(cyclesDir)) return sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no .cycles directory in this workspace');

    void readBody(req as RouteReq).then((body) => {
      const result = runArchiveFlow(root, {
        cycle: typeof body.cycle === 'number' ? body.cycle : undefined,
        clean: body.clean === true,
        keep: typeof body.keep === 'number' ? body.keep : undefined,
        list: body.list === true,
        mode: body.mode === 'script' ? 'script' : 'native',
      });
      send(res, result.ok ? 200 : 422, result);
    });
  });

  // GET /anic/governance/budget — 预算检查
  reg('/anic/governance/budget', (req, res) => {
    const root = getWorkspaceRoot(req);
    if (!root) return sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable for this request');
    const cyclesDir = join(root, '.cycles');
    if (!existsSync(cyclesDir)) return sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no .cycles directory in this workspace');

    const url = (req as { url?: string }).url ?? '';
    const params = new URLSearchParams(url.split('?')[1] ?? '');
    const thresholds: BudgetThresholds = {};
    const w = params.get('warn');
    const a = params.get('alert');
    if (w) thresholds.warnBytes = parseInt(w, 10);
    if (a) thresholds.alertBytes = parseInt(a, 10);

    const report = checkBudget(cyclesDir, thresholds);
    // cycle-91：`flow.budgetEnforce` 开关接上（此前**零消费点** ⇒ 纯声明）。
    //
    // 语义（与 `flows.ts` 的 degradation 文案一致）：
    //   开启 ⇒ status 如实报 `alert`（= 达到熔断线）；
    //   关闭 ⇒ **降级为只告警不熔断**（alert → warn，并如实说明降级原因）。
    //
    // 为什么降级要**说明**而不是静默改值：静默降级会让读者以为「没超预算」
    // —— 那正是「用假数据掩盖真实状态」。
    const enforce = workspaceFlowEnabled(root, 'flow.budgetEnforce');
    if (!enforce && report.status === 'alert') {
      send(res, 200, {
        ...report,
        status: 'warn',
        rawStatus: 'alert',
        enforcement: 'disabled',
        note: '预算熔断已关闭（flow.budgetEnforce=false）——超阈值仅告警不熔断',
      });
      return;
    }
    send(res, 200, { ...report, enforcement: enforce ? 'enabled' : 'disabled' });
  });

  // POST /anic/governance/sweep — 清扫空目录与过期 .tmp
  reg('/anic/governance/sweep', (req, res) => {
    const root = getWorkspaceRoot(req);
    if (!root) return sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable for this request');
    const cyclesDir = join(root, '.cycles');
    if (!existsSync(cyclesDir)) return sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no .cycles directory in this workspace');

    // P0-BODY 残留修复：原直接读 req.body（真实宿主恒 undefined）——改 readBody 流式兼容。
    void readBody(req as RouteReq).then((body) => {
      const options: SweepOptions = {};
      if (body.removeTmpFiles === false) options.removeTmpFiles = false;
      if (typeof body.tmpMaxAgeMs === 'number') options.tmpMaxAgeMs = body.tmpMaxAgeMs;
      const result = sweepCycles(cyclesDir, options);
      send(res, 200, result);
    });
  });

  // GET /anic/governance/prune — 孤儿检查
  reg('/anic/governance/prune', (req, res) => {
    const root = getWorkspaceRoot(req);
    if (!root) return sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable for this request');
    const cyclesDir = join(root, '.cycles');
    if (!existsSync(cyclesDir)) return sendAnicError(send, res, 'ANIC_ROUTE_NO_WORKSPACE', 'no .cycles directory in this workspace');

    const report = pruneCheck(cyclesDir);
    send(res, 200, report);
  });

  return disposers;
}
