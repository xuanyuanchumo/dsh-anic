/**
 * 实时调用环回缓冲 —— 动态白盒调用流（m02733 核心需求：不能只可视化静态产物）。
 *
 * 数据来源是 DSH 官方事件双通道（契约见 dsh-plugin-dev-kb 镜像
 * kb/site/develop/framework/events.md 与 kb/site/reference/subsystems/session.md，
 * 已对安装版 asar 二进制验证 dsh-skill/SkillRegistry/registerProvider 在场）：
 *
 *   开始：Cordis 事件 `session/event`（emit）携带持久化会话事件
 *         `tool/call` = { turn, step, callId, name, arguments(原始串,未解析) }
 *         —— 这是**模型请求调用工具的瞬间**，in-flight 从这里开始。
 *   结束：Cordis 事件 `tools/result`（emit）携带
 *         (exec: ToolExecution, result: ToolExecutionResult)
 *         —— exec.callId 与 tool/call 的 callId 同源配对；result 按 isError 判别，
 *            失败态带 error: { name, code, reason? }；成功态的 content 文本块
 *            由 extractResultPreview 提取为 resultPreview（T-4801 白盒：成功
 *            调用返回了什么，面板一眼可见）。
 *
 * 为什么结束不用 session/event 的 tool/result：它的载荷是 message: ToolResultMessage，
 * callId 提取不在我们核验过的文档契约里；tools/result 的 exec.callId 是文档明写的。
 * 每个相位走一条已核验通道。
 *
 * 过滤范围（isAnicInvocation）：本插件的两类调用面——
 *   1. anic_* 工具（12 个：evaluate/iterate/gate_check/bootstrap/...）；
 *   2. 官方 skill 工具对本技能的调用（name === 'skill' 且原始参数含
 *      'ai-native-iteration-cycle'）——「dsh 的轨迹要有本技能插件的调用」的伴生通道。
 *
 * 环回缓冲上限 50 条，drop-oldest；进程内存态（重启即清空，如实呈现）。
 * in-flight 超过 15 分钟标记 possiblyOrphaned（tools/result 因进程内异常未到达时，
 * 面板不把"永远转圈"伪装成"还在跑"）。
 *
 * T-4801 拆分：extractResultPreview/contentText 纯函数已拆至
 * ./invocationFeedPreview.ts（本文件触 250 行纪律时的同域拆分）。
 * cycle-71 拆分：宿主事件接线（attach + 诊断注入）已拆至
 * ./invocationFeedAttach.ts —— 归属字段（cycle/phase，方案 A′）把本文件推向
 * 250 行纪律。两个拆出模块均由本文件**再导出**，消费者 import 路径零变更。
 */
import { previewOf } from './invocationFeedPreview.ts';
import type { InvocationAttribution } from './invocationAttribution.ts';

export { extractResultPreview, previewOf } from './invocationFeedPreview.ts';
/**
 * cycle-71 同域拆分：宿主事件接线（attach + 诊断注入）拆至
 * `./invocationFeedAttach.ts` —— 归属字段（方案 A′）把本文件推向 250 行纪律
 * （先例：T-4801 的 invocationFeedPreview.ts 拆分）。此处**再导出**，消费者
 * （src/index.ts / 单测）的 import 路径零变更。
 */
export { attachInvocationFeed, type AttachOptions } from './invocationFeedAttach.ts';

/** 单次工具调用的白盒记录（序列化形状 = 路由响应形状）。 */
export interface InvocationRecord {
  callId: string;
  name: string;
  /** 模型产出的原始参数串（未解析），截断到 200 字符。 */
  argumentsPreview: string;
  turn?: number;
  step?: number;
  startedAt: number;
  endedAt?: number;
  status: 'in-flight' | 'done' | 'error';
  error?: { name: string; code: string; reason?: string };
  durationMs?: number;
  /**
   * cycle-48 T-4801：结果内容预览（截断 200 字符，对齐 argumentsPreview）。
   * 提取自 tools/result 载荷的 content 文本块（官方 ContentBlock[] 形状，
   * 见 ./invocationFeedPreview.ts 的 extractResultPreview 契约注）；错误调用
   * 无此字段（error 三元组已足）。
   */
  resultPreview?: string;
  /** in-flight 超过 15 分钟：结束事件大概率永远不会来，如实标记。 */
  possiblyOrphaned?: boolean;
  /**
   * cycle-71 T-10501：流程归属（`workflow-state.json` 的 currentCycle）——
   * 白盒四元组「流程流向」元的 join key。**事件到达时**解析（call = 模型请求
   * 调用的瞬间），解析不到则缺省不落（宁缺勿猜，INV-27；见 invocationAttribution.ts）。
   */
  cycle?: string;
  /** 同上的 currentPhase（宏观六相之一，如 `build`）。 */
  phase?: string;
}

/** 路由响应形状。 */
export interface InvocationFeedSnapshot {
  invocations: InvocationRecord[];
  total: number;
  generatedAt: string;
}

/**
 * 事件通道诊断计数（动态白盒的一部分：事件到达情况本身也要透明，不能只看结果）。
 * 排障价值：feed 空时区分「事件根本没到」（sessionEvents/toolsResults 为 0）
 * 与「事件到了但被过滤/配对逻辑丢弃」（计数 > 0 但 invocations 空）。
 */
export interface FeedDiagnostics {
  /** 订阅后看到的 session/event 事件总数（任意类型，含非 tool/call）。 */
  sessionEvents: number;
  /** 其中 type === 'tool/call' 的事件数（任意工具名）。 */
  sessionToolCalls: number;
  /** 看到的 tools/result 事件总数（任意工具，含非本插件调用）。 */
  toolsResults: number;
  /** 通过 isAnicInvocation 过滤、进入 feed 的开始相位数。 */
  anicCalls: number;
  /** 结束相位到达且 feed 内有对应 in-flight 记录的次数。 */
  anicResults: number;
}

/** 判定一次调用是否属于本插件的能力面（工具 or 官方 skill 通道）。 */
export function isAnicInvocation(name: string, rawArguments: string): boolean {
  if (name.startsWith('anic_')) return true;
  // 官方 skill 工具的参数形态是 {"name":"ai-native-iteration-cycle",...}。
  // 优先 JSON 解析后精确匹配 name 字段（kb-researcher cycle-16 P2：原始串
  // 子串匹配会被「参数里恰好提到技能名」的其他技能调用误命中）；解析失败
  // （模型产出非法 JSON）才回退子串匹配——事件不丢，误报优先于漏报。
  if (name === 'skill') {
    try {
      const parsed = JSON.parse(rawArguments) as { name?: unknown };
      return parsed?.name === 'ai-native-iteration-cycle';
    } catch {
      return rawArguments.includes('ai-native-iteration-cycle');
    }
  }
  return false;
}

/** 截断与提取函数见 ./invocationFeedPreview.ts（T-4801 拆分）。 */
const ORPHAN_AFTER_MS = 15 * 60 * 1000;

/** 环回缓冲（纯数据结构，便于单测；宿主接线见 attachInvocationFeed）。 */
export interface InvocationFeed {
  recordCall(input: { callId: string; name: string; arguments: string; turn?: number; step?: number; attribution?: InvocationAttribution | null }): void;
  /**
   * 结束一次调用；返回是否真实结算（命中 in-flight 记录）——诊断计数用。
   * cycle-48 T-4801：第二参收 tools/result 全载荷（isError/error/resultPreview
   * 已由调用方 extractResultPreview 提取；此处只存不解析——feed 保持纯数据结构）。
   */
  recordResult(callId: string, result: { isError: boolean; error?: { name: string; code: string; reason?: string }; resultPreview?: string }): boolean;
  snapshot(now?: number): InvocationFeedSnapshot;
  /** 事件通道诊断（由 attachInvocationFeed 注入；未接线时不存在）。 */
  diagnostics?(): FeedDiagnostics;
}

/**
 * 归属字段落盘（cycle-71）：只落**真实解析到**的值——整体 null 或字段缺失/
 * 空串一律不加字段。绝不写占位符（`undefined`/空串/`process.cwd()` 兜底）。
 */
function applyAttribution(rec: InvocationRecord, attribution?: InvocationAttribution | null): void {
  if (!attribution) return;
  if (typeof attribution.cycle === 'string' && attribution.cycle !== '') rec.cycle = attribution.cycle;
  if (typeof attribution.phase === 'string' && attribution.phase !== '') rec.phase = attribution.phase;
}

/** 创建环回缓冲。limit 默认 50。 */
export function createInvocationFeed(limit = 50): InvocationFeed {
  const records: InvocationRecord[] = [];
  const byCallId = new Map<string, InvocationRecord>();

  function evict(): void {
    while (records.length > limit) {
      const oldest = records.shift();
      if (oldest) byCallId.delete(oldest.callId);
    }
  }

  return {
    recordCall(input) {
      // 同 callId 重复到达（重放/补偿）时保持首见 startedAt，不覆盖已结束态。
      if (byCallId.has(input.callId)) return;
      const rec: InvocationRecord = {
        callId: input.callId,
        name: input.name,
        argumentsPreview: previewOf(input.arguments),
        turn: input.turn,
        step: input.step,
        startedAt: Date.now(),
        status: 'in-flight',
      };
      // cycle-71：归属是观测元数据——解析不到就**不落字段**（宁缺勿猜），
      // 且只在 call 相位沉淀一次（终态不改写，保持"发生时的坐标"语义）。
      applyAttribution(rec, input.attribution);
      records.push(rec);
      byCallId.set(input.callId, rec);
      evict();
    },
    recordResult(callId, result) {
      const rec = byCallId.get(callId);
      // 结束先于开始到达（订阅晚挂/跨进程重启）：不伪造开始，直接跳过。
      if (!rec) return false;
      if (rec.status !== 'in-flight') return false;
      rec.endedAt = Date.now();
      rec.durationMs = rec.endedAt - rec.startedAt;
      rec.status = result.isError ? 'error' : 'done';
      if (result.isError && result.error) rec.error = result.error;
      // T-4801：成功调用的结果内容预览（错误态走 error 三元组，无预览）。
      if (!result.isError && result.resultPreview) rec.resultPreview = result.resultPreview;
      return true;
    },
    snapshot(now = Date.now()) {
      // 快照必须无副作用：possiblyOrphaned 只写在**副本**上。写在内部记录上
      // 会让第一次超时快照永久污染后续早于阈值的快照（单测抓出的真实缺陷）。
      const invocations = [...records].reverse().map((r) => {
        const copy: InvocationRecord = { ...r };
        if (copy.status === 'in-flight' && now - copy.startedAt > ORPHAN_AFTER_MS) copy.possiblyOrphaned = true;
        return copy;
      });
      return { invocations, total: invocations.length, generatedAt: new Date(now).toISOString() };
    },
  };
}

