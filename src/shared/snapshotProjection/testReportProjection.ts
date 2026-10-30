/**
 * 最新测试报告的**摘要投影**（cycle-39 W-3 全档的来源；cycle-83 拆出以守 T3 ≤250 行）。
 *
 * ## 为什么必须在 shared 层（而不是 host 的 gateArtifacts）
 *
 * 解析语义与 `host/flows/gateArtifacts.ts` 的 `parseTestSummary` **同构**（§2 汇总表契约），
 * 但 `snapshotCore` 是 shared（客户端可达），不得 import host 模块——那会把 host 域
 * 拖进客户端编译单元。所以此处保留正则副本，一致性由
 * `tests/contract/flowDifferential.test.ts` 的差分钉死（两侧对同一夹具必须同结论）。
 *
 * ## 为什么只取**最新一轮**的报告
 *
 * 快照的门禁事件节点要回答「这轮测试什么状态」。全量投影 79 轮报告会再制造一次
 * 「过度产物」；而历史轮次的测试结论已由各自 cycle 目录保存，按需可查。
 * 只取最新一轮 = 与「主视图讲当前」的投影纪律一致。
 *
 * ## 空目录不算产出
 *
 * `test-reports/` 存在但零 .md ⇒ 返回 null（init-cycle 会先建空目录，把空目录
 * 当成"有测试报告"正是本仓踩过的假绿形态）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 报告摘要形状（与 SnapshotNode.testReport 同构，避免两处类型漂移）。 */
export interface TestReportSummary {
  report: string;
  passed: number;
  failures: number;
  errors: number;
  layers: string[];
}

/** 目录是否真实存在（不存在/无权限 → false，不抛）。 */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 读**指定轮次**目录下的最新测试报告摘要。
 *
 * @param cycleDir 某一轮循环的绝对目录（由调用方按窗口决定，本函数不做轮次选择）
 * @returns 无报告 / 无汇总表 / 不可读 → null（调用方据 null 决定是否挂 testReport）
 */
export function projectLatestTestReport(cycleDir: string): TestReportSummary | null {
  const reportsDir = join(cycleDir, 'test-reports');
  if (!isDir(reportsDir)) return null;
  const files = readdirSync(reportsDir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) return null;
  const latest = files
    .map((f) => ({ f, m: statSync(join(reportsDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0]?.f;
  if (latest === undefined) return null;
  try {
    const content = readFileSync(join(reportsDir, latest), 'utf8');
    // §2 汇总表契约：没有「| 通过 | N |」这一行就不是可识别汇总表（= 无证据）。
    if (!/^\|\s*(通过|失败|错误)\s*\|/m.test(content)) return null;
    const num = (label: string): number => {
      const m = content.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|`));
      return m ? Number.parseInt(m[1] ?? '0', 10) : 0;
    };
    // 分层结果行（| 层 | 结果 | 关键数字 | 形态）——只保留前 8 行，避免长报告膨胀节点。
    const layers = content
      .split('\n')
      .filter((l) => /^\|\s*(validate|vitest|smoke|trigger|typecheck|build|L\d)\b/i.test(l.trim()))
      .map((l) => l.trim().replace(/\|/g, '·').replace(/\s+/g, ' ').slice(0, 120))
      .slice(0, 8);
    return { report: latest, passed: num('通过'), failures: num('失败'), errors: num('错误'), layers };
  } catch {
    return null;
  }
}
