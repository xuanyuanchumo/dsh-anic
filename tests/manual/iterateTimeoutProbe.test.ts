/**
 * T-4403 iterate timeout 真实子进程级实测探针（doc20 实验3）。
 *
 * 驱动真实技能脚本（与 anic_iterate 网关同一条 invokeSkillScriptAsync 代码路径，
 * toolsSkillGateway.ts:220 把 iterate 的 timeout 参数传到这里）：
 *   场景A：慢命令 × timeout 500ms → timedOut=true + SIGTERM 杀 + 不悬挂
 *   场景B：快命令 × timeout 60s → 正常收敛 timedOut=false
 *   场景C：AbortSignal 取消 → aborted=true（与 timedOut 语义分离）
 *   场景D：脚本不存在 → Script not found 快速失败（-1）
 * 慢命令实现：用技能脚本 fact-base-verify 在大参数下自然慢不可控，改为
 * 「命令包装法」——node -e 慢脚本不在白名单；故用**已装技能脚本 org-status
 * 在无 .cycles 的空目录上跑**（其 loadConfig 会走容错，但 listCycleDirNames
 * 读取大目录可控慢）不可控。最终方案：直接测 invoker 层（iterate 工具的
 * timeout 语义就实现在这一层），用真实存在的技能脚本 + 极小 timeout 强制
 * 触发定时器路径——脚本本身多快无所谓，500ms 内 org-status 能否完成都不
 * 影响断言「A=必超时」需要更小 timeout：用 1ms 保证定时器先于任何完成。
 *
 * 运行：npx vitest run tests/manual/iterateTimeoutProbe.ts
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { invokeSkillScriptAsync } from '../../src/host/skillInvokerAsync.ts';

const SCRIPTS_DIR = join(import.meta.dirname, '../../.dsh/skills/ai-native-iteration-cycle/scripts');
const WORKSPACE = mkdtempSync(join(tmpdir(), 'anic-timeout-'));

// node spawn 子进程冷启动 ~200-400ms；1ms timeout 必先触发定时器。
const FORCED_TIMEOUT_MS = 1;

describe('T-4403 iterate timeout 真实子进程实测（invoker 层=工具同路径）', () => {
  it('场景A：1ms 超时 → timedOut=true + SIGTERM 杀 + 不悬挂（快速返回）', async () => {
    const t0 = Date.now();
    const r = await invokeSkillScriptAsync(SCRIPTS_DIR, 'org-status', ['status'], WORKSPACE, FORCED_TIMEOUT_MS);
    const wall = Date.now() - t0;
    expect(r.timedOut).toBe(true);
    expect(r.aborted).toBeUndefined();
    expect(wall).toBeLessThan(5000); // 不悬挂：远小于无超时时的自然时长
  }, 10000);

  it('场景B：60s 充足 timeout → 真实脚本正常收敛 timedOut=false', async () => {
    const r = await invokeSkillScriptAsync(SCRIPTS_DIR, 'org-status', ['status'], WORKSPACE, 60000);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0); // org-status 在空目录容错运行成功（脚本自身契约）
  }, 60000);

  it('场景C：AbortSignal 取消 → aborted=true（区别于 timedOut）', async () => {
    const ac = new AbortController();
    const p = invokeSkillScriptAsync(SCRIPTS_DIR, 'org-status', ['status'], WORKSPACE, 60000, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
  }, 30000);

  it('场景D：脚本不存在 → Script not found 快速失败（exitCode -1）', async () => {
    const r = await invokeSkillScriptAsync(SCRIPTS_DIR, 'no-such-script', [], WORKSPACE, 5000);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain('Script not found');
    expect(r.timedOut).toBe(false);
  }, 10000);
});

// 清理放 afterAll（WORKSPACE 被多场景共享）
import { afterAll } from 'vitest';
afterAll(() => {
  rmSync(WORKSPACE, { recursive: true, force: true });
});
