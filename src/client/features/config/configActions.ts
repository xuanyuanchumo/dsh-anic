/**
 * 配置分区的**写侧数据腿**（cycle-83：从 ConfigSection.ts 拆出，T3 ≤250 行）。
 *
 * ## 为什么这几段单独成文件
 *
 * ConfigSection 的职责是「订阅切片 + 组装输入 + 翻译点击」（见其文件头）。
 * 而这三段是**动作语义**：提交 patch、保存路径覆盖、回滚备份。它们各自有
 * 自己的时序纪律（begin→await→finish/fail、写后刷新、失败保留输入），
 * 混在组装层会让「这个分区怎么做写」与「这个分区怎么渲染」纠缠在一起。
 *
 * ## 三条共同纪律
 *
 * ① **失败保留用户输入**：路径保存被拒时编辑态仍留着输入与错误原文——
 *    擦掉输入等于让用户重打（与 config 写失败保留草稿同款）；
 * ② **写后立刻刷新事实**：不靠 4s 下一拍（用户会以为没生效并再点一次，产生重复写）；
 * ③ **本地只挡形状，服务端才是判据权威**：`localPathHint` 只拦明显非相对/含 `..`
 *    的输入，真正的 realpath/类型/碰撞判定一律交给 paths 端点（写第二份判据
 *    必然漂移，而用户只会相信客户端那一份）。
 */
import { useCallback, useState } from 'react';
import { bindPanelActions, type PanelActions } from '../../components/panelActions.ts';
import type { PanelDataStore } from '../../panelState.ts';
import { t } from '../../i18n.ts';
import { draftsToPatch, refreshConfigFact, submitConfigPatch, submitPathPatch, submitRollback } from './configTarget.ts';
import type { ConfigWriteJson } from './configTypes.ts';

/** 路径编辑态（null = 没在编辑；只活在这个分区）。 */
export interface PathEditState { id: string; value: string; error: string | null; busy: boolean }

/** 备份操作结果反馈。 */
export interface BackupFeedback { ok: boolean; message: string; safetyBackupPath?: string | null }

/**
 * 提交配置（dryRun 或真写）。
 *
 * 三个动作层的时序是**刻意**的：begin → await → finish/fail。中间那段 await
 * 期间 busy=true 让按钮禁用——否则用户连点两次会产生两个并发写，而后端是
 * "读-改-写"语义，第二个 patch 是基于旧快照算的（丢更新）。
 */
export function useConfigSubmit(store: PanelDataStore): { onPreview: () => void; onSave: () => void } {
  const run = useCallback(async (dryRun: boolean): Promise<void> => {
    const actions: PanelActions = bindPanelActions(store);
    const state = store.getState();
    const cfg = state.config;
    if (cfg === null) return;
    const patch = draftsToPatch(cfg.schema, cfg.values, state.configDrafts);
    if (Object.keys(patch).length === 0) return; // 无改动不提交（按钮已禁用，这里是二道保险）
    actions.beginConfigWrite();
    const out = await submitConfigPatch(patch, dryRun);
    if (out.body === null) { actions.failConfigWrite(out.error ?? 'unknown', null); return; }
    if (out.body.ok === false && !dryRun) { actions.failConfigWrite(out.body.error || 'rejected', out.body as ConfigWriteJson); return; }
    if (dryRun) {
      // 预览不改草稿、不改 baseline：它只是"如果保存会发生什么"的一次问答。
      actions.finishConfigPreview(out.body as ConfigWriteJson);
      return;
    }
    actions.finishConfigWrite(out.body as ConfigWriteJson, new Date().toISOString());
  }, [store]);

  const onPreview = useCallback((): void => { void run(true); }, [run]);
  const onSave = useCallback((): void => { void run(false); }, [run]);
  return { onPreview, onSave };
}

/** 本地成形校验：只挡明显形状错误（服务端才是判据权威）。 */
export function localPathHint(raw: string): string | null {
  const v = raw.trim();
  if (v === '') return t('config.' + 'pathEditHint');
  if (/^[/\\]|^[A-Za-z]:[\\/]/.test(v)) return t('config.' + 'pathEditOutside');
  if (v.split(/[\\/]/).includes('..')) return t('config.' + 'pathEditInvalid');
  return null;
}

/**
 * 路径编辑的读-改-写三动作（begin / change / cancel）+ 原始 setter。
 *
 * `setState` 一并导出是刻意的：保存失败时要把错误写回同一份编辑态
 * （`usePathSave` 拿的就是它）。若两处各持一份 state，就会出现
 * 「保存失败的错误显示在 A，用户看到的是 B 的输入」这种分裂。
 */
export function usePathEdit(): {
  begin: (id: string, currentRel: string) => void;
  change: (id: string, value: string) => void;
  cancel: () => void;
  state: PathEditState | null;
  setState: (s: PathEditState | null) => void;
} {
  const [state, setState] = useState<PathEditState | null>(null);
  const begin = useCallback((id: string, currentRel: string): void => {
    setState({ id, value: currentRel, error: null, busy: false });
  }, []);
  const change = useCallback((id: string, value: string): void => {
    setState((prev) => (prev === null || prev.id !== id ? prev : { ...prev, value, error: null }));
  }, []);
  const cancel = useCallback((): void => { setState(null); }, []);
  return { begin, change, cancel, state, setState };
}

/** 保存/撤销一条路径覆盖（`reset=true` ⇒ patch 值为 null，回默认）。 */
export function usePathSave(store: PanelDataStore, setState: (s: PathEditState | null) => void): (id: string, raw: string, reset: boolean) => Promise<void> {
  return useCallback(async (id: string, raw: string, reset: boolean): Promise<void> => {
    const hint = reset ? null : localPathHint(raw);
    if (hint !== null) { setState({ id, value: raw, error: hint, busy: false }); return; }
    setState({ id, value: raw, error: null, busy: true });
    const out = await submitPathPatch({ [id]: reset ? null : raw.trim() }, false);
    if (out.body === null) { setState({ id, value: raw, error: out.error ?? 'unknown', busy: false }); return; }
    if (!out.body.ok) {
      // 服务端拒绝显示**原文**（哪条、为什么），不吞成"非法"。
      const msg = out.body.warnings.length > 0 ? out.body.warnings.join(' · ') : out.body.error;
      setState({ id, value: raw, error: msg === '' ? 'rejected' : msg, busy: false });
      return;
    }
    setState(null);
    await refreshConfigFact(store);
  }, [store, setState]);
}

/** 回滚（dryRun 只看 diff）。成功/失败都落到反馈上，写后刷新事实。 */
export function useRollback(
  store: PanelDataStore,
  setBusy: (name: string | null) => void,
  setFeedback: (f: BackupFeedback | null) => void,
): (name: string, dryRun: boolean) => Promise<void> {
  return useCallback(async (name: string, dryRun: boolean): Promise<void> => {
    setBusy(name);
    setFeedback(null);
    const out = await submitRollback(name, dryRun);
    setBusy(null);
    // 失败一律用统一句式（「恢复失败：{error}」）：把原因原样带上，
    // 不吞成一句"失败"——用户要知道是"备份名不在清单"还是"写盘失败"。
    if (out.body === null) {
      setFeedback({ ok: false, message: t('config.' + 'backupRestoreFailed', { error: out.error ?? 'unknown' }) });
      return;
    }
    const b = out.body;
    if (!b.ok) {
      const reason = b.error.length > 0 ? b.error : (b.warnings.join(' · ') || 'rejected');
      setFeedback({ ok: false, message: t('config.' + 'backupRestoreFailed', { error: reason }) });
      return;
    }
    setFeedback({
      ok: true,
      message: `${t('config.' + (dryRun ? 'backupPreviewRestore' : 'backupRestored'))}: ${String(b.changedFields.length)}`,
      safetyBackupPath: b.safetyBackupPath ?? null,
    });
    if (!dryRun) await refreshConfigFact(store);
  }, [store, setBusy, setFeedback]);
}
