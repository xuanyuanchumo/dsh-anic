/**
 * 技能健康观测路由（ui-domain-plan P3）：GET /anic/skill/health。
 *
 * 数据面：FlowTracker（.cycles/flow-tracker.json 的技能调用历史）→
 * analyzeSkillHealth 纯函数分析 → SkillHealthReport。
 *
 * 与 anic_status 工具的关系：工具面早已有 health+healthSummary（LLM 调用面），
 * 本路由把**同一份分析**暴露给面板 HTTP 面——单一事实源（continuousLearning.ts
 * 的阈值常量），两个消费面（LLM 工具 / 面板轮询）。
 *
 * getWorkspaceRoot(req)：带 X-ANIC-Workspace 请求头解析（P2 桌面多会话错位
 * 的既定契约——面板学得工作区根后回带头，服务端据此选「本面板的工作区」）。
 */
import { join } from 'node:path';
import { createScoped, newRequestId } from '../logger.ts';
import { loadFlowTracker } from '../runtime/flowTracker.ts';
import { analyzeSkillHealth } from '../runtime/continuousLearning.ts';
import { persistHealthSuggestionsAsDebt } from '../evolution/healthDebtBridge.ts';

const log = createScoped('anic:route:skill-health');
export const SKILL_HEALTH_ROUTE = '/anic/skill/health';

interface SendFn {
  (res: unknown, status: number, body: unknown, requestId?: string): void;
}

/** 注册技能健康路由。deps.getWorkspaceRoot 接收 req 以支持工作区请求头。 */
export function registerSkillHealthRoute(
  ctx: unknown,
  deps: { send: SendFn; getWorkspaceRoot: (req?: unknown) => string | null },
): Array<(() => void) | null> {
  const ws = (ctx as { webServer?: { register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => (() => void) | void } }).webServer;
  if (!ws || typeof ws.register !== 'function') return [];

  const disposers: Array<(() => void) | null> = [];

  const d = ws.register({
    kind: 'exact',
    path: SKILL_HEALTH_ROUTE,
    handler: (req, res) => {
      const requestId = newRequestId();
      const r = req as { method?: string };
      if ((r?.method ?? 'GET') !== 'GET') {
        deps.send(res, 405, { error: 'GET only' }, requestId);
        return;
      }
      const root = deps.getWorkspaceRoot(req);
      if (!root) {
        deps.send(res, 404, { error: { code: 'ANIC_ROUTE_NO_WORKSPACE', message: 'no workspace resolvable' } }, requestId);
        return;
      }
      // FlowTracker 不存在 → initialFlowTrackerState（空 flows）→ 报告如实为
      // totalInvocations: 0（不伪造、不 500——「没有调用历史」是合法事实）。
      const state = loadFlowTracker(join(root, '.cycles'));
      const report = analyzeSkillHealth(state);
      // cycle-55（T-5501）：健康建议落 tech-debt 提案（写面合流——改进建议
      // 从「看完即散」变工作队列承载）。同日幂等：重复轮询不堆重复提案；
      // 落盘失败不阻塞读面（面板照常拿 report——债务落盘是旁路增强，读面
      // 可用性优先），只在 debug 日志留痕。
      try {
        const debt = persistHealthSuggestionsAsDebt(join(root, '.cycles'), report.suggestions, new Date().toISOString());
        if (debt.written > 0) {
          log.debug(`health→debt: ${String(debt.written)} written, ${String(debt.skipped)} skipped, file ${debt.file ?? 'none'}`, requestId);
        }
      } catch (e) {
        log.debug(`health→debt persist failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`, requestId);
      }
      log.debug(`skill health: ${String(report.totalInvocations)} invocations, ${String(report.scripts.length)} scripts`, requestId);
      deps.send(res, 200, report, requestId);
    },
  });
  if (typeof d === 'function') disposers.push(d);

  return disposers;
}
