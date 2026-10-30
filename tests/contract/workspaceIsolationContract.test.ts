/**
 * 多项目隔离**接线**契约（cycle-89）—— 证明防线真的接在**取数路径**上，
 * 而不是只有一堆没人调用的纯函数。
 *
 * ## 为什么要有这层契约
 *
 * `workspaceGuard.ts` 的纯函数全绿，**不证明**面板真的用了它 ——
 * 一个从未被调用的守卫和一个接在出口上的守卫，测试上长得一样。
 *
 * 这层契约从**源码文本**层面钉死接线：守卫必须出现在 `usePanelFetch` 里，
 * 且出现在 `apply` **之前**（顺序错了 = 串味数据已经进了 store 再被丢弃，
 * 用户仍会看到一闪的错误数据）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const FETCH_SRC = join(ROOT, 'src', 'client', 'components', 'usePanelFetch.ts');
const GUARD_SRC = join(ROOT, 'src', 'client', 'components', 'workspaceGuard.ts');
const VIEW_SRC = join(ROOT, 'src', 'client', 'components', 'workspaceViewState.ts');

describe('防线接线：usePanelFetch 必须真的用守卫', () => {
  it('usePanelFetch 引入了 workspaceGuard', () => {
    const src = readFileSync(FETCH_SRC, 'utf-8');
    expect(src).toContain("from './workspaceGuard.ts'");
  });

  it('**acceptPayload 在 apply 之前被调用**（顺序是接线正确性的核心）', () => {
    const src = readFileSync(FETCH_SRC, 'utf-8');
    const guardAt = src.indexOf('acceptPayload(');
    const applyAt = src.indexOf('tgt.apply(json)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(applyAt).toBeGreaterThan(-1);
    // 载荷守卫必须在 apply 之前。
    expect(guardAt).toBeLessThan(applyAt);
  });

  it('**世代号检查也在 apply 之前**（在途丢弃先于写入）', () => {
    const src = readFileSync(FETCH_SRC, 'utf-8');
    const epochAt = src.indexOf('isCurrent(requestEpoch)');
    const applyAt = src.indexOf('tgt.apply(json)');
    expect(epochAt).toBeGreaterThan(-1);
    expect(epochAt).toBeLessThan(applyAt);
  });

  it('载荷被拒时**不 apply**（守卫有否决权）', () => {
    const src = readFileSync(FETCH_SRC, 'utf-8');
    // 守卫返回后必须 return（不能只是打个标记继续走）。
    expect(src).toMatch(/if \(!verdict\.accepted\) \{[\s\S]{0,200}?return;/);
  });

  it('**options 是可选参数**（既有调用方零改动 —— 回归红线）', () => {
    const src = readFileSync(FETCH_SRC, 'utf-8');
    expect(src).toMatch(/options: PanelFetchOptions = \{\}/);
    expect(src).toMatch(/export interface PanelFetchOptions/);
  });

  it('世代号守卫**跨 effect 存活**（放 ref 不放 effect 局部）', () => {
    const src = readFileSync(FETCH_SRC, 'utf-8');
    expect(src).toContain('useRef(createEpochGuard())');
  });
});

describe('守卫模块边界纪律', () => {
  it('workspaceGuard 是**纯函数**（无 DOM / clock / random）', () => {
    const src = readFileSync(GUARD_SRC, 'utf-8');
    expect(src).not.toMatch(/\bdocument\./);
    expect(src).not.toMatch(/\bDate\.now\(\)/);
    expect(src).not.toMatch(/Math\.random/);
  });

  it('**不 import host 代码**（client 与 host 是两条独立发版链）', () => {
    const src = readFileSync(GUARD_SRC, 'utf-8');
    expect(src).not.toContain('/host/');
    expect(src).not.toMatch(/from '\.\.\/\.\.\/host/);
  });

  it('视图态模块独立成文件且纯函数边界干净', () => {
    const src = readFileSync(VIEW_SRC, 'utf-8');
    expect(src).not.toMatch(/\bdocument\./);
    expect(src).not.toMatch(/Math\.random/);
  });

  it('**单文件 ≤250 行**（T3 机械守卫）', () => {
    for (const f of [FETCH_SRC, GUARD_SRC, VIEW_SRC]) {
      const lines = readFileSync(f, 'utf-8').split('\n').length;
      expect(lines, `${f} 超过 250 行`).toBeLessThanOrEqual(250);
    }
  });
});
