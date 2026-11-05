/**
 * ANIC 工具 id 的**共享清单**（cycle-107 原生优化：命令窗口显示修复）。
 *
 * 为什么移到 shared：client 半部要在 `tool.call.toolview` 席位注册 anic_* 工具的
 * 终端卡片（官方契约见 kb/site/reference/cookbook/adding-a-tool.md:95——内置 Web Client
 * **不消费** `presentCall`/`presentResult`，必须由 client 插件经 keyed slot 注册自己的
 * wire 工具名并从 `ToolCallBlock` 派生 props）。client 需要工具名清单，而
 * `tsconfig.client.json:17` 已 include `src/shared` 下全部 `.ts`，故放 shared。
 *
 * 单一真相源纪律（继承 host/toolIds.ts）：
 *   本清单是「注册代码是真相」的**投影**——`tests/contract/toolIdsContract.test.ts`
 *   扫 `src/host/tools*.ts` 里所有 `name: 'anic_...'` 字面量，与本表做**双向**集合比对。
 *   host/toolIds.ts 从此**再导出**本表（保持契约测试的 import 路径零变更）。
 *
 * 诚实边界：本表只回答「这个 id 是不是本插件注册的工具」，不回答「该角色是否被允许调用」
 * ——授权判定是 `autonomyBand` 与调用点的职责。
 */

/** 本插件注册的全部 DSH 工具 id（24 个，字典序）。
 *
 * cycle-74：19 → 21（渐进式披露加载器 anic_tool_detail / anic_tools_search）。
 * cycle-77：21 → 22（anic_autonomy_upgrade）。
 * cycle-80：22 → 23（anic_reload_self）。
 * cycle-96：23 → 24（anic_bootstrap_other「举他」工具化）。 */
export const ANIC_TOOL_IDS: readonly string[] = [
  'anic_autonomy_downgrade',
  'anic_autonomy_upgrade',
  'anic_bootstrap',
  'anic_bootstrap_analyze',
  'anic_bootstrap_cycle',
  'anic_bootstrap_other',
  'anic_evaluate',
  'anic_flows_advance',
  'anic_flows_archive',
  'anic_flows_auto_fix',
  'anic_flows_gate_check',
  'anic_flows_hitl',
  'anic_gate_check',
  'anic_hitl',
  'anic_install',
  'anic_iterate',
  'anic_reload_self',
  'anic_self_check',
  'anic_skill',
  'anic_skill_repair',
  'anic_snapshot',
  'anic_status',
  'anic_tool_detail',
  'anic_tools_search',
];

/** anic_ 前缀判定（工具名合法性：`^anic_[a-z][a-z0-9_]*$` 的宽松版）。 */
export const ANIC_TOOL_PREFIX = 'anic_';

/** 该 id 是否为 anic_* 工具（前缀判定，宽松——只判前缀，不判存在性）。 */
export function isAnicToolName(name: string): boolean {
  return name.startsWith(ANIC_TOOL_PREFIX);
}
