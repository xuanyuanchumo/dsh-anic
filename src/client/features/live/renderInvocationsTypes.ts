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
  possiblyOrphaned?: boolean;
}

export interface InvocationsJson {
  invocations: InvocationJson[];
  total: number;
  generatedAt: string;
  /** 通道诊断（可选——旧宿主/旧 feed 无此字段时缺省不渲染，零回归面）。 */
  diagnostics?: FeedDiagnosticsJson | null;
}
