/**
 * 实时调用域的共享类型（cycle-41 T3 拆分：useInvocations.ts 与
 * renderInvocations.ts 都消费——类型是两文件间的唯一公共面）。
 */

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
}
