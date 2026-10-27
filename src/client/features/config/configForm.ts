/**
 * 字段表单渲染（cycle-82）—— 纯函数、无 hooks、无副作用。
 *
 * ## 为什么每个控件都带 data-anic-config-* 锚
 *
 * ① 样式全部写在 `shared/panelCss.ts`（选择器锚 `[data-anic-config-*]`），
 *    本文件不产生任何颜色字面量——颜色只经 `token('anic-*')` 的内联兜底；
 * ② smoke 与契约测试用锚点断言「控件真的渲染了」（而不是"有个 div"）。
 *
 * ## 为什么脏标记在渲染层算而不是存状态
 *
 * 面板是纯渲染器（数据腿由 Lead 统一接、状态在 panelState）。这里拿到
 * `drafts`（当前输入）与 `values`（服务端事实）两份只读输入，脏 = 两者不等。
 * 存进组件状态会把"要不要保存"变成第二份真相，和 panelState 打架。
 */
import { createElement, type ReactElement } from 'react';
import { token } from '../../../shared/tokens.ts';
import { t } from '../../i18n.ts';
import {
  cfgGroupText,
  cfgText,
  valueToDraftText,
  type ConfigFieldJson,
} from './configTypes.ts';

export interface ConfigFormHandlers {
  /** 输入变化（id + 新草稿值）。 */
  onChange: (id: string, draft: string | boolean) => void;
  /** 还原单个字段到服务端事实。 */
  onReset: (id: string) => void;
}

export interface ConfigFormInput {
  schema: ConfigFieldJson[];
  /** 服务端事实值（GET 的 values）。 */
  values: Record<string, unknown>;
  /** 当前草稿（脏值）；缺省项视为未修改。 */
  drafts: Record<string, string | boolean>;
}

/** 脏字段判定：草稿存在且与服务端值不等（布尔按真值比，数组按内容比）。 */
export function isDirty(field: ConfigFieldJson, values: Record<string, unknown>, drafts: Record<string, string | boolean>): boolean {
  const draft = drafts[field.id];
  if (draft === undefined) return false;
  const server = values[field.id];
  if (field.kind === 'bool') {
    const draftBool = draft === true || draft === 'true';
    return draftBool !== (server === true);
  }
  if (field.kind === 'stringArray') {
    const text = typeof draft === 'string' ? draft : String(draft);
    const draftList = text.split(',').map((s) => s.trim()).filter((s) => s !== '');
    const serverList = Array.isArray(server) ? server.map((x) => String(x)) : [];
    return JSON.stringify(draftList) !== JSON.stringify(serverList);
  }
  return valueToDraftText(server) !== (typeof draft === 'string' ? draft : String(draft));
}

const LABEL_STYLE = { fontSize: 11, color: token('anic-text'), flex: '0 0 160px' } as const;
const INPUT_STYLE = {
  flex: '1 1 200px', fontSize: 11, padding: '2px 6px',
  border: `1px solid ${token('anic-border')}`, borderRadius: 4,
  background: token('anic-surface'), color: token('anic-text'),
} as const;

/** 单个布尔开关（flow.* —— 与 ⚙ 抽屉同款 checkbox 形态）。 */
function renderBool(field: ConfigFieldJson, input: ConfigFormInput, h: ConfigFormHandlers, dirty: boolean): ReactElement {
  const draft = input.drafts[field.id];
  const checked = draft === undefined ? input.values[field.id] === true : (draft === true || draft === 'true');
  return createElement(
    'label',
    {
      'data-anic-config-row': field.id,
      'data-anic-config-dirty': dirty ? 'true' : 'false',
      style: { display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0', cursor: 'pointer' },
    },
    createElement('input', {
      type: 'checkbox',
      'data-anic-config-toggle': field.id,
      checked,
      'aria-label': t(field.labelKey),
      onChange: () => h.onChange(field.id, !checked),
    }),
    createElement('span', { style: { ...LABEL_STYLE, flex: 1 } }, t(field.labelKey)),
    dirty ? createElement('span', { 'data-anic-config-dirty-mark': field.id, style: { fontSize: 10, color: token('anic-warn-text') } }, cfgText('dirty')) : null,
  );
}

/** 枚举控件：值域由 host schema 下发（客户端不硬编码 L1-L4 / full-indexed）。 */
function renderEnum(field: ConfigFieldJson, input: ConfigFormInput, h: ConfigFormHandlers): ReactElement {
  const draft = input.drafts[field.id];
  const current = draft !== undefined ? String(draft) : valueToDraftText(input.values[field.id]);
  const options = (field.enumValues ?? []).map((v) => createElement('option', { key: v, value: v }, v));
  return createElement(
    'select',
    {
      'data-anic-config-select': field.id,
      'aria-label': t(field.labelKey),
      value: current,
      onChange: (e: { target?: { value?: string } }) => h.onChange(field.id, e?.target?.value ?? ''),
      style: INPUT_STYLE,
    },
    // 空值占位：配置里缺该键时不得假装已选某个枚举值（诚实空态）。
    current === '' ? createElement('option', { key: '__empty', value: '' }, '') : null,
    ...options,
  );
}

/** 单个字段行（含脏标记与还原按钮）。 */
function renderRow(field: ConfigFieldJson, input: ConfigFormInput, h: ConfigFormHandlers): ReactElement | null {
  const dirty = isDirty(field, input.values, input.drafts);
  if (field.kind === 'bool') return renderBool(field, input, h, dirty);
  const draft = input.drafts[field.id];
  const text = draft !== undefined ? String(draft) : valueToDraftText(input.values[field.id]);
  return createElement(
    'div',
    {
      'data-anic-config-row': field.id,
      'data-anic-config-dirty': dirty ? 'true' : 'false',
      style: { display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0', flexWrap: 'wrap' },
    },
    createElement('label', { htmlFor: `anic-cfg-${field.id}`, style: LABEL_STYLE }, t(field.labelKey)),
    field.kind === 'enum'
      ? renderEnum(field, input, h)
      : createElement('input', {
          id: `anic-cfg-${field.id}`,
          type: field.kind === 'int' ? 'number' : 'text',
          'data-anic-config-input': field.id,
          'aria-label': t(field.labelKey),
          value: text,
          min: field.min ?? undefined,
          max: field.max ?? undefined,
          maxLength: field.maxLength,
          onChange: (e: { target?: { value?: string } }) => h.onChange(field.id, e?.target?.value ?? ''),
          style: INPUT_STYLE,
        }),
    dirty
      ? createElement('button', {
          type: 'button',
          'data-anic-config-reset': field.id,
          'aria-label': cfgText('resetOne', { field: t(field.labelKey) }),
          onClick: () => h.onReset(field.id),
          style: { fontSize: 10, cursor: 'pointer', border: 'none', background: 'transparent', color: token('anic-warn-text') },
        }, cfgText('reset'))
      : null,
  );
}

/** 分组标题（组名走 t('config.group.<g>')）。 */
function renderGroupHead(group: string): ReactElement {
  return createElement(
    'div',
    { 'data-anic-config-group': group, style: { fontSize: 11, fontWeight: 600, color: token('anic-text-strong'), margin: '6px 0 2px' } },
    cfgGroupText(group),
  );
}

/**
 * 字段表单（按 schema 顺序分组渲染）。
 *
 * schema 为空 → 不渲染（不伪造空表单：那会让用户以为"没有可配项"）。
 */
export function renderConfigForm(input: ConfigFormInput, handlers: ConfigFormHandlers): ReactElement | null {
  if (input.schema.length === 0) return null;
  const children: ReactElement[] = [];
  let lastGroup = '';
  for (const field of input.schema) {
    if (field.group !== lastGroup) {
      children.push(renderGroupHead(field.group));
      lastGroup = field.group;
    }
    const row = renderRow(field, input, handlers);
    if (row !== null) children.push(row);
  }
  return createElement('div', { 'data-anic-config-form': 'true' }, ...children);
}

/** 脏字段 id 列表（保存按钮要提交的就是它）。 */
export function dirtyFieldIds(input: ConfigFormInput): string[] {
  return input.schema.filter((f) => isDirty(f, input.values, input.drafts)).map((f) => f.id);
}

/** 草稿 → patch 体（只含脏字段——未改字段不进 patch，diff 才等于改动数）。 */
export function draftsToPatch(input: ConfigFormInput): Record<string, string | boolean> {
  const patch: Record<string, string | boolean> = {};
  for (const id of dirtyFieldIds(input)) {
    const v = input.drafts[id];
    if (v !== undefined) patch[id] = v;
  }
  return patch;
}
