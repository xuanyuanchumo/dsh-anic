/**
 * `skills/change` 的**到达计数**（cycle-109）—— 与 `toolsChangeCounter.ts`
 * 同构的零依赖叶子。
 *
 * ## 为什么需要它（修观测不对称）
 *
 * 工具面早就有 `tools/change` 计数 + 读数出口（`toolsChangeCounter.ts` →
 * `disclosureReadout.ts` → `GET /anic/api/disclosure`）；
 * 技能面**零订阅**（cycle-107 研究输入 L §4.3 D3：`skills/change` 全仓命中 0）。
 * 于是「工作区新增了一个同名技能把本插件 runtime 技能静默压制」这类事实
 * 在运行时**没有任何信号** —— 两个能力面一个可观测、一个不可观测。
 *
 * ## 为什么是**计数**而不是缓存列表
 *
 * 官方契约（KB `subsystems/skills.md:340-352`）：`skills/change` **不带 diff**，
 * 消费方自行重取 `snapshot()`。存列表就等于在插件里复制一份宿主目录的**第二真相源**
 * —— 它会漂移。计数只回答「变过几次」，把「变成了什么」留给按需 `snapshot()`。
 *
 * ## 边界
 *
 * 进程级单例；只累加，不复位（`resetSkillsChangeCount` 仅测试用）。
 */

let changes = 0;

/** 记一次 `skills/change` 到达。 */
export function noteSkillsChange(): void {
  changes++;
}

/** 当前累计到达次数。 */
export function skillsChangeCount(): number {
  return changes;
}

/** 单测复位（生产路径不调用）。 */
export function resetSkillsChangeCount(): void {
  changes = 0;
}