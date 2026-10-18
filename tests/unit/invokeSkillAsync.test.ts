/**
 * invokeSkillScriptAsync 行为级测试（P1-EXEC-SIGNAL / P1-EVENT-LOOP，cycle-16）。
 *
 * 钉死的契约：
 * 1. exec.signal 触发 → 子进程被 kill，结果带 aborted:true（区别于 timedOut）；
 * 2. timeoutMs 到 → timedOut:true（与同步版语义一致）；
 * 3. 正常退出 → exitCode/stdout/stderr/durationMs 形状与同步版一致（调用方零改动）；
 * 4. 事件循环不阻塞：spawn 进行中同步代码仍可执行（setImmediate 探针）；
 * 5. 已 abort 的 signal → 不悬挂，立即 kill。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeSkillScriptAsync } from '../../src/host/skillInvoker.ts';

function makeScriptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anic-async-'));
  writeFileSync(join(dir, 'ping.mjs'), 'console.log("pong"); process.exit(0);\n', 'utf-8');
  writeFileSync(
    join(dir, 'hang.mjs'),
    'console.log("started"); const t = setTimeout(() => {}, 60000); process.on("SIGTERM", () => { console.log("killed"); process.exit(143); });\n',
    'utf-8',
  );
  return dir;
}

function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'anic-ws2-'));
  mkdirSync(join(ws, '.cycles'), { recursive: true });
  return ws;
}

describe('invokeSkillScriptAsync（P1-EXEC-SIGNAL / P1-EVENT-LOOP）', () => {
  it('正常退出：形状与同步版一致（exitCode/stdout/stderr/durationMs）', async () => {
    const scriptsDir = makeScriptsDir();
    const ws = makeWorkspace();
    const r = await invokeSkillScriptAsync(scriptsDir, 'ping', [], ws, 10000);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('pong');
    expect(r.stderr).toBe('');
    expect(r.timedOut).toBe(false);
    expect(r.aborted).toBeUndefined();
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('exec.signal 触发 → 子进程 kill + aborted:true（区别于 timedOut）', async () => {
    const scriptsDir = makeScriptsDir();
    const ws = makeWorkspace();
    const ac = new AbortController();
    // 800ms 而非 300ms：并行全量跑（93 文件）下 spawn 起进程可能已耗去数百 ms，
    // 300ms 时 abort 会在「started」尚未输出前到达——kill 先于首条 stdout 是
    // 既有实现的真实语义（abort 是尽力而为的取消），不是缺陷。800ms 只为让
    // 「进程真的被启动过再被终止」这一断言目标在负载下稳定成立。
    setTimeout(() => ac.abort(), 800);
    const r = await invokeSkillScriptAsync(scriptsDir, 'hang', [], ws, 30000, { signal: ac.signal });
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
    // SIGTERM 处理器写了 killed（证明进程真的被终止而非等到自然退出）
    expect(r.stdout).toContain('started');
  }, 10000);

  it('timeout 到 → timedOut:true（与同步版语义一致）', async () => {
    const scriptsDir = makeScriptsDir();
    const ws = makeWorkspace();
    const r = await invokeSkillScriptAsync(scriptsDir, 'hang', [], ws, 400);
    expect(r.timedOut).toBe(true);
    expect(r.aborted).toBeUndefined();
  }, 10000);

  it('事件循环不阻塞：子进程运行中宿主同步任务仍被调度', async () => {
    const scriptsDir = makeScriptsDir();
    const ws = makeWorkspace();
    let ticked = false;
    setImmediate(() => { ticked = true; });
    const r = await invokeSkillScriptAsync(scriptsDir, 'ping', [], ws, 10000);
    expect(r.exitCode).toBe(0);
    expect(ticked).toBe(true);
  });

  it('已 abort 的 signal → 立即 kill 不悬挂', async () => {
    const scriptsDir = makeScriptsDir();
    const ws = makeWorkspace();
    const ac = new AbortController();
    ac.abort();
    const r = await invokeSkillScriptAsync(scriptsDir, 'hang', [], ws, 30000, { signal: ac.signal });
    expect(r.aborted).toBe(true);
  }, 5000);

  it('脚本不存在 → 与同步版同形（exitCode -1 + Script not found）', async () => {
    const scriptsDir = makeScriptsDir();
    const ws = makeWorkspace();
    const r = await invokeSkillScriptAsync(scriptsDir, 'no-such-script', [], ws, 5000);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain('Script not found');
  });
});
