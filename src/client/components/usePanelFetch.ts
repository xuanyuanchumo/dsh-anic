/**
 * 面板数据拉取统一钩子（B4 组件整合）。
 *
 * 合并两套轮询实现（ui-domain-plan §2.4）：
 *   - useInvocations（2s，自带 data/pollError 状态，失败保留旧数据）；
 *   - usePolledSection（4s，注入式 targets，guard 不过 → 静默不渲染）。
 * 以及面板 fetchLive 的三个一次性任务（挂载 + 手动刷新，带行级降级文案）。
 *
 * 统一语义（三者此前各写一份）：
 *   - **暂停**：pollMs <= 0 → 只首拍（autoRefresh 关闭形态），manualKey 变化重拍；
 *   - **防抖**：上一轮未完成不发起下一轮（原 fetchLive 的 inFlight 守卫）；
 *   - **降级**：非 2xx / 形状不符 / 网络失败 → FetchFailure 三分类，由 target
 *     的 onFail 决定行级反馈（有 onFail = 可见降级；无 = 静默不渲染，org/flows 式）；
 *   - **成功恢复**：onRecover 清错误通道；
 *   - **原始响应**：onResponse 暴露 Response（快照任务学习 X-ANIC-Workspace 头）。
 *
 * cycle-38（V-1 + TanStack Query 轮询纪律吸收，context7 /tanstack/query 检索结论）：
 *   - **ETag 条件请求**：每个 target 学得响应 ETag，下轮带 If-None-Match；
 *     304 = 「数据语义未变」—— 不重放 apply（等价 replaceEqualDeep 的结构性
 *     共享收益：引用不变 → 消费方 setState 不触发重渲染）、不算失败、不降级。
 *     「轮询继续」与「数据未变」是两件事：304 正是轮询的健康形态。
 *   - **隐藏暂停**（refetchIntervalInBackground=false 缺省语义）：document 隐藏时
 *     定时器跳过本轮拉取，可见时立即补一拍（等价 focusManager.isFocused() 门）。
 *     用户不看面板时省掉全部轮询流量；4s 档 8 端点 × N 标签页的常态成本显著下降。
 *     jsdom/无 fetch 沙盒无此 API → 特性静默缺省（不改变既有行为）。
 *
 * 无 fetch（smoke 沙盒）→ 一次都不拉（与原 useInvocations/fetchLive 同纪律）。
 * getHeaders 是取头函数（非对象）：ref 持最新，避免 effect 因引用不等重跑。
 */
import { useEffect, useRef } from 'react';

/** 拉取失败三分类（调用方据此构造行级文案；与原三处降级文案一一对应）。 */
export type FetchFailure =
  | { kind: 'http'; status: number }
  | { kind: 'malformed' }
  | { kind: 'network'; message: string };

export interface PanelFetchTarget {
  url: string;
  /** 形状守卫：false → 畸形（不 apply，onFail 收 malformed）。 */
  guard: (value: unknown) => boolean;
  /** 守卫通过时应用数据。 */
  apply: (value: unknown) => void;
  /** 失败行级反馈（非 2xx/畸形/网络）；省略 = 静默降级（分区不渲染）。 */
  onFail?: (failure: FetchFailure) => void;
  /** 成功后恢复（清错误通道，如 pollError 置 null）。 */
  onRecover?: () => void;
  /** 原始响应钩子（学习响应头等；拿到的不是 JSON）。 */
  onResponse?: (res: unknown) => void;
}

/** document 可见性门（无 document 的沙盒恒 true——不改变无 API 环境行为）。 */
function pageVisible(): boolean {
  try {
    const d = (globalThis as { document?: { visibilityState?: string } }).document;
    if (d && typeof d.visibilityState === 'string') return d.visibilityState === 'visible';
  } catch { /* ignore */ }
  return true;
}

/** 从 Response 摘 ETag（去引号；缺失/非字符串返回 null）。 */
function etagOf(res: unknown): string | null {
  try {
    const r = res as { headers?: { get?: (name: string) => string | null } };
    const raw = typeof r.headers?.get === 'function' ? r.headers.get('etag') : null;
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    return raw.trim().replace(/^"|"$/g, '');
  } catch {
    return null;
  }
}

export function usePanelFetch(
  targets: PanelFetchTarget[],
  pollMs: number,
  manualKey: number,
  getHeaders: () => Record<string, string>,
): void {
  // targets 每次渲染都是新数组（含内联闭包）——ref 持最新引用，
  // effect 依赖保持 [pollMs, manualKey]（setState 函数引用稳定，闭包安全）。
  const ref = useRef(targets);
  ref.current = targets;
  const headersRef = useRef(getHeaders);
  headersRef.current = getHeaders;
  const inFlightRef = useRef(false);
  // V-1：per-target ETag 学习（url → etag）。不进 React state——它是请求层
  // 内部状态，渲染不消费；ref 持有跨轮次存活。
  const etagsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (typeof fetch !== 'function') return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      if (inFlightRef.current) return;
      // 隐藏暂停：不可见时跳过本轮（定时器照排——可见时自然恢复；不打断节奏）。
      if (!pageVisible()) {
        if (!cancelled && pollMs > 0) timer = setTimeout(() => { void tick(); }, pollMs);
        return;
      }
      inFlightRef.current = true;
      try {
        await Promise.all(ref.current.map(async (tgt) => {
          try {
            // V-1：学得的 ETag 随请求回带（If-None-Match 标准条件请求）。
            const headers = { ...headersRef.current() };
            const known = etagsRef.current.get(tgt.url);
            if (known) headers['If-None-Match'] = `"${known}"`;
            const res = await fetch(tgt.url, { headers });
            if (tgt.onResponse !== undefined) tgt.onResponse(res);
            const resOk = res.ok;
            // 304：语义等价「数据未变」——不重放 apply（结构共享语义）、不算失败。
            // res.status === 304 在 fetch 层 res.ok 为 false（2xx 才 true），先判 304。
            if (res.status === 304) { tgt.onRecover?.(); return; }
            if (!resOk) { tgt.onFail?.({ kind: 'http', status: res.status }); return; }
            const etag = etagOf(res);
            if (etag) etagsRef.current.set(tgt.url, etag);
            const json: unknown = await res.json();
            if (!tgt.guard(json)) { tgt.onFail?.({ kind: 'malformed' }); return; }
            if (!cancelled) { tgt.apply(json); tgt.onRecover?.(); }
          } catch (e) {
            tgt.onFail?.({ kind: 'network', message: e instanceof Error ? e.message : String(e) });
          }
        }));
      } finally {
        inFlightRef.current = false;
      }
      // pollMs<=0：不排下一轮（autoRefresh 关闭形态）；数据行的 generatedAt
      // 让「最后已知数据」的陈旧性可观测（INV-30 关闭形态可观测的落点之一）。
      if (!cancelled && pollMs > 0) timer = setTimeout(() => { void tick(); }, pollMs);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs, manualKey]);
}
