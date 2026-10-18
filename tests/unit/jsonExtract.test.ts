/**
 * jsonExtract 直测（cycle-33 测试深挖第二轮）。
 *
 * reviewEngine.test.ts 已有四用例间接覆盖（散文前缀/围栏/嵌套花括号/schema 闭合）；
 * 本文件钉**提取器自身的边界分支**：
 *   - 三级顺序的降级链（整串→围栏→平衡扫描）
 *   - 围栏内容非法 JSON → 降级平衡扫描（不是直接 null）
 *   - 首个平衡候选解析失败 → null（不贪第二个 {——fail-fast 语义）
 *   - 字符串字面量内的花括号/转义引号不扰动深度
 *   - 数组根：整串形态可过，散文包裹形态不可提（扫描只找对象根）
 */
import { describe, it, expect } from 'vitest';
import { extractJsonCandidate } from '../../src/host/llm/jsonExtract.ts';

describe('extractJsonCandidate —— 三级提取链', () => {
  it('一级：整串合法 JSON 原样返回（含空白）', () => {
    expect(extractJsonCandidate('{"a":1}')).toBe('{"a":1}');
    expect(extractJsonCandidate('  {"a": 1}  ')).toBe('  {"a": 1}  ');
    expect(extractJsonCandidate('[1,2,3]')).toBe('[1,2,3]'); // 数组根整串也过一级
    expect(extractJsonCandidate('"plain string"')).toBe('"plain string"'); // 字符串根整串同理
    expect(extractJsonCandidate('42')).toBe('42'); // 数字根整串同理
  });

  it('二级：```json 围栏体提取（含首尾空白 trim）', () => {
    const raw = '结论如下：\n```json\n{"verdict":"pass","score":9}\n```\n以上。';
    expect(extractJsonCandidate(raw)).toBe('{"verdict":"pass","score":9}');
  });

  it('二级：裸 ``` 围栏（无 json 标签）同样提取', () => {
    expect(extractJsonCandidate('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('二级失败 → 三级兜底：围栏内容非 JSON 时降级平衡扫描', () => {
    // 围栏里是散文；真 JSON 在围栏外。提取器必须降级而不是放弃。
    const raw = '```\n这只是一段说明文字\n```\n随后给出 {"a":1}';
    expect(extractJsonCandidate(raw)).toBe('{"a":1}');
  });

  it('三级：散文前缀 + 对象 + 散文后缀（首平衡子串）', () => {
    expect(extractJsonCandidate('好的，评估结果 {"ok":true} 请查收')).toBe('{"ok":true}');
  });

  it('三级：嵌套对象取最外层平衡', () => {
    expect(extractJsonCandidate('prefix {"outer":{"inner":{"deep":1}}} suffix')).toBe('{"outer":{"inner":{"deep":1}}}');
  });
});

describe('extractJsonCandidate —— 字符串字面量边界', () => {
  it('字符串内的花括号不扰动深度（尾括号才算闭合）', () => {
    expect(extractJsonCandidate('x {"s":"}{ 混淆 }{"} y')).toBe('{"s":"}{ 混淆 }{"}');
  });

  it('转义引号后的括号仍在字符串外语义正确闭合', () => {
    expect(extractJsonCandidate('{"s":"a\\"b"} tail')).toBe('{"s":"a\\"b"}');
  });

  it('转义反斜杠结尾的字符串（\\\\ 后不再吞字符）', () => {
    // JSON 里 "\\\\" 是一个转义反斜杠；其后引号应正常关闭字符串
    expect(extractJsonCandidate('{"s":"\\\\"} end')).toBe('{"s":"\\\\"}');
  });
});

describe('extractJsonCandidate —— 失败形态（fail-closed → null）', () => {
  it('无花括号且非整串 JSON → null', () => {
    expect(extractJsonCandidate('纯散文，没有任何结构')).toBe(null);
    expect(extractJsonCandidate('[1,2] 散文包裹的数组')).toBe(null); // 扫描只找对象根
  });

  it('截尾（深度未归零）→ null', () => {
    expect(extractJsonCandidate('{"a":{"b":1}')).toBe(null);
  });

  it('首个平衡候选非法 JSON → null（fail-fast，不贪第二个对象）', () => {
    // 语义注记：{"bad"} 平衡但非法；后面虽有合法对象，提取器不再前进。
    expect(extractJsonCandidate('{"bad"} {"good":1}')).toBe(null);
  });

  it('空串/空白串 → null', () => {
    expect(extractJsonCandidate('')).toBe(null);
    expect(extractJsonCandidate('   ')).toBe(null);
  });
});
