/**
 * 项目事实基线契约（cycle-89 WP-C P0）。
 *
 * 钉死三件事，任何一条退回都会让「历史产物压过最新事实」复发：
 *   1. 活跃/归档**分列**，评估报告只从活跃面取（归档是历史，不是判据）；
 *   2. `diffFacts` 的 stale 判据（无存档事实 ⇒ 陈旧；mtime 抖动 ⇒ **不**陈旧）；
 *   3. 缺 `.cycles/` 时**不抛**、字段为空，由路由层响亮 412（不折叠成 0 分）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeVsArchived,
  collectProjectFacts,
  diffFacts,
  factsDigest,
  FACT_KEYS,
  readStoredFacts,
  type ProjectFacts,
} from '../../src/host/runtime/bootstrapFacts.ts';

const made: string[] = [];

/** 造一个工作区；`structure` 里的键是相对路径，值是文件内容（目录用 null）。 */
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anic-facts-'));
  made.push(dir);
  return dir;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function blankFacts(over: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    gitHead: null,
    gitDirty: null,
    currentCycle: null,
    currentPhase: null,
    ledgerHead: null,
    ledgerEntries: 0,
    ledgerValid: true,
    evalReport: null,
    activeCycles: 0,
    archivedCycles: 0,
    activeCycleNames: [],
    skillVersion: null,
    hasCyclesDir: true,
    ...over,
  };
}

afterEach(() => {
  while (made.length > 0) {
    const d = made.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('collectProjectFacts — 缺 .cycles 不折叠', () => {
  it('没有 .cycles 时返回 hasCyclesDir:false 且字段为空，不抛', () => {
    const ws = makeWorkspace();
    const f = collectProjectFacts(ws);
    expect(f.hasCyclesDir).toBe(false);
    expect(f.currentCycle).toBeNull();
    expect(f.currentPhase).toBeNull();
    expect(f.ledgerEntries).toBe(0);
    expect(f.evalReport).toBeNull();
    expect(f.activeCycles).toBe(0);
    expect(f.archivedCycles).toBe(0);
    expect(f.skillVersion).toBeNull();
  });

  it('非 git 工作区的 gitHead/gitDirty 为 null（不是空串，也不是 false）', () => {
    const ws = makeWorkspace();
    const f = collectProjectFacts(ws);
    expect(f.gitHead).toBeNull();
    expect(f.gitDirty).toBeNull();
  });
});

describe('collectProjectFacts — 活跃与归档分列', () => {
  it('只有 cycle-<n> 目录计入；manifest.json 等非循环条目不计', () => {
    const ws = makeWorkspace();
    const cd = join(ws, '.cycles');
    mkdirSync(join(cd, 'cycles', 'cycle-88'), { recursive: true });
    mkdirSync(join(cd, 'cycles', 'cycle-89'), { recursive: true });
    mkdirSync(join(cd, 'archive', 'cycle-1'), { recursive: true });
    mkdirSync(join(cd, 'archive', 'cycle-2'), { recursive: true });
    mkdirSync(join(cd, 'archive', 'cycle-10'), { recursive: true });
    writeFile(ws, '.cycles/archive/manifest.json', '{}');

    const f = collectProjectFacts(ws);
    expect(f.activeCycles).toBe(2);
    expect(f.archivedCycles).toBe(3);
    // 按编号升序（不是字典序：cycle-10 不能排到 cycle-2 前面）
    expect(f.activeCycleNames).toEqual(['cycle-88', 'cycle-89']);
  });

  it('评估报告只从活跃面取：归档里的更新报告不得成为当前判据', () => {
    const ws = makeWorkspace();
    writeFile(ws, '.cycles/cycles/cycle-88/项目评估报告.md', '# 活跃 88\n');
    // 归档里放一个编号更大的报告——旧实现按全量扫描会误选它
    writeFile(ws, '.cycles/archive/cycle-99/项目评估报告.md', '# 归档 99（历史）\n');

    const f = collectProjectFacts(ws);
    expect(f.evalReport).not.toBeNull();
    expect(f.evalReport?.path).toBe('.cycles/cycles/cycle-88/项目评估报告.md');
    expect(f.archivedCycles).toBe(1);
  });

  it('取编号最大的活跃循环报告，并给出 sha256 + mtime', () => {
    const ws = makeWorkspace();
    writeFile(ws, '.cycles/cycles/cycle-88/项目评估报告.md', '# 88\n');
    writeFile(ws, '.cycles/cycles/cycle-89/项目评估报告.md', '# 89\n');

    const f = collectProjectFacts(ws);
    expect(f.evalReport?.path).toContain('cycle-89');
    expect(f.evalReport?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(f.evalReport?.mtime ?? ''))).toBe(false);
  });

  it('活跃循环里没有评估报告时 evalReport 为 null（不去归档里找）', () => {
    const ws = makeWorkspace();
    writeFile(ws, '.cycles/cycles/cycle-89/任务清单.md', '| a |\n');
    writeFile(ws, '.cycles/archive/cycle-99/项目评估报告.md', '# 历史\n');
    expect(collectProjectFacts(ws).evalReport).toBeNull();
  });
});

describe('collectProjectFacts — 状态 / 账本 / 技能版本', () => {
  it('读 workflow-state.json 的 currentCycle 与 currentPhase', () => {
    const ws = makeWorkspace();
    writeFile(ws, '.cycles/workflow-state.json', JSON.stringify({ currentCycle: 'cycle-89', currentPhase: 'plan' }));
    const f = collectProjectFacts(ws);
    expect(f.currentCycle).toBe('cycle-89');
    expect(f.currentPhase).toBe('plan');
  });

  it('workflow-state.json 损坏 → null（不抛、不猜）', () => {
    const ws = makeWorkspace();
    writeFile(ws, '.cycles/workflow-state.json', '{not json');
    const f = collectProjectFacts(ws);
    expect(f.currentCycle).toBeNull();
    expect(f.currentPhase).toBeNull();
  });

  it('账本包裹形态读出 entries 计数与 chainHead；断链则 ledgerValid=false', () => {
    const ws = makeWorkspace();
    // 一条 hash 明显不相符的条目：verifyLedger 必须报 ok:false，但条数照数
    writeFile(ws, '.cycles/gates/ledger.json', JSON.stringify({
      entries: [{ gate: 'G1', gateName: 'g1', result: 'PASS', detail: 'd', timestamp: 't', previousHash: null, hash: 'deadbeef' }],
      chainHead: 'deadbeef',
    }));
    const f = collectProjectFacts(ws);
    expect(f.ledgerEntries).toBe(1);
    expect(f.ledgerValid).toBe(false);
    expect(f.ledgerHead).toBe('deadbeef');
  });

  it('无账本 → entries 0 / head null / valid true（空链不是断链）', () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, '.cycles'), { recursive: true });
    const f = collectProjectFacts(ws);
    expect(f.ledgerEntries).toBe(0);
    expect(f.ledgerHead).toBeNull();
    expect(f.ledgerValid).toBe(true);
  });

  it('技能版本取 CHANGELOG 最新条目标题', () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, '.cycles'), { recursive: true });
    writeFile(ws, '.dsh/skills/ai-native-iteration-cycle/CHANGELOG.md', '# Changelog\n\n## 2.6.1 — x\n\n## 2.6.0 — y\n');
    expect(collectProjectFacts(ws).skillVersion).toBe('2.6.1');
  });
});

describe('diffFacts — 陈旧判据', () => {
  it('没有存档事实 ⇒ stale，changed=[facts]', () => {
    const d = diffFacts(null, blankFacts());
    expect(d).toEqual({ stale: true, changed: ['facts'] });
  });

  it('完全相等 ⇒ 不陈旧', () => {
    const a = blankFacts({ gitHead: 'abc', activeCycles: 2 });
    expect(diffFacts(a, { ...a })).toEqual({ stale: false, changed: [] });
  });

  it('关键字段变化 ⇒ 精确 char 名单（不乱报、不遗漏）', () => {
    const prev = blankFacts({ gitHead: 'aaa', currentCycle: 'cycle-88' });
    const next = blankFacts({ gitHead: 'bbb', currentCycle: 'cycle-88', currentPhase: 'test' });
    const d = diffFacts(prev, next);
    expect(d.stale).toBe(true);
    expect(d.changed.sort()).toEqual(['currentPhase', 'gitHead']);
  });

  it('评估报告内容变化 ⇒ 陈旧；仅 mtime 抖动 ⇒ 不陈旧', () => {
    const rep = { path: '.cycles/cycles/cycle-89/项目评估报告.md', sha256: 'sha1', mtime: 't1' };
    const base = blankFacts({ evalReport: rep });
    expect(diffFacts(base, blankFacts({ evalReport: { ...rep, mtime: 't2' } })).stale).toBe(false);
    expect(diffFacts(base, blankFacts({ evalReport: { ...rep, sha256: 'sha2' } })).stale).toBe(true);
  });

  it('FACT_KEYS 覆盖全部参与比较的字段，且不变量 changed 空 ⇔ stale false', () => {
    expect(FACT_KEYS).toContain('gitHead');
    expect(FACT_KEYS).toContain('evalReport');
    expect(FACT_KEYS).toContain('activeCycles');
    expect(FACT_KEYS).not.toContain('hasCyclesDir');
    const same = diffFacts(blankFacts(), blankFacts());
    expect(same.changed.length === 0).toBe(same.stale === false);
  });
});

describe('readStoredFacts — 存档事实的形状守卫（cycle-95）', () => {
  it('合法存档事实原样返回（引用同一对象，不做深拷贝——陈旧判定只读不写）', () => {
    const f = blankFacts({ gitHead: 'abc', activeCycleNames: ['cycle-88'] });
    expect(readStoredFacts({ status: 'IDLE', facts: f })).toBe(f);
  });

  it('旧状态文件（**没有** facts 键）⇒ null（调用方据此判 stale:true）', () => {
    // 复刻真实事故形态：cycle-89 之前的 self-bootstrap.json 没有这个字段。
    expect(readStoredFacts({ status: 'EXHAUSTED', round: 3, lastEvalScore: 0 })).toBeNull();
  });

  it('坏形状一律判"未采集"，绝不半截参与陈旧判定', () => {
    // 半截 facts（缺 activeCycleNames）比没有 facts 更危险：它会让 diffFacts 拿
    // undefined 参与比较，把真实变化静默读成"相等"。
    expect(readStoredFacts({ facts: { hasCyclesDir: true, ledgerEntries: 0, activeCycles: 2, archivedCycles: 1 } })).toBeNull();
    expect(readStoredFacts({ facts: { ...blankFacts(), activeCycleNames: 'cycle-88' } })).toBeNull();
    expect(readStoredFacts({ facts: { ...blankFacts(), hasCyclesDir: 'true' } })).toBeNull();
    expect(readStoredFacts({ facts: { ...blankFacts(), ledgerEntries: '0' } })).toBeNull();
    expect(readStoredFacts({ facts: null })).toBeNull();
    expect(readStoredFacts({ facts: [] })).toBeNull();
    expect(readStoredFacts(null)).toBeNull();
    expect(readStoredFacts('nonsense')).toBeNull();
  });

  it('坏形状 ⇒ diffFacts 判陈旧（与"没有存档事实"同一方向，可自我修复）', () => {
    // 反向自检：守卫把坏形状读成 null 之后，陈旧判定必须落到 stale:true；
    // 若落到 false，坏数据就被当成"最新事实"，本缺陷换个形态复发。
    for (const broken of [
      { hasCyclesDir: true, ledgerEntries: 0, activeCycles: 2, archivedCycles: 1 },
      { ...blankFacts(), activeCycles: '2' },
    ]) {
      const prev = readStoredFacts({ facts: broken });
      expect(diffFacts(prev, blankFacts())).toEqual({ stale: true, changed: ['facts'] });
    }
  });
});

describe('factsDigest / activeVsArchived', () => {
  it('digest 稳定：同事实同摘要，任一关键字段变化即不同', () => {
    const a = blankFacts({ gitHead: 'abc' });
    expect(factsDigest(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(factsDigest(a)).toBe(factsDigest({ ...a }));
    expect(factsDigest(a)).not.toBe(factsDigest({ ...a, gitHead: 'def' }));
  });

  it('activeVsArchived 分列且 evaluationInput 只含活跃面', () => {
    const f = blankFacts({ activeCycles: 2, archivedCycles: 80, activeCycleNames: ['cycle-88', 'cycle-89'] });
    const v = activeVsArchived(f);
    expect(v.active).toEqual(['cycle-88', 'cycle-89']);
    expect(v.archived).toBe(80);
    expect(v.total).toBe(82);
    expect(v.evaluationInput).toEqual(v.active);
  });
});
