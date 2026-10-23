/**
 * 门禁工件解析器（L1 纯函数）—— 与技能脚本**逐字对齐**的语义移植。
 *
 * 差分测试（tests/contract/flowDifferential.test.ts）的契约面：本文件每个解析器
 * 的判定结果必须与技能脚本一致。来源行号（assets/skill/scripts 基线）：
 *  - parseTaskRows      ← lib/tasks.mjs:12-25（G1 与 archive-cycle 共用实现）
 *  - countEvalVerdictRows ← gate-check.mjs:53（G0 裁决行证据）
 *  - parseTestSummary   ← gate-check.mjs:103-111（G2 §2 汇总表契约）
 *  - parseQualityRow    ← gate-check.mjs:156（质量门三态行）
 *  - readYamlString     ← lib/config.mjs:36-48（引号容错 + 行尾注释剥离）
 *
 * 修改任何正则前先跑差分测试——两侧判定分叉 = 双真相源（R3 最大风险项）。
 */
import type { TaskRow, TestSummary, QualityRow } from './gateTypes.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 任务行状态值（lib/tasks.mjs 同源；cycle-72 与脚本同步扩表）。
 *  封闭三值白名单会让「部分完成」被静默丢弃 → G1 假 PASS（见技能包 tasks.mjs 文件头）。 */
export const TASK_STATUS_VALUES = ['待办', '进行中', '部分完成', '未完成', '未开始', '阻塞', '完成'];
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const TASK_STATUS_RE = new RegExp(`^(${TASK_STATUS_VALUES.map(escapeRe).join('|')})$`);

/** G1：P0-P3 任务表行解析（lib/tasks.mjs:12-25 逐字移植）。 */
export function parseTaskRows(content: string): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const line of String(content).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    const first = cells[0] ?? '';
    if (!first || first.replace(/`/g, '').trim() === '') continue; // 模板占位行（首列空）
    if (first === '任务') continue; // 表头
    const last = cells[cells.length - 1] ?? '';
    if (!TASK_STATUS_RE.test(last)) continue;
    rows.push(cells);
  }
  return rows;
}

/** G0：评估报告裁决行计数（gate-check.mjs:53 同正则）。 */
export function countEvalVerdictRows(content: string): number {
  return (content.match(/^\|\s*(E[1-8]|Q[1-8])\s*\|/gm) ?? []).length;
}

/** G2：§2 汇总表解析（gate-check.mjs:103-111 同正则）。recognized=false = 无证据。 */
export function parseTestSummary(content: string): TestSummary {
  if (!/^\|\s*(通过|失败|错误)\s*\|/m.test(content)) return { recognized: false, failures: 0, errors: 0 };
  const failMatch = content.match(/\|\s*失败\s*\|\s*(\d+)\s*\|/);
  const errorMatch = content.match(/\|\s*错误\s*\|\s*(\d+)\s*\|/);
  return {
    recognized: true,
    failures: failMatch ? parseInt(failMatch[1] ?? '0', 10) : 0,
    errors: errorMatch ? parseInt(errorMatch[1] ?? '0', 10) : 0,
  };
}

/** 质量门维度映射（gate-check.mjs:142-147 同表）。 */
export const QUALITY_CHECKS: Readonly<Record<string, readonly string[]>> = {
  G0: ['Q1', 'Q5'],
  G1: ['Q7'],
  G2: ['Q2'],
  G3: ['Q3', 'Q4'],
};

/**
 * 质量行三态解析（gate-check.mjs:156 同正则形态）。
 * 注意技能侧正则是 `^\| Qn \|`（字面空格），与 G0 的 `\s*` 容忍形态**不同**——
 * 逐字保留该差异，否则差分测试会在边缘格式上分叉。
 * 返回 null = 行缺失（unevaluated，不能关门）。
 */
export function parseQualityRow(content: string, q: string): QualityRow {
  const pattern = new RegExp(`^\\| ${q} \\|.*\\|\\s*(PASS|FAIL|SKIP)\\s*\\|`, 'm');
  const match = content.match(pattern);
  if (!match) return null;
  return match[1] as 'PASS' | 'FAIL' | 'SKIP';
}

/** YAML 单行字符串读取（lib/config.mjs:36-48 逐字移植：引号可选 + 行尾注释剥离）。 */
export function readYamlString(configContent: string | null, key: string): string | null {
  if (!configContent) return null;
  const m = configContent.match(new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm'));
  if (!m) return null;
  let v = (m[1] ?? '').trim();
  const commentIdx = v.indexOf(' #');
  if (commentIdx >= 0) v = v.slice(0, commentIdx).trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    v = v.slice(1, -1);
  }
  return v.length > 0 ? v : null;
}

/**
 * 嵌套 YAML 布尔读取（gate-check.mjs getYamlNestedBoolean 同构，cycle-39 T-3903）。
 * 形态：section → 两空格 key2 → 四空格 leaf。未声明 → false。
 */
export function readYamlNestedBoolean(content: string | null, section: string, key2: string, leaf: string): boolean {
  if (!content) return false;
  const re = new RegExp(
    `^${section}:\\s*$\\n(?:[^\\n]*\\n)*?^\\s{2}${key2}:\\s*$\\n(?:[^\\n]*\\n)*?^\\s{4}${leaf}:\\s*(true|false)\\s*$`,
    'm',
  );
  const m = content.match(re);
  return m?.[1] === 'true';
}

/**
 * 旅程覆盖检查（gate-check.mjs checkJourneyCoverage 同构，cycle-39 T-3903）。
 * journeys 声明的每条旅程的 test_files 必须存在且非空——装饰性声明从此有门禁。
 */
export function checkJourneyCoverage(projectDir: string, configContent: string | null): { pass: boolean; detail: string } {
  if (!configContent || !/^journeys:\s*$/m.test(configContent)) {
    return { pass: true, detail: 'No journeys declared (journey_coverage vacuously true)' };
  }
  const lines = configContent.split('\n');
  const startIdx = lines.findIndex((l) => /^journeys:\s*$/.test(l));
  const missing: string[] = [];
  let journeyCount = 0;
  let currentJourney = '';
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\S/.test(line)) break;
    const jm = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*$/);
    if (jm) { journeyCount++; currentJourney = jm[1] ?? ''; continue; }
    const tfm = line.match(/^\s*test_files:\s*\[(.*)\]\s*$/);
    if (tfm) {
      const files = (tfm[1] ?? '')
        .split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      if (files.length === 0) {
        missing.push(`${currentJourney}: test_files declared but empty`);
      } else {
        for (const f of files) {
          if (!existsSync(join(projectDir, f))) missing.push(`${currentJourney}: ${f}`);
        }
      }
    }
  }
  if (journeyCount === 0) return { pass: true, detail: 'journeys section empty' };
  if (missing.length > 0) {
    return { pass: false, detail: `Journey coverage broken: ${missing.join('; ')} (journey_coverage requires declared test files to exist)` };
  }
  return { pass: true, detail: `Journey coverage OK (${journeyCount} journeys, all test files exist)` };
}
