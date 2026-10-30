/**
 * flowJoin 契约测试（cycle-89 WP-D P0）：流程 ↔ cycle/phase/gate join key 与量化覆盖率。
 *
 * 钉死四件事：
 *  1. 三维分组与确定性排序（同一输入永远同一输出，面板/快照可断言）；
 *  2. 归属严格口径：只有 attribution.source 能自证，字段孤立出现仍算孤儿（不编造）；
 *  3. 量化指标口径：attributionRate 4 位小数、0 条记录不是 NaN、门禁证据全集齐全；
 *  4. 多项目隔离：filterByWorkspace 空工作区 fail-closed（返回空集而非全量）。
 *
 * 反例（本文件主动防的错）：把 `cycle` 字段当归属、把孤儿按 startedAt 回填当期
 * 循环、拿账本链首当现行门禁、工作区没传就把所有项目的流倒出去。
 */
import { describe, expect, it } from 'vitest';
import {
  GATE_SCRIPT_NAMES,
  JOIN_GATE_IDS,
  JOIN_PHASE_ORDER,
  attributionSourceOf,
  coverageMetrics,
  filterByWorkspace,
  isAttributed,
  isGateEvidence,
  joinFlows,
  normalizeWorkspace,
  sameWorkspace,
} from '../../src/host/flows/flowJoin.ts';
import type { FlowRecord } from '../../src/host/runtime/flowTracker.ts';

let seq = 0;
/** 造一条记录：只填测试关心的字段，其余给稳定缺省。 */
function rec(over: Partial<FlowRecord> = {}): FlowRecord {
  seq += 1;
  return {
    flowId: `flow-${seq}`,
    script: 'gate-check',
    workspace: 'D:/ws/a',
    args: [],
    status: 'DONE',
    startedAt: '2026-10-30T00:00:00.000Z',
    ...over,
  };
}

/** 已归属记录：source + 三字段齐全。 */
function attributed(cycle: string, phase: string, gate: string, over: Partial<FlowRecord> = {}): FlowRecord {
  return rec({ cycle, phase, gate, attribution: { at: '2026-10-30T00:00:00.000Z', source: 'workflow-state' }, ...over });
}

describe('旧记录向后兼容（cycle-88 及更早无 join 字段）', () => {
  it('无 cycle/phase/gate/attribution 的旧记录照常可读、被计为孤儿', () => {
    const legacy = rec();
    expect(legacy.cycle).toBeUndefined();
    expect(attributionSourceOf(legacy)).toBe('none');
    expect(isAttributed(legacy)).toBe(false);
    const m = coverageMetrics([legacy]);
    expect(m.total).toBe(1);
    expect(m.attributed).toBe(0);
    expect(m.orphans).toBe(1);
    expect(m.attributionRate).toBe(0);
  });

  it('只有 cycle 字段、没有 attribution 的记录**不算**归属（严格口径：字段不能自证）', () => {
    const sneaky = rec({ cycle: 'cycle-89', phase: 'build', gate: 'G2' });
    expect(isAttributed(sneaky)).toBe(false);
    expect(coverageMetrics([sneaky]).orphans).toBe(1);
  });

  it('attribution.source 非法值归一为 none', () => {
    const bad = rec({ cycle: 'cycle-1', attribution: { at: 'x', source: 'invented' as never } });
    expect(attributionSourceOf(bad)).toBe('none');
    expect(isAttributed(bad)).toBe(false);
  });

  it('source 合法但三维字段全缺 → 仍是孤儿（找不到归属别硬贴）', () => {
    const empty = rec({ attribution: { at: 'x', source: 'workflow-state' } });
    expect(isAttributed(empty)).toBe(false);
  });
});

describe('joinFlows 三维聚合', () => {
  it('按 cycle/phase/gate 正确分组并统计状态', () => {
    const records = [
      attributed('cycle-89', 'build', 'G2'),
      attributed('cycle-89', 'build', 'G2', { status: 'FAILED' }),
      attributed('cycle-88', 'test', 'G1', { status: 'RUNNING' }),
      rec({ status: 'TIMEOUT' }),
    ];
    const idx = joinFlows(records);
    expect(idx.total).toBe(4);
    expect(idx.orphanCount).toBe(1);
    expect(idx.byCycle.map((g) => g.key)).toEqual(['cycle-89', 'cycle-88']);
    const c89 = idx.byCycle[0]!;
    expect(c89.total).toBe(2);
    expect(c89.done).toBe(1);
    expect(c89.failed).toBe(1);
    expect(c89.active).toBe(0);
    expect(c89.scripts['gate-check']).toBe(2);
    const c88 = idx.byCycle[1]!;
    expect(c88.active).toBe(1);
  });

  it('phase 组按宏观六相声明序排序，未知相位排在后面', () => {
    const records = [
      attributed('cycle-89', 'maintain', 'G0'),
      attributed('cycle-89', 'plan', 'G0'),
      attributed('cycle-89', 'custom-phase', 'G0'),
      attributed('cycle-89', 'build', 'G0'),
    ];
    const keys = joinFlows(records).byPhase.map((g) => g.key);
    expect(keys).toEqual(['plan', 'build', 'maintain', 'custom-phase']);
    expect(JOIN_PHASE_ORDER).toContain('design');
  });

  it('gate 组按 G0..G3 / H1..H4 声明序排序，未知门禁排最后', () => {
    const records = [
      attributed('cycle-89', 'build', 'H2'),
      attributed('cycle-89', 'build', 'G0'),
      attributed('cycle-89', 'build', 'X9'),
    ];
    expect(joinFlows(records).byGate.map((g) => g.key)).toEqual(['G0', 'H2', 'X9']);
    expect(JOIN_GATE_IDS).toEqual(['G0', 'G1', 'G2', 'G3', 'H1', 'H2', 'H3', 'H4']);
  });

  it('缺某个维度时不构造「未归属」组，也不把记录塞进别的维度组', () => {
    const noGate = rec({ cycle: 'cycle-89', phase: 'build', attribution: { at: 'x', source: 'workflow-state' } });
    const idx = joinFlows([noGate]);
    expect(idx.orphanCount).toBe(0); // 有 cycle+phase 即算归属
    expect(idx.byCycle.map((g) => g.key)).toEqual(['cycle-89']);
    expect(idx.byGate).toEqual([]);
  });

  it('declares gate 维度证据缺失时 gateEvidence 该项为 false', () => {
    const m = coverageMetrics([attributed('cycle-89', 'build', 'G2')]);
    const g2 = m.gateEvidence.find((e) => e.gate === 'G2')!;
    const h1 = m.gateEvidence.find((e) => e.gate === 'H1')!;
    expect(g2).toEqual({ gate: 'G2', evidence: true, flows: 1 });
    expect(h1).toEqual({ gate: 'H1', evidence: false, flows: 0 });
  });
});

/*
 * ★cycle-89 门禁白名单闸（Lead 核查发现的语义缺陷，防「门禁证据覆盖」永久假绿）。
 *
 * 实测反例：宿主侧归属解析曾取**账本链头**（上一次跑过的门禁）的 gate 字段
 * 当「本次流程的门禁归属」——于是一次 `workflow-state check`（与门禁毫无
 * 关系）被记成 `gate:'G3'`，且该字段其实来自 ledger 而 source 却写着
 * 'workflow-state'（来源标注与字段实际出处不一致，双重失真）。
 *
 * 后果不是「多了一个字段」，而是**指标永久假绿**：任意流程都被算成「有 G3
 * 证据」⇒ `gateEvidence[G3].evidence` 恒为 true ⇒ 用户看到的量化条毫无意义。
 *
 * 宿主侧已改成「按脚本语义判定」，但**消费侧仍必须独立设闸**：记录可能来自
 * 旧版本宿主、手工编辑过的 tracker 文件、或任何写了 gate 字段的写入方。
 * 判据不能建立在「上游应该已经做对」的善意假设上。
 */
describe('门禁证据白名单（字段存在 ≠ 有门禁证据）', () => {
  it('gate 字段存在但脚本不是门禁脚本 → **不得**计入 G3 证据', () => {
    const fake = attributed('cycle-89', 'build', 'G3', { script: 'workflow-state' });
    const m = coverageMetrics([fake]);
    const g3 = m.gateEvidence.find((e) => e.gate === 'G3')!;
    expect(g3, 'workflow-state 不是门禁脚本 ⇒ G3 不得有证据').toEqual({ gate: 'G3', evidence: false, flows: 0 });
    expect(m.byGate).toEqual({});
    // 也不进 gate 分组（分组与证据必须同口径，否则两个视图会打架）
    expect(joinFlows([fake]).byGate).toEqual([]);
  });

  it('eval-runner / init-cycle 等非门禁脚本同样不算门禁证据', () => {
    for (const script of ['eval-runner', 'init-cycle', 'quick-validate', 'org-status', 'band-detector']) {
      const fake = attributed('cycle-89', 'build', 'G3', { script });
      const m = coverageMetrics([fake]);
      expect(m.gateEvidence.find((e) => e.gate === 'G3')?.evidence, script + ' 不得算门禁证据').toBe(false);
    }
  });

  it('真正的门禁脚本（gate-check / hitl-audit）**照常**算证据（白名单不是把门禁全灭）', () => {
    const g = attributed('cycle-89', 'build', 'G3', { script: 'gate-check' });
    const h = attributed('cycle-89', 'build', 'H2', { script: 'hitl-audit' });
    const m = coverageMetrics([g, h]);
    expect(m.gateEvidence.find((e) => e.gate === 'G3')).toEqual({ gate: 'G3', evidence: true, flows: 1 });
    expect(m.gateEvidence.find((e) => e.gate === 'H2')).toEqual({ gate: 'H2', evidence: true, flows: 1 });
    expect(m.byGate).toEqual({ G3: 1, H2: 1 });
  });

  it('门禁脚本但 gate 字段缺失 → 无证据（缺门就是没证据，不猜）', () => {
    const noGate = attributed('cycle-89', 'build', undefined as never, { script: 'gate-check' });
    const m = coverageMetrics([noGate]);
    expect(m.gateEvidence.every((e) => e.evidence === false)).toBe(true);
    expect(m.byGate).toEqual({});
  });

  it('isGateEvidence：白名单判据的公开契约', () => {
    const base = { flowId: 'f', workspace: 'w', args: [], status: 'DONE' as const, startedAt: 'x' };
    expect(isGateEvidence({ ...base, script: 'gate-check', gate: 'G1' })).toBe(true);
    expect(isGateEvidence({ ...base, script: 'hitl-audit', gate: 'H4' })).toBe(true);
    expect(isGateEvidence({ ...base, script: 'workflow-state', gate: 'G3' })).toBe(false);
    expect(isGateEvidence({ ...base, script: 'gate-check' })).toBe(false);
    expect(isGateEvidence({ ...base, script: '', gate: 'G1' })).toBe(false);
  });

  it('白名单是**独立声明**：宿主 runtime 层改动不得静默改掉指标口径', () => {
    // 客户端不能 import host，故两侧各自声明一份白名单、测试用同一批向量对账。
    // 这里钉住宿主侧这一份的取值（客户端那份在 flowMatrixTypes.ts）。
    expect([...GATE_SCRIPT_NAMES].sort()).toEqual(['gate-check', 'hitl-audit']);
  });
});

describe('coverageMetrics 量化口径', () => {
  it('attributionRate 保留 4 位小数（2/3 → 0.6667）', () => {
    const m = coverageMetrics([attributed('cycle-89', 'build', 'G2'), attributed('cycle-89', 'test', 'G2'), rec()]);
    expect(m.total).toBe(3);
    expect(m.attributed).toBe(2);
    expect(m.attributionRate).toBe(0.6667);
    expect(m.orphans).toBe(1);
    expect(m.attributed + m.orphans).toBe(m.total);
  });

  it('空输入 → 全零，rate 为 0 而不是 NaN', () => {
    const m = coverageMetrics([]);
    expect(m.total).toBe(0);
    expect(m.attributionRate).toBe(0);
    expect(Number.isNaN(m.attributionRate)).toBe(false);
    expect(m.gateEvidence).toHaveLength(JOIN_GATE_IDS.length);
    expect(m.gateEvidence.every((e) => e.evidence === false)).toBe(true);
    expect(m.unGatedCycles).toEqual([]);
  });

  it('全归属 → rate 恰好 1（浮点不外溢成 0.9999）', () => {
    const m = coverageMetrics([attributed('cycle-89', 'build', 'G0'), attributed('cycle-89', 'build', 'G0')]);
    expect(m.attributionRate).toBe(1);
  });

  it('byCycle/byPhase/byGate 是取值→条数的扁平字典', () => {
    const m = coverageMetrics([
      attributed('cycle-89', 'build', 'G2'),
      attributed('cycle-89', 'test', 'G2'),
      attributed('cycle-88', 'build', 'G1'),
    ]);
    expect(m.byCycle).toEqual({ 'cycle-89': 2, 'cycle-88': 1 });
    expect(m.byPhase).toEqual({ build: 2, test: 1 });
    expect(m.byGate).toEqual({ G2: 2, G1: 1 });
  });

  it('unGatedCycles：有流但无任何门禁证据的循环（有门的循环不进名单）', () => {
    const m = coverageMetrics([
      attributed('cycle-89', 'build', 'G2'), // 有门
      rec({ cycle: 'cycle-88', phase: 'build', attribution: { at: 'x', source: 'workflow-state' } }), // 无门
      rec(), // 孤儿，不算任何循环
    ]);
    expect(m.unGatedCycles).toEqual(['cycle-88']);
  });

  it('ledger 来源的归属同样被计入（source 两种合法值都算）', () => {
    const m = coverageMetrics([rec({ gate: 'H1', attribution: { at: 'x', source: 'ledger' } })]);
    expect(m.attributed).toBe(1);
    expect(m.byGate).toEqual({ H1: 1 });
  });

  it('纯函数：不修改入参数组与记录', () => {
    const records = [attributed('cycle-89', 'build', 'G2')];
    const snapshot = JSON.stringify(records);
    joinFlows(records);
    coverageMetrics(records);
    expect(JSON.stringify(records)).toBe(snapshot);
  });
});

describe('多项目隔离（服务端过滤）', () => {
  it('normalizeWorkspace 归一斜杠/尾斜杠/Windows 大小写', () => {
    expect(normalizeWorkspace('D:\\ws\\a\\')).toBe('d:/ws/a');
    expect(normalizeWorkspace('D:/ws/a')).toBe('d:/ws/a');
    // POSIX 大小写有意义，不归一
    expect(normalizeWorkspace('/home/A/ws/')).toBe('/home/A/ws');
    expect(sameWorkspace('D:\\ws\\a', 'd:/WS/a')).toBe(true);
  });

  it('filterByWorkspace 只留本工作区记录，不串味', () => {
    const a = rec({ workspace: 'D:\\ws\\a' });
    const b = rec({ workspace: 'D:\\ws\\b' });
    expect(filterByWorkspace([a, b], 'D:/ws/a')).toEqual([a]);
    expect(filterByWorkspace([a, b], 'D:/ws/b')).toEqual([b]);
  });

  it('filterByWorkspace 对 encodeURIComponent 过的参数同样命中', () => {
    const a = rec({ workspace: 'D:/工作区/a' });
    expect(filterByWorkspace([a], encodeURIComponent('D:/工作区/a'))).toEqual([a]);
  });

  it('工作区缺失/为空 → 空集（fail-closed，绝不返回全量）', () => {
    const a = rec({ workspace: 'D:/ws/a' });
    expect(filterByWorkspace([a], null)).toEqual([]);
    expect(filterByWorkspace([a], undefined)).toEqual([]);
    expect(filterByWorkspace([a], '')).toEqual([]);
  });

  it('非法百分号编码不抛错（解码兜底为原串）', () => {
    const weird = rec({ workspace: 'D:/ws/%E0%A4%A' });
    expect(() => filterByWorkspace([weird], '%E0%A4%A')).not.toThrow();
  });

  it('两工作区交叉请求：各自只看到自己的记录（0 污染）', () => {
    const records = [rec({ workspace: 'D:/p1' }), rec({ workspace: 'D:/p1' }), rec({ workspace: 'D:/p2' })];
    const m1 = coverageMetrics(filterByWorkspace(records, 'D:/p1'));
    const m2 = coverageMetrics(filterByWorkspace(records, 'D:/p2'));
    expect(m1.total).toBe(2);
    expect(m2.total).toBe(1);
  });
});
