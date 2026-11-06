/**
 * 技能**可见性三态**判据（cycle-109 · 修 D2「注册了但没激活」的技能面同款缺陷）。
 *
 * 从 `skillRegistration.ts` 拆出（T3 ≤250 行；边界是「判据 / 副作用」）：
 * 本文件只有纯函数与类型，注册动作留在 `skillRegistration.ts`。
 * 这样三态判据可以离线穷举，不必真挂宿主 —— 与 `disclosureVerdict.ts` 同一条纪律。
 *
 * ## 为什么是三态而不是布尔
 *
 * `register()` 成功**不等于**模型可见：官方语义里 **project 层同名条目直接赢得**
 * runtime 条目（KB `subsystems/skills.md`「本地发现优先级」）。而观测**不完整**时
 * （`snapshot.complete === false`）**没有资格**下「缺失」结论。
 *
 * 把 `unknown` 谎报成 `absent` 会让「工作区安装态」被误判成缺失 ——
 * 这是本仓反复记过的「没有证据 ≠ 通过」的同一条纪律的反面。
 */

/** 技能可见性三态。 */
export type SkillVisibility = 'active' | 'absent' | 'unknown';

/** 技能快照的窄形状（只取判定要用的三个字段）。 */
export interface SkillSnapshotLike {
  skills: Array<{ name: string; source?: string; provider?: string }>;
  complete: boolean;
}

/** 分类结果（`reason` 必填——读者要知道**为什么**是这个态）。 */
export interface SkillVisibilityResult {
  /** 被判定的技能名（读数出口要用它回答「**哪个**技能是什么态」）。 */
  name: string;
  state: SkillVisibility;
  source?: string;
  provider?: string;
  reason: string;
}

/**
 * 把一次 `snapshot()` 回读分类成三态（**纯函数**，可离线穷举）。
 *
 * 判据（顺序不可换）：
 *   1. `snap === null`（宿主无 snapshot / 旧代 / 抛错）⇒ `unknown`；
 *   2. `snap.complete === false` ⇒ `unknown`（**绝不** absent：不完整观测不可下结论）；
 *   3. 命中同名 ⇒ `active`（附带 source/provider 供读者分辨是 runtime 还是 project）；
 *   4. 未命中且 complete ⇒ `absent`。
 */
export function classifySkillVisibility(
  snap: SkillSnapshotLike | null,
  name: string,
): SkillVisibilityResult {
  if (snap === null) return { name, state: 'unknown', reason: 'host has no skills.snapshot (old generation) — visibility unverified' };
  if (!snap.complete) return { name, state: 'unknown', reason: 'snapshot incomplete (complete:false) — official rule: incomplete observation cannot conclude' };
  const hit = snap.skills.find((s) => s.name === name);
  if (hit) {
    return {
      name,
      state: 'active',
      ...(hit.source === undefined ? {} : { source: hit.source }),
      ...(hit.provider === undefined ? {} : { provider: hit.provider }),
      reason: `visible in catalog (source=${hit.source ?? 'unknown'}, provider=${hit.provider ?? 'unknown'})`,
    };
  }
  return { name, state: 'absent', reason: 'complete catalog does not contain this name — likely shadowed by a project-layer skill of the same name' };
}