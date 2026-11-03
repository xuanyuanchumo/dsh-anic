/**
 * 跨项目自举**执行体**（cycle-96 WS-B）—— HTTP 端点与 `anic_bootstrap_other` 工具
 * 共用**同一份实现**。
 *
 * ## 为什么必须抽出来（不是行数问题，是纪律问题）
 *
 * cycle-89 只把「举他」做成 HTTP 端点（`POST /anic/self/bootstrap-other`），于是
 * LLM 触发不了它（`grep bootstrap_other src/host/tools*.ts` 零命中）。补齐工具面有两条路：
 *   ① 工具内部**自调本仓 HTTP 端点**（fetch 自己的地址）；
 *   ② 工具与路由 in-process 调用**同一个函数**。
 * 本仓纪律只允许 ②：`closureAudit/channelRegistry.ts` 每条通道声明的 reason 都写着
 * 「插件内部不自我调用该端点」。自调会让「源零写入」变成「对自己发了个请求」的副作用，
 * 也让端点从「运维入口」变成插件内部行为（运维留痕失去意义）。
 *
 * ## 为什么放在 runtime 层（分层方向）
 *
 * 工具（`toolsBootstrapGateway.ts`）与路由（`routes/crossBootstrapRoute.ts`）都是
 * **上层装配**，两者都应向下依赖**执行层**。若执行体留在 routes/，工具就得
 * `tools → routes` 反向依赖。故执行体下沉到 runtime/（L0），两侧各自向下 import。
 * 连带把「记账 + 解析」执行体（原 `routes/selfBootstrapRunners.ts`）也下沉为
 * `runtime/bootstrapTrackedRunners.ts`（纯搬迁，语义一字未改）。
 *
 * ## 返回值为什么是 `{ status, body }`（HTTP 形状）
 *
 * 「不得改变既有 HTTP 路由行为」是硬约束。让执行体直接产出**原样的**状态码与响应体，
 * 路由只剩 `send(res, r.status, r.body)` —— 行为不可能因重构漂移（连键名都不用手抄）。
 * 工具侧再做一次**显式投影**（见 `toolsBootstrapGateway.ts`），投影是可断言的一层。
 *
 * ## 源零写入凭据的形态（唯一证据形态，不是自述）
 *
 * `sourceFingerprint`（调用前）与 `sourceFingerprintAfter`（调用后）都是**真实计算**的
 * `.cycles/**` 指纹（`fingerprintCycles`）；`sourceUnchanged === sameFingerprint(两者)`。
 * 源不可解析时两者为 `null`、断言降级为 `null`——**「没法证明」不等于「证明了没写」**，
 * 绝不伪造成 true。
 *
 * 边界：只写**目标**工作区的 `.cycles/**`；对源只做 `fingerprintCycles`（纯读）。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCrossTarget, fingerprintCycles, sameFingerprint } from './crossBootstrap.ts';
import { runEvalTracked, runGateTracked } from './bootstrapTrackedRunners.ts';
import { loadBootstrapState, saveBootstrapState, type BootstrapState } from '../selfBootstrap.ts';
import { runCrossInit } from './crossBootstrapInit.ts';

/** 动作白名单（闭合枚举——不接受任意字符串，避免拼错就静默走默认分支）。 */
export const CROSS_ACTIONS = ['init', 'evaluate', 'gate-check'] as const;
export type CrossAction = (typeof CROSS_ACTIONS)[number];

/** 执行体入参（HTTP 面与工具面都按这三字段调用）。 */
export interface CrossBootstrapInput {
  /** 源工作区（要被证明「没被写」的那一侧）；不可解析时为 null。 */
  sourceRoot: string | null;
  /** 目标工作区（**绝对路径**；相对路径由 resolveCrossTarget 响亮拒绝）。 */
  targetWorkspace: string;
  /** 原始动作串。未知值的语义由调用方定：HTTP 面回落 evaluate（既有契约）。 */
  action: string;
}

/** 执行体产出：HTTP 状态码 + 原样响应体（路由不再自己拼装任何键）。 */
export interface CrossBootstrapResponse {
  status: number;
  body: Record<string, unknown>;
}

/** 动作串是否落在闭合枚举内（调用方各自决定「未知值」的语义）。 */
export function isCrossAction(value: string): value is CrossAction {
  return (CROSS_ACTIONS as readonly string[]).includes(value);
}

/**
 * 源 `.cycles` 指纹；源为空 → null。
 *
 * 为什么不返回「空指纹」兜底：空指纹的 digest 是固定的常量，它与「真的读了但目录空」
 * 不可区分——那会让凭据看起来成立而实际什么也没证明。
 */
function sourceFingerprint(sourceRoot: string | null): ReturnType<typeof fingerprintCycles> | null {
  if (!sourceRoot) return null;
  return fingerprintCycles(join(sourceRoot, '.cycles'), sourceRoot);
}

/**
 * 在目标工作区上跑一次跨项目自举动作，返回 HTTP 形状结果。
 *
 * 三个动作的语义与 cycle-89 端点**逐字一致**（连错误码与响应键都一致）：
 *   init        只建目标 `.cycles/` 骨架（不跑脚本，目标没装技能也能跑）；
 *   evaluate    在目标上跑一次 eval-runner；
 *   gate-check  在目标上跑一次 gate-check（`--record` 固定，与端点一致）。
 */
export function runCrossBootstrap(input: CrossBootstrapInput): CrossBootstrapResponse {
  const { sourceRoot, targetWorkspace } = input;
  const resolved = resolveCrossTarget(targetWorkspace, sourceRoot);
  if (!resolved.ok) {
    // 400/404/412 三选一由 failure.error 决定：**语义不同，修复动作也不同**。
    const code = resolved.failure.error === 'ANIC_CROSS_TARGET_MISSING' ? 404
      : resolved.failure.error === 'ANIC_CROSS_NO_SKILL' ? 412
        : 400;
    return { status: code, body: { error: resolved.failure } };
  }
  const target = resolved.target;
  // HTTP 面既有语义：未知动作**回落** evaluate（不新增失败码——那是破坏性变更）。
  const action: CrossAction = isCrossAction(input.action) ? input.action : 'evaluate';
  const before = sourceFingerprint(sourceRoot);
  const targetInfo = { root: target.targetRoot, cyclesDir: target.targetCyclesDir, scriptsSource: target.scriptsSource };

  /** 收尾：重取源指纹并装配零写入凭据（三个动作共用同一形态，键序与端点一致）。 */
  const finish = (extra: Record<string, unknown>): CrossBootstrapResponse => {
    const after = sourceFingerprint(sourceRoot);
    return {
      status: 200,
      body: {
        ok: true,
        action,
        target: targetInfo,
        ...extra,
        sourceUnchanged: before !== null && after !== null ? sameFingerprint(before, after) : null,
        sourceFingerprint: before,
        sourceFingerprintAfter: after,
      },
    };
  };

  if (action === 'init') {
    // cycle-101：init 语义抽到 runtime/crossBootstrapInit.ts（一域一文件 + T3 守）。
    // 它真跑 init-workflow 并回报 initOk/initExitCode/artifacts —— 旧实现只 mkdir
    // 就报 ok（「假装成功」，真机实测目标项目空无一物）。
    const outcome = runCrossInit(target.targetRoot, target.targetCyclesDir, target.scriptsDir);
    if (outcome.failed) return { status: 412, body: outcome.failureBody! };
    return finish(outcome.extra ?? {});
  }

  // 目标 `.cycles` 必须已存在 —— 评估脚本要求工作区已初始化。
  // 缺失时给**可执行**建议，而不是含糊的失败。
  if (!existsSync(target.targetCyclesDir)) {
    return {
      status: 412,
      body: {
        error: {
          code: 'ANIC_CROSS_TARGET_NOT_INITIALIZED',
          message: `target workspace has no .cycles/: ${target.targetRoot}`,
          remedy: '先对目标执行 action:"init"（POST /anic/self/bootstrap-other），或在目标项目运行 init-workflow',
        },
      },
    };
  }

  const trackTarget = { roots: target.targetRoot, cyclesDir: target.targetCyclesDir, scriptsDir: target.scriptsDir };
  const state = loadBootstrapState(target.targetCyclesDir);

  if (action === 'evaluate') {
    const { result, flowId, score, outcome, phase } = runEvalTracked(trackTarget, state);
    saveBootstrapState(target.targetCyclesDir, phase.state);
    return finish({
      flowId,
      score,
      outcome,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 2000),
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      status: phase.state.status,
    });
  }

  // gate-check
  const { result, flowId, verdict, outcome } = runGateTracked(trackTarget, ['--gate', 'all', '--quality', '--record']);
  saveBootstrapState(target.targetCyclesDir, {
    ...state,
    lastGateVerdict: verdict,
    history: [...state.history, {
      round: state.round,
      evalScore: state.lastEvalScore,
      gateVerdict: verdict,
      fixApplied: null,
      timestamp: new Date().toISOString(),
    }],
  } as BootstrapState);
  return finish({
    flowId,
    verdict,
    outcome,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 4000),
    stderr: result.stderr.slice(0, 2000),
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  });
}

/**
 * 解析源工作区（工具面）：缺省取会话工作区；**给了就必须是绝对路径且存在**。
 *
 * 为什么校验：源路径只用于 `join(root, '.cycles')` 取指纹。相对路径会随宿主 cwd
 * 漂移，于是「证明 A 项目没被写」会静默变成「证明了一个不知道哪个目录没被写」——
 * 凭据看起来成立而实际无效。这正是本仓最忌讳的形态（假绿）。
 */
export function resolveCrossSource(
  explicit: unknown,
  fallback: () => string | null,
): { ok: true; sourceRoot: string | null } | { ok: false; message: string; remedy: string } {
  const raw = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : null;
  if (raw === null) {
    // 缺省：会话工作区。取不到也不失败——指纹会退化为 null（如实降级）。
    let root: string | null = null;
    try { root = fallback(); } catch { root = null; }
    return { ok: true, sourceRoot: root };
  }
  if (!isAbsolutePath(raw)) {
    return {
      ok: false,
      message: `source workspace must be an absolute path: ${raw}`,
      remedy: 'source 只用于取「源零写入」指纹；相对路径会随宿主 cwd 漂移，请传绝对路径或省略该参数（缺省 = 当前会话工作区）',
    };
  }
  if (!existsSync(raw)) {
    return {
      ok: false,
      message: `source workspace does not exist: ${raw}`,
      remedy: '省略 source 让默认取当前会话工作区；或指向真实存在的项目根',
    };
  }
  return { ok: true, sourceRoot: raw };
}

/**
 * 是否是绝对路径（Windows 与 POSIX 双判）。
 *
 * 为什么不用 `path.isAbsolute`：本仓在 Windows 上开发、可能在任何平台被审阅，
 * 而 `path.isAbsolute('D:/x')` 在 POSIX 主机上返回 false —— 那会让「绝对路径」
 * 这条判据随运行平台漂移。凭据判定不该有平台相关的假绿。
 */
function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || /^\\\\/.test(p);
}
