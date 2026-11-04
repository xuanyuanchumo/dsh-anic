/**
 * 状态全景工具（anic_status）——拆分自 tools.ts（cycle-39 T3 行数纪律：
 * tools.ts 加 presentCall 后 264 行超限）。
 *
 * 内容：FlowTracker 最近记录 + 统计 + 持续学习健康报告 + 技能完整性（doctor）。
 */
import type { ToolRegistration, ToolsSlot } from './toolsSlot.ts';
import { makeToolOutput } from './toolsSlot.ts';
import { inlineSkillRoot } from './skillInvoker.ts';
import { skillIntegritySummary } from './skillIntegrity.ts';
import { readConvergeOutcome } from './skillConverge.ts';
import { loadFlowTracker, recentFlows, flowStats } from './runtime/flowTracker.ts';
import { projectFlowTrackerView, renderFlowViewMarker, projectStatusDistribution } from './flowTrackerProjection.ts';
import { analyzeSkillHealth, formatHealthSummary } from './runtime/continuousLearning.ts';
import { statusPresentCall } from './presentation.ts';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/** 注册 anic_status 工具（org 全景 + flow 记录 + 健康 + 完整性）。 */
export function registerStatusTool(
  register: (tool: ToolRegistration) => (() => void) | null | undefined,
  getRoot: () => string | null,
): Array<(() => void) | null> {
  return [
    register({
      name: 'anic_status',
      // SDO：触发条件 = 要看项目全景/调用历史/技能健康/技能完整性；只读查询，无副作用。
      description: 'Use when an ANIC-managed project needs a status panorama — cycles, ledger, trust/autonomy level, '
        + 'band violations, recent skill-invocation flows, skill health report, or installed-skill integrity. '
        + 'Read-only. Triggers: 项目状态 / org status / 自主级 / 技能健康 / flow records / 全景.',
      output: makeToolOutput(),
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: 'Target project directory' },
          flowLimit: { type: 'number', description: 'Max recent flow records to return (default 10, max 50)' },
        },
      },
      presentCall: statusPresentCall,
      presentResult: () => ({ card: 'generic' as const, title: 'anic_status ✓' }),
      execute: async (args) => {
        const root = (args.workspace as string) ?? getRoot() ?? '';
        const flowLimit = Math.min(Math.max(typeof args.flowLimit === 'number' ? args.flowLimit : 10, 1), 50);
        // M10-a/e：FlowTracker 有界视图 + 统计 + 持续学习健康报告
        // cycle-101（dsh-context 模式）：旧实现 recentFlows 返回**完整 FlowRecord**
        // （含 stdout≤8000/stderr≤4000 的原始大文本，默认 10 条最坏 120KB）——
        // 改成 projectFlowTrackerView 的有界视图：字段白名单 + 保留钳制 +
        // dropped/floorStartedAt 诚实读数。stdout 已由 presentationMeta 通道承载，
        // 视图层重复传输只是 token 浪费（非信息增益）。
        const cyclesDir = join(root, '.cycles');
        let flows: unknown[] = []; let stats: Record<string, unknown> = {};
        let flowView: unknown = null; let flowMarker = '';
        let flowDistribution: unknown = null;
        let health: unknown = null; let healthSummary = '';
        if (existsSync(cyclesDir)) {
          const ts = loadFlowTracker(cyclesDir);
          // cycle-101（dsh-context 模式）：新增**有界视图** flowView —— 字段白名单 +
          // 保留钳制 + dropped/floorStartedAt 诚实读数，供面板/摘要消费（省 token）。
          // 同时**保留** flows/flowStats（无损契约 toolOutputLosslessContract 钉死：
          // 删除既有事实类别 = 消费方静默丢数据）。两者互补：全量事实 + 有界视图。
          const view = projectFlowTrackerView(ts, { limit: flowLimit });
          flowView = view;
          flowMarker = renderFlowViewMarker(view);
          // 状态分布读数（管理面板直接消费：状态计数 + 失败率 + 平均时长）
          flowDistribution = projectStatusDistribution(view);
          flows = recentFlows(ts, flowLimit); stats = flowStats(ts);
          const report = analyzeSkillHealth(ts);
          health = report; healthSummary = formatHealthSummary(report);
        }
        // eco P0：技能完整性（doctor 语义）
        const installedDir = existsSync(join(root, '.dsh', 'skills', 'ai-native-iteration-cycle'))
          ? join(root, '.dsh', 'skills', 'ai-native-iteration-cycle')
          : null;
        const skillIntegrity = skillIntegritySummary(installedDir, inlineSkillRoot());
        // cycle-104：技能自收敛读数（上次激活的收敛动作 + 修复文件数；无记录 = null，不猜）
        const skillConverge = existsSync(join(root, '.cycles'))
          ? readConvergeOutcome(join(root, '.cycles'))
          : null;
        return {
          statusUrl: `/anic/org-status?workspace=${encodeURIComponent(root)}`,
          desktopNote: 'URL routes are served by the dsh web host; desktop (Electron) reaches them via the dsh-app:// IPC bridge.',
          // cycle-101：有界视图（flowsHead/stats/summary 计入）+ grep 友好 marker
          flowView, flowMarker, flowDistribution,
          flows, flowStats: stats,
          health, healthSummary, skillIntegrity, skillConverge,
        };
      },
    }) ?? null,
  ];
}

/** 保留具名导出（tools.ts 聚合面兼容；ToolsSlot 形状仅供类型引用）。 */
export type { ToolsSlot };
