/**
 * 异步技能脚本调用（P1-EXEC-SIGNAL / P1-EVENT-LOOP，cycle-16）。
 *
 * 为什么要异步版：官方 adding-a-tool.md 契约「**遵守 exec.signal** — 信号触发时
 * 取消进行中的工作」。工具 execute 侧持有宿主传入的 AbortSignal；spawnSync 是
 * 同步阻塞（60-120s 脚本会冻结宿主事件循环——所有会话 + UI 一起卡死），且无法
 * 中途响应取消。本实现：
 *  - async spawn（事件循环不阻塞，与官方 shell/subprocess 全异步先例一致）；
 *  - 三路终止：exec.signal（用户取消，语义上不是 timedOut 而是 aborted）、
 *    timeoutMs（既有语义不变）、进程自然退出；
 *  - stdout/stderr 全量收集后仍按 InvokeResult 形状返回（调用方零改动）；
 *  - signal 已 abort 时立即 kill 子进程并 settle（绝不悬挂）。
 *
 * 从 skillInvoker.ts 拆出（T3 ≤250 行纪律；同步版与白名单留在原文件）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 调用结果形状（Q5 断环）：类型单一实现在此文件；同步版（skillInvoker.ts）
 * 与本文件之间不得再有任何跨文件 import 边——静态 import 图扫描器
 * （assets/skill/scripts/lib/importGraph.mjs 的 IMPORT_RE）匹配源文本里的
 * from-字符串字面量，注释里写带引号的相对路径会被当成真实边。本注释故意的
 * 不含可匹配的字面量。
 */
export interface InvokeResult {
  script: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 异步路径：exec.signal 触发的取消（区别于超时；同步路径无此字段）。 */
  aborted?: boolean;
  durationMs: number;
}

export interface InvokeOptions {
  /** 宿主 exec.signal（或任意 AbortSignal）；触发即 kill 子进程。 */
  signal?: AbortSignal;
}

export async function invokeSkillScriptAsync(
  scriptsDir: string,
  script: string,
  args: string[] = [],
  workspace: string,
  timeoutMs = 30000,
  options?: InvokeOptions,
): Promise<InvokeResult> {
  const scriptPath = path.join(scriptsDir, `${script}.mjs`);
  const start = Date.now();

  if (!fs.existsSync(scriptPath)) {
    return {
      script,
      exitCode: -1,
      stdout: '',
      stderr: `Script not found: ${scriptPath}`,
      timedOut: false,
      durationMs: Date.now() - start,
    };
  }

  return await new Promise<InvokeResult>((resolve) => {
    const child = spawn('node', [scriptPath, workspace, ...args], {
      cwd: scriptsDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, Math.min(timeoutMs, 120000));

    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGTERM');
    };
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        script,
        exitCode: status ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        timedOut,
        // 用户取消经 aborted 字段如实上报（exitCode = signal kill 的 null → -1）
        ...(aborted ? { aborted: true } : {}),
        durationMs: Date.now() - start,
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });
    child.on('close', (status) => finish(status));
    child.on('error', (err) => {
      stderrChunks.push(Buffer.from(`spawn error: ${err.message}`, 'utf-8'));
      finish(null);
    });
  });
}
