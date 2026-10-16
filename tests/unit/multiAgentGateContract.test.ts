import { describe, it, expect } from 'vitest';
import {
  aggregateVerdicts,
  deriveEvidenceResult,
  heuristicEvaluate,
  runGate,
  runAllGates,
  GATE_THRESHOLDS,
  GATE_NAMES,
  type AgentVerdict,
  type EvidenceItem,
} from '../../src/host/llm/multiAgentGate.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 本文件钉死 multiAgentGate 的**契约级不变量**，全部来自真实缺陷修复：
 *  - P0-7 去中文假设：证据裁决改走结构化事实，不再解析自然语言
 *  - P0-8 pr 门阈值：与技能侧 multi-agent-gate.mjs:139 的 pr=3 对齐
 *  - P0-9 空裁决集 NaN：aggregateVerdicts 必须返回 0 分而非 NaN
 *
 * 这些断言的存在意义是「回归守卫」：任何一条被改回旧形态都必须立刻变红。
 */

const CARDS_DIR = join(process.cwd(), 'assets', 'agents');

/**
 * 从 assets/agents 真实装载角色卡。
 *
 * 键必须取**卡内 `id` 字段**（形如 `anic.agent.intent.planner`），
 * 而不是由文件名拼（`intent-planner.json` → `anic.agent.intent-planner`）。
 * `runGate` 查的是 `anic.agent.${gate}.${role}`；用文件名拼会得到 15 张
 * 全部查不到的卡，从而静默退化成「空裁决集」路径——测试会以假绿通过
 * 「缺卡不崩」却永远测不到真实的 3 卡路径。
 */
function loadAgentCards(): Map<string, { id: string }> {
  const map = new Map<string, { id: string }>();
  for (const file of readdirSync(CARDS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const raw = JSON.parse(readFileSync(join(CARDS_DIR, file), 'utf-8')) as { id?: string };
    if (typeof raw.id !== 'string' || raw.id === '') continue;
    map.set(raw.id, { id: raw.id });
  }
  return map;
}

describe('multiAgentGate · P0-9 空裁决集不得产生 NaN', () => {
  it('aggregateVerdicts([]) 返回 doubt / trustScore 0 / passed false', () => {
    const r = aggregateVerdicts([], 2);
    expect(r.verdict).toBe('doubt');
    expect(r.trustScore).toBe(0);
    expect(r.passed).toBe(false);
  });

  it('trustScore 永不为 NaN（NaN 会污染信任分升降级与账本 JSON）', () => {
    for (const threshold of [1, 2, 3]) {
      const r = aggregateVerdicts([], threshold);
      expect(Number.isNaN(r.trustScore)).toBe(false);
      expect(Number.isFinite(r.trustScore)).toBe(true);
    }
  });

  it('空裁决集经 JSON 往返后不变成 null', () => {
    const r = aggregateVerdicts([], 2);
    const roundTrip = JSON.parse(JSON.stringify(r)) as { trustScore: number };
    expect(roundTrip.trustScore).toBe(0);
    expect(roundTrip.trustScore).not.toBeNull();
  });

  it('非空裁决集行为不变（回归基线）', () => {
    const mk = (verdict: 'approve' | 'reject' | 'doubt'): AgentVerdict => ({
      role: 'planner',
      verdict,
      confidence: 0.8,
      evidenceIds: [],
      notes: '',
      tier: 'Tier-1',
    });
    expect(aggregateVerdicts([mk('approve'), mk('approve')], 2).trustScore).toBe(100);
    expect(aggregateVerdicts([mk('approve'), mk('doubt')], 2).verdict).toBe('doubt');
    expect(aggregateVerdicts([mk('reject'), mk('approve')], 2).verdict).toBe('reject');
  });
});

describe('multiAgentGate · P0-8 各门阈值与技能侧对齐', () => {
  it('pr 与 release 同为 3（PR 合并门不可降为 2）', () => {
    expect(GATE_THRESHOLDS.pr).toBe(3);
    expect(GATE_THRESHOLDS.release).toBe(3);
  });

  it('intent / spec / plan 为 2', () => {
    expect(GATE_THRESHOLDS.intent).toBe(2);
    expect(GATE_THRESHOLDS.spec).toBe(2);
    expect(GATE_THRESHOLDS.plan).toBe(2);
  });

  it('GATE_THRESHOLDS 覆盖全部 5 门且无多余键', () => {
    expect(Object.keys(GATE_THRESHOLDS).sort()).toEqual([...GATE_NAMES].sort());
  });

  it('技能侧源码确实声明 pr=3 —— 阈值不是凭空定的', () => {
    // 与技能脚本交叉验证：若技能侧改了，本断言会提醒我们重新对齐。
    const skill = join(
      process.cwd(),
      '..',
      'dsh-codegraph-visualizer',
      '.dsh',
      'skills',
      'ai-native-iteration-cycle',
      'scripts',
      'multi-agent-gate.mjs',
    );
    let text: string;
    try {
      text = readFileSync(skill, 'utf-8');
    } catch {
      return; // 技能侧不存在（独立工程场景）时跳过，不制造假红
    }
    const prBlock = /pr:\s*\{[\s\S]*?threshold:\s*(\d+)/.exec(text);
    expect(prBlock, '技能侧 pr 门定义未找到，契约来源失效').not.toBeNull();
    expect(Number(prBlock?.[1])).toBe(GATE_THRESHOLDS.pr);
  });

  it('runGate 在 pr 门只有 2/3 通过时不放行', () => {
    const cards = loadAgentCards();
    const approve2of3: EvidenceItem[] = [{ id: 'e1', content: 'x', result: 'PASS' }];
    const r = runGate('pr', cards, approve2of3);
    // 三张 reviewer/implementer/planner 卡都存在 → 3 个 verdict 全 approve
    expect(r.threshold).toBe(3);
    expect(r.verdicts.length).toBe(3);
    // 2 票通过场景需人工注入：直接验证阈值语义
    const twoApproveOneDoubt: AgentVerdict[] = [
      { role: 'planner', verdict: 'approve', confidence: 0.8, evidenceIds: [], notes: '', tier: 'Tier-1' },
      { role: 'implementer', verdict: 'approve', confidence: 0.8, evidenceIds: [], notes: '', tier: 'Tier-1' },
      { role: 'reviewer', verdict: 'doubt', confidence: 0.4, evidenceIds: [], notes: '', tier: 'Tier-1' },
    ];
    expect(aggregateVerdicts(twoApproveOneDoubt, GATE_THRESHOLDS.pr).passed).toBe(false);
    expect(aggregateVerdicts(twoApproveOneDoubt, GATE_THRESHOLDS.intent).passed).toBe(true);
  });
});

describe('multiAgentGate · P0-7 结构化裁决优先，无自然语言假设', () => {
  it('结构化 result 为 FAIL → FAIL（即使正文含通过词）', () => {
    expect(deriveEvidenceResult([{ id: 'e1', content: '全部通过 PASS ✅', result: 'FAIL' }])).toBe('FAIL');
  });

  it('结构化 result 为 PASS → PASS（即使正文含失败词）', () => {
    expect(deriveEvidenceResult([{ id: 'e1', content: '失败 FAIL ❌', result: 'PASS' }])).toBe('PASS');
  });

  it('结构化全为 SKIP → SKIP（没有证据 ≠ 通过）', () => {
    expect(deriveEvidenceResult([{ id: 'e1', content: '任意', result: 'SKIP' }])).toBe('SKIP');
  });

  it('任一 FAIL 压过 PASS', () => {
    expect(
      deriveEvidenceResult([
        { id: 'e1', content: '', result: 'PASS' },
        { id: 'e2', content: '', result: 'FAIL' },
      ]),
    ).toBe('FAIL');
  });

  it('空证据集 → SKIP', () => {
    expect(deriveEvidenceResult([])).toBe('SKIP');
  });

  it('纯中文「通过」不再被当作通过（去中文假设的核心断言）', () => {
    // 旧实现含 hasKeywords=['通过','PASS',...] → 会判 approve。
    // 新实现无结构化字段时只认语言中立标记，纯中文散文必须落到 SKIP。
    expect(deriveEvidenceResult([{ id: 'e1', content: '这个功能通过验收了，一切正常没有问题' }])).toBe('SKIP');
    const v = heuristicEvaluate('reviewer', 'pr', [
      { id: 'e1', content: '这个功能通过验收了，一切正常没有问题' },
    ]);
    expect(v.verdict).toBe('doubt');
  });

  it('纯中文「失败」不再被当作失败（同样去中文假设）', () => {
    expect(deriveEvidenceResult([{ id: 'e1', content: '测试失败了，构建也失败了' }])).toBe('SKIP');
  });

  it('语言中立标记兜底仍可用（ASCII 与 Unicode 符号）', () => {
    expect(deriveEvidenceResult([{ id: 'e1', content: 'FAIL: 3 assertions' }])).toBe('FAIL');
    expect(deriveEvidenceResult([{ id: 'e1', content: '❌ 2 broken' }])).toBe('FAIL');
    expect(deriveEvidenceResult([{ id: 'e1', content: 'all checks PASS' }])).toBe('PASS');
    expect(deriveEvidenceResult([{ id: 'e1', content: '✅ 42 tests' }])).toBe('PASS');
  });

  it('结构化字段完全缺席时才走兜底扫描', () => {
    // 有 result 字段（即便值都是 SKIP）时不看正文
    expect(deriveEvidenceResult([{ id: 'e1', content: '❌ FAIL', result: 'SKIP' }])).toBe('SKIP');
  });

  it('heuristicEvaluate 的 notes 记录派生结果，便于审计', () => {
    const v = heuristicEvaluate('planner', 'intent', [{ id: 'e1', content: '', result: 'FAIL' }]);
    expect(v.notes).toContain('derived=FAIL');
    expect(v.notes).toContain('evidence=1');
  });

  it('Tier-1 结果始终诚实标注为非模型评审', () => {
    const v = heuristicEvaluate('planner', 'intent', [{ id: 'e1', content: '', result: 'PASS' }]);
    expect(v.tier).toBe('Tier-1');
  });
});

describe('multiAgentGate · 真实角色卡装载与全门运行', () => {
  it('assets/agents 提供 5 门 × 3 角色 = 15 张卡', () => {
    const cards = loadAgentCards();
    expect(cards.size).toBe(15);
  });

  it('runAllGates 对 5 门各返回一个结果', () => {
    const cards = loadAgentCards();
    const evidence: Record<string, EvidenceItem[]> = {};
    for (const gate of GATE_NAMES) evidence[gate] = [{ id: `${gate}-1`, content: '', result: 'PASS' }];
    const results = runAllGates(cards, evidence);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.verdicts.length).toBe(3);
      expect(Number.isNaN(r.trustScore)).toBe(false);
    }
  });

  it('缺卡时 verdicts 为空且不崩（走 P0-9 的空集路径）', () => {
    const r = runGate('intent', new Map(), [{ id: 'e1', content: '', result: 'PASS' }]);
    expect(r.verdicts).toHaveLength(0);
    // 注意：GateResult 的聚合字段名是 `aggregate`（不是 `verdict`）。
    expect(r.aggregate).toBe('doubt');
    expect(r.trustScore).toBe(0);
    expect(r.passed).toBe(false);
  });
});
