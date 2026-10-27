/**
 * 配置编辑器客户端渲染测试（cycle-82）。
 *
 * ## 守什么
 *
 * ① 形状守卫：半截/畸形响应必须**整块不渲染**（null），而不是渲染出一张
 *    "字段都在但值全是空"的假表单——那时用户保存下去的是错值；
 * ② 脏标记：只读输入（服务端事实 + 草稿）算出来，不是组件状态里的第二份真相；
 * ③ patch 只含脏字段：未改字段不进 patch，「差异行数 = 改动字段数」才成立；
 * ④ 纯渲染铁律：渲染器返回 ReactElement（不是字符串）、不引 hooks
 *    （smoke 的 stub React 只有 4 个 hooks，多一个就 TypeError）；
 * ⑤ 反馈诚实：失败显示 error 原文，回滚必须说出来。
 *
 * ## 反向自检
 *
 * 每条守卫都先证明它能判出坏形态（畸形响应 / 未污染输入），否则「全绿」
 * 可能只是判定器哑了。
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dynamicKeyPrefixes } from '../../src/host/closureAudit/i18nClosure.ts';
import { stripComments } from '../../src/host/closureAudit/scanPrimitives.ts';
import {
  CONFIG_I18N_PREFIX,
  CONFIG_URL,
  cfgGroupText,
  cfgText,
  draftToPatchValue,
  isConfigJson,
  isConfigWriteJson,
  valueToDraftText,
  type ConfigFieldJson,
  type ConfigJson,
} from '../../src/client/features/config/configTypes.ts';
import { dirtyFieldIds, draftsToPatch, isDirty } from '../../src/client/features/config/configForm.ts';
import { renderConfigEditor, type ConfigEditorHandlers, type ConfigEditorInput } from '../../src/client/features/config/configRender.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIELDS: ConfigFieldJson[] = [
  { id: 'project.name', group: 'project', kind: 'string', labelKey: 'config.field.projectName', enumValues: null, min: null, max: null, maxLength: 512 },
  { id: 'project.tech_stack', group: 'project', kind: 'stringArray', labelKey: 'config.field.techStack', enumValues: null, min: null, max: null, maxLength: 512 },
  { id: 'build.test_cmd', group: 'commands', kind: 'command', labelKey: 'config.field.testCmd', enumValues: null, min: null, max: null, maxLength: 512 },
  { id: 'macro_cycle.autonomy_level', group: 'macro', kind: 'enum', labelKey: 'config.field.autonomyLevel', enumValues: ['L1', 'L2', 'L3', 'L4'], min: null, max: null, maxLength: 8 },
  { id: 'macro_cycle.complexity_budget', group: 'macro', kind: 'int', labelKey: 'config.field.complexityBudget', enumValues: null, min: 1, max: 10000, maxLength: 12 },
  { id: 'anic.flow.workflowTab', group: 'anic', kind: 'bool', labelKey: 'flows.workflowTab', enumValues: null, min: null, max: null, maxLength: 8 },
];

const VALUES: Record<string, unknown> = {
  'project.name': 'dsh-anic',
  'project.tech_stack': ['typescript'],
  'build.test_cmd': 'node scripts/run-tests.mjs',
  'macro_cycle.autonomy_level': 'L4',
  'macro_cycle.complexity_budget': 100,
  'anic.flow.workflowTab': true,
};

function config(over: Partial<ConfigJson> = {}): ConfigJson {
  return {
    workspace: 'D:/p/dsh-anic',
    values: VALUES,
    schema: FIELDS,
    paths: {
      workspace: 'D:/p/dsh-anic',
      entries: [
        { id: 'config', labelKey: 'config.path.config', path: 'D:/p/dsh-anic/.cycles/config.yml', kind: 'file', exists: true, isDir: false, bytes: 3072, mtime: '2026-10-27T03:00:00.000Z', source: 'canonical' },
        { id: 'dist', labelKey: 'config.path.dist', path: null, kind: 'dir', exists: false, isDir: false, bytes: 0, mtime: null, source: 'pluginRoot' },
      ],
      warnings: [],
    },
    warnings: [],
    rawHash: 'a1b2c3d4e5f60718',
    configFile: { exists: true, bytes: 3072, mtime: '2026-10-27T03:00:00.000Z' },
    backups: ['config.yml.bak.20261027T030000000Z'],
    ...over,
  };
}

function handlers(over: Partial<ConfigEditorHandlers> = {}): ConfigEditorHandlers {
  return {
    onChange: () => undefined,
    onReset: () => undefined,
    onCopy: () => undefined,
    onPreview: () => undefined,
    onSave: () => undefined,
    onDiscard: () => undefined,
    ...over,
  };
}

function render(input: ConfigEditorInput): string {
  return renderToStaticMarkup(createElement('div', null, renderConfigEditor(input, handlers(), 'anic-config-1')));
}

describe('isConfigJson 形状守卫', () => {
  it('完整响应被采信', () => {
    expect(isConfigJson(config())).toBe(true);
  });

  it('畸形响应一律不采信（宁可不渲染，也不渲染假表单）', () => {
    const bad: unknown[] = [
      null, undefined, 42, 'x', {},
      { ...config(), schema: [] },                        // 空 schema：会渲染出"没有可配项"的假象
      { ...config(), schema: [{ id: 'x' }] },             // 字段形状不全
      { ...config(), values: 'nope' },
      { ...config(), paths: { entries: 'nope' } },
      { ...config(), paths: { entries: [{ id: 'x' }] } },
      { ...config(), warnings: 'x' },
      { ...config(), configFile: null },
      { ...config(), workspace: 42 },
    ];
    for (const b of bad) expect(isConfigJson(b), `应拒绝 ${JSON.stringify(b)?.slice(0, 60)}`).toBe(false);
    // 反向自检：把一条必需项修回去，同一份对象必须重新变绿（判定器不是恒假）
    const repaired = { ...config(), schema: [{ id: 'x' }] };
    expect(isConfigJson(repaired)).toBe(false);
    expect(isConfigJson({ ...repaired, schema: FIELDS })).toBe(true);
  });

  it('写入响应守卫：ok 与数组字段是硬契约', () => {
    expect(isConfigWriteJson({ ok: true, changedFields: [], warnings: [] })).toBe(true);
    expect(isConfigWriteJson({ ok: 'yes', changedFields: [], warnings: [] })).toBe(false);
    expect(isConfigWriteJson({ ok: true, changedFields: 'x', warnings: [] })).toBe(false);
  });

  it('URL 是相对路径（桌面端经 dsh-app 同源代理，绝对 URL 会被 Origin 白名单拒）', () => {
    expect(CONFIG_URL.startsWith('/anic/')).toBe(true);
    expect(CONFIG_URL).not.toMatch(/^https?:/);
  });
});

describe('脏标记与 patch 构造（只读输入算出，不存状态）', () => {
  it('无草稿 → 零脏字段、零 patch', () => {
    const input = { schema: FIELDS, values: VALUES, drafts: {} };
    expect(dirtyFieldIds(input)).toEqual([]);
    expect(draftsToPatch(input)).toEqual({});
  });

  it('草稿等值于服务端 → 不算脏（避免"点一下保存就 produce 无谓 diff"）', () => {
    const input = { schema: FIELDS, values: VALUES, drafts: { 'project.name': 'dsh-anic', 'anic.flow.workflowTab': true } };
    expect(isDirty(FIELDS[0] as ConfigFieldJson, VALUES, input.drafts)).toBe(false);
    expect(dirtyFieldIds(input)).toEqual([]);
  });

  it('改了值才算脏；patch 只含脏字段', () => {
    const drafts = { 'project.name': 'renamed', 'macro_cycle.autonomy_level': 'L4' };
    const input = { schema: FIELDS, values: VALUES, drafts };
    // autonomy_level 草稿与服务端相同（L4）⇒ 不脏
    expect(dirtyFieldIds(input)).toEqual(['project.name']);
    expect(draftsToPatch(input)).toEqual({ 'project.name': 'renamed' });
  });

  it('数组字段按内容比（逗号串 vs 数组），空格差异不算脏', () => {
    const input = { schema: FIELDS, values: VALUES, drafts: { 'project.tech_stack': 'typescript' } };
    expect(dirtyFieldIds(input)).toEqual([]);
    const input2 = { schema: FIELDS, values: VALUES, drafts: { 'project.tech_stack': 'typescript, node' } };
    expect(dirtyFieldIds(input2)).toEqual(['project.tech_stack']);
  });

  it('布尔字段：草稿字符串 "true" 与布尔 true 等价', () => {
    expect(isDirty(FIELDS[5] as ConfigFieldJson, VALUES, { 'anic.flow.workflowTab': 'true' })).toBe(false);
    expect(isDirty(FIELDS[5] as ConfigFieldJson, VALUES, { 'anic.flow.workflowTab': false })).toBe(true);
  });

  it('draftToPatchValue：布尔/整数/数组在边界处定型', () => {
    expect(draftToPatchValue(FIELDS[5] as ConfigFieldJson, false)).toBe(false);
    expect(draftToPatchValue(FIELDS[4] as ConfigFieldJson, '120')).toBe(120);
    expect(draftToPatchValue(FIELDS[1] as ConfigFieldJson, 'a, b ,')).toEqual(['a', 'b']);
    expect(draftToPatchValue(FIELDS[0] as ConfigFieldJson, 'x')).toBe('x');
  });

  it('valueToDraftText：null 显示为空串（不让 "null" 字面进输入框）', () => {
    expect(valueToDraftText(null)).toBe('');
    expect(valueToDraftText(['a', 'b'])).toBe('a, b');
    expect(valueToDraftText(true)).toBe('true');
    expect(valueToDraftText(100)).toBe('100');
  });
});

describe('renderConfigEditor：元素树与锚点', () => {
  it('config=null → null（未拉取不渲染，不伪造空态）', () => {
    expect(renderConfigEditor({ config: null, drafts: {} }, handlers(), 'p1')).toBeNull();
  });

  it('分区锚点 + 三个动作按钮 + 脏计数', () => {
    const html = render({ config: config(), drafts: {} });
    expect(html).toContain('data-anic-config="editor"');
    expect(html).toContain('id="anic-config-1"');
    expect(html).toContain('role="region"');
    for (const action of ['save', 'preview', 'discard']) {
      expect(html).toContain(`data-anic-config-action="${action}"`);
    }
    expect(html).toContain('data-anic-config-dirty-count="0"');
  });

  it('字段行按类型渲染控件（input / select / checkbox），带 aria-label', () => {
    const html = render({ config: config(), drafts: {} });
    expect(html).toContain('data-anic-config-input="project.name"');
    expect(html).toContain('data-anic-config-select="macro_cycle.autonomy_level"');
    expect(html).toContain('data-anic-config-toggle="anic.flow.workflowTab"');
    // 枚举选项来自 schema（含 L4 与服务端当前值）
    expect(html).toContain('>L4</option>');
    // 无障碍：每个控件都有 aria-label
    expect((html.match(/aria-label=/g) ?? []).length).toBeGreaterThanOrEqual(FIELDS.length);
  });

  it('脏字段标记 + 还原按钮只在脏字段上出现', () => {
    const html = render({ config: config(), drafts: { 'project.name': 'renamed' } });
    expect(html).toContain('data-anic-config-row="project.name"');
    expect(html).toContain('data-anic-config-reset="project.name"');
    expect(html).toContain('data-anic-config-dirty-count="1"');
    // 未改字段没有还原按钮（反向自检：不能到处都有）
    expect(html).not.toContain('data-anic-config-reset="build.test_cmd"');
  });

  it('路径表：存在项显示大小与 mtime + 复制按钮；不存在项显示 missing', () => {
    const html = render({ config: config(), drafts: {} });
    expect(html).toContain('data-anic-config-paths="true"');
    expect(html).toContain('data-anic-config-path-row="config"');
    expect(html).toContain('data-anic-config-path-exists="true"');
    expect(html).toContain('data-anic-config-copy="config"');
    // 事实值（大小）是独立文本节点：locale 未合并时也不会跟着插值一起消失
    expect(html).toContain('3.0 KB');
    expect(html).toContain('2026-10-27T03:00:00.000Z');
    // 不存在项：没有复制按钮，meta 显示 missing
    expect(html).toContain('data-anic-config-path-exists="false"');
    expect(html).not.toContain('data-anic-config-copy="dist"');
  });

  it('自定义路径被拒：原因显示出来（不是"输入了路径但什么都没发生"）', () => {
    const html = render({
      config: config({ probe: { ok: false, reason: '路径包含 .. 段（不做越界赌博）', code: 'PATH_TRAVERSAL' } }),
      drafts: {},
    });
    expect(html).toContain('data-anic-config-probe="rejected"');
    expect(html).toContain('.. 段');
    // 拒绝码也必须在场（原因为人类语言，码给机器/日志对账用）
    expect(html).toContain('PATH_TRAVERSAL');
    expect(html).toContain('data-anic-config-probe-code="PATH_TRAVERSAL"');
  });

  it('dryRun 结果：显示 diff 行与预览摘要，不说"已保存"', () => {
    const html = render({
      config: config(),
      drafts: {},
      writeResult: {
        ok: true, dryRun: true, applied: false, error: '', changedFields: ['project.name'],
        insertedFields: [], warnings: [],
        diff: [
          { kind: 'remove', text: '  name: "dsh-anic"', beforeLine: 2, afterLine: null },
          { kind: 'add', text: '  name: "renamed"', beforeLine: null, afterLine: 2 },
        ],
        stats: { changed: 2, added: 1, removed: 1 },
      },
    });
    expect(html).toContain('data-anic-config-dryrun="true"');
    expect(html).toContain('data-anic-config-diff="true"');
    // diff 行是纯事实（+/- 前缀 + 原始行文本），不经翻译层
    // 统一 diff 形态：标记直接贴行首（`+` + 原始行），行的缩进原样保留
    expect(html).toContain('+  name: &quot;renamed&quot;');
    expect(html).toContain('-  name: &quot;dsh-anic&quot;');
    // 反向自检：缩进若被吃掉，上面的断言会红（证明断言确实在看缩进）
    expect(html).not.toContain('+ name: &quot;renamed&quot;');
    expect(html).toContain('data-anic-config-result="ok"');
    // 预览**不得**声称已保存
    expect(html).not.toContain('data-anic-config-saved');
  });

  it('失败结果：显示 error 原文（不吞成一句"失败"）', () => {
    const html = render({
      config: config(),
      drafts: {},
      writeResult: {
        ok: false, dryRun: false, applied: false,
        error: 'readback mismatch (rolled back from backup): got L4 want L3',
        changedFields: [], insertedFields: [], warnings: ['project.name: 未知字段'],
      },
    });
    expect(html).toContain('data-anic-config-result="fail"');
    expect(html).toContain('readback mismatch');
    // 回滚这件事必须说出来
    expect(html).toContain('rolled back');
    expect(html).toContain('data-anic-config-warnings="true"');
  });

  it('保存成功后：显示备份路径；未保存过则**不**显示"已保存"', () => {
    const saved = render({
      config: config(), drafts: {}, savedAt: '2026-10-27T11:00:00.000Z',
      writeResult: { ok: true, dryRun: false, applied: true, error: '', changedFields: ['project.name'], insertedFields: [], warnings: [], backupPath: 'D:/p/.cycles/config.yml.bak.x' },
    });
    expect(saved).toContain('data-anic-config-saved="true"');
    expect(saved).toContain('data-anic-config-backup="true"');
    const fresh = render({ config: config(), drafts: {} });
    expect(fresh).not.toContain('data-anic-config-saved');
  });

  it('busy：按钮禁用（防重复提交同一份 patch）', () => {
    const html = render({ config: config(), drafts: { 'project.name': 'x' }, busy: true });
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(3);
    const idle = render({ config: config(), drafts: { 'project.name': 'x' } });
    expect((idle.match(/disabled=""/g) ?? []).length).toBe(0);
  });

  it('错误条与写结果分开显示（来源不同，不互相覆盖）', () => {
    const html = render({ config: config(), drafts: {}, error: '拉取失败：HTTP 500' });
    expect(html).toContain('data-anic-config-error="true"');
    expect(html).toContain('HTTP 500');
    expect(html).not.toContain('data-anic-config-result');
  });

  it('渲染器是纯函数：同输入同输出，且返回元素（不是 HTML 字符串）', () => {
    const a = render({ config: config(), drafts: {} });
    const b = render({ config: config(), drafts: {} });
    expect(a).toBe(b);
    const el = renderConfigEditor({ config: config(), drafts: {} }, handlers(), 'p');
    expect(typeof el).toBe('object');
    expect(typeof el).not.toBe('string');
  });

  it('源码形状：不引 hooks（smoke 的 stub React 只有 4 个 hooks）', () => {
    const dir = join(ROOT, 'src', 'client', 'features', 'config');
    const files = ['configTypes.ts', 'configForm.ts', 'configPaths.ts', 'configRender.ts'];
    const joined = files.map((f) => readFileSync(join(dir, f), 'utf-8')).join('\n');
    // 反向自检：hook 名的正则确实能匹配（否则这条断言永远绿）
    expect(/\buse[A-Z]\w*\(/.test('const x = useState(0)')).toBe(true);
    expect(joined).not.toMatch(/\buse[A-Z]\w*\(/);
    // 也不许出现绝对 URL（同源契约）
    expect(joined).not.toMatch(/https?:\/\//);
  });
});

describe('词表键必须被闭包扫描器**认领**（cycle-82 实测踩坑的回归钉）', () => {
  /**
   * 被守卫的缺陷（真实发生过，不是假设）：
   *
   * `cfgText` 原本写成 `t(CONFIG_I18N_PREFIX + suffix)` —— 经常量中转。而
   * `dynamicKeyPrefixes` 只认「`t(` 首实参是引号字面量且以 `.`/`_` 结尾、紧跟 `+`」
   * 与反引号模板两种形态；标识符开头两种都不命中 ⇒ locale 合并后 55 条
   * `config.*` 键**全部被判死键**（i18nDeadKeyContract 红）。
   *
   * 这个测试的判据不依赖实现细节：直接把本分区的真实源码喂给**同一个扫描器**，
   * 断言 `config.` 前缀确实被认领。任何"把前缀挪进常量/变量"的重构都会立刻红。
   */
  it('dynamicKeyPrefixes 从本分区源码里认领到 `config.` 前缀', () => {
    const dir = join(ROOT, 'src', 'client', 'features', 'config');
    const files = new Map<string, string>();
    for (const f of ['configTypes.ts', 'configForm.ts', 'configPaths.ts', 'configRender.ts']) {
      files.set(`src/client/features/config/${f}`, readFileSync(join(dir, f), 'utf-8'));
    }
    const prefixes = dynamicKeyPrefixes(files, () => true).map((p) => p.prefix);
    expect(prefixes, '闭包扫描器看不见 config.* 消费 ⇒ 合并后的键会被判死键').toContain('config.');

    // 反向自检：经常量中转的形态确实不被认领（证明这条断言有牙，不是恒真）
    const viaConst = new Map([['src/probe.ts', `const x = t(CONFIG_I18N_PREFIX + suffix);`]]);
    expect(dynamicKeyPrefixes(viaConst, () => true)).toEqual([]);
    // 内联字面量形态被认领
    const inlined = new Map([['src/probe.ts', `const x = t('config.' + suffix);`]]);
    expect(dynamicKeyPrefixes(inlined, () => true).map((p) => p.prefix)).toEqual(['config.']);
  });

  it('CONFIG_I18N_PREFIX 常量仍导出且值为 config.（契约测试的断言锚）', () => {
    expect(CONFIG_I18N_PREFIX).toBe('config.');
    // 并且它**不**出现在任何 t() 的实参首位置（那正是会失效的形态）。
    // 必须去注释后判定：头注里故意引用了错误形态作反例，不去注释会自己命中自己。
    const raw = readFileSync(join(ROOT, 'src/client/features/config/configTypes.ts'), 'utf-8');
    const code = stripComments(raw);
    expect(code).not.toMatch(/t\(\s*CONFIG_I18N_PREFIX/);
    // 反向自检：同一条正则在**未去注释**的原文上确实命中（证明它不是在匹配空气）
    expect(raw).toMatch(/t\(\s*CONFIG_I18N_PREFIX/);
    // 去注释后仍能看见内联形态（否则上面的"不命中"可能只是代码都没了）
    expect(code).toMatch(/t\('config\.' \+ suffix/);
  });

  it('cfgText 渲染出的是真实文案（locale 已合并 ⇒ 不再是裸键名）', () => {
    // 合并前这里会回退成键名本身；合并后必须拿到中文文案。
    // 用短名联合里的一个代表项，并断言它不等于键名（漏翻可见性守卫）。
    const title = cfgText('title');
    expect(title).not.toBe('config.title');
    expect(title.length).toBeGreaterThan(0);
    // 分组标题同款（动态拼接的两段式）
    expect(cfgGroupText('project')).not.toBe('config.group.project');
  });
});
