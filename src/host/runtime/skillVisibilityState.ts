/**
 * 技能**可见性**的运行时读数（cycle-109 · 修 D2「注册了但没激活」的技能面同款缺陷）。
 *
 * ## 为什么需要一个独立的状态叶子
 *
 * `verifyRuntimeSkillVisibility` 是**异步**的（宿主 `snapshot()` 返回 Promise），
 * 而 HTTP 路由 / 面板是**同步**读的。没有这层，回读结论只能进日志 ——
 * 而本仓已确立「不触发的日志不是证据」（`disclosureReadout.ts` cycle-95 删注）。
 *
 * ## 为什么是「最后一次结论」而不是历史
 *
 * 技能目录是**状态**不是**流**：读者问的是「现在模型能不能看见本技能」。
 * 存历史会变成第二真相源（还要处理时间窗/水位线），而宿主目录本身一直在变。
 * ⇒ 只留最后一次回读（含时刻），历史由 `skillsChangeCount` 的计数回答「变过几次」。
 *
 * ## 边界
 *
 * 进程级单例；`record` 只在 `index.ts` 的 verify 链路调用；路由只读。
 */
import type { SkillVisibilityResult } from '../skillRegistration.ts';
import { skillsChangeCount } from './skillsChangeCounter.ts';

/** 一次回读的记录。 */
export interface SkillVisibilityRecord {
  /** 被判定的技能名。 */
  name: string;
  /** 三态结论（`unknown` = 采不到/不完整，**绝不**等于缺失）。 */
  state: SkillVisibilityResult['state'];
  /** 为什么是这个态。 */
  reason: string;
  /** 命中时的来源层（runtime / project）——回答「谁赢了同名」。 */
  source?: string;
  /** 提供方。 */
  provider?: string;
  /** 回读时刻（ISO）。 */
  at: string;
}

let last: SkillVisibilityRecord | null = null;

/** 记录一次回读结论（由 `index.ts` 的 verify 链路调用）。 */
export function recordSkillVisibility(r: SkillVisibilityResult, atIso?: string): void {
  last = {
    name: r.name,
    state: r.state,
    reason: r.reason,
    ...(r.source === undefined ? {} : { source: r.source }),
    ...(r.provider === undefined ? {} : { provider: r.provider }),
    at: atIso ?? new Date().toISOString(),
  };
}

/** 读最后一次结论（null = 尚未回读 / 宿主无 snapshot 服务）。 */
export function readSkillVisibility(): SkillVisibilityRecord | null {
  return last === null ? null : { ...last };
}

/** 读数出口的完整形状（`GET /anic/skill/health` 的 `runtimeSkill` 段）。 */
export interface SkillVisibilityReadout {
  /** 最后一次回读；null = 还没跑过。 */
  last: SkillVisibilityRecord | null;
  /** `skills/change` 累计到达次数（0 = 宿主未发过 / 未接线）。 */
  skillsChangeEmits: number;
}

/** 组装读数（路由 / 面板共用同一构造点，避免两处各拼一份）。 */
export function buildSkillVisibilityReadout(): SkillVisibilityReadout {
  return { last: readSkillVisibility(), skillsChangeEmits: skillsChangeCount() };
}

/**
 * **线上形状**（cycle-109 · 沙箱真机抓到的契约缺陷修复）。
 *
 * 首版路由直接发 `SkillVisibilityReadout`（`{last:{…}, skillsChangeEmits}`），
 * 而客户端 `RuntimeSkillJson` 是**扁平**的 `{name, state, reason, skillsChangeEmits}`
 * ⇒ 面板读到的 `name/state` 全是 `undefined`（沙箱实测：`runtimeSkill.last.state` 才是真值）。
 *
 * ⇒ 收敛为唯一线上契约：扁平 + 保留 `source/provider/at` 三个诊断字段（可选）。
 * 客户端类型必须逐字段对齐，由 `skillLibraryRegistryContract` 的 wire 段断言。
 */
export interface SkillVisibilityWire {
  name: string | null;
  state: 'active' | 'absent' | 'unknown';
  reason: string;
  skillsChangeEmits: number;
  source?: string;
  provider?: string;
  /** 回读时刻（ISO）；未回读时缺省。 */
  at?: string;
}

/** 服务端读数 → 线上形状（未回读时给诚实形态：`unknown` + 说明，**不伪造** active）。 */
export function toSkillVisibilityWire(r: SkillVisibilityReadout): SkillVisibilityWire {
  const last = r.last;
  if (last === null) {
    return {
      name: null,
      state: 'unknown',
      reason: 'visibility not read back yet',
      skillsChangeEmits: r.skillsChangeEmits,
    };
  }
  return {
    name: last.name,
    state: last.state,
    reason: last.reason,
    skillsChangeEmits: r.skillsChangeEmits,
    ...(last.source === undefined ? {} : { source: last.source }),
    ...(last.provider === undefined ? {} : { provider: last.provider }),
    at: last.at,
  };
}

/** 单测复位（生产路径不调用）。 */
export function resetSkillVisibility(): void {
  last = null;
}