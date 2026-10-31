/**
 * 错误分类学的**契约**（cycle-95 接线：让 `anicError` / `isAnicError` 有真消费者）。
 *
 * ## 为什么需要这条测试（不是为审计凑数）
 *
 * `src/shared/errors.ts` 声明了「四域闭合错误码」，但全仓实测显示：
 *
 * - 95 处路由/工具**手写** `'ANIC_ROUTE_…'` / `'ANIC_CONFIG_…'` 字面码；
 * - 工厂 `anicError()` 的调用点数为 **0**（它只被自己的 `export` 行匹配到）；
 * - 类型守卫 `isAnicError()` 的调用点数同样为 **0**。
 *
 * ⇒ 也就是说：**分类学的声明与实际用法完全脱钩**，没有任何测试钉住
 * 「工厂产出的形状」与「守卫认什么」。它们此前是 audit-wiring 的 P1 别域死导出。
 *
 * ## 裁决：接线（而不是删除），接在这里
 *
 * 工厂与守卫的价值是**进程内**的（`anicError()` 造一个带 `.code` 的 Error，
 * 边界处用 `isAnicError()` 判定它是不是本仓的错误）。它们**不**用于 HTTP
 * 报文：报文里的错误是 `{ error: { code, message } }` 这样的**普通对象**，
 * 不是 `Error` 实例 —— 本契约第 ③ 条专门把这条边界钉住，防止下一个人拿
 * `isAnicError` 去判报文（那会恒为 false，且是**静默**的语义错误）。
 *
 * 本契约因此断言三件真实语义：
 *   ① 工厂：code 拼接规则、`[code] message` 前缀、requestId 可选透传；
 *   ② 守卫：只认 **Error 实例 + 以 `ANIC_` 开头的字符串 code**；
 *   ③ 边界：普通报文对象（含 ANIC 形状的 code）**不**被守卫认作 AnicError。
 */
import { describe, it, expect } from 'vitest';
import { ERROR_DOMAINS, anicError, isAnicError, type AnicError } from '../../src/shared/errors.ts';

describe('anicError 工厂（错误码拼接是唯一权威）', () => {
  it('code = ANIC_<domain>_<detail>，message 带 [code] 前缀（日志可直接 grep 码）', () => {
    const e = anicError('ROUTE', 'SNAPSHOT_NOT_FOUND', 'snapshot missing');
    expect(e.code, 'code 必须是 域+细节 的拼接结果').toBe('ANIC_ROUTE_SNAPSHOT_NOT_FOUND');
    expect(e.message, 'message 必须以 [code] 开头，否则日志里码与文案对不上').toBe('[ANIC_ROUTE_SNAPSHOT_NOT_FOUND] snapshot missing');
    expect(e instanceof Error, '必须是真 Error（能被 try/catch 与 instanceof 捕获）').toBe(true);
  });

  it('requestId 可选：不给就不写该字段（不伪造空串）', () => {
    const without = anicError('FETCH', 'TIMEOUT', 'too slow');
    expect(without.requestId, '未传 requestId 时该字段必须是 undefined').toBeUndefined();
    const withId = anicError('CONFIG', 'READ_FAILED', 'io', 'req-7');
    expect(withId.requestId).toBe('req-7');
  });

  it('四个域各自产出可区分的码（闭合词表，域是编译期约束）', () => {
    for (const domain of ERROR_DOMAINS) {
      const e = anicError(domain, 'X', 'x');
      expect(e.code.startsWith(`ANIC_${domain}_`), `${domain} 域的码必须带自己的域段（诊断面板按此分域着色）`).toBe(true);
    }
    // 域段互不前缀重叠：否则 `ANIC_ROUTE_X` 会被误判成别的域。
    expect(ERROR_DOMAINS.length, '四域闭合').toBe(4);
  });
});

describe('isAnicError 守卫', () => {
  it('认工厂产出（自产自销的往返）', () => {
    const e = anicError('RENDER', 'BAD_SHAPE', 'bad');
    expect(isAnicError(e), '工厂产出必须被自己的守卫认作 AnicError').toBe(true);
  });

  it('不认普通 Error / 非 Error 值 / 非 ANIC 前缀的 code', () => {
    expect(isAnicError(new Error('plain'))).toBe(false);
    expect(isAnicError('ANIC_ROUTE_X')).toBe(false);
    expect(isAnicError(null)).toBe(false);
    expect(isAnicError(undefined)).toBe(false);
    expect(isAnicError(42)).toBe(false);
    // 有 code 但不是 ANIC 前缀：属于别的错误体系，不得混入本域分类。
    const foreign = new Error('foreign') as AnicError;
    foreign.code = 'ENOENT';
    expect(isAnicError(foreign), '非 ANIC_ 前缀的 code 不得被认成本仓错误').toBe(false);
  });

  it('③ 边界：HTTP 报文里的 `{ error: { code } }` **不**是 AnicError', () => {
    // 报文是普通对象（JSON.parse 的产物），不是 Error 实例。
    // 这条断言存在的意义：防止有人拿 isAnicError 去判报文 —— 那会恒 false 且静默错。
    const wireBody = { error: { code: 'ANIC_ROUTE_NO_WORKSPACE', message: 'no workspace' } };
    expect(isAnicError(wireBody), '报文对象不是 Error 实例 ⇒ 守卫必须拒绝（错误用法要被看见）').toBe(false);
    expect(isAnicError(wireBody.error), '连内层 error 也是普通对象，同样不是 AnicError').toBe(false);
  });
});
