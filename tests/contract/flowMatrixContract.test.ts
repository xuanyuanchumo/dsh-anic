/**
 * 流程归属矩阵契约（cycle-89）—— **生产 → 出口 → 消费**三段都必须通。
 *
 * ## 被守卫的缺口
 *
 * `flowJoin` / `coverageMetrics` 生产了归属数据，但此前：
 * - **没有路由暴露它**（`grep "flows/matrix" src/` 只命中注释）；
 * - **没有客户端消费者**（`grep coverageMetrics src/client/` 零命中）。
 *
 * 这就是典型的「生产了但没人消费」——用户点名的空心问题。
 *
 * ## 本契约钉死
 *
 * 1. 路由**真的注册**了（读源码文本，不靠「函数被调用过」这种间接证据）。
 * 2. 隔离 fail-closed：拿不到工作区 → 500，**绝不**返回全项目的流。
 * 3. 响应**裁剪**：不含 stdout/stderr（大字段不进量化条）。
 * 4. 客户端**门禁白名单校正**：`gate:'G3'` 但 script 是 `workflow-state` 的记录
 *    **不得**被计入 G3 证据。
 */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import {
  buildFlowMatrixForWorkspace,
  buildFlowMatrixView,
  toFlowSummary,
  type FlowSummary,
} from '../../src/host/flows/flowMatrixView.ts';
import type { FlowRecord } from '../../src/host/runtime/flowTracker.ts';
// 宿主侧门禁白名单（与客户端侧那份**独立声明**，靠本文件对账）。
import { GATE_SCRIPT_NAMES, coverageMetrics, isGateEvidence } from '../../src/host/flows/flowJoin.ts';
import {
  GATE_EVIDENCE_SCRIPTS,
  gateCoverageOf,
  gateEvidenceFlows,
  isFlowMatrix,
  isGateEvidenceScript,
  phaseCountsOf,
  attributionRateOf,
  orphanCountOf,
} from '../../src/client/features/flows/flowMatrixTypes.ts';
// cycle-96 WS-A：宏观相位漂移读数（宿主生产者 + 客户端四态裁决）。
import { buildMacroPhaseStatus } from '../../src/host/flows/macroPhaseStatusView.ts';
import { PHASE_IDS } from '../../src/host/flows/macroPhaseEngine.ts';
import { registerFlowsRoute } from '../../src/host/routes/flowsRoute.ts';
import { registerBuiltinFlows } from '../../src/host/flows/builtin.ts';
import { driftVerdictOf } from '../../src/client/features/flows/macroPhaseTypes.ts';

const ROOT = process.cwd();
const TMPS: string[] = [];
afterEach(() => {
  while (TMPS.length > 0) {
    const d = TMPS.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 并行竞态忽略 */ }
  }
});

/** 造一条 FlowRecord。 */
function rec(over: Partial<FlowRecord> = {}): FlowRecord {
  return {
    flowId: 'f-1',
    script: 'gate-check',
    workspace: 'D:\\ws-a',
    args: [],
    status: 'DONE',
    startedAt: '2026-10-30T00:00:00.000Z',
    ...over,
  };
}

describe('路由注册（生产 → 出口）', () => {
  it('**flowsRoute.ts 真的注册了 /anic/api/flows/matrix**', () => {
    const src = readFileSync(join(ROOT, 'src', 'host', 'routes', 'flowsRoute.ts'), 'utf-8');
    expect(src).toContain("reg('/anic/api/flows/matrix'");
  });

  it('路由**用 flowMatrixView 构造响应**（不是自己现算一份）', () => {
    const src = readFileSync(join(ROOT, 'src', 'host', 'routes', 'flowsRoute.ts'), 'utf-8');
    expect(src).toContain('buildFlowMatrixForWorkspace');
  });

  it('**拿不到工作区 → 500**（fail-closed，绝不返回全项目流）', () => {
    const src = readFileSync(join(ROOT, 'src', 'host', 'routes', 'flowsRoute.ts'), 'utf-8');
    expect(src).toMatch(/anic\/api\/flows\/matrix[\s\S]{0,400}?ANIC_ROUTE_NO_WORKSPACE/);
  });
});

describe('投影裁剪（响应体不含大字段）', () => {
  it('**摘要不含 stdout/stderr**', () => {
    const s = toFlowSummary(rec({ stdout: 'x'.repeat(8000), stderr: 'y'.repeat(4000) }));
    expect(s).not.toHaveProperty('stdout');
    expect(s).not.toHaveProperty('stderr');
  });

  it('摘要保留计数与归属字段', () => {
    const s: FlowSummary = toFlowSummary(rec({ cycle: 'cycle-89', phase: 'build', gate: 'G2', exitCode: 0, durationMs: 12 }));
    expect(s.cycle).toBe('cycle-89');
    expect(s.phase).toBe('build');
    expect(s.gate).toBe('G2');
    expect(s.exitCode).toBe(0);
    expect(s.durationMs).toBe(12);
  });

  it('**响应体整体不含 stdout 字段**', () => {
    const view = buildFlowMatrixView([rec({ stdout: 'SECRET-LOG' })], 'D:/ws-a');
    expect(JSON.stringify(view)).not.toContain('SECRET-LOG');
  });
});

describe('多项目隔离（投影层）', () => {
  it('**只保留目标工作区的记录**', () => {
    const records = [
      rec({ flowId: 'a', workspace: 'D:\\ws-a' }),
      rec({ flowId: 'b', workspace: 'D:\\ws-b' }),
    ];
    const view = buildFlowMatrixForWorkspace(records, 'D:/ws-a');
    expect(view.total).toBe(1);
    expect(view.workspace).toBe('D:/ws-a');
  });

  it('**工作区为 null → 空集合**（fail-closed，绝不返回全项目流）', () => {
    const records = [rec({ flowId: 'a', workspace: 'D:\\ws-a' })];
    const view = buildFlowMatrixForWorkspace(records, null);
    expect(view.total).toBe(0);
    expect(view.orphans).toHaveLength(0);
  });
});

describe('客户端门禁白名单校正（防线：证据不许假绿）', () => {
  it('**gate 字段存在但脚本不是门禁脚本 → 不算证据**', () => {
    const group = { key: 'G3', flows: [{ script: 'workflow-state', gate: 'G3' }] };
    expect(gateEvidenceFlows(group)).toHaveLength(0);
  });

  it('脚本是门禁脚本 → 算证据', () => {
    const group = { key: 'G3', flows: [{ script: 'gate-check', gate: 'G3' }] };
    expect(gateEvidenceFlows(group)).toHaveLength(1);
  });

  it('**gateCoverageOf 只列有真实证据的门**', () => {
    const view = {
      byGate: [
        { key: 'G3', flows: [{ script: 'workflow-state', gate: 'G3' }] },
        { key: 'G1', flows: [{ script: 'gate-check', gate: 'G1' }] },
      ],
    };
    const cov = gateCoverageOf(view);
    expect(cov.map((c) => c.gate)).toEqual(['G1']);
    expect(cov[0]?.flows).toBe(1);
  });

  it('isGateEvidenceScript 白名单', () => {
    expect(isGateEvidenceScript('gate-check')).toBe(true);
    expect(isGateEvidenceScript('hitl-audit')).toBe(true);
    expect(isGateEvidenceScript('workflow-state')).toBe(false);
    expect(isGateEvidenceScript('eval-runner')).toBe(false);
    expect(isGateEvidenceScript(undefined)).toBe(false);
  });
});

describe('客户端形状守卫与派生', () => {
  it('isFlowMatrix 接受有 metrics 或 byCycle 的对象', () => {
    expect(isFlowMatrix({ metrics: {} })).toBe(true);
    expect(isFlowMatrix({ byCycle: [] })).toBe(true);
    expect(isFlowMatrix({})).toBe(false);
    expect(isFlowMatrix(null)).toBe(false);
    expect(isFlowMatrix([])).toBe(false);
  });

  it('**缺字段 → null（不落 0）**：取不到 ≠ 零', () => {
    expect(attributionRateOf({})).toBeNull();
    expect(orphanCountOf({})).toBeNull();
  });

  it('有值时如实返回', () => {
    expect(attributionRateOf({ metrics: { attributionRate: 0.5 } })).toBe(0.5);
    expect(orphanCountOf({ metrics: { orphans: 7 } })).toBe(7);
  });

  it('六相分布只列有记录的相（按固定相序）', () => {
    const counts = phaseCountsOf({ metrics: { byPhase: { test: 3, plan: 1, build: 5 } } });
    expect(counts.map((c) => c.phase)).toEqual(['plan', 'build', 'test']);
  });
});

/*
 * ★两侧白名单的**对账**（同语义、两实现、测试对账）。
 *
 * 宿主侧判据在 `src/host/flows/flowGateSemantics.ts`（`GATE_SCRIPT_NAMES`），
 * 客户端侧在 `src/client/features/flows/flowMatrixTypes.ts`
 * （`GATE_EVIDENCE_SCRIPTS`）。两侧**必须各持一份**——客户端不能 import host
 * 侧模块（G-IND + host/client 两条独立发版链）。
 *
 * 但「各持一份」不等于「各行其是」：两份白名单若漂移（宿主加了新门禁脚本而
 * 客户端没加），就会出现「服务端算它有门禁证据、客户端把它从证据里滤掉」的
 * 口径分裂 —— 面板显示的门禁覆盖与宿主算的指标对不上，且**没有任何一侧会报错**。
 *
 * 本条断言把两份实现**钉成同一张表**：任一侧改动而另一侧没跟上 ⇒ 红。
 */
describe('宿主侧 / 客户端侧门禁白名单对账', () => {
  it('两份白名单取值完全一致（漂移即红）', () => {
    expect([...GATE_SCRIPT_NAMES].sort()).toEqual([...GATE_EVIDENCE_SCRIPTS].sort());
  });

  it('两份白名单对同一批脚本给出相同裁决', () => {
    const probe = ['gate-check', 'hitl-audit', 'workflow-state', 'eval-runner', 'init-cycle', 'quick-validate', 'org-status', '', undefined];
    for (const script of probe) {
      const hostSide = isGateEvidence({
        flowId: 'f', script: script ?? '', workspace: 'w', args: [], status: 'DONE', startedAt: 'x', gate: 'G3',
      });
      const clientSide = isGateEvidenceScript(script);
      expect(clientSide, '两侧对 ' + String(script) + ' 的裁决不一致').toBe(hostSide);
    }
  });

  it('反例钉死：gate 字段是 G3 但 script 是 workflow-state ⇒ 两侧都不认（证据不假绿）', () => {
    const record = {
      flowId: 'f', script: 'workflow-state', workspace: 'w', args: [],
      status: 'DONE' as const, startedAt: 'x', gate: 'G3',
      attribution: { at: 'x', source: 'workflow-state' as const },
    };
    expect(isGateEvidence(record)).toBe(false);
    expect(isGateEvidenceScript('workflow-state')).toBe(false);
    // 宿主侧指标：G3 不得有证据（这是「门禁证据覆盖永久假绿」的根因）
    const m = coverageMetrics([record]);
    expect(m.gateEvidence.find((e) => e.gate === 'G3')?.evidence).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* cycle-96 WS-A：宏观相位漂移读数（生产 → 出口 → 消费 三段）           */
/* ------------------------------------------------------------------ */

/**
 * 被守卫缺陷：同一概念（当前相位）存在两个口径 —— 宿主只读、技能脚本自行改写。
 * 修复分两条腿：
 *   生产：宿主 `statusMacroPhase` 补 `inferredPhase`/`drift`（**仍然不落盘**）；
 *   出口：`/anic/flows/status` 与 `/anic/flows/macro-phase/status` 同一生产者；
 *   消费：客户端 `driftVerdictOf` 把三值裁决成四态（consistent/drift/ceiling/unknown）。
 *
 * 为什么断言源码文本而不是只调函数：路由是「有没有出口」的唯一证据。
 * 生产了字段却没人出口，等于面板漆黑 —— 这正是本仓反复出现的空心问题。
 */
describe('宏观相位漂移读数（cycle-96 WS-A）', () => {
  const ROUTE_SRC = (): string => readFileSync(join(ROOT, 'src', 'host', 'routes', 'flowsRoute.ts'), 'utf-8');

  it('**出口不新增路由**：路由数不变，只扩既有响应体（objectiveConformanceContract ⑧ 硬断言 76）', () => {
    const src = ROUTE_SRC();
    const regs = src.match(/reg\('/g) ?? [];
    // 10 条既有路由（0zeroCoverageFiles.test.ts 的注册数同源）
    expect(regs).toHaveLength(10);
    expect(src).not.toContain("reg('/anic/flows/macro-phase/drift'");
  });

  it('**两个出口同一生产者**（不得各算一份口径）', () => {
    const src = ROUTE_SRC();
    // /anic/flows/status 的一站式响应里带上 macroPhase，且与专用端点同源。
    expect(src).toMatch(/macroPhase: root \? statusMacroPhase\(root\) : null/);
    expect(src).toContain('statusMacroPhase(root)');
  });

  it('**拿不到工作区 → macroPhase 为 null**（不伪造一个 plan）', () => {
    // 路由侧的口径：root 缺失时整片读数如实为 null（不是投影成 plan 默认态）。
    // 这里对「同一份磁盘事实」做直证：无状态文件 ⇒ 视图的相位三字段全 null。
    const view = buildMacroPhaseStatus('/nonexistent-root-xyz-b', null);
    expect(view.currentPhase).toBeNull();
    expect(view.inferredPhase).toBeNull();
    expect(view.drift).toBeNull();
    const src = ROUTE_SRC();
    expect(src).toMatch(/macroPhase: root \? statusMacroPhase\(root\) : null/);
  });

  it('生产侧：stored / inferred / drift 三字段齐全且 inferenceCeiling 如实', () => {
    const view = buildMacroPhaseStatus('/nonexistent-root-xyz-a', null);
    expect(view.currentPhase).toBeNull();
    expect(view.inferredPhase).toBeNull();
    // 无状态文件 ⇒ 无从比较 ⇒ null（不是 false —— false 会被画成「一致」）
    expect(view.drift).toBeNull();
    expect(view.inferenceCeiling).toBe('test');
    expect(view.wroteState).toBe(false);
    expect(view.projectionSeeded).toBe(false);
  });

  it('**同一概念三处读法全等**（宿主 PHASES / 客户端相序 / 技能脚本 PHASES 不得漂移）', () => {
    // 客户端独立声明相序（不能 import host），靠本断言对账 —— 漂移即红。
    const client = readFileSync(join(ROOT, 'src', 'client', 'features', 'flows', 'macroPhaseTypes.ts'), 'utf-8');
    const order = /const PHASE_ORDER = \[(.+?)\] as const/.exec(client)?.[1] ?? '';
    const ids = [...order.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    const hosted = PHASE_IDS;
    expect(ids).toEqual([...hosted]);
  });

  /*
   * 两个出口都不得写盘（cycle-96 WS-A 的端到端形态）。
   *
   * 为什么在契约里跑真路由而不只直测视图：路由层可以做任何事 —— 视图是只读的，
   * 但路由若在前后各补一次 `saveState`，缺陷照样存在。这条把「响应已生成」与
   * 「磁盘未变」绑在**同一次**调用里。
   */
  it('**两个只读端点跑完磁盘不变**（响应生成 ⟺ 磁盘零写入）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'anic-flows-readonly-'));
    TMPS.push(ws);
    mkdirSync(join(ws, '.cycles', 'cycles', 'cycle-1', 'test-reports'), { recursive: true });
    for (const f of ['项目评估报告.md', '当前循环总规划.md', '任务清单.md']) {
      writeFileSync(join(ws, '.cycles', 'cycles', 'cycle-1', f), 'x');
    }
    writeFileSync(join(ws, '.cycles', 'cycles', 'cycle-1', 'test-reports', 'r.md'), 'x');
    const statePath = join(ws, '.cycles', 'workflow-state.json');
    writeFileSync(statePath, JSON.stringify({
      currentPhase: 'plan', currentCycle: 'cycle-1', phaseHistory: [], nodeStatus: {},
      createdAt: 't', updatedAt: 't',
    }));
    const before = readFileSync(statePath, 'utf-8');

    const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
    const ctx = { webServer: { register: (r: { path: string; handler: (q: unknown, s: unknown) => unknown }) => { routes.set(r.path, r.handler); return () => {}; } } };
    registerFlowsRoute(ctx as never, () => {}, { getWorkspaceRoot: () => ws });
    const sink = { writeHead: () => {}, end: () => {} };
    // **必须 await 处理器返回的 Promise**：漏掉等于只测了「函数被调用」，
    // 而路由可以把写盘放进 async 体里 —— 那样观测照样会改状态（实测形态已踩到）。
    await Promise.resolve(routes.get('/anic/flows/status')!({}, sink));
    await Promise.resolve(routes.get('/anic/flows/macro-phase/status')!({}, sink));

    expect(readFileSync(statePath, 'utf-8'), '只读端点写了盘（观测改变被观察对象）').toBe(before);
  });
});

/**
 * 客户端裁决的四态（纯函数直测）：
 * 把 `ceiling` 混进 `drift` 会让用户去修一个正确的状态文件；
 * 把 `unknown` 混进 `consistent` 是把「没读到」画成「没问题」。
 */
describe('客户端 driftVerdictOf（四态裁决）', () => {
  it('一致 → consistent（且两值原样给出）', () => {
    const v = driftVerdictOf({ currentPhase: 'test', inferredPhase: 'test', drift: false });
    expect(v).toEqual({ kind: 'consistent', stored: 'test', inferred: 'test' });
  });

  it('分叉 → drift', () => {
    const v = driftVerdictOf({ currentPhase: 'plan', inferredPhase: 'test', drift: true });
    expect(v.kind).toBe('drift');
  });

  it('**推断到顶 → ceiling（不是 drift）**：deploy/maintain 没有工件指纹', () => {
    for (const stored of ['deploy', 'maintain']) {
      const v = driftVerdictOf({ currentPhase: stored, inferredPhase: 'test', drift: true, inferenceCeiling: 'test' });
      expect(v.kind, `${stored} 应判推断到顶而不是分叉`).toBe('ceiling');
    }
  });

  it('**无状态文件 → unknown（不是 consistent）**：没读到 ≠ 没问题', () => {
    expect(driftVerdictOf({ currentPhase: null, inferredPhase: null, drift: null }).kind).toBe('unknown');
    expect(driftVerdictOf(null).kind).toBe('unknown');
    // 旧宿主：字段整个缺失
    expect(driftVerdictOf({ currentPhase: 'plan' }).kind).toBe('unknown');
  });

  it('反向自检：把 ceiling 判据去掉就必须把 deploy 误报成 drift', () => {
    const beyond = driftVerdictOf({ currentPhase: 'deploy', inferredPhase: 'test', drift: true, inferenceCeiling: 'test' });
    expect(beyond.kind).toBe('ceiling');
    // 同一输入但 stored 在 ceiling 之前 ⇒ 真分叉（证明判别确实在按相序比）
    expect(driftVerdictOf({ currentPhase: 'build', inferredPhase: 'test', drift: true, inferenceCeiling: 'test' }).kind).toBe('drift');
  });
});

