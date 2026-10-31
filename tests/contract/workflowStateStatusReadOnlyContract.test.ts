/**
 * 查询命令只读化契约（cycle-96 WS-A P0）—— **观测不得改变被观察对象**。
 *
 * ## 被守卫缺陷（Lead 已用干净复现证明，非推断）
 *
 * ```
 * 强制把 .cycles/workflow-state.json 的 currentPhase 置为 plan
 * → 跑 node assets/skill/scripts/workflow-state.mjs <ws> status
 * → 磁盘上变成了 test
 * ```
 *
 * 根因：`cmdStatus` 里 `inferPhase(artifacts)` 的结果被**静默写回** `currentPhase`
 * 并 `saveState`。于是「查一次状态」改掉了被观察的状态。
 *
 * 本仓宿主侧早有共识（`flows/macroPhaseStatusView.ts` 头注：不落盘、不执行
 * inferPhase 回写），只是脚本侧没跟上 —— 本轮让脚本对齐宿主，不是让宿主放宽。
 *
 * ## 四条判据（每条都可机器证伪）
 *
 * ① **只读**：`status` / `check` 跑完之后，状态文件**字节完全不变**（含 mtime 语义外的
 *    内容一致性）。这条是本任务的核心守卫 —— 实现一旦回退成写盘，立刻红。
 * ② **反向自检**：上面那条若恒绿则等于没测。故先证明「漂移夹具真的漂移」
 *    （stored=plan 而工件推断=test），并证明 **advance 确实会写盘** ——
 *    两相对照才说明「不写盘」是查询命令的**性质**，不是文件系统哑了。
 * ③ **分叉可见**：`status` 必须同时显示 stored 与 inferred 并标 drift；
 *    `--json` 必须给 `{stored, inferred, drift}` 三字段。
 * ④ **无状态文件时不创世**：旧实现缺文件即 `saveState` —— 查询行为篡改了
 *    「该文件从未存在」这个事实。
 *
 * 测试策略：对**真脚本**黑盒驱动（execFileSync），不重实现判据 ——
 * 这不是「测我自己写的函数」，是「测用户实际会跑的那条命令」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * 用**发行源**（`assets/skill/scripts/`）而不是安装副本。
 *
 * 为什么：`assets/skill/**` 是发行源，`.dsh/skills/**` 是 live 副本，两者由
 * skillIntegrity 校验同步。本轮回写纪律修在发行源；用发行源驱动才能在本工作区
 * （尚未重新安装副本的时刻）就先证明修复成立。双轨同步由 Lead 用 skill_repair 收口。
 */
const SCRIPT = resolve(import.meta.dirname, '../../assets/skill/scripts/workflow-state.mjs');

let root = '';
const statePath = (): string => join(root, '.cycles', 'workflow-state.json');
const cycleDir = (): string => join(root, '.cycles', 'cycles', 'cycle-1');

/** 跑脚本，返回 {code, out, err}（不抛：非零退出也是被测行为）。 */
function run(command: string, extra: string[] = []): { code: number; out: string; err: string } {
  try {
    const out = execFileSync('node', [SCRIPT, root, command, ...extra], { encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, out, err: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: err.stdout ?? '', err: err.stderr ?? '' };
  }
}

/** 完整工件集（inferPhase 判据：eval+plan+tasks+非空 testReports ⇒ 推断 test）。 */
function seedArtifactsToTest(): void {
  mkdirSync(join(cycleDir(), 'test-reports'), { recursive: true });
  for (const f of ['项目评估报告.md', '当前循环总规划.md', '任务清单.md']) {
    writeFileSync(join(cycleDir(), f), 'x');
  }
  writeFileSync(join(cycleDir(), 'test-reports', 'report.md'), 'x');
}

/** 造状态文件（原样序列化，便于逐字节比对）。 */
function seedState(currentPhase: string): void {
  mkdirSync(join(root, '.cycles'), { recursive: true });
  writeFileSync(statePath(), JSON.stringify({
    currentPhase, currentCycle: 'cycle-1', phaseHistory: [], nodeStatus: {},
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }));
}

/** 门禁账本（G0/G1/G2 全 PASS，让 advance 可推进）。 */
function seedLedger(gates: string[]): void {
  mkdirSync(join(root, '.cycles', 'gates'), { recursive: true });
  writeFileSync(join(root, '.cycles', 'gates', 'ledger.json'), JSON.stringify({
    entries: gates.map((g, i) => ({
      gate: g, gateName: g, result: 'PASS', detail: 'd', timestamp: `t${i}`, previousHash: '', hash: `h${i}`,
    })),
    chainHead: 'h',
  }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anic-ws-readonly-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('① 只读：查询命令跑完，状态文件字节不变（核心守卫）', () => {
  it('**漂移夹具（stored=plan / inferred=test）+ status → 磁盘仍是 plan**', () => {
    seedArtifactsToTest();
    seedState('plan');
    const before = readFileSync(statePath(), 'utf-8');
    const r = run('status');
    expect(r.code).toBe(0);
    // 逐字节相等 —— 不只比 currentPhase：旧实现同时改 updatedAt，
    // 只断言相位字段会让「时间戳仍被写」的回归漏网。
    expect(readFileSync(statePath(), 'utf-8')).toBe(before);
    // 漂移确实存在（否则本用例退化成「一致时当然不变」的空转）
    expect(r.out).toContain('stored: plan / inferred: test');
  });

  it('**check 同样是查询：漂移夹具跑 check → 磁盘不变**', () => {
    seedArtifactsToTest();
    seedState('plan');
    const before = readFileSync(statePath(), 'utf-8');
    run('check');
    expect(readFileSync(statePath(), 'utf-8')).toBe(before);
  });

  it('**多次 status（幂等观测）→ 首次之后仍逐字节不变**（观测不累积副作用）', () => {
    seedArtifactsToTest();
    seedState('plan');
    const before = readFileSync(statePath(), 'utf-8');
    run('status');
    run('status');
    run('status');
    expect(readFileSync(statePath(), 'utf-8')).toBe(before);
  });
});

describe('② 反向自检：证明「不写盘」是查询的性质，不是文件系统哑了', () => {
  it('对照：**advance 确实会写盘**（写者存在 ⇒ ① 的绿灯有意义）', () => {
    seedArtifactsToTest();
    seedState('plan');
    seedLedger(['G0']);
    const before = readFileSync(statePath(), 'utf-8');
    const r = run('advance');
    expect(r.code).toBe(0);
    const after = JSON.parse(readFileSync(statePath(), 'utf-8')) as { currentPhase: string };
    expect(after.currentPhase).toBe('design');
    expect(readFileSync(statePath(), 'utf-8')).not.toBe(before);
    expect(r.out).toContain('Advanced from Plan（规划） to Design（设计）');
  });

  it('对照：**漂移夹具本身是真的漂移**（stored≠inferred），否则 ① 空转', () => {
    const r = run('status');
    seedArtifactsToTest();
    seedState('plan');
    const r2 = run('status');
    expect(r2.out).toContain('drift');
    // 无工件时推断 = plan，与 stored 一致 ⇒ 不标 drift（反证「drift 恒报」不成立）
    expect(r.out).not.toContain('drift');
  });
});

describe('③ 分叉可见：谁说了算必须是可读事实', () => {
  it('一致形态：照印两值（证明推断跑过，而不是省掉了没显示）', () => {
    seedArtifactsToTest();
    seedState('test');
    const r = run('status');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Current Phase: Test（测试） (stored: test / inferred: test)');
    expect(r.out).not.toContain('drift');
  });

  it('分叉形态：同时显示 stored 与 inferred + drift 行 + 可操作出路', () => {
    seedArtifactsToTest();
    seedState('plan');
    const r = run('status');
    expect(r.out).toContain('Current Phase: Plan（规划） (stored: plan / inferred: test)');
    expect(r.out).toContain('drift: 相位推断不一致');
    // 出路必须点名：查询不写盘 ⇒ 要以前者为准只能显式 advance
    expect(r.out).toContain('advance --node test');
  });

  it('--json：{stored, inferred, drift} 三字段机器可读', () => {
    seedArtifactsToTest();
    seedState('plan');
    const r = run('status', ['--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out) as { stored: string; inferred: string; drift: boolean; artifacts: Record<string, boolean> };
    expect(body.stored).toBe('plan');
    expect(body.inferred).toBe('test');
    expect(body.drift).toBe(true);
    expect(body.artifacts['testReports']).toBe(true);
  });

  it('--json 一致形态：drift=false（不是缺字段）', () => {
    seedArtifactsToTest();
    seedState('test');
    const r = run('status', ['--json']);
    const body = JSON.parse(r.out) as { drift: boolean };
    expect(body.drift).toBe(false);
  });

  it('反向：--json 用在 advance 上是**用法错误**（不得静默忽略）', () => {
    seedState('plan');
    const r = run('advance', ['--json']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--json 只适用于 status');
    // 而且真的没推进（用法错误零副作用）
    const after = JSON.parse(readFileSync(statePath(), 'utf-8')) as { currentPhase: string };
    expect(after.currentPhase).toBe('plan');
  });
});

describe('④ 无状态文件时不创世（查询不产生新事实）', () => {
  it('**全新目录 + status → .cycles/ 不得被创建**', () => {
    expect(existsSync(join(root, '.cycles'))).toBe(false);
    const r = run('status');
    expect(r.code).toBe(0);
    expect(existsSync(statePath())).toBe(false);
    expect(existsSync(join(root, '.cycles'))).toBe(false);
    // 如实说「文件缺失」而不是把内存缺省当磁盘事实
    expect(r.out).toContain('state file: absent');
  });

  it('**全新目录 + check → 同样不创建**', () => {
    run('check');
    expect(existsSync(join(root, '.cycles'))).toBe(false);
  });

  it('反向：无状态文件时 advance **仍会创建**（写者职责不变）', () => {
    seedLedger(['G0']);
    const r = run('advance');
    expect(r.code).toBe(0);
    expect(existsSync(statePath())).toBe(true);
    expect(JSON.parse(readFileSync(statePath(), 'utf-8'))).toMatchObject({ currentPhase: 'design' });
  });
});

describe('⑤ 手改出来的非法相位不得让查询崩掉', () => {
  it('currentPhase="limbo" → status 退出 0 且原样回显', () => {
    seedState('limbo');
    const r = run('status');
    expect(r.code).toBe(0);
    expect(r.out).toContain('limbo');
  });

  it('currentPhase="limbo" → check 退出 0 并报 PHASE_VALID WARN（不抛）', () => {
    seedState('limbo');
    const r = run('check');
    expect(r.code).toBe(0);
    expect(r.out).toContain('[WARN] PHASE_VALID');
  });
});

describe('⑥ 脚本目录卫生（技能包完整性哨兵）', () => {
  it('**加速写前后 scripts/ 不含幽灵目录**（位置参数从不被当成路径创建）', () => {
    seedState('plan');
    run('status');
    const phantom = readdirSync(resolve(import.meta.dirname, '../../assets/skill/scripts'))
      .filter((n) => n.includes('project-dir') || n === '--json');
    expect(phantom).toEqual([]);
  });
});
