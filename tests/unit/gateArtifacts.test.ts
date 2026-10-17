/**
 * gateArtifacts 解析器单元（R3 阶段 2）—— 与技能脚本**逐字对齐**的语义移植钉死。
 *
 * 这些解析器是差分契约的基石：任何正则漂移都会在 flowDifferential.test.ts
 * 里表现为 native/script 判定分叉（双真相源）。此处单测钉边界形态。
 */
import { describe, expect, it } from 'vitest';
import {
  QUALITY_CHECKS,
  countEvalVerdictRows,
  parseQualityRow,
  parseTaskRows,
  parseTestSummary,
  readYamlString,
} from '../../src/host/flows/gateArtifacts.ts';

describe('parseTaskRows（lib/tasks.mjs:12-25 逐字移植）', () => {
  it('六列管道行 + 合法状态 → 收录；末列即状态', () => {
    const rows = parseTaskRows('| T-01 | P0 | 任务 | 验证 | lead | 完成 |');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(['T-01', 'P0', '任务', '验证', 'lead', '完成']);
  });
  it('表头行（首列=任务）被跳过', () => {
    expect(parseTaskRows('| 任务 | 优先级 | 内容 | 方式 | 责任 | 状态 |')).toEqual([]);
  });
  it('列数 <6 跳过；状态值不在 {待办|进行中|完成} 跳过', () => {
    expect(parseTaskRows('| T-01 | P0 | 短行 |')).toEqual([]);
    expect(parseTaskRows('| T-01 | P0 | 任务 | 验证 | lead | 已完成 |')).toEqual([]);
    expect(parseTaskRows('| T-01 | P0 | 任务 | 验证 | lead | 进行中 |')).toHaveLength(1);
    expect(parseTaskRows('| T-01 | P0 | 任务 | 验证 | lead | 待办 |')).toHaveLength(1);
  });
  it('首列空 / 反引号占位 → 跳过（模板占位行）', () => {
    expect(parseTaskRows('|   | P0 | x | y | z | 完成 |')).toEqual([]);
    expect(parseTaskRows('| `` | P0 | x | y | z | 完成 |')).toEqual([]);
    expect(parseTaskRows('| `T-01` | P0 | x | y | z | 完成 |')).toHaveLength(1); // 非空内容保留
  });
  it('七列以上照收（GATE_AGENTS 等宽表）', () => {
    expect(parseTaskRows('| T-01 | P0 | a | b | c | extra | 完成 |')).toHaveLength(1);
  });
});

describe('countEvalVerdictRows（gate-check.mjs:53 同正则）', () => {
  it('E1-E8 / Q1-Q8 裁决行计数；非裁决行不计', () => {
    const md = [
      '# 评估报告',
      '| E1 | 意图对齐 | PASS | 详情 |',
      '| E2 | 规格符合 | FAIL | 详情 |',
      '| Q1 | 架构 | PASS | 详情 |',
      '| 维度 | 名称 | 结果 | 详情 |', // 表头不计
      '| X1 | 无关 | PASS | x |',      // X 不计
      '普通文本 | E3 | 混排 |',          // 不在行首不计
    ].join('\n');
    expect(countEvalVerdictRows(md)).toBe(3);
  });
  it('不容忍行首空白（技能正则 ^\\| 要求管道符在行首——逐字移植，宽空白形态不计）', () => {
    expect(countEvalVerdictRows('  | E5 | 性能 | SKIP | x |')).toBe(0);
  });
});

describe('parseTestSummary（gate-check.mjs:103-111 §2 汇总表契约）', () => {
  it('识别汇总表并提取失败/错误计数', () => {
    const md = [
      '# 测试报告',
      '| 结果 | 数量 |',
      '| --- | --- |',
      '| 通过 | 480 |',
      '| 失败 | 2 |',
      '| 错误 | 1 |',
    ].join('\n');
    expect(parseTestSummary(md)).toEqual({ recognized: true, failures: 2, errors: 1 });
  });
  it('缺 失败/错误 行 → 0（脚本同款：failMatch 为 null 时取 0）', () => {
    const md = '| 结果 | 数量 |\n| --- | --- |\n| 通过 | 10 |';
    expect(parseTestSummary(md)).toEqual({ recognized: true, failures: 0, errors: 0 });
  });
  it('无 通过/失败/错误 表头 → recognized=false（无证据 ≠ 通过）', () => {
    expect(parseTestSummary('自由文本报告，没有汇总表')).toEqual({ recognized: false, failures: 0, errors: 0 });
  });
});

describe('parseQualityRow（gate-check.mjs:156 字面空格形态）', () => {
  const md = [
    '| Q1 | 架构 | PASS | 备注 |',
    '| Q2 | 测试 | SKIP | 未评 |',
    '| Q3 | 构建 | FAIL | 红 |',
  ].join('\n');
  it('三态解析', () => {
    expect(parseQualityRow(md, 'Q1')).toBe('PASS');
    expect(parseQualityRow(md, 'Q2')).toBe('SKIP');
    expect(parseQualityRow(md, 'Q3')).toBe('FAIL');
  });
  it('行缺失 → null（unevaluated，不能关门）', () => {
    expect(parseQualityRow(md, 'Q8')).toBeNull();
  });
  it('字面空格差异钉死：`| Qn |` 前必须恰好一空格——宽空白形态不匹配（与技能逐字一致）', () => {
    const wide = '|  Q1  | 架构 | PASS | x |';
    expect(parseQualityRow(wide, 'Q1')).toBeNull();
  });
});

describe('QUALITY_CHECKS 维度映射（gate-check.mjs:142-147 同表）', () => {
  it('G0→[Q1,Q5] G1→[Q7] G2→[Q2] G3→[Q3,Q4]；无多余键', () => {
    expect(QUALITY_CHECKS).toEqual({ G0: ['Q1', 'Q5'], G1: ['Q7'], G2: ['Q2'], G3: ['Q3', 'Q4'] });
  });
});

describe('readYamlString（lib/config.mjs:36-48 引号容错 + 注释剥离）', () => {
  it('无引号 / 双引号 / 单引号统一', () => {
    expect(readYamlString('build_cmd: exit 0', 'build_cmd')).toBe('exit 0');
    expect(readYamlString('build_cmd: "exit 0"', 'build_cmd')).toBe('exit 0');
    expect(readYamlString("build_cmd: 'exit 0'", 'build_cmd')).toBe('exit 0');
  });
  it("行尾注释剥离（' #'）；行中 # 保留", () => {
    expect(readYamlString('build_cmd: exit 0 # 注释', 'build_cmd')).toBe('exit 0');
    expect(readYamlString('build_cmd: node a.js#frag', 'build_cmd')).toBe('node a.js#frag');
  });
  it('键缺失 / 空值 / null 输入 → null', () => {
    expect(readYamlString('other: 1', 'build_cmd')).toBeNull();
    expect(readYamlString('build_cmd:', 'build_cmd')).toBeNull();
    expect(readYamlString('build_cmd: ""', 'build_cmd')).toBeNull();
    expect(readYamlString(null, 'build_cmd')).toBeNull();
  });
});
