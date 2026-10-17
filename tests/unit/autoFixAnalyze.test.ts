/**
 * autoFixAnalyze 纯函数单测 —— 报告解析 / 失败识别 / 失败模式分析
 * （技能 auto-fix-loop.mjs:57-140 逐字对齐的契约测试）。
 */
import { describe, it, expect } from 'vitest';
import {
  parseReportContent, filterFailLines, identifyFailures, analyzeFailurePattern,
  type FixAttempt, type TestCommandResult, type TestReportSummary, type AutoFixFailure,
} from '../../src/host/evolution/autoFixAnalyze.ts';

const ok: TestCommandResult = { success: true, output: 'all green' };
const boom: TestCommandResult = { success: false, output: '', error: 'exit 1', exitCode: 1 };

describe('parseReportContent（技能 mjs:63-76 v1.8.5-fork 双格式：管道表优先 + 键值回退）', () => {
  it('解析 通过/失败/错误 三计数（旧「键：值」格式——全半角冒号兼容，回退路径）', () => {
    expect(parseReportContent('通过：12\n失败：2\n错误：1')).toEqual({ failures: 2, errors: 1, passes: 12 });
  });

  it('半角冒号同样匹配；缺失计数为 0', () => {
    expect(parseReportContent('失败: 3\n')).toEqual({ failures: 3, errors: 0, passes: 0 });
    expect(parseReportContent('no counters here')).toEqual({ failures: 0, errors: 0, passes: 0 });
  });

  it('D-1103 正典 §2 汇总管道表「| 失败 | N |」可解析（G2 同形态）', () => {
    const canonical = [
      '# 测试报告',
      '',
      '## 2. 汇总',
      '',
      '| 指标 | 数量 |',
      '|---|---|',
      '| 通过 | 837 |',
      '| 失败 | 3 |',
      '| 错误 | 1 |',
      '| 跳过 | 0 |',
    ].join('\n');
    expect(parseReportContent(canonical)).toEqual({ failures: 3, errors: 1, passes: 837 });
  });

  it('D-1103 双格式并存：管道表权威——§4 散文「失败：99 次」不覆盖 §2 计数', () => {
    const both = [
      '## 2. 汇总',
      '| 通过 | 10 |',
      '| 失败 | 2 |',
      '| 错误 | 0 |',
      '',
      '## 4. 失败项详情',
      '复现时观察到失败：99 次，远超预期。错误：7 处也需要关注。',
    ].join('\n');
    expect(parseReportContent(both)).toEqual({ failures: 2, errors: 0, passes: 10 });
  });

  it('D-1103 散文键值命中但管道表全零：管道表仍权威（0 不是缺失）', () => {
    const zeroTable = [
      '| 指标 | 数量 |',
      '| 通过 | 50 |',
      '| 失败 | 0 |',
      '| 错误 | 0 |',
      '',
      '备注：历史版本曾失败：12 次，现已修复。',
    ].join('\n');
    expect(parseReportContent(zeroTable)).toEqual({ failures: 0, errors: 0, passes: 50 });
  });

  it('D-1103 修复前缺陷钉：纯正典报告（无键值行）不再读成 0——报告失败通道复活', () => {
    const pureCanonical = '# 测试报告\n\n| 通过 | 100 |\n| 失败 | 5 |\n| 错误 | 2 |\n';
    const parsed = parseReportContent(pureCanonical);
    expect(parsed.failures).toBe(5);
    expect(parsed.errors).toBe(2);
    // identifyFailures 的 test-report-failure 通道依赖该计数：>0 才会进失败清单
    const reports: TestReportSummary[] = [{ file: 'r.md', ...parsed, content: pureCanonical }];
    const failures = identifyFailures(ok, reports);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.type).toBe('test-report-failure');
    expect((failures[0] as Extract<AutoFixFailure, { type: 'test-report-failure' }>).failures).toBe(5);
  });
});

describe('filterFailLines（技能 mjs:92-94：FAIL|失败|错误|Error 前 10）', () => {
  it('过滤四类标记行并截断到 10', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `FAIL test ${i}`).join('\n');
    expect(filterFailLines(lines)).toHaveLength(10);
    expect(filterFailLines('ok\nFAIL a\n失败 b\n错误 c\nError d\nfine')).toEqual(['FAIL a', '失败 b', '错误 c', 'Error d']);
  });
});

describe('identifyFailures（技能 mjs:79-106 两类失败）', () => {
  it('命令成功 + 报告全绿 → 无失败', () => {
    const reports: TestReportSummary[] = [{ file: 'r.md', failures: 0, errors: 0, passes: 5, content: '' }];
    expect(identifyFailures(ok, reports)).toEqual([]);
  });

  it('命令失败 → test-command-failure（detail=error，exitCode 透传）', () => {
    const [f] = identifyFailures(boom, []);
    expect(f?.type).toBe('test-command-failure');
    expect(f).toMatchObject({ detail: 'exit 1', exitCode: 1 });
  });

  it('报告有失败/错误 → test-report-failure（前 10 失败行详情）', () => {
    const reports: TestReportSummary[] = [{ file: 'tr.md', failures: 2, errors: 1, passes: 3, content: 'FAIL a\n错误 b' }];
    const [f] = identifyFailures(ok, reports);
    expect(f?.type).toBe('test-report-failure');
    expect(f).toMatchObject({ file: 'tr.md', failures: 2, errors: 1, details: ['FAIL a', '错误 b'] });
  });
});

describe('analyzeFailurePattern（技能 mjs:108-140 三模式）', () => {
  const cmdFailure = { type: 'test-command-failure' as const, detail: 'x', exitCode: 1 };
  const reportFailure = { type: 'test-report-failure' as const, file: 'a.md', failures: 1, errors: 0, details: [] };

  function attempt(failures: FixAttempt['failures']): FixAttempt {
    return { success: false, failures, fixAction: 'Fix applied but failures remain' };
  }

  it('单类型 ≥3 次 → repeating（架构层根因假设）', () => {
    const a = analyzeFailurePattern([attempt([cmdFailure]), attempt([cmdFailure]), attempt([cmdFailure])]);
    expect(a.pattern).toBe('repeating');
    expect(a.rootCauseHypothesis).toContain('架构层面');
    expect(a.recommendedAction).toContain('接口契约');
  });

  it('多类型且某类 ≥2 → cascading（先修主失败）', () => {
    const a = analyzeFailurePattern([attempt([cmdFailure, reportFailure]), attempt([cmdFailure])]);
    expect(a.pattern).toBe('cascading');
    expect(a.recommendedAction).toContain('先修复主失败');
  });

  it('低频单类型 → transient（环境/时序假设）', () => {
    const a = analyzeFailurePattern([attempt([cmdFailure])]);
    expect(a.pattern).toBe('transient');
    expect(a.recommendedAction).toContain('重试次数');
  });

  it('failureTypes 分组计数', () => {
    const a = analyzeFailurePattern([attempt([cmdFailure, reportFailure]), attempt([cmdFailure])]);
    expect(a.failureTypes['test-command-failure']).toHaveLength(2);
    expect(a.failureTypes['test-report-failure']).toHaveLength(1);
  });
});
