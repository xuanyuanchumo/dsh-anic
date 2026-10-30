/**
 * 路径覆盖表测试（cycle-83）——**两层分离 + 整份 fail-closed** 的行为证据。
 *
 * ## 守什么（每条都配反向自检）
 *
 * ① 覆盖生效：解析结果变化，而**登记表未被改写**（默认路径仍在、overridable 白名单不变）；
 * ② 覆盖表非法（`..` / 绝对路径 / workspace 外 / 类型不符 / id 不可覆盖）→
 *    **整份忽略** + 响亮 warnings，且解析结果**逐项等于默认值**（不是"看起来差不多"）；
 * ③ 撤销一条（patch 传 null）回默认，其余未触及项原样保留；
 * ④ 组合校验：两条指向同一处 → 拒绝（谁写的不可判定）；
 * ⑤ 写入是原子 + 回读断言（写后重新解析整份表）。
 *
 * ## 为什么「逐项等于默认值」必须逐字段比对
 *
 * 只断言「overrides 是空对象」是不够的：把合法的 A 与不合法的 B 一起忽略时，
 * 实现可能仍然把 A 写进了解析结果（半套生效）。这里比对的是**每个 entry 的
 * 绝对路径**——那正是半套生效唯一会留下的痕迹。
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  collectPaths, EDITABLE_PATH_IDS, PATH_DEFS, loadPathOverrides, defaultPathOf,
  buildPathContext, isInside, pathDefById,
} from '../../src/host/configEdit/paths.ts';
import {
  PATHS_FILE_REL, PATHS_VERSION, applyPathOverrides, loadPathOverrides as loadRaw,
  planPathOverrides, pathsFilePath, validateOverride, overriddenCount,
} from '../../src/host/configEdit/pathOverrides.ts';
import type { PathEntry } from '../../src/host/configEdit/pathRegistry.ts';

const TMP = mkdtempSync(join(tmpdir(), 'anic-path-overrides-'));
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理竞态容忍 */ } });

let seq = 0;
/** 造一个真实工作区（生命周期目录都在默认位置）。 */
function makeWorkspace(tag: string): string {
  seq += 1;
  const ws = join(TMP, `${tag}-${String(seq)}`);
  for (const rel of ['.cycles', '.cycles/gates', '.cycles/cycles', '.cycles/evals', '.cycles/tech-debt', '.cycles/incidents', '.cycles/archive', 'artifacts']) {
    mkdirSync(join(ws, rel), { recursive: true });
  }
  writeFileSync(join(ws, '.cycles', 'config.yml'), 'project:\n  name: x\n', 'utf-8');
  // 一份真实文件：类型不符用例（dir 项指向文件）需要一个**存在**的文件，
  // 否则它会先撞 PATH_NOT_FOUND，测的就不是形态判据了。
  writeFileSync(join(ws, 'artifacts', 'workflow-snapshot.json'), '{}', 'utf-8');
  return ws;
}

/** 写一份覆盖表（原始 JSON 文本，允许构造非法表）。 */
function writeTable(ws: string, body: unknown): void {
  writeFileSync(pathsFilePath(ws), typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf-8');
}

/** 把路径表压成 `id → path` 便于逐项比较。 */
function pathMap(entries: PathEntry[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const e of entries) out[e.id] = e.path;
  return out;
}

/** 默认解析结果（不套覆盖）——「等于默认值」的唯一基线。 */
function defaultMap(ws: string): Record<string, string | null> {
  const ctx = buildPathContext(ws);
  const out: Record<string, string | null> = {};
  for (const def of PATH_DEFS) out[def.id] = defaultPathOf(def, ctx);
  return out;
}

describe('登记表：两层分离的真相源', () => {
  it('可覆盖白名单只含生命周期目录（契约文件/解析项不开放）', () => {
    expect(EDITABLE_PATH_IDS).toEqual(['cyclesDocs', 'evals', 'techDebt', 'incidents', 'archive', 'artifacts']);
    // 反向自检：不可覆盖项确实不在白名单里（不是"白名单恰好为空"）
    for (const id of ['config', 'ledger', 'workflowState', 'flowTracker', 'workspace', 'cycles', 'pluginRoot', 'dist']) {
      expect(EDITABLE_PATH_IDS.includes(id)).toBe(false);
      expect(pathDefById(id)?.overridable).not.toBe(true);
    }
  });

  it('登记表 19 项、id 唯一、每项有 suffix 与 source（空表 = 假守卫）', () => {
    expect(PATH_DEFS.length).toBe(19);
    const ids = PATH_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of PATH_DEFS) {
      expect(def.suffix.startsWith('path.')).toBe(true);
      expect(def.source.length).toBeGreaterThan(0);
      // 每条要么有相对路径、要么有 resolver——两者皆无 = 无法解析的死登记
      expect(def.rel !== undefined || def.resolve !== undefined).toBe(true);
    }
  });

  it('覆盖**不改登记表**：登记项仍是 19 条、默认路径不变', () => {
    const ws = makeWorkspace('registry');
    const before = defaultMap(ws);
    expect(applyPathOverrides(ws, { evals: 'docs/evals' }).ok).toBe(false); // 目标不存在 → 拒绝
    mkdirSync(join(ws, 'docs', 'evals'), { recursive: true });
    const out = applyPathOverrides(ws, { evals: 'docs/evals' });
    expect(out.ok).toBe(true);
    // 登记表未被改写：默认解析仍然是 .cycles/evals
    expect(defaultMap(ws)).toEqual(before);
    expect(PATH_DEFS.length).toBe(19);
    expect(defaultMap(ws)['evals']).toBe(resolve(ws, '.cycles', 'evals'));
    // 而解析层（两层的产物）确实变了
    const table = collectPaths(ws);
    expect(table.entries.find((e) => e.id === 'evals')?.path).toBe(resolve(ws, 'docs', 'evals'));
    expect(table.entries.find((e) => e.id === 'evals')?.overridden).toBe(true);
  });
});

describe('覆盖生效：解析变化 + 可覆盖性来自服务端', () => {
  it('单条覆盖生效，且只有该项 overridden（其余仍是默认）', () => {
    const ws = makeWorkspace('single');
    mkdirSync(join(ws, 'docs', 'evals'), { recursive: true });
    const out = applyPathOverrides(ws, { evals: 'docs/evals' });
    expect(out).toEqual(expect.objectContaining({ ok: true, applied: true }));
    expect(out.changedIds).toEqual(['evals']);
    expect(overriddenCount(loadPathOverrides(ws))).toBe(1);
    const table = collectPaths(ws);
    const overridden = table.entries.filter((e) => e.overridden).map((e) => e.id);
    expect(overridden).toEqual(['evals']);
    // 反向自检：别的目录项没有跟着被改（覆盖是逐项的）
    expect(table.entries.find((e) => e.id === 'techDebt')?.overridden).toBe(false);
  });

  it('editable 标记只给白名单项（客户端编辑入口的依据）', () => {
    const ws = makeWorkspace('editable');
    const table = collectPaths(ws);
    const editable = table.entries.filter((e) => e.editable).map((e) => e.id);
    expect(editable).toEqual([...EDITABLE_PATH_IDS]);
    expect(table.entries.find((e) => e.id === 'config')?.editable).toBe(false);
  });

  it('撤销一条（null）回默认，其余覆盖保留', () => {
    const ws = makeWorkspace('reset');
    mkdirSync(join(ws, 'docs', 'evals'), { recursive: true });
    mkdirSync(join(ws, 'docs', 'debt'), { recursive: true });
    expect(applyPathOverrides(ws, { evals: 'docs/evals', techDebt: 'docs/debt' }).ok).toBe(true);
    const out = applyPathOverrides(ws, { evals: null });
    expect(out.ok).toBe(true);
    expect(out.removedIds).toEqual(['evals']);
    const table = collectPaths(ws);
    expect(table.entries.find((e) => e.id === 'evals')?.path).toBe(resolve(ws, '.cycles', 'evals'));
    expect(table.entries.find((e) => e.id === 'techDebt')?.path).toBe(resolve(ws, 'docs', 'debt'));
  });
});

describe('fail-closed：任何一条非法 ⇒ 整份忽略 + 结果逐项等于默认', () => {
  const cases: Array<{ tag: string; overrides: Record<string, unknown>; code: string }> = [
    { tag: 'dotdot', overrides: { evals: '../outside' }, code: 'PATH_TRAVERSAL' },
    { tag: 'absolute', overrides: { evals: resolve(TMP, 'abs-target') }, code: 'PATH_ABSOLUTE' },
    { tag: 'kind', overrides: { evals: 'artifacts/workflow-snapshot.json' }, code: 'PATH_KIND_MISMATCH' },
    { tag: 'notfound', overrides: { evals: 'no/such/dir' }, code: 'PATH_NOT_FOUND' },
    { tag: 'noteditable', overrides: { ledger: '.cycles/gates/ledger.json' }, code: 'ID_NOT_EDITABLE' },
  ];

  for (const c of cases) {
    it(`${c.code}（${c.tag}）⇒ 整份忽略，解析逐项等于默认`, () => {
      const ws = makeWorkspace(`bad-${c.tag}`);
      // 合法的一条与非法的一条**混在同一份表里**：半套生效的唯一检测面。
      mkdirSync(join(ws, 'docs', 'evals'), { recursive: true });
      const table: Record<string, unknown> = { evals: 'docs/evals', ...c.overrides };
      writeTable(ws, { version: PATHS_VERSION, overrides: table });
      const resolved = loadPathOverrides(ws);
      expect(resolved.ignored).toBe(true);
      expect(overriddenCount(resolved)).toBe(0);
      expect(resolved.warnings.some((w) => w.includes(c.code))).toBe(true);
      expect(resolved.warnings.some((w) => w.includes('整份覆盖表被忽略'))).toBe(true);
      // 逐项比对：**没有一条**被偷偷用上（含那条合法的）
      expect(pathMap(collectPaths(ws).entries)).toEqual(defaultMap(ws));
      expect(collectPaths(ws).overridesIgnored).toBe(true);
    });
  }

  it('含 `..` 的路径即使解析后仍在界内也拒（不做越界赌博）', () => {
    const ws = makeWorkspace('dotdot-inside');
    mkdirSync(join(ws, 'docs', 'evals'), { recursive: true });
    // `docs/../docs/evals` 解析后确实在界内 —— 仍然拒（脆弱写法 = 未来的事故）
    const r = validateOverride(ws, 'evals', 'docs/../docs/evals');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PATH_TRAVERSAL');
  });

  it('工作区外的绝对路径被点名（判据与 isolationScan 同源）', () => {
    const ws = makeWorkspace('outside-abs');
    const outside = join(TMP, 'not-in-ws');
    mkdirSync(outside, { recursive: true });
    const r = validateOverride(ws, 'evals', outside);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PATH_ABSOLUTE');
    // 反向自检：同一判据（isInside = inWorkspace）确实判定它在界外
    expect(isInside(ws, outside)).toBe(false);
    expect(isInside(ws, join(ws, '.cycles', 'evals'))).toBe(true);
  });

  it('符号链接指到界外 → 拒绝（realpath 后判定才是真边界）', () => {
    const ws = makeWorkspace('symlink');
    const secret = join(TMP, 'symlink-secret');
    mkdirSync(secret, { recursive: true });
    try {
      symlinkSync(secret, join(ws, 'esc'), 'junction');
    } catch {
      // 无符号链接权限（Windows 非开发者模式）：该档不可测，跳过而不是假绿
      return;
    }
    const r = validateOverride(ws, 'evals', 'esc');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PATH_OUTSIDE_WORKSPACE');
  });

  it('表形状坏（JSON 坏 / version 错 / overrides 非对象）一律整份忽略', () => {
    const ws = makeWorkspace('shape');
    const base = defaultMap(ws);
    for (const body of ['{not json', { version: 99, overrides: {} }, { version: PATHS_VERSION, overrides: [] }, { version: PATHS_VERSION, overrides: 'x' }]) {
      writeTable(ws, body);
      const r = loadPathOverrides(ws);
      expect(r.ignored).toBe(true);
      expect(r.warnings.length).toBeGreaterThan(0);
      expect(pathMap(collectPaths(ws).entries)).toEqual(base);
    }
  });

  it('空表（无 paths.json）不是警告：解析等于默认、ignored=false', () => {
    const ws = makeWorkspace('absent');
    const r = loadPathOverrides(ws);
    expect(r.present).toBe(false);
    expect(r.ignored).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(pathMap(collectPaths(ws).entries)).toEqual(defaultMap(ws));
    // 反向自检：写入一份**非法**表后 present 变 true 且 ignored 也变 true
    writeTable(ws, { version: PATHS_VERSION, overrides: { evals: '../x' } });
    expect(loadPathOverrides(ws).present).toBe(true);
    expect(loadPathOverrides(ws).ignored).toBe(true);
  });
});

describe('组合校验与写入纪律', () => {
  it('两条指向同一路径 → 拒绝（谁写的不可判定）', () => {
    const ws = makeWorkspace('collision');
    mkdirSync(join(ws, 'shared'), { recursive: true });
    const plan = planPathOverrides(ws, { evals: 'shared', techDebt: 'shared' });
    expect(plan.ok).toBe(false);
    expect(plan.warnings.join(' ')).toContain('PATH_COLLISION');
    // 零写入
    expect(existsSync(pathsFilePath(ws))).toBe(false);
    // 反向自检：只改一条时同一目标被接受（碰撞判据不是恒假）
    expect(planPathOverrides(ws, { evals: 'shared' }).ok).toBe(true);
  });

  it('patch 非对象成员（非法类型值）零写入且原因可读', () => {
    const ws = makeWorkspace('badtype');
    const out = applyPathOverrides(ws, { evals: 42 });
    expect(out.ok).toBe(false);
    expect(out.warnings.join(' ')).toContain('PATH_EMPTY');
    expect(existsSync(pathsFilePath(ws))).toBe(false);
  });

  it('写入是原子的：文件内容是可解析的规范 JSON，且 version=1', () => {
    const ws = makeWorkspace('atomic');
    mkdirSync(join(ws, 'docs', 'evals'), { recursive: true });
    expect(applyPathOverrides(ws, { evals: 'docs/evals' }).ok).toBe(true);
    const path = pathsFilePath(ws);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { version: number; overrides: Record<string, string> };
    expect(parsed.version).toBe(PATHS_VERSION);
    expect(parsed.overrides).toEqual({ evals: 'docs/evals' });
    // 相对路径用 `/` 分隔（跨平台 JSON 里不该出现 `\`）
    expect(parsed.overrides['evals']).not.toContain('\\');
  });

  it('无变化 ⇒ applied=false 且不重写文件（幂等）', () => {
    const ws = makeWorkspace('idempotent');
    mkdirSync(join(ws, 'docs', 'evals'), { recursive: true });
    expect(applyPathOverrides(ws, { evals: 'docs/evals' }).ok).toBe(true);
    const first = readFileSync(pathsFilePath(ws), 'utf-8');
    const again = applyPathOverrides(ws, { evals: 'docs/evals' });
    expect(again.ok).toBe(true);
    expect(again.applied).toBe(false);
    expect(readFileSync(pathsFilePath(ws), 'utf-8')).toBe(first);
  });

  it('覆盖表路径由唯一常量派生（读写同一个文件）', () => {
    const ws = makeWorkspace('filepath');
    expect(pathsFilePath(ws)).toBe(resolve(ws, ...PATHS_FILE_REL.split('/')));
    // 反向自检：写入后再读，读到的必须是我们写的那份
    writeTable(ws, { version: PATHS_VERSION, overrides: {} });
    expect(loadRaw(ws).present).toBe(true);
  });
});

describe('路径表 warnings：覆盖与推导告警不互相掩盖', () => {
  beforeEach(() => { /* 每个用例自建工作区，这里无需重置 */ });
  it('非法覆盖时 warnings 同时给出「哪条」与「整份忽略」', () => {
    const ws = makeWorkspace('warn');
    writeTable(ws, { version: PATHS_VERSION, overrides: { evals: '../x' } });
    const table = collectPaths(ws);
    const joined = table.warnings.join(' | ');
    expect(joined).toContain('PATH_TRAVERSAL');
    expect(joined).toContain('解析一律回落到登记表的默认路径');
    expect(table.entries.length).toBe(19);
  });
});
