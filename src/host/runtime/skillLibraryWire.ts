/**
 * 内部技能库的**线上形状**（cycle-109 · 沙箱真机抓到的契约缺陷修复）。
 *
 * ## 为什么单独成文件（T3 ≤250，但边界是职责）
 *
 * `skillLibrary.ts` 的职责是「读盘 + 对账」（有 fs 副作用面）；
 * 本文件是「服务端读数 → 客户端契约」的**纯投影**（零 IO、零状态）。
 * 混在一起会让读侧模块被 wire 的演进拖着长（首版正是这样涨到 270 行）。
 *
 * ## 修复的缺陷（沙箱实测）
 *
 * 首版路由把 `SkillLibraryReadout` 整个发出去：`skills` / `issues` 是**数组**，
 * 而客户端 `SkillLibraryJson` 期望**数字** + `summary` 字符串 ⇒ 面板三个数全渲染成
 * `undefined`（实测 `library.ok=True version=0.4.0 skills=(空) issues=(空)`）。
 *
 * 根因是「同一事实两处定义」：host 类型与 client 类型各自声明、无人对账。
 * ⇒ 收敛为**唯一线上契约**：host 显式投影，client 类型逐字段对齐，并由
 * `tests/contract/skillLibraryRegistryContract.test.ts` 的 wire 段把
 * 「真 readout → wire → 渲染」串起来断言（手造夹具只能证明渲染器会渲染）。
 */
import { summarizeSkillLibrary, type SkillLibraryReadout } from './skillLibrary.ts';

/** 线上形状（与 `src/client/features/skillhealth/renderSkillHealth.ts` 的 `SkillLibraryJson` 逐字段对齐）。 */
export interface SkillLibraryWire {
  ok: boolean;
  version: string;
  updatedAt: string;
  /** 技能条目**数**（不是数组）。 */
  skills: number;
  /** 对账问题**数**（不是数组）。 */
  issues: number;
  /** 一行人类可读摘要（面板 title 与无障碍文本用）。 */
  summary: string;
}

/** 服务端读数 → 线上形状（单一投影点，杜绝两处各拼一份）。 */
export function toSkillLibraryWire(r: SkillLibraryReadout): SkillLibraryWire {
  return {
    ok: r.ok,
    version: r.version,
    updatedAt: r.updatedAt,
    skills: r.skills.length,
    issues: r.issues.length,
    summary: summarizeSkillLibrary(r),
  };
}