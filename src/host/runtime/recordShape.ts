/**
 * 迁移合法性矩阵 #5：advance record 形状校验（cycle-40，doc18 §3 #8 收口 5/5）。
 *
 * 从 stateMachine.ts 拆出（T3 ≤250 行纪律）：白名单与校验是纯函数域，
 * 与图解析/状态推进分离——advance 只调用 validateRecordShape 一个入口。
 */

/** advance record 的合法字段集（唯一白名单——新字段必须显式扩此表）。 */
export const RECORD_FIELDS: ReadonlySet<string> = new Set([
  'gateApproved', 'gate', 'gateName', 'result', 'detail',
]);

/** advance record 类型（与 stateMachine.AdvanceRecord 同构，此处为形状域的权威定义）。 */
export interface AdvanceRecord {
  gateApproved?: boolean;
  gate?: string;
  gateName?: string;
  result?: 'PASS' | 'FAIL';
  detail?: string;
}

/**
 * 矩阵 #5：record 形状校验（纯函数）。
 *
 * 未定义 record 合法（非门节点的普通推进）；携带 record 时必须：
 * - 是普通对象（非数组/非 null）；
 * - 只含白名单字段（未知字段 = 调用方契约漂移，响亮拒绝而非静默丢弃）；
 * - 每个字段的类型受检（gateApproved: boolean / gate|gateName|detail: string /
 *   result: 'PASS' | 'FAIL' 闭合枚举）。
 */
export function validateRecordShape(record: unknown): { ok: boolean; reason?: string } {
  if (record === undefined) return { ok: true };
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return { ok: false, reason: 'record must be an object' };
  }
  for (const key of Object.keys(record)) {
    if (!RECORD_FIELDS.has(key)) {
      return { ok: false, reason: `unknown record field '${key}' (whitelist: ${[...RECORD_FIELDS].join(', ')})` };
    }
  }
  const r = record as Record<string, unknown>;
  if (r.gateApproved !== undefined && typeof r.gateApproved !== 'boolean') {
    return { ok: false, reason: 'record.gateApproved must be boolean' };
  }
  if (r.gate !== undefined && typeof r.gate !== 'string') {
    return { ok: false, reason: 'record.gate must be string' };
  }
  if (r.gateName !== undefined && typeof r.gateName !== 'string') {
    return { ok: false, reason: 'record.gateName must be string' };
  }
  if (r.result !== undefined && r.result !== 'PASS' && r.result !== 'FAIL') {
    return { ok: false, reason: `record.result must be 'PASS' | 'FAIL' (got ${JSON.stringify(r.result)})` };
  }
  if (r.detail !== undefined && typeof r.detail !== 'string') {
    return { ok: false, reason: 'record.detail must be string' };
  }
  return { ok: true };
}
