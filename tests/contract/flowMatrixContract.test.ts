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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

const ROOT = process.cwd();

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
