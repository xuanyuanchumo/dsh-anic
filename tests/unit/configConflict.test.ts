/**
 * 草稿冲突判定测试（cycle-83）——**四态**必须都能判出来。
 *
 * ## 为什么要四态而不是「冲突 / 不冲突」
 *
 * 判据是 `draft ≠ newServer ∧ draft ≠ originalServer ∧ newServer ≠ originalServer`。
 * 四个值参与，其中三个比较各自挡掉一种误报形态：
 *
 *   - `newServer ≠ originalServer` 挡掉「磁盘没动，用户正在改」——
 *     少了它，用户改 A→B 的每个 4s tick 都会报冲突（面板一直红 = 告警噪音）；
 *   - `draft ≠ newServer` 挡掉「已经和新事实一致」；
 *   - `draft ≠ originalServer` 挡掉「用户改回原值（撤销）」——
 *     少了它，撤销会被报成冲突，而误报多了整条冲突带会被无视。
 *
 * 所以本文件对**每一条**都同时断言「该报」与「不该报」两态（同一判据两个输入）。
 *
 * ## 反向自检
 *
 * 「三值 vs 四值」的差别只有靠同一组输入喂给两个判定式才能证明：
 * 若把 `diskMoved` 条件去掉，`pending` 那组输入必须变成 `conflict`。
 * 本文件用 `classifyWithoutDiskMoved` 复刻那个错误实现来钉这条。
 */
import { describe, it, expect } from 'vitest';
import {
  adoptServerDraft, classifyField, conflictSignature, conflictText,
  detectConflicts, pendingConflicts, type ConflictState,
} from '../../src/client/features/config/configConflict.ts';
import type { ConfigFieldJson } from '../../src/client/features/config/configTypes.ts';

const NAME: ConfigFieldJson = { id: 'project.name', group: 'project', kind: 'string', labelKey: 'config.field.projectName', enumValues: null, min: null, max: null, maxLength: 512 };
const BUDGET: ConfigFieldJson = { id: 'macro_cycle.complexity_budget', group: 'macro', kind: 'int', labelKey: 'config.field.complexityBudget', enumValues: null, min: 1, max: 10000, maxLength: 12 };
const FLOW: ConfigFieldJson = { id: 'anic.flow.workflowTab', group: 'anic', kind: 'bool', labelKey: 'flows.workflowTab', enumValues: null, min: null, max: null, maxLength: 8 };
const STACK: ConfigFieldJson = { id: 'project.tech_stack', group: 'project', kind: 'stringArray', labelKey: 'config.field.techStack', enumValues: null, min: null, max: null, maxLength: 512 };
const SCHEMA = [NAME, BUDGET, FLOW, STACK];

/** 反向自检用：**错误实现**（去掉 diskMoved 条件，只看草稿与两侧值不等）。 */
function classifyWithoutDiskMoved(field: ConfigFieldJson, draft: string | boolean | undefined, now: unknown, orig: unknown): ConflictState {
  if (draft === undefined) return 'clean';
  const d = conflictText(field, draft);
  if (d === conflictText(field, now)) return 'clean';
  if (d === conflictText(field, orig)) return 'reverted';
  return 'conflict';
}

describe('classifyField：四态各一档，且三档「不报」都真的不报', () => {
  it('clean：无草稿', () => {
    expect(classifyField(NAME, undefined, 'dsh-anic', 'dsh-anic')).toBe('clean');
  });

  it('clean：草稿已与新事实一致（无论旧值是什么）', () => {
    expect(classifyField(NAME, 'B', 'B', 'A')).toBe('clean');
    expect(classifyField(NAME, 'B', 'B', 'B')).toBe('clean');
  });

  it('pending：磁盘没动、用户正在改 —— **不是冲突**（最常见的误报形态）', () => {
    // 用户把 A 改成 B，磁盘仍是 A
    expect(classifyField(NAME, 'B', 'A', 'A')).toBe('pending');
    // 反向自检：错误的「三值」实现会把它报成 conflict —— 这正是被修的缺陷
    expect(classifyWithoutDiskMoved(NAME, 'B', 'A', 'A')).toBe('conflict');
  });

  it('reverted：用户改回原值（撤销）—— **不是冲突**', () => {
    // 磁盘从 A 变成 C（别人改了），用户草稿仍是 A（他改回了原值）
    expect(classifyField(NAME, 'A', 'C', 'A')).toBe('reverted');
    // 反向自检：若判据漏掉「draft ≠ original」这一条，撤销会被报成冲突
    const naive = (d: string, now: string, orig: string): ConflictState =>
      (d !== now && now !== orig ? 'conflict' : 'clean');
    expect(naive('A', 'C', 'A')).toBe('conflict'); // 错误实现确实会说冲突
    expect(classifyField(NAME, 'A', 'C', 'A')).not.toBe('conflict');
  });

  it('conflict：磁盘动了且用户改了别的值（基线过期）', () => {
    // 用户改 A→B；磁盘已从 A 变成 C；B 既不等于 C 也不等于 A
    expect(classifyField(NAME, 'B', 'C', 'A')).toBe('conflict');
    // 反向自检：把磁盘改回 A（没动）时同一草稿必须退回 pending
    expect(classifyField(NAME, 'B', 'A', 'A')).toBe('pending');
  });

  it('数值/布尔/数组按归一文本比（类型差异不算冲突）', () => {
    // 整数：草稿 '100' 与服务端 100 是同一件事
    expect(classifyField(BUDGET, '100', 100, 50)).toBe('clean');
    expect(classifyField(BUDGET, '120', 130, 100)).toBe('conflict');
    // 布尔：草稿 'true' 与 true 同义
    expect(classifyField(FLOW, 'true', true, false)).toBe('clean');
    expect(classifyField(FLOW, false, true, false)).toBe('reverted');
    // 数组：空格不同不算改动（`a, b` vs ['a','b']）
    expect(classifyField(STACK, 'a, b', ['a', 'b'], ['a', 'b'])).toBe('clean');
    // 磁盘动了（['a','b'] → ['a','x']）且草稿是第三个值 ⇒ 冲突
    expect(classifyField(STACK, 'a, c', ['a', 'x'], ['a', 'b'])).toBe('conflict');
    // 反向自检：同一草稿但磁盘没动 ⇒ pending（不是冲突）
    expect(classifyField(STACK, 'a, c', ['a', 'b'], ['a', 'b'])).toBe('pending');
  });
});

describe('detectConflicts：清单只含真冲突，且首次拉取不报', () => {
  const DRAFTS = { 'project.name': 'B', 'macro_cycle.complexity_budget': '120', 'anic.flow.workflowTab': false };

  it('混合场景：只有磁盘真动过的那一项进清单', () => {
    const prev = { 'project.name': 'A', 'macro_cycle.complexity_budget': 120, 'anic.flow.workflowTab': false };
    // name: 磁盘 A→C（动了）且草稿 B ≠ C/A ⇒ 冲突
    // budget: 磁盘没动（120）且草稿 120 ⇒ clean
    // flow: 磁盘没动（false）且草稿 false ⇒ clean（草稿与事实一致）
    const now = { 'project.name': 'C', 'macro_cycle.complexity_budget': 120, 'anic.flow.workflowTab': false };
    const out = detectConflicts(SCHEMA, now, prev, DRAFTS);
    expect(out.map((c) => c.fieldId)).toEqual(['project.name']);
    const [c] = out;
    expect(c?.draft).toBe('B');
    expect(c?.server).toBe('C');
    expect(c?.original).toBe('A'); // 基线必须一并给出（用户才看清"两个人都改过"）
  });

  it('空草稿 ⇒ 零冲突（不该拿"没改"去比）', () => {
    expect(detectConflicts(SCHEMA, { 'project.name': 'C' }, { 'project.name': 'A' }, {})).toEqual([]);
  });

  it('首次拉取（无基线）⇒ 零冲突（否则一打开面板就是一串红条）', () => {
    const out = detectConflicts(SCHEMA, { 'project.name': 'C' }, {}, { 'project.name': 'B' });
    expect(out).toEqual([]);
    // 反向自检：同一组输入**有**基线时报冲突（判据不是恒空）
    expect(detectConflicts(SCHEMA, { 'project.name': 'C' }, { 'project.name': 'A' }, { 'project.name': 'B' })).toHaveLength(1);
  });

  it('磁盘没动的整组输入 ⇒ 零冲突（pending 不进 UI）', () => {
    const vals = { 'project.name': 'A' };
    expect(detectConflicts(SCHEMA, vals, vals, { 'project.name': 'B' })).toEqual([]);
  });
});

describe('已确认去重：同字段同两侧值的第二次出现被过滤，值变了要再报', () => {
  const prev = { 'project.name': 'A' };
  const drafts = { 'project.name': 'B' };

  it('未确认时全报', () => {
    const all = detectConflicts(SCHEMA, { 'project.name': 'C' }, prev, drafts);
    expect(pendingConflicts(all, [])).toHaveLength(1);
  });

  it('确认后同一签名被过滤', () => {
    const all = detectConflicts(SCHEMA, { 'project.name': 'C' }, prev, drafts);
    const sig = conflictSignature(all[0]!);
    expect(pendingConflicts(all, [sig])).toHaveLength(0);
  });

  it('磁盘又改（C→D）⇒ 新签名，必须再报（不能永久静默）', () => {
    const sigs = detectConflicts(SCHEMA, { 'project.name': 'C' }, prev, drafts).map(conflictSignature);
    const again = detectConflicts(SCHEMA, { 'project.name': 'D' }, prev, drafts);
    expect(again).toHaveLength(1);
    expect(pendingConflicts(again, sigs)).toHaveLength(1);
    // 反向自检：只按 fieldId 去重会把它静默掉（那是被拒的错误实现）
    const byIdOnly = again.filter((c) => !sigs.some((s) => s.split('|')[0] === c.fieldId));
    expect(byIdOnly).toHaveLength(0);
  });
});

describe('adoptServerDraft：「采用磁盘」给出的草稿值与被采纳的字段同型', () => {
  it('字符串/数值/布尔各回正确的草稿形态', () => {
    expect(adoptServerDraft(NAME, { 'project.name': 'C' })).toBe('C');
    expect(adoptServerDraft(BUDGET, { 'macro_cycle.complexity_budget': 120 })).toBe('120');
    expect(adoptServerDraft(FLOW, { 'anic.flow.workflowTab': true })).toBe(true);
    expect(adoptServerDraft(STACK, { 'project.tech_stack': ['a', 'b'] })).toBe('a, b');
  });

  it('缺键 ⇒ undefined（不猜一个空串当值）', () => {
    expect(adoptServerDraft(NAME, {})).toBeUndefined();
    // 反向自检：键在（哪怕是空串）时必须给出，不被当成缺失
    expect(adoptServerDraft(NAME, { 'project.name': '' })).toBe('');
  });
});
