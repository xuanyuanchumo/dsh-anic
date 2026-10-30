/**
 * 写入型测试守卫（cycle-87 · O-86-05）——**测试不得无声改动用户工作区**。
 *
 * ## 事故来源（cycle-86 真实发生）
 *
 * 一个基线重置探针写了 `archiveBaseline(..., { dryRun: false })`，并且落在
 * `vitest.config.ts` 的 include 扫描域（tests 目录下全部 .test.ts）里 ⇒ **每次全量测试
 * 都真的执行归档**：刚建好的 cycle-86 被当场搬进 `.cycles/archive/`。
 *
 * 三重危害（缺一都够严重）：
 *   ① 测试对**用户数据**产生不可预期写副作用；
 *   ② 套件仍然全绿 —— 故障完全不可见（比红更糟）；
 *   ③ 若接上定时任务，会持续吃掉最新轮次。
 *
 * ## 判据（宽严如何取舍）
 *
 * 不按"文件里出现 rmSync 就红"（那会把 14 处**临时夹具**误伤，守卫立刻变噪声，
 * 团队学会忽略它）。只钉**真正危险的组合**：
 *
 *   A. 调用**归档/还原写 API**（`archiveBaseline` / `restoreArchivedCycle`）的文件，
 *      必须至少满足其一：
 *        - `mkdtempSync` 在场（证明它只操作临时目录），或
 *        - `process.env.ANIC_*` 在場（显式门控：危险动作要人按下去）；
 *   B. 若同时出现 `process.cwd()` 与 `.cycles`（= 瞄准真实工作区）**且**写模式
 *      （`dryRun: false`），则**必须**有 env 门控（夹具隔离不算——夹具变量不构成
 *      对真实路径的保护）。
 *
 * 两条都带反向自检：合成样例必须能被判红，否则守卫是恒绿的装饰。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 整个 tests 树的 `.test.ts`（递归；扫描域由"测试在哪"决定，不手工枚举）。 */
function testFiles(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      const relPath = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) { walk(full, relPath); continue; }
      if (!e.name.endsWith('.test.ts')) continue;
      out.push({ rel: `tests/${relPath}`, text: readFileSync(full, 'utf-8') });
    }
  };
  walk(join(ROOT, 'tests'), '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 归档/还原的写 API。 */
const WRITE_APIS = /\b(archiveBaseline|restoreArchivedCycle)\s*\(/;
/** 夹具隔离证明。 */
const FIXTURE_ISOLATION = /mkdtempSync\s*\(/;
/** 显式门控证明（只看 ANIC_ 前缀，避免把无关 env 当门控）。 */
const ENV_GATE = /process\.env\.ANIC_[A-Z_]+/;
/** 瞄准真实工作区（`process.cwd()` + `.cycles` 同时出现）。 */
const REAL_WORKSPACE = /process\.cwd\(\)/;
/** 显式写模式。 */
const WRITE_MODE = /dryRun\s*:\s*false/;

/** 判定单个文件（纯函数，便于反向自检）。返回问题清单。 */
export function writeProbeProblems(text: string): string[] {
  const problems: string[] = [];
  if (!WRITE_APIS.test(text)) return problems;
  const isolated = FIXTURE_ISOLATION.test(text);
  const gated = ENV_GATE.test(text);
  if (!isolated && !gated) {
    problems.push('调用归档/还原写 API，但既没有 mkdtempSync 夹具隔离，也没有 ANIC_* env 门控');
  }
  const realWs = REAL_WORKSPACE.test(text) && /\.cycles/.test(text);
  if (realWs && WRITE_MODE.test(text) && !gated) {
    problems.push('对真实工作区（process.cwd() + .cycles）使用 dryRun:false，但没有 ANIC_* env 门控');
  }
  return problems;
}

describe('cycle-87 写入型测试守卫', () => {
  const files = testFiles();

  it('扫描集非空下限（空扫描 = 永久假绿）', () => {
    expect(files.length).toBeGreaterThanOrEqual(150);
    // 每个文件都得真读到内容（防"文件列表对但读空"）
    expect(files.every((f) => f.text.length > 50)).toBe(true);
  });

  it('主断言：没有任何测试文件无声改动工作区', () => {
    const offenders = files
      .map((f) => ({ rel: f.rel, problems: writeProbeProblems(f.text) }))
      .filter((x) => x.problems.length > 0);
    expect(
      offenders.map((o) => `${o.rel}: ${o.problems.join('；')}`),
      '写入型测试必须夹具隔离（mkdtempSync）或显式 env 门控（ANIC_*）——'
      + 'cycle-86 的探针就是漏了这一步，把真实 cycle-86 归档掉了',
    ).toEqual([]);
  });

  it('反向自检：无隔离无门控的写调用必须判红（守卫有牙）', () => {
    const bad = `
      import { archiveBaseline } from '../src/host/runtime/artifactArchiveBaseline.ts';
      const r = archiveBaseline(join(process.cwd(), '.cycles'), { dryRun: false });
    `;
    expect(writeProbeProblems(bad).length).toBeGreaterThan(0);
    // 且**必须**点名两条原因中的至少一条（不是含糊的"有问题"）
    expect(writeProbeProblems(bad).join(' ')).toMatch(/夹具隔离|env 门控/);
  });

  it('反向自检：夹具隔离 / env 门控任一在场即放行（守卫不误伤）', () => {
    const isolated = `
      const root = mkdtempSync(join(tmpdir(), 'x-'));
      archiveBaseline(join(root, '.cycles'), { dryRun: false });
    `;
    expect(writeProbeProblems(isolated)).toEqual([]);

    const gated = `
      const execute = process.env.ANIC_ARCHIVE_EXECUTE === '1';
      archiveBaseline(join(process.cwd(), '.cycles'), { dryRun: !execute });
    `;
    expect(writeProbeProblems(gated)).toEqual([]);
  });

  it('反向自检：真实路径 + 写模式 + 只有夹具隔离（变量其实是临时目录）仍放行；但真实路径写模式缺门控必红', () => {
    // 真实路径 + 写模式 + 门控 → 放行
    expect(writeProbeProblems(`
      const execute = process.env.ANIC_ARCHIVE_EXECUTE === '1';
      archiveBaseline(join(process.cwd(), '.cycles'), { dryRun: !execute });
    `)).toEqual([]);
    // 真实路径 + 写模式 + 无门控（即便文件里有 mkdtempSync）→ 红
    expect(writeProbeProblems(`
      const tmp = mkdtempSync('x');
      archiveBaseline(join(process.cwd(), '.cycles'), { dryRun: false });
    `).join(' ')).toContain('env 门控');
  });

  it('非写 API 的文件不参与判定（避免守卫扫全仓噪声）', () => {
    expect(writeProbeProblems('const x = 1; rmSync(join(root, ".cycles"));')).toEqual([]);
  });
});
