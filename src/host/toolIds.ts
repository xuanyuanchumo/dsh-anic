/**
 * ANIC DSH 工具 id 的正典清单（cycle-38 · M2-a 落地）。
 *
 * 为什么需要这个文件（补的是 agents.ts 里一条**自我承诺**）：
 *   `src/host/agents.ts` 的注释原文写着「`toolsAllowlist` M1 只做形状校验
 *   （`^anic_[a-z][a-z0-9_]*$`）；存在性校验在 M2-a 工具面落地后接入
 *   （ToolRegistry 出现时启用，注释即契约）」。形状校验能过
 *   `anic_this_tool_does_not_exist`——它语法合法，但根本没有这个工具。
 *   于是「白名单」能声明出一个不存在的工具而无人拒绝，白名单实际是装饰。
 *
 * 单一真相源纪律：
 *   本清单**不是**第二个真相源，而是「注册代码是真相」的**投影**——
 *   `tests/contract/toolIdsContract.test.ts` 扫 `src/host/tools*.ts` 里所有
 *   `name: 'anic_...'` 字面量，与本表做**双向**集合比对（多一个、少一个都红）。
 *   改注册代码而不改本表 → 契约测试立即失败；这正是我们要的耦合方向：
 *   真相在注册处，本表只是让「存在性」可以在装载期被机械检查。
 *
 * 诚实边界：
 *   本表只回答「这个 id 是不是本插件注册的工具」。它**不**回答「这个角色
 *   被允许调用它」——授权判定是 `autonomyBand` 与调用点的职责，本表不做。
 */

/** 本插件注册的全部 DSH 工具 id（22 个，字典序）。
 *
 * cycle-74：19 → 21 —— 新增两个**渐进式披露加载器**（anic_tool_detail / anic_tools_search）。
 * 它们是 indexed 模式下模型取回 schema 的唯一通道，缺则自锁（见 indexActivation.activationReady）。
 * cycle-77：21 → 22 —— 新增 `anic_autonomy_upgrade`（升级此前无任何入口，只能手改 config，
 * 与「人类授权的 L4」无法区分；现在升级能力进工具面才可被计数/索引/自检消费）。 */
export const ANIC_TOOL_IDS: readonly string[] = [
  'anic_autonomy_downgrade',
  'anic_autonomy_upgrade',
  'anic_bootstrap',
  'anic_bootstrap_analyze',
  'anic_bootstrap_cycle',
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
  'anic_self_check',
  'anic_skill',
  'anic_skill_repair',
  'anic_snapshot',
  'anic_status',
  'anic_tool_detail',
  'anic_tools_search',
];

const KNOWN = new Set(ANIC_TOOL_IDS);

/** 该 id 是否为本插件真实注册的工具。 */
export function isKnownToolId(id: string): boolean {
  return KNOWN.has(id);
}

/**
 * 过滤出**不存在**的工具 id（保序、去重）。
 * 返回空数组 = 全部存在；调用方据此决定是拒绝装载还是放行。
 */
export function unknownToolIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (KNOWN.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
