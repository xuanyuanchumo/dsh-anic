/**
 * 跨项目 init 诚实性契约（cycle-101 · 「假装成功」缺陷回归钉）。
 *
 * ## 被守卫的缺陷（真机实测）
 *
 * 旧实现 `if (action === 'init') { mkdirSync(targetCyclesDir); return finish({}) }` ——
 * 只建空目录就返回 `ok: true`。调用方拿到 200 却会发现目标项目里：
 * 没有 config.yml、没有 intent/、连 `workflow-state status` 都跑不起来。
 * 这比失败更坏：**它让人以为自举成功了**。
 *
 * ## 判定
 *
 * init 结果必须带 `initOk` 与 `artifacts{config,intent,cycles}` 三读数，
 * 且脚本不可用时必须**响亮失败**（412 + 可执行 remedy），不得静默报 ok。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src', 'host', 'runtime', 'crossBootstrapInit.ts');

describe('跨项目 init 诚实性（cycle-101）', () => {
  const text = readFileSync(SRC, 'utf-8');

  it('① init 分支必须真正执行 init-workflow 脚本（不是只 mkdir）', () => {
    // 定位 init 分支
    const start = text.indexOf("export function runCrossInit");
    expect(start, 'runCrossInit 实现存在').toBeGreaterThan(0);
    const branch = text.slice(start, start + 2000);
    expect(branch, 'init 分支必须 spawn 脚本').toContain('spawnSync');
    expect(branch, 'init 分支必须指向 init-workflow.mjs').toContain('init-workflow.mjs');
    // 反向：不允许「只 mkdir 就 finish」的旧形态
    expect(branch).not.toMatch(/mkdirSync\([^)]*\);\s*\n\s*return finish\(\{\}\);/);
  });

  it('② init 结果必须带诚实读数（initOk + artifacts 三键）', () => {
    const start = text.indexOf("export function runCrossInit");
    const branch = text.slice(start, start + 2000);
    expect(branch).toContain('initOk');
    expect(branch).toContain('initExitCode');
    expect(branch).toContain('artifacts');
    expect(branch).toContain("config: existsSync");
    expect(branch).toContain("intent: existsSync");
    expect(branch).toContain("cycles: existsSync");
  });

  it('③ 脚本缺失必须响亮失败（412 + remedy），不得静默 ok', () => {
    const start = text.indexOf("export function runCrossInit");
    const branch = text.slice(start, start + 2000);
    expect(branch).toContain('ANIC_CROSS_INIT_SCRIPT_MISSING');
    expect(branch).toContain('remedy');
    expect(branch, '脚本缺失分支必须先于 spawn 返回').toMatch(/if \(!existsSync\(initScript\)\)[\s\S]{0,400}return \{/);
  });

  it('④ windowsHide 必带（循环体一律不弹控制台窗口）', () => {
    const start = text.indexOf("export function runCrossInit");
    const branch = text.slice(start, start + 2000);
    expect(branch).toContain('windowsHide: true');
  });
});
