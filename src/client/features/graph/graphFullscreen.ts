/**
 * 全屏（cycle-90 · P2-6）——图区独占整屏，以及**如实降级**。
 *
 * ## 为什么降级必须"如实"
 *
 * `requestFullscreen` 在三种情况下会失败或不存在：
 *   ① 浏览器不支持该 API（老浏览器 / 部分内嵌 WebView）；
 *   ② 用户拒绝了（按 Esc 退出全屏后浏览器会记住这次会话的拒绝）；
 *   ③ 页面不在用户手势栈里（异步调用会被拒）。
 *
 * 常见的错法是 `catch(() => {})` —— 静默失败。用户点了"全屏"，屏幕没变，
 * **没有任何反馈**。本仓的纪律是「如实降级」：失败必须**说清楚发生了什么**，
 * 而不是假装成功或默默消失。
 *
 * ## 状态机
 *
 * `fullscreenStateOf(el)` 读浏览器的真实状态（`document.fullscreenElement`），
 * 不自己维护一份"我认为是否全屏"的影子状态 —— 影子状态会与真实状态漂移
 * （用户按 Esc 退出时浏览器会自己退出，但我们不知道）。
 *
 * ## 只做 DOM，不引依赖
 *
 * 全屏 API 是浏览器原生能力，无需任何库。
 */
import { gt } from './graphText.ts';

/** 全屏相关的最小 DOM 形状（便于纯函数单测，jsdom 里没有真全屏）。 */
export interface FullscreenElementLike {
  requestFullscreen?: () => Promise<void> | void;
  webkitRequestFullscreen?: () => Promise<void> | void;
}

/** 全屏相关的最小 document 形状。 */
export interface FullscreenDocumentLike {
  fullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void> | void;
  webkitExitFullscreen?: () => Promise<void> | void;
}

/** 全屏能力探测（缺失任何一环 ⇒ 不可用）。 */
export interface FullscreenCapability {
  /** 能否进入全屏（进入需要 request，退出需要 exit —— 只有 request 也算不可用）。 */
  canEnter: boolean;
  /** 能否退出全屏。 */
  canExit: boolean;
}

/** 探测当前环境的全屏能力。 */
export function fullscreenCapabilityOf(doc: FullscreenDocumentLike | undefined): FullscreenCapability {
  const el = globalThis.document as unknown as FullscreenDocumentLike | undefined;
  const target = doc ?? el;
  const proto = target === undefined
    ? undefined
    : (globalThis.Element as unknown as { prototype?: FullscreenElementLike } | undefined)?.prototype;
  const hasRequest = proto?.requestFullscreen !== undefined || proto?.webkitRequestFullscreen !== undefined;
  const hasExit = target?.exitFullscreen !== undefined || target?.webkitExitFullscreen !== undefined;
  return { canEnter: hasRequest, canExit: hasExit };
}

/** 元素当前是否处于全屏（读浏览器真状态，不维护影子状态）。 */
export function isFullscreenOf(el: Element | null | undefined): boolean {
  const doc = globalThis.document as unknown as FullscreenDocumentLike | undefined;
  if (doc?.fullscreenElement === undefined || doc.fullscreenElement === null) return false;
  return el === undefined || el === null ? true : doc.fullscreenElement === el;
}

/** 降级原因（供 UI 如实提示）。 */
export type FullscreenFailure =
  | 'unsupported'   // API 不存在
  | 'rejected'     // 浏览器拒绝（用户取消 / 非用户手势）
  | 'error';       // 其它异常

/** 全屏操作的结果（成功也返回结果 —— 调用方需要区分"进了"与"没进"）。 */
export interface FullscreenOutcome {
  ok: boolean;
  /** 失败原因（ok=true 时为 null）。 */
  reason: FullscreenFailure | null;
  /** 给用户看的话（已本地化）。 */
  message: string | null;
}

/**
 * 进入全屏。
 *
 * 失败**不抛**（抛了调用方还得包一层 try/catch，而"失败"在这里是**正常路径**
 * ——浏览器拒绝全屏是常态，不是异常）。
 */
export async function enterFullscreen(el: FullscreenElementLike | null | undefined): Promise<FullscreenOutcome> {
  if (el === null || el === undefined) return fail('unsupported');
  const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (req === undefined) return fail('unsupported');
  try {
    await req.call(el);
    return { ok: true, reason: null, message: null };
  } catch {
    // 用户按 Esc 拒绝、页面不在手势栈里 —— 都归到 "rejected"（用户能理解的话）。
    return fail('rejected');
  }
}

/** 退出全屏。 */
export async function exitFullscreen(doc?: FullscreenDocumentLike): Promise<FullscreenOutcome> {
  const target = doc ?? (globalThis.document as unknown as FullscreenDocumentLike | undefined);
  const exit = target?.exitFullscreen ?? target?.webkitExitFullscreen;
  if (exit === undefined || target === undefined) return fail('unsupported');
  try {
    await exit.call(target);
    return { ok: true, reason: null, message: null };
  } catch {
    return fail('rejected');
  }
}

/** 失败结果的统一形态（消息已本地化，调用方直接显示即可）。 */
function fail(reason: FullscreenFailure): FullscreenOutcome {
  return { ok: false, reason, message: gt('fullscreenUnavailable') };
}
