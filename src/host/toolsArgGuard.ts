/**
 * 工具参数未知键守卫（cycle-89 T-04）—— 从 `toolsSlot.ts` 拆出，守 T3 ≤250 行。
 *
 * ## 拆出的理由（职责，不是行数）
 *
 * `toolsSlot.ts` 是「工具形状契约 + 出口防线」，讲的是**宿主契约**：
 * 字段名怎么写、宿主校验什么、canonical value 怎么收敛。
 * 而本模块讲的是**参数面的语义裁决**：模型多传了一个键，是拒还是放。
 * 两者抽象层不同 —— 混在一个文件里，改守卫时要去读契约注释，改契约时会被
 * 守卫的实现细节干扰。
 *
 * ## 缺陷形态（真机语义，实测自 dsh-ops 同款路径）
 *
 * 宿主 `ctx.tools.register(definition)` 对 plain-object 定义**只校验 `output.schema`**，
 * **不校验 `parameters`**；模型的 arguments 原样进 `execute`。于是模型多传一个
 * 键时，各网关按 `args?.foo` 取已知字段，**未知键被静默丢弃** —— 调用报告成功，
 * 却忽略了调用方真正要求的东西。
 *
 * dsh-ops 的原文判据：走 plain object 定义时「必须自写未知键白名单」，
 * 否则「the call reports success while ignoring what the caller asked for」。
 *
 * ## 为什么这在本仓是真风险而非理论
 *
 * `anic_autonomy_upgrade` 的参数含 `humanAuthorized` / `reason`。模型若把
 * `reason` 拼成 `Reason`（大小写错），旧实现会**当作没传**而继续执行升级 ——
 * 一个本该被记录的授权理由消失了，而调用返回「成功」。
 *
 * 另一个例子：`anic_skill` 的 `workspace` 拼错成 `workspaces` 时，旧实现会在
 * **宿主当前工作区**上执行 —— 用户的本意是「在另一个项目跑」，实际跑在了
 * 错误的项目上，且没有任何报错。
 *
 * ## 为什么抛错而不是返回 `{error}`
 *
 * 与 `sanitizeToolValue` 同理：返回 `{error}` 会让模型以为工具跑通了，
 * 只是在返回值里带了一句错误。宿主对 throw 的语义就是 isError=true ——
 * 让错误可见，与本仓「守卫必须响亮」一致。
 *
 * ## 边界（三条，都要写在代码里而不是只在心里）
 *
 * - `known` 为 null（schema 无 `properties`）→ **不校验**；
 *   空集合会拒掉一切调用，比不校验更糟。
 * - 参数不是普通对象 → 不校验（宿主已保证 object-rooted，这里不重复拦）。
 * - 空参数对象 → 平凡通过。
 */
import type { ToolRegistration } from './toolsSlot.ts';

/**
 * 从工具的 `parameters` schema 反射出**合法的参数键集合**。
 *
 * 为什么反射而不是硬编码清单：硬编码清单会随 schema 演进而腐化（改了字段
 * 忘了改清单 → 合法调用被拒），而反射天然与 schema 同源。
 *
 * @returns 合法键集合；**null** 表示「不知道合法键」（schema 非 object-rooted
 *   或没有 `properties`）→ 调用方**不做**未知键校验。
 */
export function knownArgumentKeys(parameters: Record<string, unknown>): ReadonlySet<string> | null {
  const props = parameters['properties'];
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return null;
  const keys = Object.keys(props as Record<string, unknown>);
  return keys.length === 0 ? null : new Set(keys);
}

/**
 * 未知参数键守卫：模型多传了 schema 里没有的键 → **响亮拒绝**。
 *
 * @param toolName 工具名（进错误消息，让模型知道是哪个工具的契约不对）
 * @param args 模型传来的参数
 * @param known 合法键集合；null = 不校验（见文件头「边界」）
 */
export function assertKnownArguments(
  toolName: string,
  args: Record<string, unknown>,
  known: ReadonlySet<string> | null,
): void {
  if (known === null) return;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return;
  const unknown = Object.keys(args).filter((k) => !known.has(k));
  if (unknown.length === 0) return;
  const names = unknown.map((k) => JSON.stringify(k)).join(', ');
  throw new Error(
    `tool "${toolName}" received unknown argument ${unknown.length === 1 ? 'key' : 'keys'} ${names}; `
    + `this tool accepts ${[...known].join(', ')}`,
  );
}

/**
 * 把未知键守卫接到一个工具注册上（**必须**接在 `wireGuard` 这个唯一出口，
 * 而不是逐个 gateway 打补丁 —— 出口防线才有保修期）。
 *
 * @param tool 工具注册定义
 * @param inner 已包好出口防线的 execute
 */
export function withArgumentGuard(
  tool: ToolRegistration,
  inner: ToolRegistration['execute'],
): ToolRegistration['execute'] {
  const known = knownArgumentKeys(tool.parameters);
  return async (args, exec) => {
    assertKnownArguments(tool.name, args, known);
    return inner(args, exec);
  };
}
