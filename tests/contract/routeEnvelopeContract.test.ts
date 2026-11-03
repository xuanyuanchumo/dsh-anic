/**
 * 路由统一信封契约（cycle-101 · dsh-ops 模式）。
 *
 * 目标一致性：全部 HTTP 路由的错误体必须是**唯一形状**
 *   { ok:false, error:{ code, message, status, retry, nextAction } }
 * （成功体为 { ok:true, value } 或携带业务字段的 200 响应——只约束错误面）。
 *
 * 策略表语义（dsh-ops errors.js 同构）：错误码 → {status, retry}，effect 主导。
 * 本契约三重守卫：
 *   ① 策略表完备性——引用的每个 code 都在 ERR_POLICIES（缺表 = 默认 unknown，
 *      模型会拿到「永不重试」的过度保守建议）；
 *   ② 信封形状——anicError 产出的对象冻结且字段齐全；
 *   ③ 路由源静态审计——routes/ 下不允许再出现三形态旧信封字面量
 *      （反向自检有牙：注释里的旧形状示例不受罚，只扫 call 位）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ERR_POLICIES,
  anicError,
  anicOk,
  errorPolicyOf,
  httpStatusOf,
  sendAnicError,
} from '../../src/host/routes/envelope.ts';

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'host', 'routes');

describe('统一错误信封（dsh-ops 模式 · cycle-101）', () => {
  it('① 策略表：anic 域已知错误码全部在表（缺表即 unknown/never 过度保守）', () => {
    const expected = [
      'ANIC_ROUTE_NO_WORKSPACE',
      'ANIC_ROUTE_BAD_REQUEST',
      'ANIC_ROUTE_METHOD',
      'ANIC_ROUTE_TIMEOUT',
      'ANIC_CONFIG_READ_FAILED',
      'ANIC_CONFIG_WRITE_FAILED',
      'ANIC_CONFIG_BAD_PATCH',
      'ANIC_CONFIG_MISSING',
      'ANIC_SKILL_UNKNOWN_SCRIPT',
      'ANIC_SKILL_EXEC_FAILED',
      'ANIC_SKILL_TIMEOUT',
      'ANIC_GATE_FAILED',
      'ANIC_ROUTE_SELF_INIT_ALREADY',
      'ANIC_ROUTE_DRYRUN_NATIVE_ONLY',
    ];
    for (const code of expected) {
      expect(ERR_POLICIES[code], `缺策略: ${code}`).toBeDefined();
    }
  });

  it('①b 策略语义：拒绝类永不重试 / 冲突类先改状态 / 配置类先改输入', () => {
    expect(errorPolicyOf('ANIC_ROUTE_NO_WORKSPACE').retry).toBe('never');
    expect(errorPolicyOf('ANIC_ROUTE_NO_WORKSPACE').status).toBe('rejected');
    expect(errorPolicyOf('ANIC_ROUTE_SELF_INIT_ALREADY').status).toBe('conflict');
    expect(errorPolicyOf('ANIC_ROUTE_BAD_REQUEST').retry).toBe('after-input-change');
    expect(errorPolicyOf('ANIC_GATE_FAILED').retry).toBe('after-state-change');
    // 未知码默认 unknown/never（诚实降级：不猜）
    expect(errorPolicyOf('ANIC_NOT_A_CODE').status).toBe('unknown');
    expect(errorPolicyOf('ANIC_NOT_A_CODE').retry).toBe('never');
  });

  it('② effect 主导：effectState=unknown 压过错误码自己的 retry 建议', () => {
    // ANIC_ROUTE_BAD_REQUEST 本身是 after-input-change，但脚本中途死 ⇒ 强制 never
    const env = anicError('ANIC_ROUTE_BAD_REQUEST', 'died mid-flight', { effectState: 'unknown' });
    expect(env.error.retry).toBe('never');
    expect(env.error.status).toBe('unknown');
    // nextAction 与 retry 同源（可执行指引）
    expect(env.error.nextAction).toContain('不要重试');
    // 显式 retry 覆盖仍然允许（调用方自担）
    const forced = anicError('ANIC_GATE_FAILED', 'x', { retry: 'after-input-change' });
    expect(forced.error.retry).toBe('after-input-change');
  });

  it('②b 信封形状：ok=false + 五字段 + nextAction 非空；成功体 ok=true', () => {
    const env = anicError('ANIC_CONFIG_MISSING', 'no config');
    expect(env.ok).toBe(false);
    for (const k of ['code', 'message', 'status', 'retry', 'nextAction']) {
      expect(env.error).toHaveProperty(k);
    }
    expect(env.error.nextAction.length).toBeGreaterThan(0);
    const ok = anicOk({ n: 1 });
    expect(ok.ok).toBe(true);
    expect(ok.value).toEqual({ n: 1 });
  });

  it('②c HTTP 映射：404/405/400/409/500 各归其位', () => {
    expect(httpStatusOf(anicError('ANIC_ROUTE_NO_WORKSPACE', 'x'))).toBe(404);
    expect(httpStatusOf(anicError('ANIC_CONFIG_MISSING', 'x'))).toBe(404);
    expect(httpStatusOf(anicError('ANIC_ROUTE_METHOD', 'x'))).toBe(405);
    expect(httpStatusOf(anicError('ANIC_ROUTE_BAD_REQUEST', 'x'))).toBe(400);
    expect(httpStatusOf(anicError('ANIC_ROUTE_SELF_INIT_ALREADY', 'x'))).toBe(409);
    expect(httpStatusOf(anicError('ANIC_SKILL_EXEC_FAILED', 'x'))).toBe(500);
  });

  it('②d sendAnicError：一行接线产出统一体（结构化 send 捕获）', () => {
    const sent: Array<{ status: number; body: unknown; requestId?: string }> = [];
    const fakeSend = (res: unknown, status: number, body: unknown, requestId?: string): void => {
      void res;
      sent.push({ status, body, requestId });
    };
    sendAnicError(fakeSend, {}, 'ANIC_ROUTE_NO_WORKSPACE', 'no workspace', { requestId: 'r-1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.status).toBe(404);
    const body = sent[0]?.body as { ok: false; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('ANIC_ROUTE_NO_WORKSPACE');
    expect(sent[0]?.requestId).toBe('r-1');
  });

  it('③ 路由源静态审计：routes/ 不允许旧三形态错误字面量（反向自检）', () => {
    const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts') && f !== 'envelope.ts');
    expect(files.length, '路由文件扫描集非空（空扫描=永久假绿）').toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(join(ROUTES_DIR, f), 'utf-8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // 只扫 call 位（send(..., { error: ...) / res.end(JSON.stringify({ error: ...)
        // 注释/文档行（以 * 或 // 开头）豁免——旧形状示例必须留档。
        const isComment = /^\s*(\*|\/\/)/.test(line);
        const callSite = /(send|sendJson)\s*\([^)]*\{\s*error\s*:|res\.end\(JSON\.stringify\(\{\s*error\s*:/.test(line);
        if (!isComment && callSite) offenders.push(`${f}:${i + 1}`);
      }
    }
    expect(offenders, `旧信封残留（必须经 anicError/sendAnicError）:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('③b 采纳面：sendAnicError/anicError 在路由域确有接线（防契约空转）', () => {
    const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts') && f !== 'envelope.ts');
    let wired = 0;
    for (const f of files) {
      if (readFileSync(join(ROUTES_DIR, f), 'utf-8').includes("from './envelope.ts'")) wired++;
    }
    expect(wired, '至少 10 个路由文件接线统一信封').toBeGreaterThanOrEqual(10);
  });
});
