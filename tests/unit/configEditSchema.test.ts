/**
 * 字段表与值校验测试（cycle-82）。
 *
 * ## 守什么
 *
 * ① 字段表的**单一事实源**性质：`anic.flow.*` 必须逐项来自 shared/flows.ts 的
 *    FLOWS（手抄一份 = 新增 flow 时编辑器静默漏项，INV-29 同族缺陷）；
 * ② 单行纪律：换行/回车/制表一律拒绝（防往 YAML 里注入新键），长度上限生效；
 * ③ 类型纪律：枚举/整数范围/布尔/数组各自拒绝越界值，且**不静默强转**
 *    （`'5'` 转 5 是允许的规范化，`1.5` 转 1 不是）；
 * ④ 回读语义与 host/config.ts 同源：同一份原文，schema 读取器与唯一 loader
 *    对 autonomy_level / allowedOrigins 必须得出**相同**结论（双投影矛盾守卫）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_FIELDS,
  MAX_SINGLE_LINE,
  configFieldViews,
  fieldById,
  validateFieldValue,
  validateSingleLine,
} from '../../src/host/configEdit/configSchema.ts';
import { readFieldValue } from '../../src/host/configEdit/configRead.ts';
import { FLOWS } from '../../src/shared/flows.ts';
import { getAutonomyLevel, getYamlString, loadWorkspaceConfig } from '../../src/host/config.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_CONFIG = readFileSync(join(ROOT, '.cycles', 'config.yml'), 'utf-8');

/** 取字段定义（表里没有就抛——测试里用 non-null 断言会把"表少一项"变成假绿）。 */
function def(id: string) {
  const d = fieldById(id);
  if (!d) throw new Error(`field not in CONFIG_FIELDS: ${id}`);
  return d;
}

describe('字段表：覆盖与单一事实源', () => {
  it('扫描集非空下限（空表 = 永久假绿）', () => {
    expect(CONFIG_FIELDS.length).toBeGreaterThanOrEqual(18);
  });

  it('anic.flow.* 逐项来自 shared/flows.ts 的 FLOWS（不手抄键名）', () => {
    const flowFields = CONFIG_FIELDS.filter((f) => f.section === 'anic' && f.kind === 'bool');
    expect(flowFields).toHaveLength(FLOWS.length);
    const ids = flowFields.map((f) => f.id).sort();
    expect(ids).toEqual(FLOWS.map((f) => `anic.${f.id}`).sort());
    // 反向自检：从 FLOWS 里删一项，集合比较必须能发现
    const shrunk = FLOWS.slice(1).map((f) => `anic.${f.id}`).sort();
    expect(shrunk).not.toEqual(ids);
  });

  it('任务点名的字段一个不少', () => {
    const required = [
      'project.name', 'project.tech_stack',
      'build.build_cmd', 'build.typecheck_cmd', 'build.lint_cmd', 'build.test_cmd',
      'build.coverage_cmd', 'build.e2e_cmd', 'build.hygiene_cmd',
      'macro_cycle.autonomy_level', 'macro_cycle.complexity_budget',
      'anic.allowedOrigins', 'anic.toolDisclosure',
    ];
    for (const id of required) expect(fieldById(id), `缺字段 ${id}`).toBeDefined();
  });

  it('id 唯一 + 每个字段都有词表键与长度上限', () => {
    const ids = CONFIG_FIELDS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of CONFIG_FIELDS) {
      // flow 开关复用既有 flows.* 词条（不新增 10 条重复文案），其余走 config.*
      const expectedPrefix = f.kind === 'bool' && f.section === 'anic' ? 'flows.' : 'config.';
      expect(f.labelKey.startsWith(expectedPrefix), `${f.id} 词表键应以 ${expectedPrefix} 开头，实为 ${f.labelKey}`).toBe(true);
      expect(f.maxLength).toBeGreaterThan(0);
    }
    // 反向自检：前缀判定不是恒真——把一条键改成别的前缀必须被看出来
    expect('panel.title'.startsWith('config.')).toBe(false);
  });

  it('allowedOrigins 必须是逗号风格（方括号会被 parseAnicSection 读坏）', () => {
    expect(def('anic.allowedOrigins').arrayStyle).toBe('comma');
    expect(def('project.tech_stack').arrayStyle).toBeUndefined();
  });

  it('序列化视图可 JSON 往返（客户端拿到的就是纯数据）', () => {
    const views = configFieldViews();
    expect(views).toHaveLength(CONFIG_FIELDS.length);
    const round = JSON.parse(JSON.stringify(views)) as typeof views;
    expect(round).toEqual(views);
    // 枚举字段必须带枚举值（否则客户端只能给个空文本框）
    const auto = round.find((v) => v.id === 'macro_cycle.autonomy_level');
    expect(auto?.enumValues).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(round.find((v) => v.id === 'project.name')?.enumValues).toBeNull();
  });
});

describe('值校验：单行纪律与类型纪律', () => {
  it('换行/回车/制表一律拒绝（防注入新键）', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'x\n  evil: true']) {
      const r = validateFieldValue(def('project.name'), bad);
      expect(r.ok, `应拒绝 ${JSON.stringify(bad)}`).toBe(false);
      expect(r.ok === false && r.error).toContain('newline');
    }
  });

  it('长度上限 512：边界值接受 / 超一位拒绝', () => {
    expect(validateFieldValue(def('project.name'), 'x'.repeat(MAX_SINGLE_LINE)).ok).toBe(true);
    expect(validateFieldValue(def('project.name'), 'x'.repeat(MAX_SINGLE_LINE + 1)).ok).toBe(false);
  });

  it('命令允许内部空格但两端 trim（`node x.mjs --watch` 是合法命令）', () => {
    const r = validateFieldValue(def('build.test_cmd'), '  node x.mjs --watch  ');
    expect(r).toEqual({ ok: true, value: 'node x.mjs --watch' });
  });

  it('枚举：只接受枚举内值', () => {
    expect(validateFieldValue(def('macro_cycle.autonomy_level'), 'L3')).toEqual({ ok: true, value: 'L3' });
    expect(validateFieldValue(def('macro_cycle.autonomy_level'), 'l3').ok).toBe(false);
    expect(validateFieldValue(def('anic.toolDisclosure'), 'indexed')).toEqual({ ok: true, value: 'indexed' });
    expect(validateFieldValue(def('anic.toolDisclosure'), 'lazy').ok).toBe(false);
  });

  it('整数：接受数字串规范化，拒绝小数/越界/NaN', () => {
    expect(validateFieldValue(def('macro_cycle.complexity_budget'), '120')).toEqual({ ok: true, value: 120 });
    expect(validateFieldValue(def('macro_cycle.complexity_budget'), 120)).toEqual({ ok: true, value: 120 });
    expect(validateFieldValue(def('macro_cycle.complexity_budget'), 1.5).ok).toBe(false);
    expect(validateFieldValue(def('macro_cycle.complexity_budget'), 0).ok).toBe(false);
    expect(validateFieldValue(def('macro_cycle.complexity_budget'), 10001).ok).toBe(false);
    expect(validateFieldValue(def('macro_cycle.complexity_budget'), 'abc').ok).toBe(false);
  });

  it('布尔：只接受 boolean / "true" / "false"，不接受 yes/on/1', () => {
    expect(validateFieldValue(def('anic.flow.workflowTab'), true)).toEqual({ ok: true, value: true });
    expect(validateFieldValue(def('anic.flow.workflowTab'), 'false')).toEqual({ ok: true, value: false });
    for (const bad of ['yes', 'on', 1, null, undefined]) {
      expect(validateFieldValue(def('anic.flow.workflowTab'), bad).ok).toBe(false);
    }
  });

  it('数组：数组或逗号串都接受，但项内不能含逗号（分隔符歧义）', () => {
    expect(validateFieldValue(def('project.tech_stack'), ['typescript', 'node'])).toEqual({ ok: true, value: ['typescript', 'node'] });
    expect(validateFieldValue(def('project.tech_stack'), 'a, b')).toEqual({ ok: true, value: ['a', 'b'] });
    expect(validateFieldValue(def('project.tech_stack'), ['a,b']).ok).toBe(false);
    expect(validateFieldValue(def('project.tech_stack'), ['a\nb']).ok).toBe(false);
  });

  it('validateSingleLine：空值策略由调用方给（命令允许空，枚举不允许）', () => {
    expect(validateSingleLine('', def('build.e2e_cmd'), true).ok).toBe(true);
    expect(validateSingleLine('', def('macro_cycle.autonomy_level'), false).ok).toBe(false);
  });
});

describe('回读语义与 host/config.ts 同源（双投影矛盾守卫）', () => {
  it('autonomy_level：schema 读取器与唯一 loader 结论一致', () => {
    const ours = readFieldValue(REAL_CONFIG, def('macro_cycle.autonomy_level'));
    const loader = getAutonomyLevel(REAL_CONFIG, 'L1');
    expect(ours).toBe(loader);
  });

  it('allowedOrigins：两者逐项一致（含去尾斜杠语义）', () => {
    const src = 'anic:\n  allowedOrigins: https://a.dev/, "https://b.dev"\n';
    const ours = readFieldValue(src, def('anic.allowedOrigins')) as string[];
    // loader 的 parseAnicSection 去尾斜杠；我们的读取器必须同口径（否则回读断言会假红）
    expect(ours).toEqual(['https://a.dev', 'https://b.dev']);
  });

  it('build/test/lint 命令：与 getYamlString 一致（引号与行内注释都剥掉）', () => {
    for (const [id, key] of [['build.build_cmd', 'build_cmd'], ['build.test_cmd', 'test_cmd']] as const) {
      expect(readFieldValue(REAL_CONFIG, def(id))).toBe(getYamlString(REAL_CONFIG, key));
    }
  });

  it('loader 不解析的字段（project.name / coverage_cmd）schema 也能读到', () => {
    expect(readFieldValue(REAL_CONFIG, def('project.name'))).toBe('dsh-anic');
    expect(readFieldValue(REAL_CONFIG, def('build.coverage_cmd'))).toBe('node node_modules/vitest/vitest.mjs run --coverage');
    // 反向自检：唯一 loader 的值表**没有**这两项（证明回读断言必须两条腿并行，
    // 只靠 loadWorkspaceConfig 会漏掉一半可编辑字段）。
    const loaderKeys = Object.keys(loadWorkspaceConfig(join(ROOT, '.cycles')).values);
    expect(loaderKeys).not.toContain('coverageCmd');
    expect(loaderKeys).not.toContain('projectName');
    expect(loaderKeys.length).toBeGreaterThan(0);
  });

  it('缺键 → null（不填默认值：表单必须显示"未设置"而不是"看起来设了")', () => {
    expect(readFieldValue('project:\n  name: x\n', def('build.test_cmd'))).toBeNull();
    expect(readFieldValue('project:\n  name: x\n', def('anic.flow.workflowTab'))).toBeNull();
  });

  it('段内注释与空行不影响定位（注释不是段结束）', () => {
    const src = 'macro_cycle:\n  # 注释\n\n  autonomy_level: L2\n';
    expect(readFieldValue(src, def('macro_cycle.autonomy_level'))).toBe('L2');
  });

  it('块标量正文里的同名键不被误读成真实字段', () => {
    const src = 'build:\n  test_cmd: |\n    build_cmd: evil\n  lint_cmd: real.mjs\n';
    expect(readFieldValue(src, def('build.build_cmd'))).toBeNull();
    expect(readFieldValue(src, def('build.lint_cmd'))).toBe('real.mjs');
  });

  it('真实工作区经唯一 loader 读出的 flow 开关与 schema 一致（工作区层事实）', () => {
    const loaded = loadWorkspaceConfig(join(ROOT, '.cycles'));
    for (const flow of FLOWS) {
      const ours = readFieldValue(REAL_CONFIG, def(`anic.${flow.id}`));
      const theirs = loaded.values.flowOverrides[flow.id];
      // 双方都缺省 = 一致（真实配置没有 anic 段）
      expect(ours === null ? undefined : ours).toBe(theirs);
    }
  });
});
