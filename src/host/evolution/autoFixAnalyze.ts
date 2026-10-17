/**
 * autoFixAnalyze —— 自动修复循环纯函数层（技能 auto-fix-loop.mjs:57-140 逐字移植）。
 *
 * 职责拆分（与 hitlAudit 的 evaluateH1-H4 与 checkH1-H4 同范式）：
 *  - 本文件：报告解析 / 失败识别 / 失败模式分析 —— 纯函数，可单测
 *  - autoFixEngine.ts：跑测试命令 / 审计行 / incident / 报告落盘 —— IO 包装
 *
 * 技能语义基准：
 *  - readTestReports（mjs:57-77，v1.8.5-fork D-1103）：.cycles/cycles/<cycle>/
 *    test-reports/*.md 解析通过/失败/错误三计数——**双格式**：正典 §2 汇总
 *    管道表「| 失败 | N |」（与 G2 gate-check.mjs 同形态）优先，旧键值
 *    「失败：N」回退；管道表命中时键值不看（§4 散文里的「失败：3 次」
 *    不覆盖 §2 权威计数）。原双正则不相交是 fail-open：正典报告读成 0。
 *  - identifyFailures（mjs:79-106）：test 命令失败 + 报告失败两类；失败行过滤
 *    FAIL|失败|错误|Error 取前 10
 *  - analyzeFailurePattern（mjs:108-140）：repeating（单类型 ≥3）/ cascading
 *    （多类型且某类 ≥2）/ transient 三模式 + 根因假设 + 建议动作
 */
export interface TestCommandResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
}

export interface TestReportSummary {
  file: string;
  failures: number;
  errors: number;
  passes: number;
  content: string;
}

export type AutoFixFailure =
  | { type: 'test-command-failure'; detail: string; exitCode: number | undefined }
  | { type: 'test-report-failure'; file: string; failures: number; errors: number; details: string[] };

export interface FixAttempt {
  success: boolean;
  failures: AutoFixFailure[];
  fixAction: string | null;
}

export type FailurePattern = 'repeating' | 'cascading' | 'transient';

export interface FailureAnalysis {
  pattern: FailurePattern;
  rootCauseHypothesis: string;
  recommendedAction: string;
  failureTypes: Record<string, AutoFixFailure[]>;
}

/**
 * 解析单份测试报告的通过/失败/错误计数（技能 mjs:63-76 v1.8.5-fork 对齐）。
 *
 * 双格式（D-1103）：正典 §2 汇总管道表优先，旧键值回退。
 * 管道表是模板与 G2 门禁规定的机器可读区；键值正则可能命中 §4 失败详情
 * 散文（如「失败：3 次」），故同报并存时管道表权威。
 */
export function parseReportContent(content: string): { failures: number; errors: number; passes: number } {
  const pipeFail = content.match(/\|\s*失败\s*\|\s*(\d+)\s*\|/);
  const pipeError = content.match(/\|\s*错误\s*\|\s*(\d+)\s*\|/);
  const pipePass = content.match(/\|\s*通过\s*\|\s*(\d+)\s*\|/);
  const kvFail = content.match(/失败[：:]\s*(\d+)/);
  const kvError = content.match(/错误[：:]\s*(\d+)/);
  const kvPass = content.match(/通过[：:]\s*(\d+)/);
  return {
    failures: pipeFail ? parseInt(pipeFail[1]!, 10) : (kvFail ? parseInt(kvFail[1]!, 10) : 0),
    errors: pipeError ? parseInt(pipeError[1]!, 10) : (kvError ? parseInt(kvError[1]!, 10) : 0),
    passes: pipePass ? parseInt(pipePass[1]!, 10) : (kvPass ? parseInt(kvPass[1]!, 10) : 0),
  };
}

/** 失败行过滤（技能 mjs:92-94 逐字）：FAIL|失败|错误|Error，取前 10。 */
export function filterFailLines(content: string): string[] {
  return content.split('\n')
    .filter((l) => l.includes('FAIL') || l.includes('失败') || l.includes('错误') || l.includes('Error'))
    .slice(0, 10);
}

/** 识别失败项（技能 mjs:79-106 逐字）：命令失败 + 报告失败两类。 */
export function identifyFailures(testResult: TestCommandResult, reports: TestReportSummary[]): AutoFixFailure[] {
  const failures: AutoFixFailure[] = [];
  if (!testResult.success) {
    failures.push({
      type: 'test-command-failure',
      detail: testResult.error || testResult.output,
      exitCode: testResult.exitCode,
    });
  }
  for (const report of reports) {
    if (report.failures > 0 || report.errors > 0) {
      failures.push({
        type: 'test-report-failure',
        file: report.file,
        failures: report.failures,
        errors: report.errors,
        details: filterFailLines(report.content),
      });
    }
  }
  return failures;
}

/**
 * 失败模式分析（技能 mjs:108-140 逐字）。
 * 纯函数消费 attempts 历史，输出 repeating/cascading/transient + 根因假设 + 建议动作。
 */
export function analyzeFailurePattern(attempts: FixAttempt[]): FailureAnalysis {
  const allFailures = attempts.flatMap((a) => a.failures);
  const failureTypes: Record<string, AutoFixFailure[]> = {};
  for (const f of allFailures) {
    const key = f.type;
    if (!failureTypes[key]) failureTypes[key] = [];
    failureTypes[key]!.push(f);
  }

  const isRepeatingFailure = Object.values(failureTypes).some((fails) => fails.length >= 3);
  const hasMultipleFailureTypes = Object.keys(failureTypes).length > 1;
  const hasCascadingPattern = hasMultipleFailureTypes && Object.values(failureTypes).some((fails) => fails.length >= 2);

  if (isRepeatingFailure && !hasMultipleFailureTypes) {
    return {
      pattern: 'repeating',
      rootCauseHypothesis: '同一失败反复出现——根因可能在于架构层面而非瞬态问题',
      recommendedAction: '尝试更深层次修复：检查接口契约、依赖关系、架构设计',
      failureTypes,
    };
  }
  if (hasCascadingPattern) {
    return {
      pattern: 'cascading',
      rootCauseHypothesis: '多种不同失败类型且至少一种反复出现——可能是级联失败，存在共同根因',
      recommendedAction: '先修复主失败（最常见类型），可能连带解决次失败',
      failureTypes,
    };
  }
  return {
    pattern: 'transient',
    rootCauseHypothesis: '偶发性失败——可能是环境或时序问题',
    recommendedAction: '增加重试次数或调整超时配置',
    failureTypes,
  };
}
