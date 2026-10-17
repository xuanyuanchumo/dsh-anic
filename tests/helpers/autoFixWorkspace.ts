/**
 * auto-fix 测试夹具助手 —— config.yml / cycle 目录 / 测试报告的播种。
 *
 * autoFixEngine / autoFixFlow / autoFixDifferential 三份测试共享同一套播种
 * 语义（与 hitlWorkspace.ts 同范式，避免各写一份后语义漂移）。
 * 测试命令要求：快速、确定性、跨 cmd/PowerShell shell——用 node -e 内联脚本
 * （exit 0 / exit 1 / 标记文件瞬态三种形态）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AUDIT_HEADER = '# 审计日志\n\n| 时间 | 检查点 | 结果 | 详情 | 状态 |\n|---|---|---|---|---|\n';

/** 恒过测试命令（shell 内建 exit 0）。 */
export const PASSING_CMD = 'exit 0';

/** 恒败测试命令。 */
export const FAILING_CMD = 'node -e "process.exit(1)"';

/**
 * 瞬态测试命令：首跑失败并写标记文件，之后（retest / 下轮）标记存在即过——
 * 精确模拟技能「test 失败 → 桩修复 → retest 过」的 fix-verified 路径。
 */
export function transientCmd(markerPath: string): string {
  const code = 'const fs=require(\'fs\');const p=process.argv[1];if(fs.existsSync(p))process.exit(0);fs.writeFileSync(p,\'x\');process.exit(1)';
  return `node -e "${code}" "${markerPath}"`;
}

export interface AutoFixSeedOptions {
  testCmd: string;
  /** 是否建带表头的 审计日志.md（缺省 true）。 */
  auditLog?: boolean;
  /** 播种 test-reports/*.md（file 相对名 + 正文）。 */
  reports?: Array<{ file: string; content: string }>;
  /** 是否播种 .cycles/config.yml（false 时靠 testCmd 参数兜底）。 */
  config?: boolean;
}

/** 播种一个最小可运行的 auto-fix 工作区（.cycles + cycle-1 + config）。 */
export function seedAutoFixWorkspace(dir: string, opts: AutoFixSeedOptions): string {
  const cyclesDir = join(dir, '.cycles');
  const cycleDir = join(cyclesDir, 'cycles', 'cycle-1');
  mkdirSync(cycleDir, { recursive: true });
  if (opts.config !== false) {
    mkdirSync(cyclesDir, { recursive: true });
    writeFileSync(join(cyclesDir, 'config.yml'), `test_cmd: "${opts.testCmd}"\nlint_cmd: "exit 0"\nbuild_cmd: "exit 0"\nautonomy_level: L4\n`);
  }
  if (opts.auditLog !== false) writeFileSync(join(cycleDir, '审计日志.md'), AUDIT_HEADER);
  if (opts.reports) {
    const reportDir = join(cycleDir, 'test-reports');
    mkdirSync(reportDir, { recursive: true });
    for (const r of opts.reports) writeFileSync(join(reportDir, r.file), r.content);
  }
  return cycleDir;
}

/**
 * 一份旧键值格式测试报告正文（「失败：N」——v1.8.5-fork 前唯一可解析形态，
 * 现为回退路径，保留验证向后兼容）。
 */
export function testReportContent(pass: number, fail: number, error: number): string {
  return `# 测试报告\n\n## 汇总\n\n通过：${pass}\n失败：${fail}\n错误：${error}\n\n- FAIL src/foo.test.ts\n- 错误: timeout\n`;
}

/**
 * 一份正典 §2 汇总管道表测试报告正文（「| 失败 | N |」——模板与 G2 门禁
 * 规定的机器可读形态；D-1103 前双侧正则均不识别，读成 0 即 fail-open）。
 */
export function canonicalTestReportContent(pass: number, fail: number, error: number): string {
  return [
    '# 测试报告',
    '',
    '## 2. 汇总',
    '',
    '| 指标 | 数量 |',
    '|---|---|',
    `| 通过 | ${pass} |`,
    `| 失败 | ${fail} |`,
    `| 错误 | ${error} |`,
    '| 跳过 | 0 |',
    '',
    '## 4. 失败项详情',
    '',
    '- FAIL src/foo.test.ts — 断言不等',
    '- 错误: timeout',
  ].join('\n');
}
