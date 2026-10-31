/**
 * 披露运行时读数的**客户端契约**（cycle-93）—— `GET /anic/api/disclosure` 的响应形状。
 *
 * ## 为什么客户端独立声明形状
 *
 * 面板跑在宿主 webview 里，宿主升级（响应字段增删）与客户端构建产物是
 * **两条独立发版链**。若客户端 import 宿主类型，一次字段改名就会让旧客户端
 * 整块崩掉（打包时类型擦除，编译期看不出来）。
 *
 * ⇒ 这里**手工声明可能缺字段**的形状，守卫只做最小准入。
 *
 * ## 这个读数解决什么问题
 *
 * cycle-92 修掉了披露自锁，但留下两个**无法查证**的项（O-92-02 / O-92-04）：
 * 「按需解锁是否真的生效」「`tools/change` 是否真的发出」。
 *
 * 根因不是"没做真机验证"，而是**状态没有出口**。
 * 本契约让面板能显示：几个 agent 被遮蔽、谁解锁了什么、事件发了几次。
 */

/** 单个 agent 的披露读数。 */
export interface AgentDisclosureJson {
  allToolCount?: number;
  loaderCount?: number;
  /** 当前被遮蔽的工具数（解锁后应减少）。 */
  denyCount?: number;
  /** 已解锁的工具 id（按解锁顺序）。 */
  unlocked?: string[];
  /** 当前是否还有生效的 restriction。 */
  restricted?: boolean;
}

/** `GET /anic/api/disclosure` 的响应。 */
export interface DisclosureReadoutJson {
  trackedAgents?: number;
  agents?: AgentDisclosureJson[];
  toolsChangeEmits?: number;
  fullyMaskedAgents?: number;
  generatedAt?: string;
  summary?: string;
}

/** 披露读数端点。 */
export const DISCLOSURE_URL = '/anic/api/disclosure';

/** 对象形守卫（独立实现，避免跨域 import 环）。 */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 形状守卫：只要求「trackedAgents 是数字」。
 *
 * 刻意**不**校验全部字段 —— 任何新增/缺失字段都不该让整块面板走失败行
 * （与 `flowMatrixTypes.isFlowMatrix` 同款最宽守卫）。
 */
export function isDisclosureReadout(v: unknown): v is DisclosureReadoutJson {
  if (!isObj(v)) return false;
  return typeof v['trackedAgents'] === 'number';
}

/**
 * ## cycle-95 删除三条「壳导出」（为什么删，而不是留着等接线）
 *
 * 这里原先还有 `unlockedTotal()` 汇总、`UnlockChannelState` 类型 +
 * `unlockChannelState()` 三态判定、`disclosureLine()` 一行摘要。全仓
 * （**去注释后**）零消费 —— 判据不是"我以为没人用"，是
 * `node scripts/audit-wiring.mjs` 的全仓零文本命中（前两条的唯二调用者就是
 * 后两条被删的函数，所以它们一并失去消费面，留着就是三条新的死导出）。
 *
 * 根因是**口径分叉**，不是"还没接线"：宿主侧已有权威摘要
 * `runtime/disclosureReadout.ts` 的 `summarizeDisclosure()`（`disclosureRoute`
 * 与 `selfCheckRoute` 都在用），而客户端面板**根本没有披露分区**
 * （`panelState.disclosure` 只被 `setDisclosure` 写入、无渲染消费点）。
 * 留着这几条，下一个人会以为客户端也在读披露 —— 那是两套摘要格式的雏形。
 * 本仓教训：没人用的兼容层是最贵的兼容层。
 *
 * 要恢复 UI 消费时应当**重新接线并同时决定唯一摘要口径**，而不是复活一份与
 * 宿主分叉的字符串格式。本文件此刻只负责「形状 + 最宽准入守卫 + 端点常量」
 * 三件真有人用的事（`isDisclosureReadout` / `DISCLOSURE_URL` / 两个 interface）。
 */
