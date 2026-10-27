/**
 * 行级手术式 patch 测试（cycle-82）—— 配置编辑器的核心难点。
 *
 * ## 为什么这组用例必须这么细
 *
 * 「保留注释的配置写入」是 easy to demo, hard to be correct 的典型：正则替换
 * 能跑通 happy path，然后在下面每一种真实输入上静默切错行——
 * 带行内注释的键、带引号的值、`|` 多行块、CRLF、段不存在、键重复……
 * 每一条都是 `.cycles/config.yml` 里真实存在的形态（cycle-77 就写过四行注释）。
 *
 * ## 断言纪律（对应验收清单）
 *
 * ① 只动那一行：差异行数 == 2 × 改动字段数（一删一增），且其余行逐字节相等；
 * ② 注释保留：改动前后**注释行集合完全相等**（不是数量相等——内容也必须一样）；
 * ③ 非法值被拒：换行注入 / 超长 / 枚举外 / 越界整数，一律 ok=false 且 after===before；
 * ④ 反向自检：每条判定都先证明它能判出「坏形态」，否则守卫可能永久假绿。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPatch } from '../../src/host/configEdit/yamlPatch.ts';
import { diffStats, lineDiff } from '../../src/host/configEdit/yamlDiff.ts';
import { commentLines, serializeScalar, splitLines } from '../../src/host/configEdit/yamlText.ts';
import { readFieldValue } from '../../src/host/configEdit/configRead.ts';
import { fieldById } from '../../src/host/configEdit/configSchema.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 真实配置文件——所有 happy-path 断言都跑在它上面（夹具不能脱离现实）。 */
const REAL_CONFIG = readFileSync(join(ROOT, '.cycles', 'config.yml'), 'utf-8');

const SAMPLE = [
  'project:',
  '  name: "demo"   # 项目名（引号与行内注释都要活下来）',
  '  tech_stack: ["typescript"]',
  '',
  'macro_cycle:',
  '  # 这一行解释为什么显式写预算（注释是「为什么」的唯一载体）',
  '  autonomy_level: L4',
  '  complexity_budget: 100',
  '',
  'build:',
  '  build_cmd: "node scripts/build.mjs"',
  '  test_cmd: node scripts/run-tests.mjs',
  '  # 尾注释：属于 build 段，不该被搬走',
  '',
].join('\n');

function changedTexts(before: string, after: string): string[] {
  return lineDiff(before, after).filter((d) => d.kind !== 'same').map((d) => `${d.kind}:${d.text}`);
}

describe('planPatch：只动命中行（真实 .cycles/config.yml 上验证）', () => {
  it('改 autonomy_level：差异恰 2 行，其余行逐字节相等', () => {
    const plan = planPatch(REAL_CONFIG, { 'macro_cycle.autonomy_level': 'L3' });
    expect(plan.ok).toBe(true);
    expect(plan.changedFields).toEqual(['macro_cycle.autonomy_level']);
    expect(diffStats(plan.before, plan.after)).toEqual({ changed: 2, added: 1, removed: 1 });

    // 行数不变（原位替换，不增删行）
    const before = splitLines(plan.before);
    const after = splitLines(plan.after);
    expect(after).toHaveLength(before.length);
    // 除命中行外逐字节相等
    const idx = before.findIndex((l) => l.includes('autonomy_level:'));
    expect(idx).toBeGreaterThan(-1);
    expect(after[idx]).toBe('  autonomy_level: L3');
    before.forEach((line, i) => {
      if (i === idx) return;
      expect(after[i], `第 ${String(i + 1)} 行被意外改动`).toBe(line);
    });
  });

  it('注释行集合改动前后完全相等（含 4 行中文解释注释）', () => {
    const plan = planPatch(REAL_CONFIG, { 'macro_cycle.complexity_budget': 120 });
    expect(plan.ok).toBe(true);
    const before = commentLines(splitLines(plan.before));
    const after = commentLines(splitLines(plan.after));
    // 真实文件里注释不止一条——先证明扫描集非空（空集上的「相等」毫无意义）
    expect(before.length).toBeGreaterThanOrEqual(4);
    expect(after).toEqual(before);
  });

  it('多字段 patch：差异行数 = 2 × 改动字段数', () => {
    const plan = planPatch(REAL_CONFIG, {
      'build.test_cmd': 'node scripts/run-tests.mjs --only=vitest',
      'macro_cycle.autonomy_level': 'L2',
      'anic.toolDisclosure': 'indexed',
    });
    expect(plan.ok).toBe(true);
    // anic 段在真实文件里不存在 ⇒ 会新建段（3 行新增），所以这里分开数
    const auto = plan.changedFields.filter((f) => f !== 'anic.toolDisclosure');
    expect(auto).toHaveLength(2);
    expect(diffStats(plan.before, plan.after).changed).toBe(2 * auto.length + 3);
  });

  it('原位替换保留行内注释与引号外的一切排版', () => {
    const plan = planPatch(SAMPLE, { 'project.name': 'renamed' });
    expect(plan.ok).toBe(true);
    const line = splitLines(plan.after).find((l) => l.includes('name:')) as string;
    expect(line).toBe('  name: renamed   # 项目名（引号与行内注释都要活下来）');
  });

  it('引号按需：普通值裸写，含 YAML 特殊字符的值加引号', () => {
    const plain = planPatch(SAMPLE, { 'project.name': 'my-project' });
    expect(splitLines(plain.after).find((l) => l.includes('name:'))).toBe('  name: my-project   # 项目名（引号与行内注释都要活下来）');
    // 值里有冒号+空格 ⇒ 必须加引号，否则 YAML 会把它读成嵌套映射（`name: a: b` 非法）
    const risky = planPatch(SAMPLE, { 'project.name': 'a: b' });
    expect(risky.ok).toBe(true);
    expect(splitLines(risky.after).some((l) => l.includes('name: "a: b"'))).toBe(true);
    // 反向自检：序列化器对「会改变语义的形态」确实加引号，对普通串确实不加
    expect(serializeScalar('a: b')).toBe('"a: b"');
    expect(serializeScalar('true')).toBe('"true"'); // 裸 true 会被读成布尔
    expect(serializeScalar('-x')).toBe('"-x"'); // 裸 `- ` 开头是列表指示符
    expect(serializeScalar('node scripts/build.mjs')).toBe('node scripts/build.mjs');
    // 再反向：真配置里那个带引号的值，读取器能完整还原
    expect(readFieldValue(REAL_CONFIG, fieldById('project.name') as never)).toBe('dsh-anic');
  });

  it('CRLF 文件：换行风格原样保留（绝不混排，也不多出 \\r）', () => {
    const crlf = 'project:\r\n  name: "x"\r\n  tech_stack: ["ts"]\r\n';
    const plan = planPatch(crlf, { 'project.name': 'y' });
    expect(plan.ok).toBe(true);
    expect(plan.after).toBe('project:\r\n  name: "y"\r\n  tech_stack: ["ts"]\r\n');
    // 混排自检：CRLF 数必须等于行数减一（没有裸 LF）
    const lf = (plan.after.match(/\n/g) ?? []).length;
    const crlfCount = (plan.after.match(/\r\n/g) ?? []).length;
    expect(lf).toBe(crlfCount);
  });

  it('无尾换行的文件：不擅自补尾换行', () => {
    const plan = planPatch('project:\n  name: "x"', { 'project.name': 'y' });
    expect(plan.ok).toBe(true);
    expect(plan.after).toBe('project:\n  name: "y"');
  });

  it('段内缺键：插在段尾，跟随段内既有缩进', () => {
    const src = 'build:\n  build_cmd: a.mjs\n  test_cmd: b.mjs\n\nother:\n  k: v\n';
    const plan = planPatch(src, { 'build.lint_cmd': 'c.mjs' });
    expect(plan.ok).toBe(true);
    expect(plan.insertedFields).toEqual(['build.lint_cmd']);
    expect(splitLines(plan.after)).toEqual([
      'build:', '  build_cmd: a.mjs', '  test_cmd: b.mjs', '  lint_cmd: c.mjs', '', 'other:', '  k: v',
    ]);
  });

  it('4 空格缩进的段：插入沿用该段的缩进宽度（不写死 2）', () => {
    const plan = planPatch('build:\n    build_cmd: a.mjs\n', { 'build.test_cmd': 'b.mjs' });
    // 0: `build:` / 1: 原键（原样）/ 2: 新插入的键（缩进跟随该段的 4 空格）
    expect(splitLines(plan.after)).toEqual(['build:', '    build_cmd: a.mjs', '    test_cmd: b.mjs']);
  });

  it('整段缺失：在文件末尾新建段（不插进别人的段里）', () => {
    const src = 'project:\n  name: x\n';
    const plan = planPatch(src, { 'build.test_cmd': 'node t.mjs' });
    expect(plan.ok).toBe(true);
    expect(splitLines(plan.after).slice(-2)).toEqual(['build:', '  test_cmd: node t.mjs']);
    // 反例自检：新行绝不能出现在 project 段体中间
    expect(splitLines(plan.after)[1]).toBe('  name: x');
  });

  it('`|` 多行块：拒绝原位改写（改成单行会截断块），ok=false', () => {
    const src = 'build:\n  test_cmd: |\n    node a.mjs\n    node b.mjs\n';
    const plan = planPatch(src, { 'build.test_cmd': 'node c.mjs' });
    expect(plan.ok).toBe(false);
    expect(plan.after).toBe(plan.before);
    expect(plan.warnings.join(' ')).toContain('多行块标量');
  });

  it('块标量正文里的 `key:` 不参与定位（否则会切到别人的字段）', () => {
    const src = [
      'build:',
      '  test_cmd: |',
      '    project:',
      '      name: evil',
      '  lint_cmd: real.mjs',
      '',
      'project:',
      '  name: "actual"',
      '',
    ].join('\n');
    const plan = planPatch(src, { 'project.name': 'renamed' });
    expect(plan.ok).toBe(true);
    // 只改真实 project 段里的那一行
    expect(splitLines(plan.after)[7]).toBe('  name: renamed');
    // 块正文原封不动
    expect(splitLines(plan.after)[3]).toBe('      name: evil');
  });

  it('键重复出现：拒绝（谁生效取决于读者，静默改一行会造出"改了没生效"）', () => {
    const src = 'macro_cycle:\n  autonomy_level: L4\n  autonomy_level: L3\n';
    const plan = planPatch(src, { 'macro_cycle.autonomy_level': 'L2' });
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain('重复键');
    expect(plan.after).toBe(plan.before);
  });
});

describe('planPatch：非法值一律拒绝且零写入', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['换行注入（防新增键）', { 'project.name': 'ok\n  evil_key: true' }, 'newline'],
    ['回车注入', { 'build.build_cmd': 'a\rb' }, 'newline'],
    ['制表注入', { 'project.name': 'a\tb' }, 'newline'],
    ['超长值', { 'project.name': 'x'.repeat(513) }, 'too long'],
    ['枚举外值', { 'macro_cycle.autonomy_level': 'L9' }, 'one of'],
    ['整数越界', { 'macro_cycle.complexity_budget': 0 }, '>='],
    ['非整数', { 'macro_cycle.complexity_budget': 1.5 }, 'integer'],
    ['布尔字段收字符串', { 'anic.flow.workflowTab': 'yes' }, 'boolean'],
    ['数组项含逗号', { 'anic.allowedOrigins': ['a,b'] }, 'comma'],
  ];

  for (const [name, patch, expectIn] of cases) {
    it(`${name} → ok=false 且字节不变`, () => {
      const plan = planPatch(SAMPLE, patch);
      expect(plan.ok).toBe(false);
      expect(plan.after).toBe(plan.before);
      expect(plan.changedFields).toEqual([]);
      expect(plan.error).toContain(expectIn);
    });
  }

  it('未知字段：只读不写（含 gates/layers 这类嵌套结构）', () => {
    const plan = planPatch(SAMPLE, { 'gates.G2.coverage_threshold.lines': 90 });
    expect(plan.ok).toBe(false);
    expect(plan.warnings.join(' ')).toContain('未知字段');
    expect(plan.after).toBe(plan.before);
  });

  it('混入一个非法值 ⇒ 整体拒绝（不做部分写入）', () => {
    const plan = planPatch(SAMPLE, { 'macro_cycle.autonomy_level': 'L3', 'macro_cycle.complexity_budget': -1 });
    expect(plan.ok).toBe(false);
    expect(plan.after).toBe(plan.before);
    // 合法的那一项也绝不能偷偷写进去
    expect(plan.changedFields).toEqual([]);
  });
});

describe('planPatch：幂等与数组', () => {
  it('目标值与现值相同 → 零变化（保存未修改的表单必须是零 diff）', () => {
    const plan = planPatch(REAL_CONFIG, { 'macro_cycle.autonomy_level': 'L4' });
    expect(plan.ok).toBe(true);
    expect(plan.changedFields).toEqual([]);
    expect(plan.after).toBe(REAL_CONFIG);
    expect(diffStats(plan.before, plan.after).changed).toBe(0);
  });

  it('数组用内联 `[a, b]`（tech_stack）', () => {
    const plan = planPatch(SAMPLE, { 'project.tech_stack': ['typescript', 'node'] });
    expect(splitLines(plan.after).some((l) => l.includes('tech_stack: [typescript, node]'))).toBe(true);
    expect(readFieldValue(plan.after, fieldById('project.tech_stack') as never)).toEqual(['typescript', 'node']);
  });

  it('allowedOrigins 用裸逗号列表（方括号会被 parseAnicSection 读坏）', () => {
    const src = 'anic:\n  allowedOrigins: https://a.dev\n';
    const plan = planPatch(src, { 'anic.allowedOrigins': ['https://b.dev', 'https://c.dev'] });
    expect(plan.ok).toBe(true);
    expect(plan.after).toBe('anic:\n  allowedOrigins: https://b.dev, https://c.dev\n');
    // 反向自检：写成方括号形态会被读成 `[https://b.dev`（证明 arrayStyle 有实际作用）
    const bracketed = 'anic:\n  allowedOrigins: [https://b.dev, https://c.dev]\n';
    const values = readFieldValue(bracketed, fieldById('anic.allowedOrigins') as never) as string[];
    expect(values[0]).toBe('[https://b.dev');
  });

  it('两次连续 patch 结果可叠加（第二次看到的是第一次的文件）', () => {
    const first = planPatch(REAL_CONFIG, { 'macro_cycle.autonomy_level': 'L3' });
    const second = planPatch(first.after, { 'macro_cycle.complexity_budget': 150 });
    expect(second.ok).toBe(true);
    expect(second.after).toContain('autonomy_level: L3');
    expect(second.after).toContain('complexity_budget: 150');
    // 第二条命令没有把第一条改回 L4
    expect(commentLines(splitLines(second.after))).toEqual(commentLines(splitLines(REAL_CONFIG)));
  });
});

describe('反向自检：判定式真的能判出坏形态', () => {
  it('diffStats 能报出"多改了一行"（否则差异行数是装饰）', () => {
    const plan = planPatch(SAMPLE, { 'project.name': 'renamed' });
    const polluted = plan.after.replace('macro_cycle:', 'macro_cycle:  # tampered');
    const stats = diffStats(plan.before, polluted);
    // 一删一增命中行 + 一删一增被污染行 = 4
    expect(stats.changed).toBe(4);
    expect(changedTexts(plan.before, polluted).some((t) => t.includes('tampered'))).toBe(true);
  });

  it('commentLines 能报出注释丢失（比对不是恒真）', () => {
    const before = commentLines(splitLines(SAMPLE));
    const stripped = commentLines(splitLines(SAMPLE.replace('  # 尾注释：属于 build 段，不该被搬走', '')));
    expect(before.length).toBeGreaterThan(0);
    expect(stripped).not.toEqual(before);
  });
});
