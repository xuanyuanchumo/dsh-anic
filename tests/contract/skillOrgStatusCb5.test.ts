/**
 * 技能侧 CB5 契约（cycle-78 WS-F）：真实 band-history 形状下必须能触发熔断。
 *
 * 被守卫缺陷（fail-open，本轮实测）：`assets/skill/scripts/org-status.mjs` 的 CB5
 *   原实现：`const history = JSON.parse(...); if (history.snapshots.length < 2) …`
 *   而 `band-detector.mjs` 写入 `.cycles/band-history.json` 的是**裸数组** ⇒
 *   `snapshots` undefined ⇒ 取 `.length` 抛 TypeError ⇒ 被 `catch { triggered:false }`
 *   吞掉 ⇒ **技能侧 CB5 永不触发**。附带第二处死谓词 `s.status === 'OVER_BUDGET'`
 *   （没有任何生产者写过 status 字段）。
 *
 * 修法（与宿主侧 src/host/evolution/breakerSignals.ts 逐字同语义）：
 *   容器归一（裸数组 / `{snapshots:[…]}` 包裹）→ 末 2 条 `band==='alarm'` 或
 *   `overBudgetCount>0` 才触发；不足 2 条 / 坏 JSON / 非数组 → 不触发不抛。
 *
 * 本套件**真 spawn** 技能脚本 `auto-fallback`（CB5 只在自动回退流程里被求值），
 * 断言的是真实输出行 `[TRIGGERED] CB5` / `[OK] CB5`，而不是静态字符串匹配。
 * ⑥ 反向自检用 `git show HEAD:…` 复制**旧实现**跑同一夹具：旧版必须判 OK，
 * 否则说明夹具没有区分力（① 会成为永真断言）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS_DIR = join(ROOT, 'assets/skill/scripts');
const ORG_STATUS = join(SCRIPTS_DIR, 'org-status.mjs');

let ws: string;

beforeEach(() => {
  ws = join(tmpdir(), `anic-cb5-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(ws, '.cycles'), { recursive: true });
  // L4 才能观察「降级」：CB5 触发后 Phase 3 会回退到 L3（exit 2）
  writeFileSync(join(ws, '.cycles', 'config.yml'), 'autonomy_level: L4\n');
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

/** 真实生产形状（band-detector.mjs 写盘）：无 band 字段、无 status 字段。 */
function qualityEntry(overBudgetCount: number): Record<string, unknown> {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    totalScore: 1840,
    avgScore: 70.77,
    fileCount: 26,
    overBudgetCount,
  };
}

function writeBandHistory(raw: unknown): void {
  writeFileSync(join(ws, '.cycles', 'band-history.json'), typeof raw === 'string' ? raw : JSON.stringify(raw));
}

/** 跑 auto-fallback，返回 { code, out }（stdout+stderr 合并，便于断言真实文本）。 */
function runAutoFallback(script = ORG_STATUS, projectDir = ws): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [script, projectDir, 'auto-fallback'], { encoding: 'utf-8', timeout: 20000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** CB5 的判定行（脚本既有输出格式：`  [TRIGGERED] CB5: <name>` / `  [OK] CB5: <name>`）。 */
function cb5Line(out: string): string {
  return /^\s*\[(?:TRIGGERED|OK)\] CB5:.*$/m.exec(out)?.[0]?.trim() ?? '';
}

describe('① 真实形状末 2 条 overBudgetCount>0 → 技能侧 CB5 必须触发', () => {
  it('输出 [TRIGGERED] CB5、诊断点名超预算、执行降级（exit 2）', () => {
    writeBandHistory([qualityEntry(0), qualityEntry(3), qualityEntry(1)]);
    const r = runAutoFallback();
    expect(cb5Line(r.out), `CB5 未触发（旧实现下恒 [OK]）：\n${r.out}`).toBe('[TRIGGERED] CB5: 性能指标超预警阈值且1轮优化后仍未恢复');
    expect(r.out).toContain('Detail: Complexity over budget for 2 consecutive cycles');
    expect(r.out).toContain('overBudgetCount=1');
    expect(r.out).toContain('Autonomy downgraded: L4 → L3');
    expect(r.code).toBe(2);
  });
});

describe('② 末 2 条 overBudgetCount=0 → 不触发（不误报）', () => {
  it('健康历史 → [OK] CB5 且 exit 0', () => {
    writeBandHistory([qualityEntry(2), qualityEntry(0), qualityEntry(0)]);
    const r = runAutoFallback();
    expect(cb5Line(r.out)).toBe('[OK] CB5: 性能指标超预警阈值且1轮优化后仍未恢复');
    expect(r.out).toContain('No circuit breaker conditions triggered');
    expect(r.code).toBe(0);
  });
});

describe('③ 只有最后 1 条超预算 → 不触发（「连续 2 轮」语义）', () => {
  it('单轮超预算不等于连续两轮', () => {
    writeBandHistory([qualityEntry(0), qualityEntry(0), qualityEntry(5)]);
    expect(cb5Line(runAutoFallback().out)).toBe('[OK] CB5: 性能指标超预警阈值且1轮优化后仍未恢复');
  });
});

describe('④ 形状兼容：{snapshots:[…]} 包裹 / 自主带 band=alarm → 均触发', () => {
  it('snapshots 包裹形状归一后触发', () => {
    writeBandHistory({ snapshots: [qualityEntry(0), qualityEntry(4), qualityEntry(2)] });
    expect(cb5Line(runAutoFallback().out)).toBe('[TRIGGERED] CB5: 性能指标超预警阈值且1轮优化后仍未恢复');
  });

  it('自主带形状 band=alarm×2 仍触发（向后兼容），且诊断如实说明形状来源', () => {
    writeBandHistory([{ band: 'stable' }, { band: 'alarm' }, { band: 'alarm' }]);
    const r = runAutoFallback();
    expect(cb5Line(r.out)).toBe('[TRIGGERED] CB5: 性能指标超预警阈值且1轮优化后仍未恢复');
    expect(r.out).toContain('自主带快照 band=alarm');
  });
});

describe('⑤ fail-safe：坏 JSON / 非数组 / 不足 2 条 → 不触发、不抛、exit 0', () => {
  it('坏 JSON → [OK] CB5，进程不崩（采集失败不等于熔断）', () => {
    writeBandHistory('[broken');
    const r = runAutoFallback();
    expect(cb5Line(r.out)).toBe('[OK] CB5: 性能指标超预警阈值且1轮优化后仍未恢复');
    expect(r.code).toBe(0);
  });

  it('非数组（对象无 snapshots）/ 只有 1 条 → 均不触发', () => {
    writeBandHistory({ foo: [] });
    expect(cb5Line(runAutoFallback().out)).toContain('[OK] CB5');
    writeBandHistory([qualityEntry(9)]);
    expect(cb5Line(runAutoFallback().out)).toContain('[OK] CB5');
  });

  it('overBudgetCount 非数字（字符串/布尔/null）→ 不触发（不做隐式转换）', () => {
    writeBandHistory([{ overBudgetCount: '3' }, { overBudgetCount: true }, { overBudgetCount: null }]);
    expect(cb5Line(runAutoFallback().out)).toContain('[OK] CB5');
  });
});

describe('⑥ 反向自检：把「质量带」判据回退成只认 band → ① 必红（证明旧版真 fail-open）', () => {
  it('回退副本在真实形状夹具上仍 [OK] CB5，新实现同夹具 [TRIGGERED]', () => {
    // 为什么用「源码变异」而不是 `git show HEAD`：cycle-78 的修复已随 ad14e22 提交，
    // HEAD 现在是**已修**版本——历史锚点会随每次 commit 腐烂（本轮实测：HEAD 版反向
    // 自检从绿变红，而缺陷其实早已修好）。变异副本与 git 历史无关，永远有效；锚点
    // 断言保证「判据形态变了就红」，不会退化成静默失效。
    const legacyDir = join(tmpdir(), `anic-cb5-legacy-${Date.now()}`);
    mkdirSync(legacyDir, { recursive: true });
    cpSync(SCRIPTS_DIR, join(legacyDir, 'scripts'), { recursive: true });
    const legacyScript = join(legacyDir, 'scripts', 'org-status.mjs');
    const src = readFileSync(legacyScript, 'utf-8');
    const qualityBranch = /  return typeof entry\.overBudgetCount === 'number' && entry\.overBudgetCount > 0; \/\/ 质量带形状/;
    expect(qualityBranch.test(src), 'CB5 判据形态已变——请同步本反向自检锚点').toBe(true);
    writeFileSync(legacyScript, src.replace(qualityBranch, '  return false; // LEGACY: 只认 band 字段'));

    try {
      // 真实生产形状：旧判据（只认 band）→ 恒 [OK]（fail-open 实锤）
      writeBandHistory([qualityEntry(0), qualityEntry(3), qualityEntry(1)]);
      const legacy = runAutoFallback(legacyScript);
      expect(cb5Line(legacy.out), `回退版竟触发 CB5，夹具失去区分力：\n${legacy.out}`).toContain('[OK] CB5');
      expect(legacy.code).toBe(0);
      // 新实现同夹具触发 ⇒ ① 在旧实现下必红（不是新旧都成立的永真断言）
      expect(cb5Line(runAutoFallback().out)).toContain('[TRIGGERED] CB5');
      // 回退版在自主带夹具上仍触发 ⇒ 变异点确实在「质量带判据」，不是把整个 CB5 关掉
      writeBandHistory([{ band: 'stable' }, { band: 'alarm' }, { band: 'alarm' }]);
      expect(cb5Line(runAutoFallback(legacyScript).out)).toContain('[TRIGGERED] CB5');
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
