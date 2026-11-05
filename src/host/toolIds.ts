/**
 * ANIC DSH 工具 id 的正典清单（cycle-38 · M2-a 落地）。
 *
 * cycle-107 起本文件**再导出** `src/shared/anicToolIds.ts` 的共享清单——client 半部
 * 要在 `tool.call.toolview` 席位注册 anic_* 工具的终端卡片，需要工具名清单，而 client
 * 的 tsconfig 已 include `src/shared` 目录下全部 TS 文件。再导出保持契约测试
 * （`tests/contract/toolIdsContract.test.ts`）的 import 路径零变更。
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

export {
  ANIC_TOOL_IDS,
  ANIC_TOOL_PREFIX,
  isAnicToolName,
} from '../shared/anicToolIds.ts';

import { ANIC_TOOL_IDS } from '../shared/anicToolIds.ts';

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

