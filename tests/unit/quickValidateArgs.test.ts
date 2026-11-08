/**
 * quick-validate 参数规范化（cycle-112）—— 无参调用不得把项目根当技能目录。
 *
 * 被守卫缺陷（真机取证 2026-11-02，flow-tracker quick-validate 记录）：
 *   `anic_skill('quick-validate')` 无参 → 脚本收到 `[项目根]` 作 skill-dir →
 *   "Directory: D:\...\dsh-anic Total files: 10226 … VALIDATION FAILED: 65 error(s)"
 *   ⇒ 必 FAIL，被健康模型记成**脚本失败**（7/14 → degraded）。根因是**调用形态**
 *   不是脚本缺陷。修复：网关侧规范化参数（本函数），无参/旗标形态自动补技能根。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeQuickValidateArgs } from '../../src/host/skillQuickValidateArgs.ts';

function workspaceWithInstalledSkill(): string {
  const ws = mkdtempSync(join(tmpdir(), 'anic-qv-'));
  mkdirSync(join(ws, '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts'), { recursive: true });
  return ws;
}

describe('normalizeQuickValidateArgs', () => {
  it('无参 → 补省缺技能根绝对路径（不再传项目根）', () => {
    const ws = workspaceWithInstalledSkill();
    try {
      const out = normalizeQuickValidateArgs(ws, []);
      expect(out).toHaveLength(1);
      expect(out[0]).toBe(join(ws, '.dsh', 'skills', 'ai-native-iteration-cycle'));
      expect(out[0]).not.toBe(ws);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('首参是旗标 → 技能根在前、旗标原样保留', () => {
    const ws = workspaceWithInstalledSkill();
    try {
      const out = normalizeQuickValidateArgs(ws, ['--freshness']);
      expect(out).toEqual([join(ws, '.dsh', 'skills', 'ai-native-iteration-cycle'), '--freshness']);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('相对技能形态 assets/skill → 解析为已装副本根（原 cycle-39 语义保留）', () => {
    const ws = workspaceWithInstalledSkill();
    try {
      expect(normalizeQuickValidateArgs(ws, ['assets/skill'])).toEqual([join(ws, '.dsh', 'skills', 'ai-native-iteration-cycle')]);
      expect(normalizeQuickValidateArgs(ws, ['assets/skill/scripts'])).toEqual([join(ws, '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts')]);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('绝对路径 / 未知形态原样返回（不猜，交给脚本守卫）', () => {
    const abs = 'D:/some/skill-dir';
    expect(normalizeQuickValidateArgs('/tmp/nonexistent-ws', [abs])).toEqual([abs]);
    expect(normalizeQuickValidateArgs('/tmp/nonexistent-ws', ['not-a-flag'])).toEqual(['not-a-flag']);
  });
});