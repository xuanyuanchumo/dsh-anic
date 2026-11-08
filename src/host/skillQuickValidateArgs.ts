/**
 * quick-validate 参数规范化（cycle-112）—— 独立模块（skillInvoker 触 T3 上限）。
 *
 * 被守卫缺陷（真机取证 2026-11-02，flow-tracker quick-validate 记录）：
 *   `anic_skill('quick-validate')` 无参 → 脚本收到 `[项目根]` 作 skill-dir →
 *   "Directory: ...\dsh-anic Total files: 10226 … VALIDATION FAILED: 65 error(s)"
 *   ⇒ 必 FAIL，被健康模型记成**脚本失败**（7/14 → degraded）。根因是**调用形态**
 *   不是脚本缺陷。修复：网关侧规范化参数（本模块），无参/旗标形态自动补技能根。
 *
 * 语义（与 resolveQuickValidateSkillDir 共用解析器，不另写一份）：
 *   - 无参 / 首参是旗标（`-` 开头）→ 补省缺技能根，旗标原样保留在后；
 *   - 首参是技能相对形态（"assets/skill"、"assets/skill/scripts"、"./…"）→ 解析为
 *     已装副本的绝对路径（原 cycle-39 行为不变）；
 *   - 首参是绝对路径 / 其他未知形态 → 原样返回（不猜，交给脚本自身守卫报错）。
 */
import { resolveQuickValidateSkillDir } from './skillInvoker.ts';

export function normalizeQuickValidateArgs(workspaceDir: string, args: readonly string[]): string[] {
  const first = args[0];
  const skillArg = first === undefined || first.startsWith('-') ? 'assets/skill' : first;
  const resolved = resolveQuickValidateSkillDir(workspaceDir, skillArg);
  if (resolved === null) return [...args];
  return first === undefined || first.startsWith('-')
    ? [resolved, ...args]
    : [resolved, ...args.slice(1)];
}
