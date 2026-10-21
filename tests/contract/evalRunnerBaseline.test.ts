/**
 * eval-runner E5 性能基线工件通道契约测试（cycle-62 T-6201 回归钉）
 *
 * 背景：E5 自技能 v1.0 起硬编码 skipped——「性能基线」维永远无证据
 * （iteration-5 的 fail-open 修复矫枉过正：修了「无证据记 PASS」，
 * 却把证据路径焊死为「永远没有」）。cycle-62 升级为工件通道：
 *   .cycles/performance-baseline.md 在位且含「基线」「阈值」关键词 → PASS；
 *   缺失 / 空占位 → 维持 SKIP（三态纪律不变）。
 *
 * 本测试 spawn 真实 eval-runner.mjs 跑最小夹具（--dimensions E5 部分
 * 运行），钉四件事：
 *  1. 工件在位+形状对 → E5 PASS 带表行计数详情；
 *  2. 工件缺失 → E5 SKIP（detail 指引工件路径）；
 *  3. 工件在位但空占位（无基线/阈值关键词）→ SKIP（防空文件绕过）；
 *  4. 旧语义回归钉：EXIT 码——SKIP 不阻塞运行（退出 0）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_RUNNER = join(__dirname, '../../assets/skill/scripts/eval-runner.mjs');

const TMP = join(tmpdir(), `anic-e5b-${Date.now()}`);

/** 建最小夹具：.cycles 骨架 + cycle-1 目录，可选写性能基线工件。 */
function seedFixture(dir: string, { baseline }: { baseline: 'full' | 'empty' | 'none' }): string {
  mkdirSync(join(dir, '.cycles', 'cycles', 'cycle-1'), { recursive: true });
  // eval-runner 需要 config.yml（loadProjectConfig 缺文件响亮失败——S-1 修复）
  writeFileSync(
    join(dir, '.cycles', 'config.yml'),
    ['project:', '  name: "fixture"', 'build:', '  lint_cmd: "node --version"', '  test_cmd: "node --version"', '  build_cmd: "node --version"'].join('\n'),
  );
  if (baseline === 'full') {
    writeFileSync(
      join(dir, '.cycles', 'performance-baseline.md'),
      [
        '# 性能基线',
        '',
        '| 指标 | 命令 | 阈值 | 实测值 | 采样时间 |',
        '|---|---|---|---|---|',
        '| 全量测试时长 | node scripts/run-tests.mjs | 60s | 24.1s | 2026-10-22T02:34:42+08:00 |',
        '',
      ].join('\n'),
    );
  } else if (baseline === 'empty') {
    // 占位文件：存在但无基线/阈值关键词——不得绕过形状检查
    writeFileSync(join(dir, '.cycles', 'performance-baseline.md'), '# TODO\n');
  }
  return dir;
}

/** spawn eval-runner 跑 E5 单维，返回 { report, exitCode }。 */
function runEval(dir: string): { report: string; exitCode: number } {
  const r = spawnSync('node', [EVAL_RUNNER, dir, '--dimensions', 'E5'], {
    encoding: 'utf-8',
    timeout: 60000,
  });
  const reportPath = join(dir, '.cycles', 'cycles', 'cycle-1', '项目评估报告.md');
  const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf-8') : '';
  return { report, exitCode: r.status ?? -1 };
}

function reportRow(content: string, dim: string): string {
  const m = content.match(new RegExp(`^\\| ${dim} \\|.*$`, 'm'));
  return m ? m[0] : '';
}

describe('eval-runner E5 性能基线工件通道（cycle-62 T-6201 回归钉）', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it(
    '工件在位+形状对（基线+阈值关键词+表行）：E5 PASS 带表行计数详情',
    { timeout: 90000 },
    () => {
      seedFixture(TMP, { baseline: 'full' });
      const { report, exitCode } = runEval(TMP);

      const e5 = reportRow(report, 'E5');
      expect(e5).toMatch(/PASS/);
      expect(e5).toMatch(/Performance baseline artifact found/);
      expect(e5).toMatch(/\d+ table rows/);
      // SKIP 不阻塞（本例是 PASS，退出码必为 0）
      expect(exitCode).toBe(0);
    },
  );

  it(
    '工件缺失：E5 维持 SKIP（三态纪律不破——无工件=无证据），退出码仍 0',
    { timeout: 90000 },
    () => {
      seedFixture(TMP, { baseline: 'none' });
      const { report, exitCode } = runEval(TMP);

      const e5 = reportRow(report, 'E5');
      expect(e5).toMatch(/SKIP/);
      expect(e5).toContain('performance-baseline.md not found');
      // iteration-5 语义：SKIP 不阻塞运行（否则无基线声明的项目永远跑不完）
      expect(exitCode).toBe(0);
    },
  );

  it(
    '空占位工件（无基线/阈值关键词）：E5 SKIP 防空文件绕过',
    { timeout: 90000 },
    () => {
      seedFixture(TMP, { baseline: 'empty' });
      const { report } = runEval(TMP);

      const e5 = reportRow(report, 'E5');
      expect(e5).toMatch(/SKIP/);
      expect(e5).toContain('lacks 基线/阈值 shape');
    },
  );

  it(
    '报告总结行如实反映三态：工件在位时总结不出现 E5 SKIP 名单',
    { timeout: 90000 },
    () => {
      seedFixture(TMP, { baseline: 'full' });
      const { report } = runEval(TMP);

      // 总结区「未评估(SKIP)」行不得含 E5（本例 PASS）
      const summaryBlock = report.split('## 总结')[1] ?? '';
      expect(summaryBlock).not.toMatch(/SKIP.*E5|E5.*SKIP/);
      expect(summaryBlock).toContain('通过: 1/1');
    },
  );

  it(
    '工件在位时 SKIP 名单如实（负例对照）：空占位总结含 E5',
    { timeout: 90000 },
    () => {
      seedFixture(TMP, { baseline: 'empty' });
      const { report } = runEval(TMP);

      const summaryBlock = report.split('## 总结')[1] ?? '';
      expect(summaryBlock).toContain('未评估(SKIP): 1');
      expect(summaryBlock).toContain('E5');
    },
  );
});
