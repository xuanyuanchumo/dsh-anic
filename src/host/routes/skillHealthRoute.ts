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
import { sendAnicError, anicError } from './envelope.ts';
import { join } from 'node:path';
import { createScoped, newRequestId } from '../logger.ts';
import { loadFlowTracker } from '../runtime/flowTracker.ts';
import { analyzeSkillHealth } from '../runtime/continuousLearning.ts';
import { persistHealthSuggestionsAsDebt } from '../evolution/healthDebtBridge.ts';
// cycle-109：runtime 技能的**可见性**读数（注册 ≠ 模型可见，见 skillRegistration.ts 文件头）。
// ★必须经 wire 投影：直发 readout 会把 {last:{…}} 的嵌套形状给客户端（沙箱实测缺陷）。
import { buildSkillVisibilityReadout, toSkillVisibilityWire } from '../runtime/skillVisibilityState.ts';
// cycle-109：**内部技能库**对账读数（assets/skills 此前零消费，见 skillLibrary.ts 文件头）。
// ★同理必须经 wire 投影：直发 readout 给的是数组，客户端要的是计数。
import { readSkillLibraryCached } from '../runtime/skillLibrary.ts';
import { toSkillLibraryWire } from '../runtime/skillLibraryWire.ts';

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
        sendAnicError(deps.send, res, 'ANIC_ROUTE_METHOD', 'GET only', { requestId });
        return;
      }
      const root = deps.getWorkspaceRoot(req);
      if (!root) {
        deps.send(res, 404, anicError('ANIC_ROUTE_NO_WORKSPACE', 'no workspace resolvable'), requestId);
        return;
      }
      // FlowTracker 不存在 → initialFlowTrackerState（空 flows）→ 报告如实为
      // totalInvocations: 0（不伪造、不 500——「没有调用历史」是合法事实）。
      const state = loadFlowTracker(join(root, '.cycles'));
      const report = analyzeSkillHealth(state);
      // cycle-57 T-5702 协议区分：JSON 序列化丢弃 undefined，宿主对「近 7 天无
      // 网关调用」的 recentSuccessRate=undefined 显式转 null——协议上可辨
      // 「新宿主无近期数据」(null) 与「旧宿主无此概念」(字段缺省)。
      const reportJson = {
        ...report,
        scripts: report.scripts.map((s) => ({ ...s, recentSuccessRate: s.recentSuccessRate === undefined ? null : s.recentSuccessRate })),
        // cycle-109：回答「本插件的 runtime 技能现在**模型可见吗**」（三态，不是布尔）。
        // 与 scripts 健康度是**两个面**：前者是官方技能注册面的可见性（project 层同名
        // 可静默压制），后者是本插件脚本调用面的成功率。合并会让两种失败原因混淆。
        runtimeSkill: toSkillVisibilityWire(buildSkillVisibilityReadout()),
        // cycle-109：内部技能库（1 主干 + 9 叶 + 1 元）注册表 ⇄ 磁盘对账。
        // 它是**包内资产**的读数，与工作区 .cycles 无关，故不需要 rootDir。
        library: toSkillLibraryWire(readSkillLibraryCached()),
      };
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
      deps.send(res, 200, reportJson, requestId);
    },
  });
  if (typeof d === 'function') disposers.push(d);

  return disposers;
}
