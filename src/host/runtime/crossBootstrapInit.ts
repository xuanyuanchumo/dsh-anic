/**
 * 跨项目自举的 init 动作（cycle-101 拆分 · 「假装成功」缺陷修复）。
 *
 * ## 为什么拆出来
 *
 * crossBootstrapExecute.ts 已 269 行（T3 ≤250 守触线）；init 与 evaluate/gate-check
 * 是**不同的诚实性要求**：后两者跑脚本并读裁决，init 要证明「骨架真的写出来了」。
 * 一域一文件。
 *
 * ## 被修的缺陷（真机实测）
 *
 * 旧实现：`if (action === 'init') { mkdirSync(targetCyclesDir); return finish({}) }`
 * ——只建空目录就报 `ok: true`。调用方拿到 200，目标项目里却连 config.yml 都没有。
 * 比失败更坏：**让人以为自举成功了**。
 *
 * ## 现在的语义
 *
 * 1. 跑真正的 init-workflow（目标获得可独立运行的骨架）；
 * 2. 如实回报 `initOk` / `initExitCode` / `artifacts{config,intent,cycles}`；
 * 3. 脚本不可用 → **响亮失败**（412 + remedy），绝不静默 ok；
 * 4. windowsHide 必带（循环体不弹控制台窗口）。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';

/** init 执行结果（HTTP body 片段，由调用方并入统一响应）。 */
export interface CrossInitOutcome {
  /** 是否发生了响亮失败（脚本缺失）。 */
  failed: boolean;
  /** 402 失败体（failed=true 时使用）。 */
  failureBody?: { error: { code: string; message: string; remedy: string } };
  /** 成功时的诚实读数。 */
  extra?: Record<string, unknown>;
}

/** init 超时预算（骨架写入是本地 fs 操作，60s 足够宽裕）。 */
const INIT_TIMEOUT_MS = 60_000;

/**
 * 在目标工作区执行 init-workflow 并回报真实结果。
 *
 * @param targetRoot 目标项目根
 * @param targetCyclesDir 目标 `.cycles/` 绝对路径
 * @param scriptsDir init-workflow.mjs 所在目录（target 已装副本或 plugin 内联底座）
 */
export function runCrossInit(targetRoot: string, targetCyclesDir: string, scriptsDir: string): CrossInitOutcome {
  if (!existsSync(targetCyclesDir)) mkdirSync(targetCyclesDir, { recursive: true });
  const initScript = join(scriptsDir, 'init-workflow.mjs');
  if (!existsSync(initScript)) {
    return {
      failed: true,
      failureBody: {
        error: {
          code: 'ANIC_CROSS_INIT_SCRIPT_MISSING',
          message: `init-workflow.mjs not found under ${scriptsDir}`,
          remedy: '先在源项目安装技能（anic_install），或对目标安装后重试',
        },
      },
    };
  }
  const r = spawnSync(process.execPath, [initScript, targetRoot, '--name', basename(targetRoot)], {
    cwd: targetRoot,
    encoding: 'utf-8',
    timeout: INIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    failed: false,
    extra: {
      // 如实回报：脚本退出码 + 关键工件是否存在（不靠「我们调过脚本」推断成功）
      initExitCode: r.status ?? null,
      initStdout: (r.stdout ?? '').slice(0, 2000),
      initStderr: (r.stderr ?? '').slice(0, 2000),
      artifacts: {
        config: existsSync(join(targetCyclesDir, 'config.yml')),
        intent: existsSync(join(targetCyclesDir, 'intent')),
        cycles: existsSync(join(targetCyclesDir, 'cycles')),
      },
      initOk: (r.status ?? 1) === 0,
    },
  };
}
