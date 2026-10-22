/**
 * 自举前置守卫（cycle-72 P0-SEC-BOOTSTRAP-PRECONDITION）。
 *
 * 被守卫的缺陷：两轮自举恒得 `evalScore 0 / gateVerdict FAIL`，`CONVERGED` 永假。
 * 根因不是「代码质量差」，而是**缺前置**被折叠成了「评估未过」：
 *   - `eval-runner.mjs:98`（经 `scripts/lib/config.mjs::loadProjectConfig`）在缺
 *     `.cycles/config.yml` 时 `console.error` + `process.exit(1)`；这是**入口拒绝**，
 *     不是任何维度的裁决；
 *   - 缺 `.cycles/cycles/cycle-N/` 时 eval 照跑，但 Q2/Q8 等依赖 cycle 目录的维度
 *     必然失败（无工件 = 无证据），同样产不出「值得修的评估结论」。
 * 两种情形都被 `parseEvalScore` 读成 0、被 gate-check 读成 FAIL，进而写出
 * `tech-debt/self-bootstrap-round-N.json` 的 0 分提案——一份**看起来像质量结论、
 * 实为环境未就绪**的误导性工件。自举因此永远无法收敛，且每一轮都在污染技术债队列。
 *
 * 本模块把「环境未就绪」与「评估未过」在**动作发生之前**分开：前置不满足即响亮
 * 返回专用错误码 + 修复指引，调用方据此**不跑脚本、不记轮次、不产提案**。
 * 这比事后从输出里反推更可靠——没有输出，就没有可误读的输出。
 *
 * 纪律：本模块只做只读探测，零副作用（不建目录、不改状态）。
 */
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

/** 前置错误码（调用方按码分支，不解析 message）。 */
export type PreconditionCode =
  | 'SKILL_NOT_INSTALLED' // 技能脚本目录未解析到
  | 'CONFIG_MISSING' //     .cycles/config.yml（或旧名）缺失
  | 'CYCLE_DIR_MISSING'; // .cycles/cycles/cycle-N/ 缺失

/** 前置就绪。 */
export interface PreflightOk {
  ok: true;
}

/** 前置未就绪——带机器码与可执行的修复指引。 */
export interface PreflightFail {
  ok: false;
  code: PreconditionCode;
  /** 一句话事实（哪一份前置缺失、在哪个路径）。 */
  message: string;
  /** 修复动作：调用方可直接展示/执行的下一步。 */
  remedy: string;
}

export type PreflightResult = PreflightOk | PreflightFail;

/**
 * config 文件名双来源探测（与 `scripts/lib/config.mjs` 同一口径）。
 *
 * 旧名 `cycle-config.yml` 仍被技能脚本兼容（且会打 DEPRECATED 警告），故守卫
 * 也必须接受它——否则会与脚本的判定分叉，出现「守卫说缺、脚本说在」的假前置。
 */
const CONFIG_CANDIDATES = ['config.yml', 'cycle-config.yml'];

/** 是否已有任一 cycle 目录（`cycle-<数字>`；非数字目录不算数）。 */
export function hasCycleDir(cyclesDir: string): boolean {
  const root = join(cyclesDir, 'cycles');
  if (!existsSync(root)) return false;
  try {
    return readdirSync(root, { withFileTypes: true })
      .some((e) => e.isDirectory() && /^cycle-\d+$/.test(e.name));
  } catch {
    // 读不了目录 = 拿不到证据 = 按「无前置」处理（fail-closed，交由调用方给指引）
    return false;
  }
}

/**
 * 探测自举前置是否就绪。
 *
 * 顺序有意为之：技能未装 → 配置缺失 → cycle 目录缺失。前者是后两者的前提，
 * 报告最靠前的根因比报告一串下游症状更有用。
 */
export function checkBootstrapPreconditions(
  scriptsDir: string | null,
  cyclesDir: string,
): PreflightResult {
  if (!scriptsDir) {
    return {
      ok: false,
      code: 'SKILL_NOT_INSTALLED',
      message: 'skill scripts directory not resolved (ai-native-iteration-cycle not installed)',
      remedy: 'Run anic_install (or `npx dsh-anic init <project-dir>`) to install the skill, then retry.',
    };
  }
  if (!CONFIG_CANDIDATES.some((f) => existsSync(join(cyclesDir, f)))) {
    return {
      ok: false,
      code: 'CONFIG_MISSING',
      message: `no ${join('.cycles', 'config.yml')} found under ${cyclesDir}`,
      remedy: 'Run `node scripts/init-workflow.mjs <project-dir>`, then set build_cmd/test_cmd/lint_cmd in .cycles/config.yml.',
    };
  }
  if (!hasCycleDir(cyclesDir)) {
    return {
      ok: false,
      code: 'CYCLE_DIR_MISSING',
      message: `no cycle-N directory under ${join(cyclesDir, 'cycles')}`,
      remedy: 'Run `node scripts/init-cycle.mjs <project-dir>` to create the cycle directory before bootstrapping.',
    };
  }
  return { ok: true };
}
