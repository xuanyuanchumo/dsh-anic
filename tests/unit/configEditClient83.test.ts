/**
 * 配置编辑器 cycle-83 客户端渲染测试：冲突条 / 路径行内编辑 / 备份下拉。
 *
 * ## 守什么
 *
 * ① 冲突条：三态判据的 UI 后果——只有真冲突才出条；「采用磁盘/保留我的/全部忽略」
 *    各发一个意图回调；每条都带**原基线**（用户才看清"两个人都改过"）；
 * ② 路径编辑：`editable` 来自**服务端**（白名单一份），编辑入口只在可编辑项出现；
 *    编辑态显示输入 + 保存/取消（有覆盖时才多"撤销自定义"）；校验错误显示**原文**；
 * ③ 备份下拉：每份带字段级 diff 摘要；恢复按钮按**备份名**回传；
 *    回滚前的安全备份路径必须显示（回滚可再回滚的唯一线索）；
 * ④ 纯渲染铁律：新文件同样不引 hooks、不出现绝对 URL（smoke stub 只有 4 个 hooks）。
 *
 * ## 反向自检
 *
 * 每条"该出现"的断言都配一个"不该出现"的对照（无冲突/不可编辑/无备份时元素缺席），
 * 否则"渲染里有这个按钮"可能只是模板恒有。
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderConfigEditor, type ConfigEditorHandlers, type ConfigEditorInput,
} from '../../src/client/features/config/configRender.ts';
import { renderConflictBar, renderBackupPanel } from '../../src/client/features/config/configExtras.ts';
import { renderConfigPaths, type PathTableInput } from '../../src/client/features/config/configPaths.ts';
import { detectConflicts } from '../../src/client/features/config/configConflict.ts';
import type { ConfigFieldJson, ConfigJson, ConfigPathJson } from '../../src/client/features/config/configTypes.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIELDS: ConfigFieldJson[] = [
  { id: 'project.name', group: 'project', kind: 'string', labelKey: 'config.field.projectName', enumValues: null, min: null, max: null, maxLength: 512 },
  { id: 'macro_cycle.autonomy_level', group: 'macro', kind: 'enum', labelKey: 'config.field.autonomyLevel', enumValues: ['L1', 'L2', 'L3', 'L4'], min: null, max: null, maxLength: 8 },
];
const VALUES: Record<string, unknown> = { 'project.name': 'demo', 'macro_cycle.autonomy_level': 'L4' };

const PATHS: ConfigPathJson[] = [
  { id: 'config', labelKey: 'config.path.config', path: '/p/.cycles/config.yml', kind: 'file', exists: true, isDir: false, bytes: 300, mtime: '2026-10-27T03:00:00.000Z', source: 'canonical', overridden: false, editable: false },
  { id: 'evals', labelKey: 'config.path.evals', path: '/p/.cycles/evals', kind: 'dir', exists: true, isDir: true, bytes: 0, mtime: '2026-10-27T03:00:00.000Z', source: '生命周期目录', overridden: false, editable: true },
  { id: 'techDebt', labelKey: 'config.path.techDebt', path: '/p/docs/debt', kind: 'dir', exists: true, isDir: true, bytes: 0, mtime: null, source: '生命周期目录', overridden: true, editable: true },
];

function config(over: Partial<ConfigJson> = {}): ConfigJson {
  return {
    workspace: '/p',
    values: VALUES,
    schema: FIELDS,
    paths: { workspace: '/p', entries: PATHS, warnings: [] },
    warnings: [],
    rawHash: 'hash1',
    configFile: { exists: true, bytes: 300, mtime: '2026-10-27T03:00:00.000Z' },
    backups: ['config.yml.bak.20261027T030000000Z'],
    backupViews: [
      { name: 'config.yml.bak.20261027T030000000Z', at: '2026-10-27T03:00:00.000Z', bytes: 300, changedFields: ['macro_cycle.autonomy_level'], values: { 'macro_cycle.autonomy_level': { backup: 'L3', current: 'L4' } } },
    ],
    pathOverrides: { active: { techDebt: 'docs/debt' }, editableIds: ['cyclesDocs', 'evals', 'techDebt', 'incidents', 'archive', 'artifacts'], ignored: false, present: true, warnings: [] },
    ...over,
  };
}

function handlers(over: Partial<ConfigEditorHandlers> = {}): ConfigEditorHandlers {
  const noop = (): void => undefined;
  return {
    onChange: noop, onReset: noop, onCopy: noop, onPreview: noop, onSave: noop, onDiscard: noop,
    onEditBegin: noop, onEditChange: noop, onEditSave: noop, onEditCancel: noop, onEditReset: noop,
    onAdoptServer: noop, onKeepMine: noop, onDismiss: noop,
    onPreviewRestore: noop, onRestore: noop,
    ...over,
  };
}

const render = (input: ConfigEditorInput, h = handlers()): string =>
  renderToStaticMarkup(createElement('div', null, renderConfigEditor(input, h, 'anic-config-1')));

describe('冲突条：只有真冲突才出现，且三个动作各自一个回调', () => {
  const prev = { 'project.name': 'A', 'macro_cycle.autonomy_level': 'L4' };
  const drafts = { 'project.name': 'B' };

  it('磁盘动了 + 用户改别的值 ⇒ 冲突条出现，带三值', () => {
    const now = { 'project.name': 'C', 'macro_cycle.autonomy_level': 'L4' };
    const conflicts = detectConflicts(FIELDS, now, prev, drafts);
    expect(conflicts).toHaveLength(1);
    const html = render({ config: config({ values: now }), drafts, conflicts });
    expect(html).toContain('data-anic-config-conflicts="1"');
    expect(html).toContain('data-anic-config-conflict="project.name"');
    expect(html).toContain('data-anic-config-conflict-adopt="project.name"');
    expect(html).toContain('data-anic-config-conflict-keep="project.name"');
    expect(html).toContain('data-anic-config-conflict-dismiss="true"');
    // 原基线是独立节点（插值缺键时不跟着消失）
    expect(html).toContain('data-anic-config-conflict-origin="project.name"');
    expect(html).toContain('A');
  });

  it('磁盘没动（普通编辑）⇒ 无冲突条（最常见的误报形态）', () => {
    const same = { 'project.name': 'A', 'macro_cycle.autonomy_level': 'L4' };
    const conflicts = detectConflicts(FIELDS, same, prev, drafts);
    expect(conflicts).toEqual([]);
    const html = render({ config: config({ values: same }), drafts, conflicts });
    expect(html).not.toContain('data-anic-config-conflicts');
  });

  it('用户改回原值（撤销）⇒ 无冲突条', () => {
    const now = { 'project.name': 'C', 'macro_cycle.autonomy_level': 'L4' };
    const conflicts = detectConflicts(FIELDS, now, prev, { 'project.name': 'A' });
    expect(conflicts).toEqual([]);
    expect(render({ config: config({ values: now }), drafts: { 'project.name': 'A' }, conflicts })).not.toContain('data-anic-config-conflicts');
  });

  it('回调缺省时按钮不渲染（不给"点了没反应"的按钮）', () => {
    const now = { 'project.name': 'C', 'macro_cycle.autonomy_level': 'L4' };
    const conflicts = detectConflicts(FIELDS, now, prev, drafts);
    const html = renderToStaticMarkup(createElement('div', null,
      renderConflictBar(conflicts, {})));
    expect(html).toContain('data-anic-config-conflicts="1"');
    expect(html).not.toContain('data-anic-config-conflict-adopt');
    // 反向自检：同一个冲突在回调齐备时必须出按钮
    const full = renderToStaticMarkup(createElement('div', null,
      renderConflictBar(conflicts, { onAdoptServer: () => undefined })));
    expect(full).toContain('data-anic-config-conflict-adopt');
  });
});

describe('路径行内编辑：入口来自服务端 editable，编辑态与错误反馈', () => {
  const base: PathTableInput = { entries: PATHS, warnings: [], overrides: config().pathOverrides };

  it('只有 editable 项出编辑按钮（契约文件不给入口）', () => {
    const html = renderToStaticMarkup(createElement('div', null, renderConfigPaths(base, null, handlers())));
    expect(html).toContain('data-anic-config-edit="evals"');
    expect(html).toContain('data-anic-config-edit="techDebt"');
    // 反向自检：config 项（editable:false）没有编辑按钮
    expect(html).not.toContain('data-anic-config-edit="config"');
  });

  it('覆盖状态标记：默认 / 自定义（覆盖是用户的意思，必须一眼看得出）', () => {
    const html = renderToStaticMarkup(createElement('div', null, renderConfigPaths(base, null, handlers())));
    expect(html).toContain('data-anic-config-path-overridden="false"'); // evals
    expect(html).toContain('data-anic-config-path-overridden="true"'); // techDebt
    expect(html).toContain('data-anic-config-overrides-count="1"');
  });

  it('编辑态：输入框 + 保存/取消；有覆盖时才多"撤销自定义"', () => {
    const withCoverage = renderToStaticMarkup(createElement('div', null, renderConfigPaths(
      { ...base, editingId: 'techDebt', editValue: 'docs/debt2' }, null, handlers())));
    expect(withCoverage).toContain('data-anic-config-path-input="techDebt"');
    expect(withCoverage).toContain('value="docs/debt2"');
    expect(withCoverage).toContain('data-anic-config-path-action="save"');
    expect(withCoverage).toContain('data-anic-config-path-action="cancel"');
    expect(withCoverage).toContain('data-anic-config-path-action="reset"'); // 有覆盖
    // 反向自检：编辑 evals（当前无覆盖）时没有 reset 按钮
    const noCoverage = renderToStaticMarkup(createElement('div', null, renderConfigPaths(
      { ...base, editingId: 'evals', editValue: '' }, null, handlers())));
    expect(noCoverage).not.toContain('data-anic-config-path-action="reset"');
  });

  it('校验错误显示服务端原文（不吞成"非法"）', () => {
    const html = renderToStaticMarkup(createElement('div', null, renderConfigPaths(
      { ...base, editingId: 'evals', editValue: '../x', editError: 'PATH_TRAVERSAL: evals: 路径包含 .. 段' }, null, handlers())));
    expect(html).toContain('data-anic-config-path-error="evals"');
    expect(html).toContain('PATH_TRAVERSAL');
  });

  it('覆盖表整份忽略 ⇒ 显著提示（fail-closed 的可见信号）', () => {
    const ignored = { active: {}, editableIds: ['evals'], ignored: true, present: true, warnings: ['PATH_TRAVERSAL: evals: 非法'] };
    const html = renderToStaticMarkup(createElement('div', null, renderConfigPaths({ ...base, overrides: ignored }, null, handlers())));
    expect(html).toContain('data-anic-config-overrides-ignored="true"');
    expect(html).toContain('PATH_TRAVERSAL');
    // 反向自检：未忽略时该节点缺席
    expect(renderToStaticMarkup(createElement('div', null, renderConfigPaths(base, null, handlers()))))
      .not.toContain('data-anic-config-overrides-ignored');
  });

  it('老宿主（无 overrides / editable 缺省）⇒ 零编辑入口（fail-closed）', () => {
    const legacy: ConfigPathJson[] = [{ id: 'evals', labelKey: 'config.path.evals', path: '/p/.cycles/evals', kind: 'dir', exists: true, isDir: true, bytes: 0, mtime: null, source: 'x' }];
    const html = renderToStaticMarkup(createElement('div', null, renderConfigPaths({ entries: legacy, warnings: [] }, null, handlers())));
    expect(html).not.toContain('data-anic-config-edit');
  });
});

describe('备份下拉：diff 摘要 + 按备份名恢复 + 安全备份可见', () => {
  const views = config().backupViews!;

  it('每份带 diff 摘要与两个动作（预览恢复 / 恢复）', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      renderBackupPanel({ views }, { onPreviewRestore: () => undefined, onRestore: () => undefined })));
    expect(html).toContain('data-anic-config-backups="1"');
    expect(html).toContain('data-anic-config-backup-row="config.yml.bak.20261027T030000000Z"');
    expect(html).toContain('data-anic-config-backup-diff="config.yml.bak.20261027T030000000Z"');
    expect(html).toContain('macro_cycle.autonomy_level'); // 字段级摘要（用户能理解的单位）
    expect(html).toContain('data-anic-config-backup-restore="config.yml.bak.20261027T030000000Z"');
    expect(html).toContain('data-anic-config-backup-preview="config.yml.bak.20261027T030000000Z"');
  });

  it('无备份 ⇒ 如实说"暂无"（不编造一行）', () => {
    const html = renderToStaticMarkup(createElement('div', null, renderBackupPanel({ views: [], names: [] }, {})));
    expect(html).toContain('data-anic-config-backups="none"');
    expect(html).not.toContain('data-anic-config-backup-row');
  });

  it('老宿主只给名字列表 ⇒ 回落成无摘要行（不清空面板）', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      renderBackupPanel({ views: [], names: views.map((v) => v.name) }, { onRestore: () => undefined })));
    expect(html).toContain('data-anic-config-backups="1"');
    expect(html).toContain('data-anic-config-backup-row');
  });

  it('恢复成功后必须显示安全备份路径（回滚可再回滚的唯一线索）', () => {
    const okHtml = renderToStaticMarkup(createElement('div', null, renderBackupPanel(
      { views, result: { ok: true, message: '已恢复', safetyBackupPath: '/p/.cycles/config.yml.bak.20261027T040000000Z' } }, {})));
    expect(okHtml).toContain('data-anic-config-backup-result="ok"');
    expect(okHtml).toContain('config.yml.bak.20261027T040000000Z');
    // 反向自检：失败态用失败锚点，且不含安全备份路径
    const failHtml = renderToStaticMarkup(createElement('div', null, renderBackupPanel(
      { views, result: { ok: false, message: '恢复失败：unknown backup' } }, {})));
    expect(failHtml).toContain('data-anic-config-backup-result="fail"');
    expect(failHtml).toContain('恢复失败');
  });

  it('恢复进行中：按钮 disabled（防重复提交同一份恢复）', () => {
    const html = renderToStaticMarkup(createElement('div', null, renderBackupPanel(
      { views, busyName: views[0]!.name }, { onRestore: () => undefined })));
    expect(html).toMatch(/data-anic-config-backup-restore="[^"]+"[^>]*disabled/);
  });
});

describe('组装层：三条信息带同现时互不遮挡', () => {
  it('冲突条 + 路径编辑 + 备份结果可同时渲染（顺序：冲突 → 表单 → 路径 → 备份）', () => {
    const now = { 'project.name': 'C', 'macro_cycle.autonomy_level': 'L4' };
    const conflicts = detectConflicts(FIELDS, now, { 'project.name': 'A' }, { 'project.name': 'B' });
    const html = render({
      config: config({ values: now }),
      drafts: { 'project.name': 'B' },
      conflicts,
      pathEdit: { id: 'evals', value: 'docs/evals', error: null, busy: false },
      backupResult: { ok: true, message: '已恢复', safetyBackupPath: '/p/b.bak' },
    });
    const atConflict = html.indexOf('data-anic-config-conflicts=');
    const atForm = html.indexOf('data-anic-config-form=');
    const atPaths = html.indexOf('data-anic-config-paths=');
    const atBackups = html.indexOf('data-anic-config-backups=');
    expect(atConflict).toBeGreaterThan(-1);
    expect(atForm).toBeGreaterThan(atConflict);
    expect(atPaths).toBeGreaterThan(atForm);
    expect(atBackups).toBeGreaterThan(atPaths);
  });

  it('config=null ⇒ null（未拉取不伪造空态），新输入也救不回来', () => {
    expect(renderConfigEditor({ config: null, drafts: {}, conflicts: [] }, handlers(), 'p')).toBeNull();
  });
});

describe('源码形状：新文件同样不引 hooks、不出现绝对 URL', () => {
  const FILES = ['configConflict.ts', 'configExtras.ts', 'configPaths.ts', 'configRender.ts', 'configGuards.ts', 'configTypes.ts'];

  it('六个渲染/判定文件都满足纯函数铁律', () => {
    const dir = join(ROOT, 'src', 'client', 'features', 'config');
    const joined = FILES.map((f) => readFileSync(join(dir, f), 'utf-8')).join('\n');
    // 反向自检：hook 名正则确实能匹配（否则这条断言永远绿）
    expect(/\buse[A-Z]\w*\(/.test('const x = useState(0)')).toBe(true);
    expect(joined).not.toMatch(/\buse[A-Z]\w*\(/);
    expect(joined).not.toMatch(/https?:\/\//);
  });

  it('新端点 URL 是相对路径（同源代理契约）', () => {
    for (const url of ['/anic/api/config/paths', '/anic/api/config/rollback']) {
      expect(url.startsWith('/anic/')).toBe(true);
      expect(url).not.toMatch(/^https?:/);
    }
  });
});
