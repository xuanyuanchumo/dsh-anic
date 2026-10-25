/**
 * 全生命周期宏观相位契约（cycle-78 WS-A）——阶段流转不再"死在 build"。
 *
 * 被守卫缺陷（真实工作区取证）：`.cycles/workflow-state.json` 的 `currentPhase` 长期
 * 停在 `build`（cycle-77 已收口仍是 build，phaseHistory 仅 2 条人工记录）。机制其实
 * 齐备——`macroPhaseEngine.advanceMacro` 有逐相门禁守卫、`anic_flows_advance` 工具也
 * 在——但**没有任何自举链调用它**：`initCycle` 只建目录、`closeCycle` 只查
 * workflow-graph 节点状态与账本哈希链，从不读门禁账本、从不推进相位。
 *
 * 本契约钉死两条写路径的同语义（host TS + 技能 .mjs 双实现）：
 *  ① host `initCycle` → 相位归零 plan + currentCycle 同步；
 *  ② 技能 `init-cycle.mjs`（真 spawn 黑盒）→ 同一断言；
 *  ③ 门禁账本 G0-G3 全 PASS → close 逐相推进 build→test→deploy→maintain，逐相留痕；
 *  ④ 缺任一 PASS（此处缺 G3）→ 零推进、零写入、原因点名缺门；
 *  ⑤ 幂等：同 cycle 二次 close 相位文件字节不动；
 *  ⑥ 反向自检：把账本一条 PASS 篡改成 FAIL → ③ 必须变红（证明绿来自真实门禁证据）。
 *
 * 全部真 IO（临时工作区真读写、真 spawn 技能脚本），不用字符串静态断言代替行为。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { initCycle, closeCycle } from '../../src/host/runtime/cycleRunner.ts';
import { loadMacroState } from '../../src/host/flows/macroPhaseEngine.ts';
import { appendEntry } from '../../src/host/runtime/ledger.ts';

/** 发行源技能脚本（assets/skill 是本任务写的正典；.dsh 安装副本由安装/修复流程同步）。 */
const SKILL_SCRIPT = resolve(import.meta.dirname, '../../assets/skill/scripts/init-cycle.mjs');

const TMP_ROOTS: string[] = [];

function mkTmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-phase-lifecycle-'));
  TMP_ROOTS.push(root);
  return root;
}

const statePath = (root: string): string => join(root, '.cycles', 'workflow-state.json');
const readState = (root: string): Record<string, unknown> =>
  JSON.parse(readFileSync(statePath(root), 'utf-8')) as Record<string, unknown>;

/** 最小宏观状态（相位 + 一条既有历史留痕，用于验证旧历史不被吞）。 */
function seedMacro(root: string, currentPhase: string, cycleName = 'cycle-77'): void {
  mkdirSync(join(root, '.cycles'), { recursive: true });
  writeFileSync(statePath(root), JSON.stringify({
    currentPhase,
    currentCycle: cycleName,
    phaseHistory: [{ phase: 'plan', exitedAt: '2026-01-01T00:00:00.000Z' }],
    nodeStatus: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }, null, 2));
}

/** 最小 workflow-graph（无 gate 节点 ⇒ checkStrict 恒过；节点门语义另由 stateMachine 测试钉死）。 */
function writeGraph(root: string): void {
  mkdirSync(join(root, '.cycles'), { recursive: true });
  writeFileSync(join(root, '.cycles', 'workflow-graph.yaml'), [
    'nodes:',
    '  - id: build',
    '    type: phase',
    '    label: "Build（构建）"',
    '  - id: test',
    '    type: phase',
    '    label: "Test（测试）"',
    '',
  ].join('\n'));
}

/** 真实哈希链入账（appendEntry 是唯一写者 ⇒ verifyLedger 可通过）。 */
function seedGates(root: string, gates: readonly string[]): void {
  for (const gate of gates) {
    appendEntry(join(root, '.cycles'), { gate, gateName: gate, result: 'PASS', detail: 'phase contract fixture' });
  }
}

const ALL_GATES = ['G0', 'G1', 'G2', 'G3'] as const;

beforeEach(() => {
  TMP_ROOTS.length = 0;
});

afterEach(() => {
  while (TMP_ROOTS.length > 0) {
    const d = TMP_ROOTS.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe('① host initCycle：相位归零到新循环的 plan（真实写盘）', () => {
  it('全新工作区 → plan/cycle-1 且不伪造退出留痕；第二次 init → cycle-2 且旧相留痕', () => {
    const root = mkTmp();
    const info = initCycle(join(root, '.cycles'), 'phase-contract');
    expect(info.cycleNumber).toBe(1);
    expect(existsSync(statePath(root))).toBe(true);

    const fresh = loadMacroState(root);
    expect(fresh?.currentPhase).toBe('plan');
    expect(fresh?.currentCycle).toBe('cycle-1');
    // 没有任何相真的退出过 —— 不许编造 exitedAt（拒绝伪造）
    expect(fresh?.phaseHistory).toEqual([]);

    initCycle(join(root, '.cycles'), 'phase-contract');
    const second = loadMacroState(root);
    expect(second?.currentPhase).toBe('plan');
    expect(second?.currentCycle).toBe('cycle-2');
    expect(second?.phaseHistory).toHaveLength(1);
    const exit = second?.phaseHistory[0];
    expect(exit?.phase).toBe('plan');
    expect(exit?.note).toBe('cycle-init');
    // exitedAt 必须是真实可解析时间戳（不是占位/伪造串）
    expect(Number.isFinite(Date.parse(exit?.exitedAt ?? ''))).toBe(true);
  });
});

describe('② 技能 init-cycle.mjs：与 host 同语义（真 spawn 黑盒）', () => {
  it('新号前移 → plan/cycle-4 + 旧相(test)留痕；同号幂等 → 状态文件字节不动', () => {
    const root = mkTmp();
    mkdirSync(join(root, '.cycles', 'cycles', 'cycle-3'), { recursive: true });
    writeFileSync(statePath(root), JSON.stringify({
      currentPhase: 'test', currentCycle: 'cycle-3', phaseHistory: [], nodeStatus: {},
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2));

    const run = spawnSync(process.execPath, [SKILL_SCRIPT, root], { encoding: 'utf-8' });
    expect(run.status, run.stderr).toBe(0);

    const state = readState(root);
    expect(state.currentPhase).toBe('plan');
    expect(state.currentCycle).toBe('cycle-4');
    const history = state.phaseHistory as Array<{ phase?: string; exitedAt?: string; note?: string }>;
    expect(history).toHaveLength(1);
    expect(history[0]?.phase).toBe('test');
    expect(history[0]?.note).toBe('cycle-init');
    expect(Number.isFinite(Date.parse(history[0]?.exitedAt ?? ''))).toBe(true);

    // 三条防御线之「同号幂等」不得被本轮改动破坏
    const before = readFileSync(statePath(root), 'utf-8');
    const again = spawnSync(process.execPath, [SKILL_SCRIPT, root, '--cycle', '4'], { encoding: 'utf-8' });
    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(statePath(root), 'utf-8')).toBe(before);
  });
});

describe('③ closeCycle：门禁账本全 PASS → 相位逐相推进到 maintain', () => {
  it('build + G0-G3 PASS → maintain，phaseAdvanced=true，phaseHistory 逐相留痕', () => {
    const root = mkTmp();
    writeGraph(root);
    seedMacro(root, 'build');
    seedGates(root, ALL_GATES);

    const res = closeCycle(join(root, '.cycles'), 77);
    expect(res).toMatchObject({
      phaseFrom: 'build', phaseTo: 'maintain', phaseAdvanced: true,
      ok: true, gatesPassed: true, ledgerValid: true,
    });
    expect(res.phaseBlockedBy).toBeUndefined();

    const after = loadMacroState(root);
    expect(after?.currentPhase).toBe('maintain');
    expect(after?.currentCycle).toBe('cycle-77');
    // 旧留痕 plan 保留 + 本次逐相退出 build/test/deploy（maintain 未退出，不写 exitedAt）
    expect(after?.phaseHistory.map((h) => h.phase)).toEqual(['plan', 'build', 'test', 'deploy']);
    for (const h of after?.phaseHistory ?? []) {
      expect(Number.isFinite(Date.parse(h.exitedAt ?? ''))).toBe(true);
    }
  });
});

describe('④ closeCycle：缺门禁 PASS → 零推进 + 零写入 + 点名缺门', () => {
  it('只有 G0-G2 PASS（缺 G3）→ phaseAdvanced=false、相位不动、原因点名 G3', () => {
    const root = mkTmp();
    writeGraph(root);
    seedMacro(root, 'build');
    seedGates(root, ['G0', 'G1', 'G2']);
    const before = readFileSync(statePath(root), 'utf-8');

    const res = closeCycle(join(root, '.cycles'), 78);
    expect(res.phaseAdvanced).toBe(false);
    expect(res.phaseFrom).toBe('build');
    expect(res.phaseTo).toBe('build');
    expect(res.phaseBlockedBy).toBe('G3');
    expect(res.phaseReason).toContain('G3');
    // 零相位写入纪律：状态文件字节完全未动
    expect(readFileSync(statePath(root), 'utf-8')).toBe(before);
  });
});

describe('⑤ 幂等：同 cycle 二次 close 不再改相位', () => {
  it('第一次推进到 maintain，第二次零写入且 phaseAdvanced=false', () => {
    const root = mkTmp();
    writeGraph(root);
    seedMacro(root, 'build');
    seedGates(root, ALL_GATES);

    expect(closeCycle(join(root, '.cycles'), 77).phaseAdvanced).toBe(true);
    const afterFirst = readFileSync(statePath(root), 'utf-8');

    const second = closeCycle(join(root, '.cycles'), 77);
    expect(second.phaseAdvanced).toBe(false);
    expect(second.phaseFrom).toBe('maintain');
    expect(second.phaseTo).toBe('maintain');
    expect(readFileSync(statePath(root), 'utf-8')).toBe(afterFirst);
  });
});

describe('⑧ 双证据源可见：节点账空 ≠ 门禁未过（自举协议与 play 协议分开报告）', () => {
  /** 带 gate 节点的最小图：节点未批准 ⇒ checkStrict 失败（真实工作区的形态）。 */
  function writeGraphWithGate(root: string): void {
    mkdirSync(join(root, '.cycles'), { recursive: true });
    writeFileSync(join(root, '.cycles', 'workflow-graph.yaml'), [
      'nodes:',
      '  - id: gate-g0',
      '    type: gate',
      '    label: "G0 评估门"',
      '  - id: build',
      '    type: phase',
      '    label: "Build（构建）"',
      '',
    ].join('\n'));
  }

  it('门禁账本全 PASS + 节点状态空 → ok=false 但 gatesLedgerPassed=true、closeEvidence=gate-ledger、相位照常推进', () => {
    const root = mkTmp();
    writeGraphWithGate(root);
    seedMacro(root, 'build'); // nodeStatus 为空 —— 自举循环从不跑 play 协议
    seedGates(root, ALL_GATES);

    const res = closeCycle(join(root, '.cycles'), 77);
    expect(res.ok).toBe(false); // 节点级证据缺席，不假绿
    expect(res.gatesPassed).toBe(false);
    expect(res.ledgerValid).toBe(true);
    expect(res.gatesLedgerPassed).toBe(true); // 门禁账本是真证据
    expect(res.closeEvidence).toBe('gate-ledger'); // 谁在支撑本次结论 —— 点名
    expect(res.phaseAdvanced).toBe(true); // 相位只认门禁账本（缺口本身）
    expect(loadMacroState(root)?.currentPhase).toBe('maintain');
  });

  it('反例：账本缺 G3 → gatesLedgerPassed=false、closeEvidence=none、零推进', () => {
    const root = mkTmp();
    writeGraphWithGate(root);
    seedMacro(root, 'build');
    seedGates(root, ['G0', 'G1', 'G2']);
    const res = closeCycle(join(root, '.cycles'), 78);
    expect(res.gatesLedgerPassed).toBe(false);
    expect(res.closeEvidence).toBe('none');
    expect(res.phaseAdvanced).toBe(false);
    expect(loadMacroState(root)?.currentPhase).toBe('build');
  });
});

describe('⑦ /anic/cycle/close 路由：新字段透传（响应即结果对象，无裁剪）', () => {
  /** 用桩宿主注册路由并真调一次 handler，返回响应体。 */
  async function callClose(root: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const { registerCycleRoute } = await import('../../src/host/routes/cycleRoute.ts');
    const registered: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = [];
    const ctx = { webServer: { register: (r: { path: string; handler: (req: unknown, res: unknown) => void }) => { registered.push(r); return () => {}; } } };
    const captured: Array<{ status: number; body: Record<string, unknown> }> = [];
    registerCycleRoute(ctx, {
      send: (_res: unknown, status: number, body: unknown) => { captured.push({ status, body: body as Record<string, unknown> }); },
      getWorkspaceRoot: () => root,
    });
    const hit = registered.find((r) => r.path === '/anic/cycle/close');
    expect(hit, 'route /anic/cycle/close 已注册').toBeDefined();
    hit!.handler({ method: 'POST', url: '/anic/cycle/close', headers: {}, body: JSON.stringify({ cycleNumber: 77 }) }, {});
    await new Promise((r) => setTimeout(r, 20));
    return captured.at(-1)!;
  }

  it('推进场景：body 含 phaseFrom/phaseTo/phaseAdvanced/phaseReason，既有四字段仍在', async () => {
    const root = mkTmp();
    writeGraph(root);
    seedMacro(root, 'build');
    seedGates(root, ALL_GATES);
    const { status, body } = await callClose(root);
    expect(status).toBe(200);
    expect(body.phaseFrom).toBe('build');
    expect(body.phaseTo).toBe('maintain');
    expect(body.phaseAdvanced).toBe(true);
    expect(typeof body.phaseReason).toBe('string');
    // 既有字段零破坏（只增字段）
    for (const key of ['ok', 'gatesPassed', 'ledgerValid']) expect(body).toHaveProperty(key);
  });

  it('被卡场景：phaseBlockedBy 经路由透出（不被裁剪）', async () => {
    const root = mkTmp();
    writeGraph(root);
    seedMacro(root, 'build');
    seedGates(root, ['G0', 'G1', 'G2']);
    const { status, body } = await callClose(root);
    expect(status).toBe(200); // ok 由节点账决定（本夹具无 gate 节点 ⇒ ok true）
    expect(body.phaseAdvanced).toBe(false);
    expect(body.phaseBlockedBy).toBe('G3');
  });
});

describe('⑥ 反向自检：篡改门禁证据 → ③ 的绿必须变红（同夹具差分）', () => {
  it('同夹具：干净账本推进到 maintain；篡改末条 PASS→FAIL（不重算 hash）后必须不推进', () => {
    // 正对照：同一夹具、干净账本 ⇒ 必须推进（否则本用例对"永不推进"的重实现免疫）
    const clean = mkTmp();
    writeGraph(clean);
    seedMacro(clean, 'build');
    seedGates(clean, ALL_GATES);
    const cleanRes = closeCycle(join(clean, '.cycles'), 77);
    expect(cleanRes.phaseAdvanced).toBe(true);
    expect(cleanRes.phaseTo).toBe('maintain');

    // 反对照：唯一差异 = 末条 PASS 被篡改成 FAIL
    const root = mkTmp();
    writeGraph(root);
    seedMacro(root, 'build');
    seedGates(root, ALL_GATES);
    const ledgerPath = join(root, '.cycles', 'gates', 'ledger.json');
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { entries: Array<{ result: string }> };
    raw.entries[raw.entries.length - 1]!.result = 'FAIL';
    writeFileSync(ledgerPath, JSON.stringify(raw, null, 2));

    const res = closeCycle(join(root, '.cycles'), 77);
    expect(res.phaseAdvanced).toBe(false);
    expect(res.phaseTo).toBe('build');
    expect(res.phaseBlockedBy).toBe('G3');
    expect(res.ledgerValid).toBe(false); // 篡改同时断了哈希链（证明改动真的落盘）
    expect(loadMacroState(root)?.currentPhase).toBe('build');
  });
});
