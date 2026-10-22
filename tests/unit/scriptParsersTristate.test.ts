/**
 * scriptParsers 三态裁决契约（cycle-72 P0-SCRIPT-PARSER-TRISTATE）。
 *
 * 旧契约只有二值，把两类**完全不同的事实**塌缩成同一个值：
 *   - 「跑到了裁决，但没通过」 —— 真实质量失败，值得进技术债队列；
 *   - 「根本没跑成」 —— 环境问题（缺前置 / 维度名非法 / 输出不可识别），
 *     修代码毫无意义。
 * 两轮自举恒 0 分的根因正是后者被当成前者。
 *
 * 本文件钉四件事：
 *   ① 三态各自可达（passed / failed / not-run + 4 种 reason）；
 *   ② **薄包装 ⇄ 三态等价**（既有调用方零破坏的机器证明）；
 *   ③ fail-closed 不变（`not-run` 与 `failed` 都不得让 CONVERGED 成立）；
 *   ④ 可观测面可区分（HTTP 响应与磁盘提案里能看出两者差别）。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseEvalOutcome,
  parseGateOutcome,
  parseEvalScore,
  parseGateVerdict,
} from '../../src/host/runtime/scriptParsers.ts';
import { advanceBootstrap, initialBootstrapState } from '../../src/host/selfBootstrap.ts';
import { registerSelfBootstrapRoutes } from '../../src/host/routes/selfBootstrapRoute.ts';

/* ---------- 真实输出 fixture（逐字转录自 assets/skill/scripts/）---------- */

/** eval-runner 通过路径（eval-runner.mjs :665/:682）。 */
const EVAL_PASSED = { stdout: 'Evaluation report written to X\n\nAll 8 evaluated dimension(s) passed.\n', stderr: '' };
/** eval-runner 失败路径（:676）。 */
const EVAL_FAILED = { stdout: '', stderr: '\n2 dimension(s) failed: Q2, Q8\n' };
/** 缺前置（scripts/lib/config.mjs::configMissingError，exit 1）。 */
const CONFIG_MISSING = {
  stdout: '',
  stderr: 'No .cycles/config.yml found in /ws. Run "node scripts/init-workflow.mjs <project-dir>" first, then edit .cycles/config.yml with your project\'s build/test commands.\n',
};
/** 未知维度（eval-runner.mjs S-11 响亮失败，exit 1）。 */
const BAD_DIMS = { stdout: '', stderr: 'Unknown dimension(s): E9. Valid dimensions: E1, E2, E3, E4.\n' };
/** gate-check 通过（gate-check.mjs :228）。 */
const GATE_PASSED = { stdout: '[PASS] G0: ok\n[PASS] G1: ok\n\nAll gates PASSED.\n', stderr: '' };
/** gate-check 失败（:225）。 */
const GATE_FAILED = { stdout: '[FAIL] G0: no task list\n', stderr: '\nGate check FAILED. Fix issues before proceeding.\n' };

describe('parseEvalOutcome — 三态', () => {
  it('passed：全部维度通过', () => {
    expect(parseEvalOutcome(EVAL_PASSED)).toEqual({ state: 'passed' });
  });

  it('failed：有失败维度（真跑过、真没过）', () => {
    expect(parseEvalOutcome(EVAL_FAILED)).toEqual({ state: 'failed' });
  });

  it('not-run + CONFIG_MISSING：缺前置必须与「质量失败」分开', () => {
    const o = parseEvalOutcome(CONFIG_MISSING);
    expect(o.state).toBe('not-run');
    expect(o.reason).toBe('CONFIG_MISSING');
    expect(o.detail).toContain('No .cycles/config.yml');
  });

  it('not-run + BAD_DIMENSIONS：维度名非法是调用错误，不是质量结论', () => {
    const o = parseEvalOutcome(BAD_DIMS);
    expect(o.state).toBe('not-run');
    expect(o.reason).toBe('BAD_DIMENSIONS');
  });

  it('not-run + NO_RECOGNIZABLE_OUTPUT：有输出但无裁决行（脚本崩溃/被截断）', () => {
    const o = parseEvalOutcome({ stdout: 'random junk\n', stderr: '' });
    expect(o.state).toBe('not-run');
    expect(o.reason).toBe('NO_RECOGNIZABLE_OUTPUT');
  });

  it('判定顺序：缺配置时即使 stdout 残留通过行也报 not-run（不得读成 passed）', () => {
    // 部分运行会合并旧报告，stdout 可能含上一次的通过行；入口拒绝否定整次运行效力
    const o = parseEvalOutcome({
      stdout: 'All 8 evaluated dimension(s) passed.\n',
      stderr: CONFIG_MISSING.stderr,
    });
    expect(o.state).toBe('not-run');
    expect(o.reason).toBe('CONFIG_MISSING');
  });
});

describe('parseGateOutcome — 三态', () => {
  it('passed + verdict=PASS', () => {
    expect(parseGateOutcome(GATE_PASSED)).toEqual({ state: 'passed', verdict: 'PASS' });
  });

  it('failed + verdict=FAIL', () => {
    const o = parseGateOutcome(GATE_FAILED);
    expect(o.state).toBe('failed');
    expect(o.verdict).toBe('FAIL');
  });

  it('not-run：缺前置 → verdict=unknown + CONFIG_MISSING', () => {
    const o = parseGateOutcome(CONFIG_MISSING);
    expect(o.state).toBe('not-run');
    expect(o.reason).toBe('CONFIG_MISSING');
    expect(o.verdict).toBe('unknown');
  });

  it('not-run：无任何裁决行 → NO_RECOGNIZABLE_OUTPUT', () => {
    const o = parseGateOutcome({ stdout: 'nothing', stderr: '' });
    expect(o.state).toBe('not-run');
    expect(o.reason).toBe('NO_RECOGNIZABLE_OUTPUT');
  });

  it('部分门禁运行（无总裁决行）按逐门禁行判 PASS/FAIL，不降级为 not-run', () => {
    const o = parseGateOutcome({ stdout: '[PASS] G1: ok\n[PASS] G2: ok\n', stderr: '' });
    expect(o.state).toBe('passed');
    expect(o.verdict).toBe('PASS');
  });
});

describe('薄包装 ⇄ 三态等价（既有调用方零破坏的机器证明）', () => {
  const corpus = [
    EVAL_PASSED, EVAL_FAILED, CONFIG_MISSING, BAD_DIMS,
    { stdout: 'junk', stderr: '' }, { stdout: '', stderr: '' },
  ];

  it('parseEvalScore 恒等于 (state === "passed" ? 1 : 0)', () => {
    for (const c of corpus) {
      expect(parseEvalScore(c)).toBe(parseEvalOutcome(c).state === 'passed' ? 1 : 0);
    }
  });

  it('parseGateVerdict 恒等于 parseGateOutcome().verdict', () => {
    for (const c of [...corpus, GATE_PASSED, GATE_FAILED, { stdout: '[FAIL] G2: x\n', stderr: '' }]) {
      expect(parseGateVerdict(c)).toBe(parseGateOutcome(c).verdict);
    }
  });

  it('旧契约取值域不变：evalScore ∈ {0,1}，verdict ∈ {PASS,FAIL,unknown}', () => {
    for (const c of corpus) {
      expect([0, 1]).toContain(parseEvalScore(c));
      expect(['PASS', 'FAIL', 'unknown']).toContain(parseGateVerdict(c));
    }
  });
});

describe('fail-closed 不变：not-run 绝不参与 CONVERGED', () => {
  it('not-run 映射出的 verdict（unknown）不推进收敛', () => {
    const notRunVerdict = parseGateOutcome(CONFIG_MISSING).verdict;
    const state = advanceBootstrap(initialBootstrapState(3), parseEvalScore(CONFIG_MISSING), notRunVerdict, null);
    expect(state.status).not.toBe('CONVERGED');
  });

  it('failed 同样不推进收敛（三态只增可辨识度，不改裁决语义）', () => {
    const state = advanceBootstrap(initialBootstrapState(3), parseEvalScore(EVAL_FAILED), parseGateVerdict(GATE_FAILED), null);
    expect(state.status).not.toBe('CONVERGED');
  });

  it('仅 passed + PASS 才收敛（正向对照，证明上两条不是因为状态机恒假）', () => {
    const state = advanceBootstrap(initialBootstrapState(3), parseEvalScore(EVAL_PASSED), parseGateVerdict(GATE_PASSED), null);
    expect(state.status).toBe('CONVERGED');
  });
});

/* ---------- 可观测面：HTTP 响应与磁盘提案可区分 ---------- */

let TMP: string;
let WS: string;
const CLEANUP: string[] = [];

function makeRes() {
  const captured: { status?: number; body?: unknown } = {};
  return {
    captured,
    res: {
      writeHead(s: number) { captured.status = s; },
      setHeader() { /* noop */ },
      end(chunk?: unknown) { if (typeof chunk === 'string') { try { captured.body = JSON.parse(chunk); } catch { captured.body = chunk; } } },
    },
  };
}
const sendFn = (res: unknown, code: number, body: unknown): void => {
  const r = res as { writeHead(s: number): void; end(c?: unknown): void };
  r.writeHead(code); r.end(JSON.stringify(body));
};

/** 建工作区 + 前置 + 指定行为的假脚本（无输出 = 模拟 not-run）。 */
function makeWs(name: string, evalBody: string, gateBody: string): string {
  const ws = mkdtempSync(join(tmpdir(), name));
  CLEANUP.push(ws);
  mkdirSync(join(ws, '.cycles', 'cycles', 'cycle-1'), { recursive: true });
  writeFileSync(join(ws, '.cycles', 'config.yml'), 'test_cmd: "echo ok"\n', 'utf8');
  const scriptsDir = join(ws, '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, 'init-workflow.mjs'), '// sentinel\n', 'utf8');
  writeFileSync(join(scriptsDir, 'eval-runner.mjs'), evalBody, 'utf8');
  writeFileSync(join(scriptsDir, 'gate-check.mjs'), gateBody, 'utf8');
  return ws;
}

function makeCtx(ws: string) {
  const routes = new Map<string, (req: unknown, res: unknown) => void>();
  return {
    routes,
    ctx: {
      webServer: { register(r: { path: string; handler: (q: unknown, s: unknown) => void }) { routes.set(r.path, r.handler); return () => {}; } },
      workspaceRegistry: { list: () => [{ path: ws }] },
    },
  };
}

const flush = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), 'tri-state-')); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); while (CLEANUP.length) rmSync(CLEANUP.pop()!, { recursive: true, force: true }); });

describe('可观测面：not-run 与 failed 在响应与磁盘上可区分', () => {
  it('not-run（eval 无输出）→ 响应 outcome=not-run/reason，且**不产** 0 分提案', async () => {
    // 退出 0 但零输出 = 脚本未走到裁决点 → not-run(NO_RECOGNIZABLE_OUTPUT)
    const ws = makeWs('tri-notrun', 'process.exit(0);', `process.stderr.write('Gate check FAILED.\\n');process.exit(1);`);
    const { ctx, routes } = makeCtx(ws);
    registerSelfBootstrapRoutes(ctx as never, sendFn);
    const { captured, res } = makeRes();
    routes.get('/anic/self/iterate')!({ body: { maxRounds: 1 } }, res);
    await flush();

    expect(captured.status).toBe(200);
    const body = captured.body as Record<string, unknown>;
    expect(body.notRun).toBe(true);
    expect((body.evalOutcome as { state?: string }).state).toBe('not-run');
    expect((body.evalOutcome as { reason?: string }).reason).toBe('NO_RECOGNIZABLE_OUTPUT');
    // 核心：未跑成不得写成 0 分提案（旧缺陷的可见症状）
    expect(body.techDebtProposals).toEqual([]);
    expect(body.fixApplied).toBeNull();
    expect(existsSync(join(ws, '.cycles', 'tech-debt'))).toBe(false);
  });

  it('failed（eval 有失败维度 + gate FAIL）→ 产提案且提案内含三态字段', async () => {
    const ws = makeWs('tri-failed',
      `process.stderr.write('\\n2 dimension(s) failed: Q2, Q8\\n');process.exit(1);`,
      `process.stderr.write('Gate check FAILED.\\n');process.exit(1);`);
    const { ctx, routes } = makeCtx(ws);
    registerSelfBootstrapRoutes(ctx as never, sendFn);
    const { captured, res } = makeRes();
    routes.get('/anic/self/iterate')!({ body: { maxRounds: 1 } }, res);
    await flush(90);

    expect(captured.status).toBe(200);
    const body = captured.body as Record<string, unknown>;
    expect(body.notRun).toBe(false);
    expect((body.evalOutcome as { state?: string }).state).toBe('failed');
    expect((body.gateOutcome as { state?: string }).state).toBe('failed');
    // 真失败才产提案
    expect(body.techDebtProposals).toEqual(['tech-debt/self-bootstrap-round-1.json']);
    const proposal = JSON.parse(readFileSync(
      join(ws, '.cycles', 'tech-debt', 'self-bootstrap-round-1.json'), 'utf8',
    )) as { evalOutcome?: { state?: string }; gateOutcome?: { state?: string } };
    // 磁盘证据同样可分辨（不只响应体）
    expect(proposal.evalOutcome?.state).toBe('failed');
    expect(proposal.gateOutcome?.state).toBe('failed');
  });
});
