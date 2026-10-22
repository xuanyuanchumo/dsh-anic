/**
 * 宿主事件接线（cycle-71 同域拆分，先例 T-4801 的 invocationFeedPreview.ts）。
 *
 * 从 `invocationFeed.ts` 拆出：归属字段（方案 A′）把该文件推向 250 行纪律。
 * 拆出的是**接线域**（订阅双通道 + 诊断注入），主体数据域留在原文件；
 * `invocationFeed.ts` 再导出本模块的 attachInvocationFeed/AttachOptions，
 * 消费者（src/index.ts、单测）import 路径零变更。
 *
 * 通道契约（原文件头转录）：开始 = `session/event` 的 `tool/call`
 * （`{turn, step, callId, name, arguments(原始串)}`，载荷在 `event.data`）；
 * 结束 = `tools/result` 的 `(exec, result)`，按 `exec.callId` 配对。
 * ctx.on 注册的监听器随插件卸载自动移除（官方 events.md「事件监听器也是效果」），
 * 因此无需手动退订。宿主没有 on（stub/旧代）时静默跳过——feed 仍可由测试直接喂。
 */
import { createScoped } from '../logger.ts';
import { extractResultPreview } from './invocationFeedPreview.ts';
import { isAnicInvocation, type FeedDiagnostics, type InvocationFeed } from './invocationFeed.ts';
import { attributionFor, type AttributionResolver } from './invocationAttribution.ts';

const log = createScoped('anic:invocation-feed');

/** 最小宿主事件类型（宿主 ctx 为 unknown 的房屋风格：本地窄化，不引宿主包）。 */
interface EventCapableCtx {
  on?: (name: string, handler: (...args: never[]) => void) => unknown;
}

/** attach 选项（cycle-71）。 */
export interface AttachOptions {
  /**
   * 归属解析器（方案 A′，见 invocationAttribution.ts）：入参 = `session/event`
   * 事件第一参 session。缺省 → 归属字段不落（真实宿主经 src/index.ts 注入
   * createInvocationAttributor(ctx)）。
   */
  resolveAttribution?: AttributionResolver;
}

/**
 * 订阅宿主双事件通道，把本插件的调用写进 feed。
 *
 * cycle-71：归属在**事件到达时**解析（第一参 session 提供工作区，见
 * invocationAttribution.ts 的方案论证）。解析器未注入 / 抛错 / 拿不到工作区
 * → attributionFor 返回 null → 字段不落；既有语义面（过滤 / drop-oldest /
 * 配对 / orphan 阈值）零改动。
 */
export function attachInvocationFeed(ctx: unknown, feed: InvocationFeed, opts: AttachOptions = {}): InvocationFeed {
  const c = ctx as EventCapableCtx;
  if (typeof c.on !== 'function') { log.info('宿主无事件通道，实时调用流未挂载（feed 保留可查询）'); return feed; }

  // 诊断计数：两个通道各自"看到任何事件"的证据。feed 空时由路由一并返回，
  // 用于区分「事件没到」（计数 0）与「到了但被过滤」（计数 > 0）。
  const diag: FeedDiagnostics = { sessionEvents: 0, sessionToolCalls: 0, toolsResults: 0, anicCalls: 0, anicResults: 0 };
  feed.diagnostics = () => ({ ...diag });

  // 开始相位：持久化会话事件 tool/call（模型请求瞬间）。
  // 事件信封（dsh-session Session.append，lib/index.js:1453-1459）：
  //   { type, seq, time, data: { turn, step, callId, name, arguments } }
  // —— 载荷在 event.data 里，不在顶层（P0-FEED-ENVELOPE：曾直接读 event.callId
  //   恒 undefined，事件到达但全被过滤，诊断计数 sessionToolCalls>0 / anicCalls=0）。
  // callId 用 falsy 检查：空串 callId 永远配不上真实 tools/result，进了流只会
  // 制造"永远执行中"的假条目。
  c.on('session/event', ((session: unknown, event: { type?: string; data?: { callId?: string; name?: string; arguments?: string; turn?: number; step?: number } }) => {
    diag.sessionEvents++;
    if (!event || event.type !== 'tool/call') return;
    diag.sessionToolCalls++;
    const payload = event.data ?? {};
    if (!payload.callId || typeof payload.name !== 'string') return;
    const raw = typeof payload.arguments === 'string' ? payload.arguments : '';
    if (!isAnicInvocation(payload.name, raw)) return;
    diag.anicCalls++;
    const attribution = attributionFor(session, opts.resolveAttribution);
    feed.recordCall({ callId: payload.callId, name: payload.name, arguments: raw, turn: payload.turn, step: payload.step, attribution });
  }) as (...args: never[]) => void);

  // 结束相位：工具运行时冻结结果（exec.callId 配对）。
  // T-4801：tools/result 载荷是 materializeFinalResult 产物（宿主 asar 考古）：
  //   { content: ContentBlock[], meta?, isError, error?, concludesTurn?, value }
  // —— extractResultPreview 从 content text 块提取预览（纯函数，只读——
  //    宿主已 deepFreeze(result)，任何写访问都会抛）。error 三元组原样透传。
  c.on('tools/result', ((exec: { callId?: string; name?: string }, result: unknown) => {
    diag.toolsResults++;
    if (!exec || !exec.callId) return;
    // tools/result 覆盖全部工具执行（含嵌套分发）；recordResult 按 callId 命中，
    // 未命中（非本插件调用）自然跳过——不需要在结束相位重复过滤 name。
    const r = (result ?? {}) as { isError?: boolean; error?: { name: string; code: string; reason?: string } };
    const settled = feed.recordResult(exec.callId, {
      isError: r.isError === true,
      error: r.isError === true && r.error ? r.error : undefined,
      resultPreview: extractResultPreview(result),
    });
    if (settled) diag.anicResults++;
  }) as (...args: never[]) => void);

  return feed;
}
