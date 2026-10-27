/**
 * 配置与路径分区组件（cycle-82）—— store 切片 + 动作层 → 纯渲染器。
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
 * ## 草稿不在这里存
 *
 * 草稿在 `panelState.configDrafts`（见 panelActions.applyConfig 的合并不变量）。
 * 本组件只把"事实 + 草稿 + 写结果"取出来交给纯渲染器，并把点击翻译成动作层调用。
 */
import { memo, useCallback, type ReactElement } from 'react';
import { usePanelSlice } from '../../components/panelStore.ts';
import { bindPanelActions, type PanelActions } from '../../components/panelActions.ts';
import type { PanelDataStore, PanelState } from '../../panelState.ts';
import { t } from '../../i18n.ts';
import { renderFoldableSection } from '../../components/sectionShell.ts';
import { useSectionFailure, bodyOrFailure, type SectionBody } from '../../components/sectionFailure.ts';
import { renderConfigEditor, type ConfigEditorInput } from './configRender.ts';
import { draftsToPatch, submitConfigPatch } from './configTarget.ts';
import { valueToDraftText } from './configTypes.ts';

const selConfig = (s: PanelState) => s.config;
const selDrafts = (s: PanelState) => s.configDrafts;
const selWrite = (s: PanelState) => s.configWrite;
const selSavedAt = (s: PanelState) => s.configSavedAt;
const selBusy = (s: PanelState) => s.configBusy;
const selError = (s: PanelState) => s.configError;

/** 面板实例唯一容器 id 的基础名（多实例同 id 会让 aria 关联静默错位，B5.1 教训）。 */
export const CONFIG_PANEL_ID = 'anic-config-panel';

/**
 * 提交（dryRun 或真写）。
 *
 * 三个动作层的时序是**刻意**的：begin → await → finish/fail。中间那段 await
 * 期间 busy=true 让按钮禁用——否则用户连点两次会产生两个并发写，而后端是
 * "读-改-写"语义，两个并发写的第二个是基于旧快照算的 patch（丢更新）。
 */
function useConfigSubmit(store: PanelDataStore): {
  onPreview: () => void;
  onSave: () => void;
} {
  const run = useCallback(async (dryRun: boolean): Promise<void> => {
    const actions: PanelActions = bindPanelActions(store);
    const state = store.getState();
    const cfg = state.config;
    if (cfg === null) return;
    const patch = draftsToPatch(cfg.schema, cfg.values, state.configDrafts);
    if (Object.keys(patch).length === 0) return; // 无改动不提交（预览/保存都禁用，这里是二道保险）
    actions.beginConfigWrite();
    const out = await submitConfigPatch(patch, dryRun);
    if (out.body === null) { actions.failConfigWrite(out.error ?? 'unknown', null); return; }
    if (out.body.ok === false && !dryRun) { actions.failConfigWrite(out.body.error || 'rejected', out.body); return; }
    if (dryRun) {
      // 预览不改草稿、不改 baseline：它只是"如果保存会发生什么"的一次问答。
      actions.finishConfigPreview(out.body);
      return;
    }
    actions.finishConfigWrite(out.body, new Date().toISOString());
  }, [store]);

  const onPreview = useCallback((): void => { void run(true); }, [run]);
  const onSave = useCallback((): void => { void run(false); }, [run]);
  return { onPreview, onSave };
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

  const input: ConfigEditorInput = {
    config,
    drafts,
    writeResult,
    savedAt,
    busy,
    // 拉取失败与写错误是两条通道：前者是"不知道磁盘现在是什么"，后者是"写了没成功"。
    error: error === '' ? null : error,
  };
  const editor = renderConfigEditor(input, {
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
  }, panelId);

  const body: SectionBody = bodyOrFailure(editor, 'config', failure);
  return renderFoldableSection({ id: 'config', title: t('fold.config'), defaultOpen: true, children: body });
}

/** 配置与路径分区（订阅六个配置切片，写路径全走动作层）。 */
export const ConfigSection = memo(ConfigSectionImpl);
