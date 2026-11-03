/**
 * 路由统一错误信封（cycle-101 · dsh-ops 模式落地）。
 *
 * 技术债根源（信封考古，cycle-101 静态扫描）：路由错误体三形态并存——
 *   ① `{ error: 'no workspace' }`（archiveResetRoute/cycleRoute 字符串派）
 *   ② `{ error: { code, message } }`（configRoute 系对象派）
 *   ③ `{ error: 'CODE', message }`（closureAuditRoute 混合派）
 * 消费方（client 面板 / 模型工具）被迫各写一套解析。dsh-ops 的解法是
 * 「失败也是一等公民」：错误码 → {status, retry} 策略表 + effect 主导 +
 * nextAction 一句话指引（模型自修复的关键输入）。
 *
 * 策略表语义（源自 OPS/lib/kernel/errors.js，裁剪到 anic 域 10 码）：
 *   rejected  —— 拒绝类（权限/路径），重试无意义；
 *   error     —— 按 retry 建议：after-input-change（改输入可重试）/
 *                after-state-change（先修产物再重试）/ never；
 *   conflict  —— 乐观锁冲突，先读新状态再重试；
 *   unknown   —— 副作用未知（脚本中途死），绝不自动重试——盲目 auto-fix
 *                可能对已生效的写入二次施力。effect 主导规则：effectState
 *                优先级高于错误码本身（OPS 原注释："a failed receipt never
 *                licenses replaying a possible write"）。
 */

/** 信封 status 四分类。 */
export type AnicErrStatus = 'rejected' | 'error' | 'conflict' | 'unknown';
/** 重试建议三分类（模型可执行的下一步语义）。 */
export type AnicRetry = 'never' | 'after-input-change' | 'after-state-change';

interface ErrPolicy {
  status: AnicErrStatus;
  retry: AnicRetry;
}

const policy = (status: AnicErrStatus, retry: AnicRetry): ErrPolicy => ({ status, retry });

/** anic 域错误码 → 策略表（dsh-ops ERROR_POLICIES 的 anic 裁剪版）。 */
export const ERR_POLICIES: Readonly<Record<string, ErrPolicy>> = Object.freeze({
  ANIC_ROUTE_NO_WORKSPACE: policy('rejected', 'never'),
  ANIC_ROUTE_BAD_REQUEST: policy('error', 'after-input-change'),
  ANIC_ROUTE_METHOD: policy('rejected', 'never'),
  ANIC_ROUTE_TIMEOUT: policy('error', 'after-state-change'),
  ANIC_CONFIG_READ_FAILED: policy('error', 'after-state-change'),
  ANIC_CONFIG_WRITE_FAILED: policy('error', 'after-state-change'),
  ANIC_CONFIG_BAD_PATCH: policy('error', 'after-input-change'),
  ANIC_CONFIG_MISSING: policy('error', 'after-state-change'),
  ANIC_SKILL_UNKNOWN_SCRIPT: policy('error', 'after-input-change'),
  ANIC_SKILL_EXEC_FAILED: policy('unknown', 'never'),
  ANIC_SKILL_TIMEOUT: policy('error', 'after-state-change'),
  ANIC_GATE_FAILED: policy('error', 'after-state-change'),
  ANIC_ROUTE_SELF_INIT_ALREADY: policy('conflict', 'after-state-change'),
  ANIC_ROUTE_DRYRUN_NATIVE_ONLY: policy('error', 'after-input-change'),
});

const DEFAULT_POLICY = policy('unknown', 'never');

/** effect 主导规则（OPS errorPolicy 同构）：effectState 优先于错误码。 */
export function errorPolicyOf(code: string, effectState: 'none' | 'unknown' = 'none'): ErrPolicy {
  if (effectState === 'unknown') return DEFAULT_POLICY;
  return ERR_POLICIES[code] ?? DEFAULT_POLICY;
}

/** 统一错误信封形状（client/模型唯一需要认识的错误形状）。 */
export interface AnicErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    status: AnicErrStatus;
    retry: AnicRetry;
    nextAction: string;
  };
}

/** nextAction 默认值表——策略表的可执行镜像（每码一句话）。 */
const NEXT_ACTIONS: Readonly<Record<AnicRetry, string>> = Object.freeze({
  never: '不要重试；该请求被策略拒绝或副作用未知。',
  'after-input-change': '修正请求输入后重试。',
  'after-state-change': '先修复工作区产物/状态，再重试。',
});

/**
 * 构造统一错误信封。effectState='unknown'（脚本中途死/进程被杀）时强制
 * unknown+never——即便错误码本身声称可重试（effect 主导）。
 */
export function anicError(
  code: string,
  message: string,
  opts: { effectState?: 'none' | 'unknown'; nextAction?: string; retry?: AnicRetry } = {},
): AnicErrorEnvelope {
  const base = errorPolicyOf(code, opts.effectState ?? 'none');
  const retry = opts.retry ?? base.retry;
  return {
    ok: false,
    error: {
      code,
      message,
      status: base.status,
      retry,
      nextAction: opts.nextAction ?? NEXT_ACTIONS[retry],
    },
  };
}

/** 信封 → HTTP 状态码映射（rejected/never→4xx；可重试→409/500）。 */
export function httpStatusOf(env: AnicErrorEnvelope): number {
  const c = env.error.code;
  if (c === 'ANIC_ROUTE_NO_WORKSPACE' || c === 'ANIC_CONFIG_MISSING') return 404;
  if (c === 'ANIC_ROUTE_METHOD') return 405;
  if (c === 'ANIC_ROUTE_BAD_REQUEST' || c === 'ANIC_CONFIG_BAD_PATCH' || c === 'ANIC_SKILL_UNKNOWN_SCRIPT') return 400;
  if (env.error.retry === 'never' && env.error.status === 'unknown') return 500;
  if (env.error.status === 'conflict') return 409;
  return 500;
}

/** 成功信封形状（与错误信封互补；value 承载业务载荷）。 */
export interface AnicOkEnvelope<T> {
  ok: true;
  value: T;
}

/** 构造成功信封。 */
export function anicOk<T>(value: T): AnicOkEnvelope<T> {
  return { ok: true, value };
}

/**
 * 发送统一错误信封的最小接线函数——路由侧一行替换旧手写信封。
 * SendFn 来自 routeContext（(res, status, body, requestId?) 形状），此处
 * 结构化最小依赖避免循环 import（envelope 不依赖 routeContext）。
 */
export function sendAnicError(
  send: (res: unknown, status: number, body: unknown, requestId?: string) => void,
  res: unknown,
  code: string,
  message: string,
  opts: { effectState?: 'none' | 'unknown'; nextAction?: string; requestId?: string } = {},
): void {
  const env = anicError(code, message, opts);
  send(res, httpStatusOf(env), env, opts.requestId);
}
