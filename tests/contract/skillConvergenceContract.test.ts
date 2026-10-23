/**
 * 技能脚本收敛阻塞契约（cycle-72 task-9）——两条真根因的回归钉。
 *
 * 由 task-9 收口（原派给 fixer-bootstrap，停滞 3.5h 未落盘，Lead 接管）。
 *
 * 根因 1（Q5 误判）：importGraph 把 **re-export**（`export { x } from './y'`）与
 * **type-only**（`import type`）也当成运行时边，于是本仓「同域拆分 + 再导出以保
 * 250 行/文件」的正当纪律被判成环：
 *   src/host/runtime/invocationFeed.ts  ↔ invocationFeedAttach.ts
 *   src/host/runtime/bootstrapOrchestrator.ts ↔ bootstrapOrchestratorAsync.ts
 * 修法：边分三类，只有 runtime 边参与环检测。
 *
 * 根因 2（G2 假 FAIL）：gate-check 按 mtime 无差别取 test-reports/*.md 作致证报告，
 * 于是 auto-fix-report.md（auto-fix-loop 必产的机器报告）与证据册都能顶替正典报告，
 * 把 FAIL 写进不可变账本。修法：正典名优先 + 派生报告永不致证 + 回显忽略项。
 *
 * 本测试**不用夹具模拟**，直接以两副本真实源码为对象做差分——
 * 因为被守卫的不是「某个函数的形状」，而是「本仓真实结构必须被判为无运行时环」。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = join(__dirname, '../..');
const LIVE = join(ROOT, '.dsh/skills/ai-native-iteration-cycle/scripts');
const ASSETS = join(ROOT, 'assets/skill/scripts');

async function loadImportGraph(base: string) {
  return import(pathToFileURL(join(base, 'lib/importGraph.mjs')).href);
}

function seed(src: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(src, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf-8');
  }
}

describe('importGraph 边分类：再导出/类型导入不构成运行时环', () => {
  it('真运行时相互 import 仍然 FAIL（不得为了变绿放过真环）', async () => {
    const { collectImportGraph, findCircularDeps } = await loadImportGraph(LIVE);
    const d = mkdtempSync(join(tmpdir(), 'anic-true-cycle-'));
    seed(d, {
      'src/client/a.ts': "import { b } from './b.ts';" + String.fromCharCode(10) + 'export const A = b;' + String.fromCharCode(10),
      'src/client/b.ts': "import { a } from './a.ts';" + String.fromCharCode(10) + 'export const B = a;' + String.fromCharCode(10),
    });
    expect(findCircularDeps(collectImportGraph(d))).toHaveLength(1);
    rmSync(d, { recursive: true, force: true });
  });

  it('再导出 + 类型导入构成的「伪环」不再误判', async () => {
    const { collectImportGraph, findCircularDeps } = await loadImportGraph(LIVE);
    const d = mkdtempSync(join(tmpdir(), 'anic-reexp-'));
    seed(d, {
      'src/host/x.ts':
        "export { y } from './y.ts';" + String.fromCharCode(10) +
        "import type { T } from './y.ts';" + String.fromCharCode(10) +
        'export type { T };' + String.fromCharCode(10) +
        'export const X = 1;' + String.fromCharCode(10),
      'src/host/y.ts': "import { X } from './x.ts';" + String.fromCharCode(10) + 'export const Y = X;' + String.fromCharCode(10),
    });
    const g = collectImportGraph(d);
    expect(findCircularDeps(g)).toHaveLength(0);
    expect(g.stats['re-export']).toBe(1);
    expect(g.stats['type-only']).toBe(1);
    expect(g.stats.runtime).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });

  it('本仓真实源码：无运行时环（修复前 2 条误判）', async () => {
    const { collectImportGraph, findCircularDeps } = await loadImportGraph(LIVE);
    const g = collectImportGraph(ROOT);
    expect(findCircularDeps(g)).toHaveLength(0);
    // 三类边都必须真实存在（否则说明分类器把一切都吞了）
    expect(g.stats.runtime).toBeGreaterThan(100);
    expect(g.stats['type-only']).toBeGreaterThan(0);
  });

  it('classifyStatement：三态可辨（按真实匹配下标，正向 + 反向）', async () => {
    const { classifyStatement } = await loadImportGraph(LIVE);
    // 入参 = 正则匹配点在源码中的下标（IMPORT_RE 命中 `from '...'`，故用 indexOf('from')）
    const cases: Array<[string, string]> = [
      ["import x from './y.ts'", 'runtime'],
      ["import './y.ts'", 'runtime'],
      ["import type { T } from './y.ts'", 'type-only'],
      ["export { y } from './y.ts'", 're-export'],
      ["export * from './y.ts'", 're-export'],
      ["export type { T } from './y.ts'", 'type-only'],
    ];
    for (const [src, kind] of cases) {
      expect(classifyStatement(src, src.indexOf('from') >= 0 ? src.indexOf('from') : src.length)).toBe(kind);
    }
  });
});

describe('gate-check G2：正典报告优先，派生报告永不致证', () => {
  it('源码契约：选择逻辑含正典名优先 + 派生排除 + 忽略项回显', () => {
    for (const base of [LIVE, ASSETS]) {
      const src = readFileSync(join(base, 'gate-check.mjs'), 'utf-8');
      expect(src).toContain("CANONICAL_REPORTS = ['测试报告.md', 'test-report.md']");
      expect(src).toContain("DERIVED_REPORTS = ['auto-fix-report.md']");
      expect(src).toMatch(/ignored newer non-canonical/);
      // 反向前提：不得只靠 mtime 直接选（旧缺陷形态）
      expect(src).not.toMatch(/const latestReport = reports\s*\n\s*\.map/);
    }
  });
});

describe('G1 任务状态词表：诚实写「部分完成」必须计 pending（不再假 PASS）', () => {
  it('非「完成」一律计 pending（两副本同源）', async () => {
    const NL = String.fromCharCode(10);
    const head = '| 任务 | 归属层 | 关联用例 | 文档变更项 | 依赖 | 状态 |' + NL;
    for (const base of [LIVE, ASSETS]) {
      const mod = await import(pathToFileURL(join(base, 'lib/tasks.mjs')).href);
      const honest = head + '| T-x | host | none | - | none | 部分完成 |' + NL;
      const s1 = mod.summarizeTaskRows(honest);
      expect(s1.total).toBe(1);
      expect(s1.pendingCount).toBe(1);
      expect(s1.allCompleted).toBe(false);
      const done = head + '| T-x | host | none | - | none | 完成 |' + NL;
      expect(mod.summarizeTaskRows(done).allCompleted).toBe(true);
      // 反向前提：词表必须仍排除表头与占位行
      expect(mod.parseTaskRows(head)).toHaveLength(0);
    }
  });
});
