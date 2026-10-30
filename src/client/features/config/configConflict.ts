/**
 * 草稿冲突可见（cycle-83）——`setConfig` 草稿合并不变量的**最后一块**。
 *
 * ## 被补的缺口（Lead 取证原话）
 *
 * 4s 轮询返回新事实时，`panelActions.setConfig` 会保留「用户动过的字段」
 * （否则输入框自己清空）。但保留下来的那一刻，用户的基线就**过期**了：
 * 他以为自己改的是 A→B，而磁盘已经是 A→C。不变量保证「不擦掉输入」，
 * 却没告诉用户「你的基线已经过期」——保存下去就是拿 B 覆盖 C，而 C 可能是
 * 技能脚本刚写的。
 *
 * ## 判据必须机器可算：**四个**值都必须参与（这条是本文件的核心）
 *
 * 直觉写法「draft ≠ server 就是冲突」是**错的**，而且错在最常见的场景：
 * 用户正在把 A 改成 B（磁盘还是 A）时每个 4s tick 都会命中它，
 * 于是面板一直红着——冲突提示就退化成背景噪音（告警疲劳）。
 *
 * 真正的判据是「**磁盘在你的背后动了**，且你改的方向与它不同」：
 *
 *     diskMoved = newServer ≠ originalServer
 *     conflict  = draft ≠ newServer ∧ draft ≠ originalServer ∧ diskMoved
 *
 * 三个比较各有不可省的理由：
 *   - `newServer ≠ originalServer`：没有磁盘变化就没有「基线过期」这回事；
 *   - `draft ≠ newServer`：已经和新事实一致 = 无需提示；
 *   - `draft ≠ originalServer`：用户**改回原值**（撤销）时它不是冲突——
 *     少了这一条，撤销会被误报成冲突，而误报多了整条冲突带会被无视。
 *
 * 四态（三态 + 一个「待提交」用来把「无冲突」说清楚，UI 只分冲突/不冲突）：
 *   clean    无草稿或已与新事实一致
 *   pending  用户改过、磁盘没动 → 正常编辑，**不是冲突**
 *   reverted 用户改回了原值 → **不是冲突**
 *   conflict 磁盘动了且用户改了别的值 → 报冲突
 *
 * ## 为什么不由本模块合并草稿
 *
 * 合并是 `setConfig` 的不变量（唯一实现）。这里只**读**三份事实输出冲突清单——
 * 出现第二份合并逻辑，两条路径迟早对同一状态给出不同答案，而用户只会相信其中一条。
 */
import type { ConfigFieldJson } from './configTypes.ts';
import { valueToDraftText } from './configTypes.ts';

/** 冲突四态（UI 只把 `conflict` 画成冲突带）。 */
export type ConflictState = 'clean' | 'pending' | 'reverted' | 'conflict';

export interface FieldConflict {
  fieldId: string;
  /** 词表键（客户端 t()）。 */
  labelKey: string;
  /** 用户草稿值的展示文本。 */
  draft: string;
  /** 磁盘当前（新事实）值的展示文本。 */
  server: string;
  /** 旧基线（用户开始改时看到的值）的展示文本。 */
  original: string;
  state: ConflictState;
}

/** 值归一成可比较文本（与 isDirty / setConfig 同口径——三处必须是同一件事）。 */
export function conflictText(field: ConfigFieldJson, v: unknown): string {
  if (field.kind === 'stringArray') {
    // 数组按内容比：`a, b` 与 `a,b` 是同一件事（空格是输入习惯，不是改动）。
    const list = Array.isArray(v)
      ? v.map((x) => String(x))
      : String(v ?? '').split(',').map((s) => s.trim());
    return list.map((s) => s.trim()).filter((s) => s !== '').join(', ');
  }
  if (field.kind === 'bool') return (v === true || v === 'true') ? 'true' : 'false';
  return valueToDraftText(v);
}

/**
 * 单字段判定（导出供测试直接喂三值做双向自检——这是判据唯一可证伪的入口）。
 *
 * `draft === undefined` 一律 clean：没有草稿就没有「用户的意图」可冲突。
 */
export function classifyField(
  field: ConfigFieldJson,
  draft: string | boolean | undefined,
  newServer: unknown,
  originalServer: unknown,
): ConflictState {
  if (draft === undefined) return 'clean';
  const draftText = conflictText(field, draft);
  const nowText = conflictText(field, newServer);
  if (draftText === nowText) return 'clean'; // 已与新事实一致
  // 磁盘在你的背后动了没有：没动就只是普通编辑（最常见的一档）。
  if (nowText === conflictText(field, originalServer)) return 'pending';
  // 磁盘动了：用户改回原值（撤销）与改了别的值，必须分开。
  if (draftText === conflictText(field, originalServer)) return 'reverted';
  return 'conflict';
}

/**
 * 计算冲突清单。
 *
 * `previousValues` 是**上一次轮询看到**的事实（由调用方的数据腿保存）。
 * 全空对象 = 首次拉取（没有基线可谈），此时按「与当前一致」处理（零冲突）——
 * 首次拉取不能报冲突，否则用户一打开面板就看到一串红条。
 */
export function detectConflicts(
  schema: ConfigFieldJson[],
  newValues: Record<string, unknown>,
  previousValues: Record<string, unknown>,
  drafts: Record<string, string | boolean>,
): FieldConflict[] {
  if (Object.keys(drafts).length === 0) return [];
  const hasBaseline = Object.keys(previousValues).length > 0;
  const out: FieldConflict[] = [];
  for (const field of schema) {
    const draft = drafts[field.id];
    if (draft === undefined) continue;
    const original = hasBaseline ? previousValues[field.id] : newValues[field.id];
    const state = classifyField(field, draft, newValues[field.id], original);
    if (state !== 'conflict') continue;
    out.push({
      fieldId: field.id,
      labelKey: field.labelKey,
      draft: conflictText(field, draft),
      server: conflictText(field, newValues[field.id]),
      original: conflictText(field, original),
      state,
    });
  }
  return out;
}

/**
 * 「采用磁盘」= 把草稿改成新事实值；「保留我的」= 只 acknowledge 不合并。
 *
 * 两者都只是**给出要写的草稿值**，不是写动作本身：调用方拿到值再走
 * `setConfigDraft`（唯一草稿写路径），与本模块的「不另建合并逻辑」一致。
 */
export function adoptServerDraft(
  field: ConfigFieldJson,
  newValues: Record<string, unknown>,
): string | boolean | undefined {
  const v = newValues[field.id];
  if (v === undefined) return undefined;
  if (field.kind === 'bool') return v === true;
  return conflictText(field, v);
}

/**
 * 冲突键签名（供「已确认」集合去重）。
 *
 * 为什么用「字段 + 两侧值」而不是只看字段 id：用户点了「保留我的」之后，
 * 若脚本又把它改成 C2，这是**新的**冲突（值变了），必须再报一次。
 * 只按 id 去重会让第二、第三次改动永久静默——那比不报更糟。
 */
export function conflictSignature(c: FieldConflict): string {
  return `${c.fieldId}|${c.draft}|${c.server}`;
}

/** 过滤掉用户已确认过的冲突（签名进 acknowledged 集合）。 */
export function pendingConflicts(all: FieldConflict[], acknowledged: readonly string[]): FieldConflict[] {
  if (acknowledged.length === 0) return all;
  const set = new Set(acknowledged);
  return all.filter((c) => !set.has(conflictSignature(c)));
}
