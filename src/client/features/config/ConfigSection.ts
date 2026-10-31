/**
 * 配置与路径分区组件（cycle-82；cycle-83 增路径编辑/冲突条/回滚接线）。
 *
 * ## 为什么独立成文件而不是塞进 components/panelSections.ts
 *
 * 同 `GraphSection` 的裁决（T3 ≤250 行 + 一域一文件）：配置分区属于
 * `features/config/` 这一域，订阅薄层应当与它所服务的渲染器相邻。
 * `panelSections.ts` 继续再导出 `ConfigSection`，装配层 import 路径零变更。
 *
 * ## 为什么这个分区**默认展开**
 *
 * `DEFAULT_OPEN_SECTIONS` 的选取标准是"兜底观测面：不展开就看不到问题"。
 * 配置分区满足这一条但理由不同——它是**唯一可写分区**，用户点开面板就是要改配置，
 * 折叠一层会让"保存按钮在哪"变成一次多余点击。其余静态分区继续默认收纳。
 *
 * ## 本文件只剩「组装」：写侧动作在 configActions.ts
 *
 * 提交/路径保存/回滚的时序纪律（begin→await→finish、失败保留输入、写后刷新）
 * 都在 configActions.ts。这里只做订阅切片、算冲突、把点击翻译成动作调用——
 * 两种职责混在一起会越过 250 行，也会让「怎么渲染」与「怎么做写」纠缠。
 *
 * ## 「旧基线」为什么用 rawHash 区分而不是另存一份影子状态
 *
 * 冲突判据需要**旧基线**。GET 响应自带 `rawHash`：ref 里存 `{hash, values}`。
 * 渲染时若 `ref.hash !== cfg.rawHash` 说明磁盘在这两拍之间变过，ref 里那份
 * values 就是用户开始编辑时看到的基线。一个来源（服务端事实 + 它的哈希），
 * 不需要第二份影子状态。ref 在 **effect 里**更新而不是渲染期——渲染期写 ref
 * 在 React 严格模式双调下会丢掉基线。
 */
import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { usePanelSlice } from '../../components/panelStore.ts';
import { bindPanelActions, type PanelActions } from '../../components/panelActions.ts';
import type { PanelDataStore, PanelState } from '../../panelState.ts';
import { t } from '../../i18n.ts';
import { renderFoldableSection } from '../../components/sectionShell.ts';
import { useSectionFailure, bodyOrFailure, type SectionBody } from '../../components/sectionFailure.ts';
import { renderConfigEditor, type ConfigEditorHandlers, type ConfigEditorInput } from './configRender.ts';
import { valueToDraftText, type ConfigJson } from './configTypes.ts';
import {
  adoptServerDraft, conflictSignature, detectConflicts, pendingConflicts, type FieldConflict,
} from './configConflict.ts';
import {
  useConfigSubmit, usePathEdit, usePathSave, useRollback,
  type BackupFeedback,
} from './configActions.ts';

const selConfig = (s: PanelState) => s.config;
const selDrafts = (s: PanelState) => s.configDrafts;
const selWrite = (s: PanelState) => s.configWrite;
const selSavedAt = (s: PanelState) => s.configSavedAt;
const selBusy = (s: PanelState) => s.configBusy;
const selError = (s: PanelState) => s.configError;

/** 面板实例唯一容器 id 的基础名（多实例同 id 会让 aria 关联静默错位，B5.1 教训）。 */
export const CONFIG_PANEL_ID = 'anic-config-panel';

/**
 * ## cycle-95 删除 `editablePaths()`（为什么删）
 *
 * 注释自称「供契约测试断言『路径项可编辑性来自服务端』」，但**没有任何契约
 * 测试引用它**（全仓去注释后零文本命中，tests/ 也没有）。真实的判据在两个
 * 更靠下的地方，而且都直接读 `entry.editable`：
 *
 * - 渲染入口：`configPaths.ts` 的 `if (entry.editable !== true) return null;`
 *   （不可编辑项连编辑按钮都不出）；
 * - 服务端权威：`configGuards.ts` 的 `editableIds`（路径覆盖响应的登记表）。
 *
 * ⇒ 这是一个**聚合包装**：它把 `entries.filter(e => e.editable === true)`
 * 包成"契约资产"，但契约资产实际上是那两处逐项判定的布尔语义。
 * 留着会诱导下一个人以为可编辑性有第二个判据来源（两套真相源）。
 * 本仓教训：没人用的兼容层是最贵的兼容层。
 */

/**
 * 冲突计算（纯读三份事实；「上一次拉到」的基线由调用方给）。
 *
 * 副作用只有一处：把「本拍事实 + 它的哈希」记进 ref（供下一拍算基线）。
 * 它在 **effect 里**执行——渲染期写 ref 在 React 严格模式双调下会丢掉基线。
 */
function useConflicts(
  config: ConfigJson | null,
  drafts: Record<string, string | boolean>,
  baselineRef: { current: { hash: string | null; values: Record<string, unknown> } },
  acknowledged: readonly string[],
): FieldConflict[] {
  const hash = config === null ? null : config.rawHash;
  const stale = config !== null && baselineRef.current.hash !== null && baselineRef.current.hash !== hash;
  // 哈希变了 ⇒ ref 里那份才是「用户开始编辑时看到的」旧事实；没变 ⇒ 就是当前事实。
  const baseline = stale ? baselineRef.current.values : (config?.values ?? {});
  useEffect(() => {
    if (config === null) return;
    baselineRef.current = { hash: config.rawHash, values: config.values };
  }, [config, baselineRef]);
  const all = config === null ? [] : detectConflicts(config.schema, config.values, baseline, drafts);
  return pendingConflicts(all, acknowledged);
}

function ConfigSectionImpl({ store, panelId }: { store: PanelDataStore; panelId: string }): ReactElement {
  const config = usePanelSlice(store, selConfig);
  const drafts = usePanelSlice(store, selDrafts);
  const writeResult = usePanelSlice(store, selWrite);
  const savedAt = usePanelSlice(store, selSavedAt);
  const busy = usePanelSlice(store, selBusy);
  const error = usePanelSlice(store, selError);
  const failure = useSectionFailure(store, 'config');
  const actions: PanelActions = bindPanelActions(store);
  const { onPreview, onSave } = useConfigSubmit(store);

  const [acknowledged, setAcknowledged] = useState<readonly string[]>([]);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [backupResult, setBackupResult] = useState<BackupFeedback | null>(null);
  const baselineRef = useRef<{ hash: string | null; values: Record<string, unknown> }>({ hash: null, values: {} });

  const conflicts = useConflicts(config, drafts, baselineRef, acknowledged);
  // 编辑态的唯一持有者：begin/save 的失败写回都走它（setState 一并下传）。
  const edit = usePathEdit();
  const savePath = usePathSave(store, edit.setState);
  const runRollback = useRollback(store, setBackupBusy, setBackupResult);

  const onAdoptServer = useCallback((fieldId: string): void => {
    const cfg = store.getState().config;
    if (cfg === null) return;
    const field = cfg.schema.find((f) => f.id === fieldId);
    if (field === undefined) return;
    const picked = conflicts.find((c) => c.fieldId === fieldId);
    const next = adoptServerDraft(field, cfg.values);
    if (next !== undefined) bindPanelActions(store).setConfigDraft(fieldId, next);
    if (picked !== undefined) setAcknowledged((prev) => [...prev, conflictSignature(picked)]);
  }, [store, conflicts]);

  const onKeepMine = useCallback((fieldId: string): void => {
    const found = conflicts.find((c) => c.fieldId === fieldId);
    if (found !== undefined) setAcknowledged((prev) => [...prev, conflictSignature(found)]);
  }, [conflicts]);

  const onDismiss = useCallback((): void => {
    setAcknowledged((prev) => [...prev, ...conflicts.map(conflictSignature)]);
  }, [conflicts]);

  const handlers: ConfigEditorHandlers = {
    onChange: (id, draft) => { actions.setConfigDraft(id, draft); },
    onReset: (id) => {
      // 还原单个字段 = 把草稿设回服务端事实值（不是删草稿键：删键会让"未修改"
      // 与"改回原值"两种状态在 isDirty 里都变成 false，但用户心智里后者是"我刚撤销"）。
      const cfg = store.getState().config;
      if (cfg === null) return;
      const server = cfg.values[id];
      if (typeof server === 'boolean') actions.setConfigDraft(id, server);
      else actions.setConfigDraft(id, valueToDraftText(server));
    },
    onCopy: (path) => {
      // clipboard 在无 DOM/无权限环境会抛；失败即静默（path 本身已在 DOM 里可选中复制）。
      try { void (globalThis as { navigator?: { clipboard?: { writeText?: (s: string) => Promise<void> } } })
        .navigator?.clipboard?.writeText?.(path); } catch { /* 降级：用户手动选中 */ }
    },
    onPreview,
    onSave,
    onDiscard: () => { actions.clearConfigDrafts(); },
    // cycle-83：路径行内编辑（服务端是唯一判据权威，本地只挡形状）。
    onEditBegin: (id) => { edit.begin(id, config?.pathOverrides?.active[id] ?? ''); },
    onEditChange: (id, value) => { edit.change(id, value); },
    onEditCancel: () => { edit.cancel(); },
    onEditSave: (id) => { if (edit.state !== null) void savePath(id, edit.state.value, false); },
    onEditReset: (id) => { void savePath(id, '', true); },
    onAdoptServer,
    onKeepMine,
    onDismiss,
    onPreviewRestore: (name) => { void runRollback(name, true); },
    onRestore: (name) => { void runRollback(name, false); },
  };

  const input: ConfigEditorInput = {
    config,
    drafts,
    writeResult,
    savedAt,
    busy,
    // 拉取失败与写错误是两条通道：前者是"不知道磁盘现在是什么"，后者是"写了没成功"。
    error: error === '' ? null : error,
    conflicts,
    pathEdit: edit.state,
    backupBusy,
    backupResult,
  };

  const editor = renderConfigEditor(input, handlers, panelId);
  const body: SectionBody = bodyOrFailure(editor, 'config', failure);
  return renderFoldableSection({ id: 'config', title: t('fold.config'), defaultOpen: true, children: body });
}

/** 配置与路径分区（订阅六个配置切片，写路径全走动作层）。 */
export const ConfigSection = memo(ConfigSectionImpl);
