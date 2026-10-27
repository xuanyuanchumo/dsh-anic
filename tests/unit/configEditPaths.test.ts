/**
 * 路径表与安全边界测试（cycle-82）。
 *
 * ## 为什么「路径可视化」必须有安全边界
 *
 * 用户诉求是「路径支持自定义可视化编辑」，但如果自定义路径请求不做校验，
 * 这个接口就变成**任意文件读取入口**——那不是诉求要的东西。边界三条：
 * 不含 `..`、realpath 后仍在 workspace 内、必须存在。三条各有独立失败形态，
 * 所以分别有用例（不能合成一条"非法"断言——那样无法定位是哪一档失效）。
 *
 * ## 纪律
 *
 * - 扫描集非空下限：路径表条目数必须可观，空表 = 假守卫；
 * - 反向自检：`isInside` 的路径段比较必须先证明它能区分 `/a/b` 与 `/a/bc`
 *   （字符串前缀匹配会把这个判成"在内部"——那是真实越权形态）；
 * - 真目录：用 mkdtemp 造真实工作区，realpath 语义只有真文件系统能验。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { collectPaths, isInside, resolveCustomPath } from '../../src/host/configEdit/paths.ts';

const TMP = mkdtempSync(join(tmpdir(), 'anic-paths-'));
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理竞态容忍 */ } });

/** 造一个最小真实工作区（.cycles + config.yml + artifacts）。 */
function makeWorkspace(name: string): string {
  const ws = join(TMP, name);
  mkdirSync(join(ws, '.cycles'), { recursive: true });
  mkdirSync(join(ws, '.cycles', 'gates'), { recursive: true });
  mkdirSync(join(ws, 'artifacts'), { recursive: true });
  writeFileSync(join(ws, '.cycles', 'config.yml'), 'project:\n  name: x\n', 'utf-8');
  writeFileSync(join(ws, '.cycles', 'gates', 'ledger.json'), '{"entries":[]}', 'utf-8');
  writeFileSync(join(ws, 'artifacts', 'workflow-snapshot.json'), '{}', 'utf-8');
  return ws;
}

describe('collectPaths：路径表结构', () => {
  const WS = makeWorkspace('ws-main');
  const table = collectPaths(WS);

  it('扫描集非空下限（空表 = 永久假绿）', () => {
    expect(table.entries.length).toBeGreaterThanOrEqual(15);
    expect(table.workspace).toBe(resolve(WS));
  });

  it('每条都有 id/labelKey/kind 且 id 唯一（客户端按 id 分组与复制）', () => {
    const ids = table.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of table.entries) {
      expect(e.id.length).toBeGreaterThan(0);
      expect(e.labelKey.startsWith('config.')).toBe(true);
      expect(e.kind === 'dir' || e.kind === 'file').toBe(true);
      expect(typeof e.source).toBe('string');
      expect(e.source.length).toBeGreaterThan(0);
    }
  });

  it('任务点名的路径项齐全', () => {
    const required = [
      'workspace', 'cycles', 'config', 'ledger', 'workflowState', 'skillInstalled',
      'skillScripts', 'skillInline', 'pluginRoot', 'dist', 'artifacts',
    ];
    for (const id of required) {
      expect(table.entries.find((e) => e.id === id), `缺路径项 ${id}`).toBeDefined();
    }
  });

  it('存在性/大小/mtime 来自真实 stat（不是硬编码 true）', () => {
    const cfg = table.entries.find((e) => e.id === 'config');
    expect(cfg?.exists).toBe(true);
    expect(cfg?.isDir).toBe(false);
    expect(cfg?.bytes).toBeGreaterThan(0);
    expect(cfg?.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 目录：bytes=0 但 exists/isDir 为真
    const cycles = table.entries.find((e) => e.id === 'cycles');
    expect(cycles?.exists).toBe(true);
    expect(cycles?.isDir).toBe(true);
    // 不存在的项如实 false（不伪造）
    const evals = table.entries.find((e) => e.id === 'evals');
    expect(evals?.exists).toBe(false);
    expect(evals?.mtime).toBeNull();
  });

  it('插件根与 dist 由 resolvePluginRoot 推导，不是自己拼的相对路径', () => {
    const root = table.entries.find((e) => e.id === 'pluginRoot');
    const dist = table.entries.find((e) => e.id === 'dist');
    // 测试跑在仓库内 ⇒ 插件根应能解析到本仓库（含 package.json name=dsh-anic）
    expect(root?.path).toBeTruthy();
    expect(root?.exists).toBe(true);
    expect(dist?.path).toBe(join(root?.path as string, 'dist'));
  });

  it('空工作区（.cycles 不存在）不抛错，逐项如实不存在', () => {
    const empty = join(TMP, 'empty-ws');
    mkdirSync(empty, { recursive: true });
    const t2 = collectPaths(empty);
    expect(t2.entries.length).toBeGreaterThan(0);
    expect(t2.entries.find((e) => e.id === 'config')?.exists).toBe(false);
    expect(t2.entries.find((e) => e.id === 'workspace')?.exists).toBe(true);
  });
});

describe('isInside：路径段比较（不是字符串前缀）', () => {
  it('同目录 / 子目录为真，兄弟目录为假', () => {
    const root = join(resolve(sep), 'a', 'b');
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(root, 'c'))).toBe(true);
    expect(isInside(root, join(root, 'c', 'd'))).toBe(true);
    expect(isInside(root, join(resolve(sep), 'a', 'bc'))).toBe(false);
    expect(isInside(root, join(resolve(sep), 'a'))).toBe(false);
  });

  it('反向自检：字符串前缀匹配会把 /a/bc 判成 /a/b 的子项（真实越权形态）', () => {
    const root = resolve(sep, 'a', 'b');
    const sibling = resolve(sep, 'a', 'bc');
    // 错误的判定式（字符串前缀）在这里返回 true —— 正是守卫要防的形态
    expect(sibling.startsWith(root)).toBe(true);
    // 正确判定式返回 false
    expect(isInside(root, sibling)).toBe(false);
  });
});

describe('resolveCustomPath：安全边界三档', () => {
  const WS = makeWorkspace('ws-secure');

  it('工作区内的相对路径被接受，且返回真实 stat 事实', () => {
    const r = resolveCustomPath(WS, '.cycles/config.yml');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.exists).toBe(true);
    expect(r.entry.bytes).toBeGreaterThan(0);
    expect(r.entry.path).toBe(join(WS, '.cycles', 'config.yml'));
  });

  it('工作区内的绝对路径被接受（绝对不在界外就行）', () => {
    const r = resolveCustomPath(WS, join(WS, 'artifacts'));
    expect(r.ok).toBe(true);
  });

  it('含 `..` 一律拒绝（不做 realpath 越界赌博）', () => {
    for (const bad of ['../etc/passwd', '.cycles/../../x', 'a/../b']) {
      const r = resolveCustomPath(WS, bad);
      expect(r.ok, `应拒绝 ${bad}`).toBe(false);
      if (!r.ok) expect(r.code).toBe('PATH_TRAVERSAL');
    }
  });

  it('工作区之外的绝对路径拒绝并给出原因', () => {
    const outside = join(TMP, 'outside.txt');
    writeFileSync(outside, 'secret', 'utf-8');
    const r = resolveCustomPath(WS, outside);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('PATH_OUTSIDE_WORKSPACE');
      expect(r.reason).toContain('工作区之外');
    }
  });

  it('不存在的路径拒绝（realpath 失败 = 没有证据）', () => {
    const r = resolveCustomPath(WS, '.cycles/nope.json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PATH_NOT_FOUND');
  });

  it('空/非字符串拒绝', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      const r = resolveCustomPath(WS, bad as unknown);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('PATH_EMPTY');
    }
  });

  it('符号链接指到界外 → 拒绝（realpath 后判定才是真边界）', () => {
    const wsLink = makeWorkspace('ws-link');
    const secretDir = join(TMP, 'secret-dir');
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, 'secret.txt'), 'top-secret', 'utf-8');
    const linkPath = join(wsLink, 'escape');
    try {
      symlinkSync(secretDir, linkPath, 'junction');
    } catch {
      // 无符号链接权限（Windows 非开发者模式）：该档不可测，跳过而不是假绿
      return;
    }
    const r = resolveCustomPath(wsLink, 'escape/secret.txt');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('PATH_OUTSIDE_WORKSPACE');
      expect(r.reason).toContain('符号链接');
    }
  });

  it('反向自检：把边界判定去掉，`..` 形态会真的落到界外（证明校验有实际作用）', () => {
    // 模拟"未做校验"的裸实现：resolve 之后直接返回
    const naive = resolve(WS, '.cycles/../../outside.txt');
    expect(isInside(WS, naive)).toBe(false);
    // 而我们的实现连 `..` 都不放行（第一档就拦住，不等 realpath）
    expect(resolveCustomPath(WS, '.cycles/../../outside.txt').ok).toBe(false);
  });
});
