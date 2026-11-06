/**
 * 技能可见性读数单测（cycle-109）。
 *
 * 为什么值得单独测：这个叶子是「回读结论能不能被 HTTP/面板读到」的唯一桥。
 * 它若退化成一个空壳，`GET /anic/skill/health` 的 `runtimeSkill` 段就会恒 null，
 * 而「恒 null」在读者眼里与「从未回读」无法区分 —— 于是 D2 的修复会静默失效。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildSkillVisibilityReadout,
  readSkillVisibility,
  recordSkillVisibility,
  resetSkillVisibility,
} from '../../src/host/runtime/skillVisibilityState.ts';
import { resetSkillsChangeCount, noteSkillsChange } from '../../src/host/runtime/skillsChangeCounter.ts';

beforeEach((): void => { resetSkillVisibility(); resetSkillsChangeCount(); });

describe('record → read 回环', () => {
  it('未回读 ⇒ null（绝不伪造 active/absent）', () => {
    expect(readSkillVisibility()).toBeNull();
    expect(buildSkillVisibilityReadout()).toEqual({ last: null, skillsChangeEmits: 0 });
  });

  it('三态原样保留 + 时刻写入（读数不猜测）', () => {
    recordSkillVisibility({ name: 'ai-native-iteration-cycle', state: 'absent', reason: 'shadowed' }, '2026-11-06T00:00:00.000Z');
    const r = readSkillVisibility();
    expect(r?.state).toBe('absent');
    expect(r?.name).toBe('ai-native-iteration-cycle');
    expect(r?.at).toBe('2026-11-06T00:00:00.000Z');
  });

  it('source/provider 只在存在时出现（不写 undefined 键）', () => {
    recordSkillVisibility({ name: 'n', state: 'unknown', reason: 'x' });
    const r = readSkillVisibility();
    expect(r !== null && 'source' in r).toBe(false);
    expect(r !== null && 'provider' in r).toBe(false);
  });

  it('读出来的是**副本**（调用方改它不得污染状态）', () => {
    recordSkillVisibility({ name: 'n', state: 'active', reason: 'x', source: 'runtime' });
    const a = readSkillVisibility();
    if (a !== null) a.state = 'absent';
    expect(readSkillVisibility()?.state).toBe('active');
  });

  it('skills/change 计数透出（工具面/技能面观测对称的落点）', () => {
    noteSkillsChange();
    noteSkillsChange();
    expect(buildSkillVisibilityReadout().skillsChangeEmits).toBe(2);
  });
});