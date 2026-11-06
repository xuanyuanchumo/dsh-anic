/**
 * 域健康分类单测（cycle-110）。
 *
 * 分类是 nav 状态点的唯一判据源——它把 fail 判成 ok，用户就在导航上看不见
 * 「评估红了」。所以每域至少钉「会判红」与「正常绿」两态 + idle（未观测），
 * 且用**真实 Json 类型**造夹具（字段名从 render*.ts 逐个核对，见 workbenchStatus.ts
 * 文件头的 file:line 对照表）。
 */
import { describe, it, expect } from 'vitest';
import { classifyDomainStatus } from '../../src/client/workbench/workbenchStatus.ts';
import { WORKBENCH_DOMAINS } from '../../src/client/workbench/workbenchModel.ts';
import { createInitialPanelState } from '../../src/client/panelState.ts';
import type { PanelState } from '../../src/client/panelState.ts';
import type { SelfCheckJson } from '../../src/client/features/diagnostics/renderDiagnostics.ts';
import type { SkillHealthJson } from '../../src/client/features/skillhealth/renderSkillHealth.ts';
import type { ClosureView } from '../../src/client/features/closure/closureTypes.ts';

/** 初始态（全部切片 null ⇒ 多域应为 idle）。 */
function base(): PanelState {
  return createInitialPanelState();
}
/** 用真实类型造自检夹具。 */
function check(ok: boolean): SelfCheckJson {
  return { checks: [{ id: 'p1', ok, detail: 'd' }], allOk: ok, requestId: 'r' };
}
function health(scripts: SkillHealthJson['scripts']): SkillHealthJson {
  return { scripts, suggestions: [], overallSuccessRate: 1, totalInvocations: 10, generatedAt: 'x' };
}
/** ClosureView 最小夹具（只填分类用到的 totals；其余按类型要求给零值空集）。 */
function closure(ghost: number): ClosureView {
  return {
    generatedAt: 'x',
    totals: {
      registered: 1, produced: 1, consumed: 1, codeConsumed: 1,
      unconsumed: 0, ghost, consumedGap: 0, producedGap: 0,
      dynamicClaimed: 0, channelOnly: 0, channelDeclared: 0,
    },
    clusters: [], unconsumed: [], ghost: [], notes: [],
    truncation: { applied: false, limit: 0, viewItems: 0, totalItems: 0 },
  };
}
const domainOf = (id: string) => {
  const d = WORKBENCH_DOMAINS.find((x) => x.id === id);
  if (!d) throw new Error(`domain ${id} missing`);
  return d;
};

describe('diagnostics（自检 → fail/idle/ok）', () => {
  it('有失败探针 ⇒ fail（导航必须亮红）', () => {
    const s = base(); s.check = check(false);
    expect(classifyDomainStatus(s, domainOf('diagnostics'))).toBe('fail');
  });
  it('全过 ⇒ ok；未加载 ⇒ idle（不谎报失败也不谎报通过）', () => {
    const s = base(); s.check = check(true);
    expect(classifyDomainStatus(s, domainOf('diagnostics'))).toBe('ok');
    expect(classifyDomainStatus(base(), domainOf('diagnostics'))).toBe('idle');
  });
});

describe('health（critical 债 > 漂移/退化 > ok/idle）', () => {
  it('critical 技术债 ⇒ fail（优先于 warn）', () => {
    const s = base();
    s.techDebt = { open: [{ file: 'f', entry: { id: 'd1', title: 't', severity: 'critical', kind: 'perf', detail: '', createdAt: '' } }], openCount: 1, resolvedCount: 0, skipped: [] };
    expect(classifyDomainStatus(s, domainOf('health'))).toBe('fail');
  });
  it('技能退化（degraded）⇒ warn', () => {
    const s = base();
    s.skillHealth = health([{ script: 'eval-runner', level: 'degraded', total: 5, successRate: 0.2, timeoutRate: 0, avgDurationMs: 1 }]);
    expect(classifyDomainStatus(s, domainOf('health'))).toBe('warn');
  });
  it('全部健康 ⇒ ok；未加载 ⇒ idle', () => {
    const s = base();
    s.skillHealth = health([]);
    s.techDebt = { open: [], openCount: 0, resolvedCount: 0, skipped: [] };
    expect(classifyDomainStatus(s, domainOf('health'))).toBe('ok');
    expect(classifyDomainStatus(base(), domainOf('health'))).toBe('idle');
  });
});

describe('flows（账本链断 ⇒ fail；HITL 未过 ⇒ warn）', () => {
  it('ledgerVerify.ok=false ⇒ fail', () => {
    const s = base();
    s.ledgerVerify = { ok: false, total: 3, brokenAt: 1, reason: 'chain broken' };
    expect(classifyDomainStatus(s, domainOf('flows'))).toBe('fail');
  });
  it('HITL 有未过/熔断检查 ⇒ warn', () => {
    const s = base();
    s.hitlAudit = { checks: [{ check: 'H1', passed: false, circuit: false, detail: '' }], allPassed: false, anyCircuit: false };
    expect(classifyDomainStatus(s, domainOf('flows'))).toBe('warn');
  });
  it('全过 ⇒ ok；未加载 ⇒ idle', () => {
    const s = base();
    s.hitlAudit = { checks: [{ check: 'H1', passed: true, circuit: false, detail: '' }], allPassed: true, anyCircuit: false };
    s.ledgerVerify = { ok: true, total: 3, brokenAt: null, reason: null };
    expect(classifyDomainStatus(s, domainOf('flows'))).toBe('ok');
    expect(classifyDomainStatus(base(), domainOf('flows'))).toBe('idle');
  });
});

describe('overview（调用流出错 ⇒ warn）', () => {
  it('invocationsError ⇒ warn；正常 ⇒ ok', () => {
    const s = base();
    s.invocationsError = 'network down';
    expect(classifyDomainStatus(s, domainOf('overview'))).toBe('warn');
    expect(classifyDomainStatus(base(), domainOf('overview'))).toBe('ok');
  });
});

describe('quality（幽灵消费/陈旧基线 ⇒ warn）', () => {
  it('closure 幽灵消费 ⇒ warn；bootstrap stale（两形态）⇒ warn', () => {
    const s = base();
    s.closure = closure(2);
    expect(classifyDomainStatus(s, domainOf('quality'))).toBe('warn');
    const s2 = base();
    s2.bootstrap = { stale: true };
    expect(classifyDomainStatus(s2, domainOf('quality'))).toBe('warn');
    const s3 = base();
    s3.bootstrap = { stale: { stale: true, changed: ['a'] } };
    expect(classifyDomainStatus(s3, domainOf('quality'))).toBe('warn');
  });
  it('干净 ⇒ ok；未加载 ⇒ idle', () => {
    const s = base();
    s.closure = closure(0);
    s.bootstrap = { stale: false };
    expect(classifyDomainStatus(s, domainOf('quality'))).toBe('ok');
    expect(classifyDomainStatus(base(), domainOf('quality'))).toBe('idle');
  });
});

describe('settings（可写面恒 idle——不把「没配置」画成故障）', () => {
  it('任意状态 ⇒ idle', () => {
    expect(classifyDomainStatus(base(), domainOf('settings'))).toBe('idle');
  });
});
