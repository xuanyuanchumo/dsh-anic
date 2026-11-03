/**
 * 工具注册 last-good 回退契约（cycle-99 · 借鉴 dsh-ops session-shells:177-193）。
 *
 * 场景：热重载时新代码的工具注册抛错——若没有兜底，该工具从宿主消失，
 * 依赖它的会话立刻断链。last-good 语义：回退重注册**上一次成功的定义**，
 * 双重失败才向上抛。首注册（无 last-good）失败必须响亮（不许静默吞）。
 */
import { describe, it, expect } from 'vitest';
import { createFaceRecorder } from '../../src/host/toolFaceRecorder.ts';
import type { ToolsSlot, ToolRegistration } from '../../src/host/toolsSlot.ts';

/** 构造可控注册槽：按脚本逐次决定成功/失败，记录全部注册调用。 */
function makeSlot(script: Array<'ok' | 'fail'>): { slot: ToolsSlot; calls: string[] } {
  let i = 0;
  const calls: string[] = [];
  const slot = {
    register: (t: ToolRegistration): (() => void) | null => {
      calls.push(`${t.name}@${String(i)}`);
      const step = script[i];
      i += 1;
      if (step === 'fail') throw new Error(`register failed for ${t.name}`);
      return (): void => {};
    },
  } as unknown as ToolsSlot;
  return { slot, calls };
}

const GOOD: ToolRegistration = {
  name: 'anic_probe',
  description: 'good def',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ ok: true }),
};

describe('cycle-99 last-good 回退', () => {
  it('重注册失败 → 回退重注册上一次成功定义（faces 与注册序一致）', () => {
    const { slot, calls } = makeSlot(['ok', 'fail', 'ok']);
    const rec = createFaceRecorder(slot);
    const d1 = rec.reg(GOOD);
    expect(d1).not.toBeNull();
    // 重注册（新描述）失败 → 自动回退旧定义成功
    const d2 = rec.reg({ ...GOOD, description: 'broken def' });
    expect(d2).not.toBeNull();
    expect(calls).toEqual(['anic_probe@0', 'anic_probe@1', 'anic_probe@2']);
    // faces 末条被校正为 last-good 定义（不留幽灵面）
    const faces = rec.faces();
    expect(faces[faces.length - 1]?.description).toBe('good def');
  });

  it('首注册失败（无 last-good）→ 响亮抛错，不静默', () => {
    const { slot } = makeSlot(['fail']);
    const rec = createFaceRecorder(slot);
    expect(() => rec.reg(GOOD)).toThrow('register failed');
  });

  it('回退也失败（双重失败）→ 向上抛第二次错误', () => {
    const { slot } = makeSlot(['ok', 'fail', 'fail']);
    const rec = createFaceRecorder(slot);
    rec.reg(GOOD);
    expect(() => rec.reg({ ...GOOD, description: 'broken' })).toThrow('register failed');
  });

  it('正常重注册成功 → last-good 更新（faces 反映新定义）', () => {
    const { slot } = makeSlot(['ok', 'ok']);
    const rec = createFaceRecorder(slot);
    rec.reg(GOOD);
    rec.reg({ ...GOOD, description: 'v2 def' });
    const faces = rec.faces();
    expect(faces[faces.length - 1]?.description).toBe('v2 def');
  });
});
