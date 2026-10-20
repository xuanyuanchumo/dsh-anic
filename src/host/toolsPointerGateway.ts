/**
 * 指针型 DSH 工具——返回路由 URL 供前端/大模型进一步查询。
 *
 * 拆分自 tools.ts（T3 ≤250 行模块化纪律）。
 * anic_snapshot / anic_self_check / anic_hitl 三个工具的共同模式：
 * 校验 workspace → 返回对应路由 URL。无副作用，无脚本调用。
 *
 * cycle-39 T-3907：三工具补 presentCall/presentResult 卡片（19/19 完备）。
 * cycle-39 T-3914：URL 字段附 desktopNote——官方 web-server.md:9 明示桌面端
 * （Electron）经 IPC 桥接不经本服务器；实测桌面宿主走 dsh-app:// scheme 转发
 * （main.js forwardWebRequest，pathname 完整透传），URL 在双端可达，但语义
 * 标注让桌面端异常时第一排查点明确。
 */
import type { ToolRegistration } from './toolsSlot.ts';
import { makeToolOutput } from './toolsSlot.ts';
import { validateWorkspace } from './skillInvoker.ts';
import { genericCall, genericResult } from './presentation.ts';

const DESKTOP_NOTE = 'URL routes are served by the dsh web host; desktop (Electron) reaches them via the dsh-app:// IPC bridge — if unreachable on desktop, check the bridge, not the route registration.';

/** 注册指针型 DSH 工具（anic_snapshot/anic_self_check/anic_hitl）。 */
export function registerPointerTools(
  register: (tool: ToolRegistration) => (() => void) | null | undefined,
  getRoot: () => string | null,
): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];

  // Tool: anic_snapshot — get workflow snapshot
  disposers.push(register({
    name: 'anic_snapshot',
    // SDO：触发条件 = 要看工作流图数据；只读。
    description: 'Use when the workflow-graph data (nodes, edges, cycles, ledger events) of an ANIC-managed project '
      + 'is needed for rendering or inspection. Read-only. Triggers: 快照 / workflow snapshot / '
      + '工作流图 / graph data.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory' },
      },
    },
    presentCall: (args) => genericCall('anic_snapshot', 'search', { workspace: args.workspace }),
    presentResult: () => genericResult('anic_snapshot ✓'),
    execute: async (args) => {
      const root = (args.workspace as string) ?? getRoot() ?? '';
      const check = validateWorkspace(root);
      if (!check.ok) return { error: check.error };
      return { snapshotUrl: `/anic/api/workflow-snapshot?workspace=${encodeURIComponent(root)}`, desktopNote: DESKTOP_NOTE };
    },
  }) ?? null);

  // Tool: anic_self_check — runtime INV probes
  disposers.push(register({
    name: 'anic_self_check',
    // SDO：触发条件 = 怀疑插件运行时不变量被破坏/要健康探针。
    description: 'Use when the plugin runtime invariants of an ANIC-managed project need probing — '
      + 'suspecting a broken invariant, or a routine health check of the anic runtime. '
      + 'Triggers: 自检 / self-check / 不变量 / INV probes / 运行时健康.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory' },
      },
    },
    presentCall: (args) => genericCall('anic_self_check', 'search', { workspace: args.workspace }),
    presentResult: () => genericResult('anic_self_check ✓'),
    execute: async (args) => {
      const root = (args.workspace as string) ?? getRoot() ?? '';
      return { selfCheckUrl: `/anic/api/self-check?workspace=${encodeURIComponent(root)}`, desktopNote: DESKTOP_NOTE };
    },
  }) ?? null);

  // Tool: anic_hitl — run HITL audit (native, no skill dependency)
  disposers.push(register({
    name: 'anic_hitl',
    // SDO：触发条件 = 需要 HITL 审计入口（人类在环审计，与 flows_hitl 三段修复区分：本工具是路由指针）。
    description: 'Use when a human-in-the-loop audit entry point is needed for an ANIC-managed project — '
      + 'auditing sensitive-data protection, rollback safety, gate-green state, ledger integrity (H1-H4). '
      + 'Triggers: HITL / 人类在环审计 / human-in-the-loop audit.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory' },
      },
    },
    presentCall: (args) => genericCall('anic_hitl', 'search', { workspace: args.workspace }),
    presentResult: () => genericResult('anic_hitl ✓'),
    execute: async (args) => {
      const root = (args.workspace as string) ?? getRoot() ?? '';
      return { hitlUrl: `/anic/hitl-audit?workspace=${encodeURIComponent(root)}`, desktopNote: DESKTOP_NOTE };
    },
  }) ?? null);

  return disposers;
}
