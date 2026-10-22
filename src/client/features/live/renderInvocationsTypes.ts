/**
 * 实时调用域的共享类型（cycle-41 T3 拆分：useInvocations.ts 与
 * renderInvocations.ts 都消费——类型是两文件间的唯一公共面）。
 */

/**
 * feed 通道诊断计数（cycle-47 T-4702：路由已随 /invocations/live 返回，此前
 * 客户端类型丢弃、面板不可见——白盒量化缺口）。五个计数对齐宿主
 * invocationFeed.ts 的 FeedDiagnostics：排障价值 = feed 空时区分「事件没到」
 * （计数 0）vs「到了但被过滤」（计数 > 0 而 invocations 空）。
 */
export interface FeedDiagnosticsJson {
  sessionEvents: number;
  sessionToolCalls: number;
  toolsResults: number;
  anicCalls: number;
  anicResults: number;
}

/** 与宿主 InvocationRecord 对齐的最小客户端形状。 */
export interface InvocationJson {
  callId: string;
  name: string;
  argumentsPreview: string;
  turn?: number;
  step?: number;
  startedAt: number;
  endedAt?: number;
  status: 'in-flight' | 'done' | 'error';
  error?: { name: string; code: string; reason?: string };
  durationMs?: number;
  /** T-4801：成功调用的结果内容预览（旧宿主/错误态无此字段缺省不渲染）。 */
  resultPreview?: string;
  possiblyOrphaned?: boolean;
  /**
   * cycle-71 T-10501：流程归属（白盒四元组「流程流向」元的 join key）。
   *
   * 语义 = **该调用发生瞬间**的 `workflow-state.json` 坐标（不是响应时刻的
   * 当前相——响应期补算对已结束的调用是伪造，INV-27）。宿主在 `tool/call`
   * 事件到达时解析（`invocationAttribution.ts`）。
   * 旧宿主/解析不到（多会话歧义、文件缺失）→ 缺省不渲染（宁缺勿猜）。
   */
  cycle?: string;
  /** 同上的 currentPhase（宏观六相之一，如 `build`）。 */
  phase?: string;
}

export interface InvocationsJson {
  invocations: InvocationJson[];
  total: number;
  generatedAt: string;
  /** 通道诊断（可选——旧宿主/旧 feed 无此字段时缺省不渲染，零回归面）。 */
  diagnostics?: FeedDiagnosticsJson | null;
}
