/**
 * **门禁证据语义**（cycle-89 · 从 flowJoin.ts 拆出，守 T3 ≤250 行）。
 *
 * ## 为什么需要这一层：字段存在 ≠ 有门禁证据
 *
 * 实测反例（Lead 核查，`.cycles/flow-tracker.json` 真实数据）：宿主侧的归属
 * 解析曾取**账本链头**（最后一条）的 gate 字段当「本次流程的门禁归属」。
 * 账本链头是**上一次**跑门禁留下的残留 —— 于是：
 *
 *   - 一次 `workflow-state check`（与门禁毫无关系的流程）被记成 `gate:'G3'`；
 *   - 更糟的是**来源标注与字段实际出处不一致**：该 gate 字段来自 ledger，
 *     而 `attribution.source` 写的是 `'workflow-state'` —— 两套真相同时失真。
 *
 * 后果不是「多了一个字段」，而是**门禁证据覆盖指标永久假绿**：任意流程都会
 * 被算成「有 G3 证据」，`gateEvidence[].evidence` 恒为 true。用户看到的量化条
 * 毫无意义 —— 正是用户点名的「空心注册 / 表面连通」。
 *
 * ## 为什么消费侧要独立设闸（不能信「上游已经做对」）
 *
 * 宿主侧已把 gate 改成「按脚本语义判定」（`gateOfScript`），但**消费面仍必须
 * 自己判**：记录可能来自旧版本宿主、手工编辑过的 tracker 文件、或任何写了
 * gate 字段的写入方。判据建立在善意假设上就会在某次数据迁移后静默失真。
 *
 * 判据：**只有脚本本身在执行门禁，才配门禁归属**。反例钉死 ——
 * 一条 `gate:'G3'` 但 script 是 `workflow-state` 的记录，**不得**被计入
 * G3 的门禁证据。
 *
 * ## 为什么是白名单而不是黑名单
 *
 * 门禁种类（G0-G3 / H1-H4）是**闭合集合**。新增一个门禁脚本时若用黑名单，
 * 它会默认「有门禁归属」而实际上可能是别的门；白名单则默认「无归属」——
 * 宁缺勿猜（INV-27 诚实标注纪律）。
 *
 * ## 边界
 *
 * 零 IO、零 clock、零 random、零依赖：纯谓词，可独立单测。
 * 与 `flowAttribution.gateOfScript` 的白名单**各自独立声明**（不反向 import
 * runtime 层）——两处白名单若共用一份实现，runtime 改动会静默改掉指标口径，
 * 而指标口径是**判据**，应当被独立钉住。
 */
import type { FlowRecord } from '../runtime/flowTracker.ts';

/**
 * 门禁脚本白名单：只有这些脚本本身在执行门禁，才算「有门禁证据」。
 *
 * - `gate-check`：G0-G3 收敛门（`--gate G0|G1|G2|G3|all`）。
 * - `hitl-audit`：H1-H4 人审门（`--gate H1|H2|H3|H4|all`）。
 */
export const GATE_SCRIPT_NAMES: ReadonlySet<string> = new Set(['gate-check', 'hitl-audit']);

/**
 * 该记录是否算「门禁证据」——**白名单判据**（不看 gate 字段是否存在）。
 *
 * 三条同时成立才算：
 *  1. script 是门禁脚本（白名单）；
 *  2. gate 字段是非空字符串（具体哪道门由它自己说，缺门就是没证据）；
 *  3. 字段必须是记录自己带的（不能由调用方事后补）。
 */
export function isGateEvidence(record: FlowRecord): boolean {
  if (typeof record.script !== 'string' || record.script === '') return false;
  if (!GATE_SCRIPT_NAMES.has(record.script)) return false;
  return typeof record.gate === 'string' && record.gate !== '';
}
