/**
 * 自主级升级契约（cycle-77 T4-B）—— 拒绝矩阵 + 成功写盘 + Post-Verify + 留痕。
 *
 * 被守卫缺陷：升级此前**没有任何入口**（只有 anic_autonomy_downgrade），
 * 要让工作区升到 L4 只能手改 `.cycles/config.yml`：无前置判定、无回读断言、
 * 无审计记录 ⇒ 「人类授权的 L4」与「偷偷改配置」在磁盘上无法区分。
 *
 * 本套件全部在 tmp 工作区真跑（真 config + 真账本 + 真 history），不 mock IO
 * （唯一例外：Post-Verify 用例需要篡改写盘结果，用 vi.doMock 精确注入）。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgradeAutonomy } from '../../src/host/evolution/autonomyUpgrade.ts';
import { runAutonomyFallback } from '../../src/host/evolution/autonomyActions.ts';
import { appendEntry } from '../../src/host/runtime/ledger.ts';
import { readHistory, historyPath } from '../../src/host/evolution/autonomyHistory.ts';
import { UPGRADE_THRESHOLDS } from '../../src/host/evolution/trustModel.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, 'tmp-autonomy-upgrade');
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 并发清理容忍 */ } });

let seq = 0;

interface WsOptions {
  /** config.yml 中的当前档（null = 不写 config） */
  band?: string | null;
  /** 账本条目结果序列（写入 .cycles/gates/ledger.json）；空数组 = 无账本 */
  ledger?: Array<'PASS' | 'FAIL'>;
  /** incidents 文件名（熔断信号采集只看文件名） */
  incidents?: string[];
}

/** 建一个 tmp 工作区（真文件，不 stub）。 */
function makeWorkspace(opts: WsOptions = {}): string {
  const root = join(TMP, `ws-${String(++seq)}`);
  const cycles = join(root, '.cycles');
  mkdirSync(cycles, { recursive: true });
  if (opts.band !== null) {
    writeFileSync(join(cycles, 'config.yml'), `macro_cycle:\n  autonomy_level: ${opts.band ?? 'L2'}\n`, 'utf-8');
  }
  for (const [i, result] of (opts.ledger ?? []).entries()) {
    // detail 必须非空：CB2（gate_doubt）的判据是「FAIL 且 detail 空/ambiguous」，
    // 空 detail 会让「信任分低」用例被熔断规则抢先拒绝，测不到想测的前置条件。
    appendEntry(cycles, { gate: `G${String(i % 4)}`, gateName: `gate ${String(i)}`, result, detail: 'checked' });
  }
  if (opts.incidents && opts.incidents.length > 0) {
    const dir = join(cycles, 'incidents');
    mkdirSync(dir, { recursive: true });
    for (const name of opts.incidents) writeFileSync(join(dir, name), 'x', 'utf-8');
  }
  return root;
}

const bandOf = (root: string): string | null => {
  const m = /autonomy_level:\s*["']?(L[1-4])/.exec(readFileSync(join(root, '.cycles', 'config.yml'), 'utf-8'));
  return m?.[1] ?? null;
};

const ALL_PASS: Array<'PASS'> = ['PASS', 'PASS', 'PASS', 'PASS'];
const ALL_FAIL: Array<'FAIL'> = ['FAIL', 'FAIL', 'FAIL', 'FAIL'];

describe('拒绝矩阵：每一条都点名缺哪个前置条件，且零写入', () => {
  it('config 缺失 → config_missing（连 .cycles 都不创建）', () => {
    const root = makeWorkspace({ band: null });
    const r = upgradeAutonomy(root, { target: 'L3', reason: 'r' });
    expect(r.action).toBe('refused');
    expect(r.missingPreconditions.map((m) => m.code)).toContain('config_missing');
    expect(existsSync(join(root, '.cycles', 'config.yml'))).toBe(false);
    expect(existsSync(historyPath(join(root, '.cycles')))).toBe(false);
  });

  it('跳档 L2→L4 → 只点名 target_not_adjacent（不拿未定义的阈值/未到达的档位凑理由）', () => {
    const root = makeWorkspace({ band: 'L2', ledger: ALL_PASS });
    const r = upgradeAutonomy(root, { target: 'L4', reason: 'r' });
    expect(r.missingPreconditions.map((m) => m.code)).toEqual(['target_not_adjacent']);
    expect(r.threshold).toBeNull(); // L2_to_L4 无阈值定义：如实为 null，不编造数字
    expect(bandOf(root)).toBe('L2');
  });

  it('L3→L4 无人类授权 → human_authorization_required（信任分满级也不行）', () => {
    const root = makeWorkspace({ band: 'L3', ledger: ALL_PASS });
    const r = upgradeAutonomy(root, { target: 'L4', reason: '自动提升' });
    expect(r.action).toBe('refused');
    expect(r.missingPreconditions.map((m) => m.code)).toEqual(['human_authorization_required']);
    expect(r.trust.verdict).toBe('sufficient');
    expect(bandOf(root)).toBe('L3');
  });

  it('reason 为空 → reason_required（审计记录不能没有理由）', () => {
    const root = makeWorkspace({ band: 'L2', ledger: ALL_PASS });
    const r = upgradeAutonomy(root, { target: 'L3', reason: '   ' });
    expect(r.missingPreconditions.map((m) => m.code)).toContain('reason_required');
  });

  it('熔断未复位 → breaker_tripped（有熔断时不升级，与降级逻辑同源）', () => {
    const root = makeWorkspace({
      band: 'L3', ledger: ALL_PASS,
      incidents: ['auto-fix-fail-1.md', 'auto-fix-fail-2.md', 'auto-fix-fail-3.md'],
    });
    const r = upgradeAutonomy(root, { target: 'L4', reason: '人类授权', humanAuthorized: true });
    const codes = r.missingPreconditions.map((m) => m.code);
    expect(codes).toContain('breaker_tripped');
    expect(r.trippedBreakers).toContain('consecutive_fix_fail');
    expect(bandOf(root)).toBe('L3');
  });

  it('信任分不足且无人类授权 → trust_below_threshold（阈值来自单一事实源）', () => {
    const root = makeWorkspace({ band: 'L2', ledger: ALL_FAIL });
    const r = upgradeAutonomy(root, { target: 'L3', reason: 'r' });
    expect(r.missingPreconditions.map((m) => m.code)).toContain('trust_below_threshold');
    expect(r.threshold).toBe(UPGRADE_THRESHOLDS.L2_to_L3);
    expect(r.trust.avg).toBe(0);
    expect(r.trust.verdict).toBe('insufficient');
    expect(bandOf(root)).toBe('L2');
    expect(existsSync(historyPath(join(root, '.cycles')))).toBe(false);
  });

  it('非法 target → target_not_allowed（schema enum 之外的运行时旁路）', () => {
    const root = makeWorkspace({ band: 'L2', ledger: ALL_PASS });
    const r = upgradeAutonomy(root, { target: 'L5', reason: 'r' });
    expect(r.missingPreconditions.map((m) => m.code)).toContain('target_not_allowed');
  });
});

describe('成功路径：改 config + 回读断言 + history 留痕', () => {
  it('L2→L3（信任 100 ≥ 70）→ upgraded，observed 回读为 L3，history 记 system', () => {
    const root = makeWorkspace({ band: 'L2', ledger: ALL_PASS });
    const r = upgradeAutonomy(root, { target: 'L3', reason: '门禁连续全绿' });
    expect(r.action).toBe('upgraded');
    expect(r.from).toBe('L2');
    expect(r.observed).toBe('L3');
    expect(r.authorization).toBe('system');
    expect(r.historyRecorded).toBe(true);
    expect(bandOf(root)).toBe('L3'); // 磁盘事实
    const hist = readHistory(join(root, '.cycles'));
    expect(hist.error).toBeNull();
    expect(hist.entries).toHaveLength(1);
    expect(hist.entries[0]).toMatchObject({ from: 'L2', to: 'L3', authorization: 'system', actor: 'anic_autonomy_upgrade' });
    expect(hist.entries[0]?.evidence.trust.avg).toBe(100);
  });

  it('L3→L4（人类授权）→ upgraded，history 记 human + atCycle（存在 cycle 目录时）', () => {
    const root = makeWorkspace({ band: 'L3', ledger: ALL_PASS });
    mkdirSync(join(root, '.cycles', 'cycles', 'cycle-77'), { recursive: true });
    const r = upgradeAutonomy(root, { target: 'L4', reason: '用户明确要求 L4 全自主', humanAuthorized: true });
    expect(r.action).toBe('upgraded');
    expect(r.observed).toBe('L4');
    expect(r.authorization).toBe('human');
    const e = readHistory(join(root, '.cycles')).entries[0];
    expect(e?.authorization).toBe('human');
    expect(e?.atCycle).toBe(77);
    expect(e?.trustExemption).toBeUndefined(); // 信任分足够时不该出现豁免记录
  });

  it('信任分不足但人类显式承担 → 升级成功且豁免事实入账（trustExemption）', () => {
    const root = makeWorkspace({ band: 'L3', ledger: ALL_FAIL });
    const r = upgradeAutonomy(root, { target: 'L4', reason: '人类显式承担风险', humanAuthorized: true });
    expect(r.action).toBe('upgraded');
    expect(r.trust.verdict).toBe('exempt-by-human');
    expect(bandOf(root)).toBe('L4');
    const e = readHistory(join(root, '.cycles')).entries[0];
    expect(e?.trustExemption).toEqual({ avg: 0, threshold: UPGRADE_THRESHOLDS.L3_to_L4 });
  });

  it('record=false → 升级照做但如实标记审计缺口（不伪造 history）', () => {
    const root = makeWorkspace({ band: 'L2', ledger: ALL_PASS });
    const r = upgradeAutonomy(root, { target: 'L3', reason: '演练', record: false });
    expect(r.action).toBe('upgraded');
    expect(r.historyRecorded).toBe(false);
    expect(r.reason).toContain('AUDIT GAP');
    expect(existsSync(historyPath(join(root, '.cycles')))).toBe(false);
  });

  it('history 坏账 → config 已改但动作判 failed（无审计记录不算成功），坏账原文保留', () => {
    const root = makeWorkspace({ band: 'L2', ledger: ALL_PASS });
    const path = historyPath(join(root, '.cycles'));
    writeFileSync(path, '{"broken":', 'utf-8');
    const r = upgradeAutonomy(root, { target: 'L3', reason: 'r' });
    expect(r.action).toBe('upgrade-failed');
    expect(r.missingPreconditions.map((m) => m.code)).toContain('history_unrecorded');
    expect(bandOf(root)).toBe('L3'); // 已发生的事实不伪造回滚
    expect(readFileSync(path, 'utf-8')).toBe('{"broken":');
  });
});

describe('Post-Verify：回读不一致即失败，且不得写「已完成」记录', () => {
  it('写盘被篡改（observed≠intent）→ upgrade-failed + 零 history', async () => {
    vi.resetModules();
    vi.doMock('../../src/shared/fs-safe.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/shared/fs-safe.ts')>();
      return {
        ...actual,
        // 精确注入：把 config 写盘结果回退成原值（模拟「写入未生效」），
        // 其余写盘（history 等）不受影响 —— 只有回读断言能发现这件事。
        atomicWriteFileSync: (p: string, c: string) => {
          actual.atomicWriteFileSync(p, p.endsWith('config.yml') ? c.replace('autonomy_level: L4', 'autonomy_level: L3') : c);
        },
      };
    });
    const { upgradeAutonomy: upgradeWithMock } = await import('../../src/host/evolution/autonomyUpgrade.ts');
    const root = makeWorkspace({ band: 'L3', ledger: ALL_PASS });
    const r = upgradeWithMock(root, { target: 'L4', reason: '人类授权', humanAuthorized: true });
    expect(r.action).toBe('upgrade-failed');
    expect(r.observed).toBe('L3');
    expect(r.reason).toContain('post-verify');
    expect(existsSync(historyPath(join(root, '.cycles')))).toBe(false); // 不得写「已完成」
    vi.doUnmock('../../src/shared/fs-safe.ts');
    vi.resetModules();
  });
});

describe('降级路径补留痕（PDF-0「降级无审计」的收口）', () => {
  it('熔断回退成功 → history 追加一条 system 记录（与升级同一账本）', () => {
    const root = makeWorkspace({
      band: 'L4', ledger: ALL_PASS,
      incidents: ['incident-H1-circuit.md'], // CB3：用户数据未隔离 → 严重熔断 → 降级
    });
    const r = runAutonomyFallback(root);
    expect(r.action).toBe('downgraded');
    expect(r.observedBand).toBe('L3');
    expect(r.historyRecorded).toBe(true);
    const hist = readHistory(join(root, '.cycles'));
    expect(hist.error).toBeNull();
    expect(hist.entries).toHaveLength(1);
    expect(hist.entries[0]).toMatchObject({ from: 'L4', to: 'L3', authorization: 'system', actor: 'anic_autonomy_downgrade' });
    expect(hist.entries[0]?.reason).toContain('user_data_unisolated');
  });

  it('无熔断 → maintained，零写入（history 不产生伪条目）', () => {
    const root = makeWorkspace({ band: 'L4', ledger: ALL_PASS });
    const r = runAutonomyFallback(root);
    expect(r.action).toBe('maintained');
    expect(existsSync(historyPath(join(root, '.cycles')))).toBe(false);
  });
});
