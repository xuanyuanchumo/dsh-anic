/**
 * 跨工作区自举（「举他」）契约（cycle-89）。
 *
 * ## 三条硬约束（每条对应一个可断言的事实，不是自述）
 *
 * 1. **源工作区零写入**：跨项目自举只在目标工作区写 `.cycles/**`；
 *    源工作区调用前后取指纹，**相同即证明未被触碰**。
 * 2. **目标工作区独立**：目标有自己的 `.cycles/`，不共享源的状态文件。
 * 3. **目标缺 `.cycles` → 明确初始化**，不静默跳过。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fingerprintCycles,
  sameFingerprint,
  resolveCrossTarget,
} from '../../src/host/runtime/crossBootstrap.ts';

/** 建临时工作区。 */
function mkWorkspace(name: string): { root: string; cycles: string } {
  const base = mkdtempSync(join(tmpdir(), `anic-cross-${name}-`));
  const root = join(base, 'ws');
  const cycles = join(root, '.cycles');
  mkdirSync(cycles, { recursive: true });
  writeFileSync(join(cycles, 'a.txt'), 'alpha');
  mkdirSync(join(cycles, 'sub'), { recursive: true });
  writeFileSync(join(cycles, 'sub', 'b.txt'), 'beta');
  return { root, cycles };
}

describe('fingerprintCycles：源零写入的凭据', () => {
  it('覆盖 `.cycles/**` 的全部文件（含嵌套目录）', () => {
    const ws = mkWorkspace('fp');
    const fp = fingerprintCycles(ws.cycles, ws.root);
    expect(fp.entries).toBe(2);
    expect(fp.cyclesOnly).toBe(true);
    rmSync(join(ws.root, '..'), { recursive: true, force: true });
  });

  it('**内容变化 → 指纹变化**（这正是「源被写了」的信号）', () => {
    const ws = mkWorkspace('fp2');
    const before = fingerprintCycles(ws.cycles, ws.root);
    writeFileSync(join(ws.cycles, 'a.txt'), 'ALPHA-CHANGED');
    const after = fingerprintCycles(ws.cycles, ws.root);
    expect(sameFingerprint(before, after)).toBe(false);
    rmSync(join(ws.root, '..'), { recursive: true, force: true });
  });

  it('**新增文件 → 指纹变化**', () => {
    const ws = mkWorkspace('fp3');
    const before = fingerprintCycles(ws.cycles, ws.root);
    writeFileSync(join(ws.cycles, 'new.txt'), 'x');
    const after = fingerprintCycles(ws.cycles, ws.root);
    expect(sameFingerprint(before, after)).toBe(false);
    expect(after.entries).toBe(before.entries + 1);
    rmSync(join(ws.root, '..'), { recursive: true, force: true });
  });

  it('无变化 → 指纹相同（幂等）', () => {
    const ws = mkWorkspace('fp4');
    const a = fingerprintCycles(ws.cycles, ws.root);
    const b = fingerprintCycles(ws.cycles, ws.root);
    expect(sameFingerprint(a, b)).toBe(true);
    rmSync(join(ws.root, '..'), { recursive: true, force: true });
  });

  it('目录不存在 → 空指纹（不是抛错）', () => {
    const fp = fingerprintCycles('/definitely-not-exist-xyz', '/definitely-not-exist-xyz');
    expect(fp.entries).toBe(0);
    expect(typeof fp.digest).toBe('string');
  });

  it('**只覆盖 .cycles（不含工作区其它部分）** —— 源指纹的范围纪律', () => {
    const ws = mkWorkspace('fp5');
    const before = fingerprintCycles(ws.cycles, ws.root);
    // 在 .cycles 之外写文件 —— 不影响指纹（跨项目自举不会写那里）。
    writeFileSync(join(ws.root, 'unrelated.txt'), 'noise');
    const after = fingerprintCycles(ws.cycles, ws.root);
    expect(sameFingerprint(before, after)).toBe(true);
    rmSync(join(ws.root, '..'), { recursive: true, force: true });
  });
});

describe('resolveCrossTarget：靶标解析', () => {
  it('绝对路径 + 存在的目录 → 解析成功', () => {
    const ws = mkWorkspace('resolve');
    const r = resolveCrossTarget(ws.root, null);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.targetRoot).toBe(ws.root);
      expect(r.target.targetCyclesDir).toBe(ws.cycles);
      // 目标没**自带**技能 → 来源必须标 'plugin'（哪怕 resolveSkillScriptsDir
      // 因 cwd/inline 回落命中了某个副本 —— 那也不是「目标自带」，标 'target' 是说谎）。
      expect(r.target.scriptsSource).toBe('plugin');
      expect(r.target.scriptsDir).not.toBe(join(ws.root, '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts'));
    }
    rmSync(join(ws.root, '..'), { recursive: true, force: true });
  });

  it('**相对路径 → 拒绝**（会随宿主 cwd 漂移，可能在错地方创建 .cycles/）', () => {
    const r = resolveCrossTarget('./relative/path', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.error).toBe('ANIC_CROSS_TARGET_RELATIVE');
  });

  it('不存在的路径 → 拒绝并给可执行建议', () => {
    const r = resolveCrossTarget('/definitely-not-exist-xyz-123', null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.error).toBe('ANIC_CROSS_TARGET_MISSING');
      expect(r.failure.remedy.length).toBeGreaterThan(0);
    }
  });

  it('空串 → 拒绝', () => {
    const r = resolveCrossTarget('', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.error).toBe('ANIC_CROSS_TARGET_MISSING');
  });

  it('**目标 == 源 → 拒绝**（那是自举自己，不是「举他」）', () => {
    const ws = mkWorkspace('same');
    const r = resolveCrossTarget(ws.root, ws.root);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.error).toBe('ANIC_CROSS_TARGET_MISSING');
      expect(r.failure.remedy).toContain('/anic/self/evaluate');
    }
    rmSync(join(ws.root, '..'), { recursive: true, force: true });
  });

  it('目标存在但不是目录 → 拒绝', () => {
    const base = mkdtempSync(join(tmpdir(), 'anic-cross-file-'));
    const file = join(base, 'afile');
    writeFileSync(file, 'x');
    const r = resolveCrossTarget(file, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.error).toBe('ANIC_CROSS_TARGET_NOT_DIR');
    rmSync(base, { recursive: true, force: true });
  });
});
