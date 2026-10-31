/**
 * 分键视图态的**接线 hook**（cycle-95 · WS-C · 修 O-94-03）——把
 * `components/workspaceViewState.ts` 从死代码接进图区。
 *
 * ## 为什么要它（实测缺陷）
 *
 * `workspaceViewState.ts` 写好了 `createViewStateStore` / `loadViewState` /
 * `saveViewState`（含 localStorage 不可用时静默降级到内存），也有单测，
 * 但**全仓零调用点**。后果是：缩放/平移/筛选是用户在这个项目里建立的
 * **空间认知**，切到另一个项目后全部丢失，切回来也不恢复 —— 每次切项目都要
 * 重新定位。这是 cycle-94 审计里 O-94-03 的真身。
 *
 * ## 为什么单独成文件（而不是写在 GraphInteractive 里）
 *
 * `GraphInteractive.ts` 已 248 行（250 是 `objectiveConformanceContract ⑪` 的
 * 机械硬限），加任何东西都要先拆。拆分的界线仍是**职责**：本文件回答
 * 「什么时候读、什么时候写、切工作区怎么办」，组件继续回答「这些状态从哪来」。
 * 附带收益：节流与判等逻辑可注入时钟单测，不必真挂组件等 300ms。
 *
 * ## 四条判据（都不是可选项）
 *
 * 1. **只在挂载/切工作区时读一次**：数据 4s 一轮询，若每轮都读会把用户
 *    刚调好的视口按回磁盘里的旧值 —— 表现为"图自己跳一下"。
 * 2. **节流写**：`pointermove` 拖拽一次产生几十次视口变化，每次都写
 *    `localStorage` 会让拖拽发涩（同步 JSON 序列化 + 磁盘写）。
 * 3. **工作区未知 ⇒ 不记忆**：`workspaceKeyOf(undefined)` 落到固定键
 *    `__unknown__`，两个都未知的项目会共用同一份视图态 —— A 的缩放串到 B，
 *    正是本功能要消灭的污染。所以未知时**不写**（诚实退化成"本会话不记"），
 *    而不是硬塞一个分不清是谁的键。
 * 4. **未知 → 已知的跃迁不抢视图**：面板刚挂载时 workspace 还没学到（配置腿
 *    要等首个响应）。若用户在头几秒已经把图调好了，随后 workspace 到达时再
 *    恢复一次旧视图，就是把图从用户手底下拽走。所以"用户已动过"时只记键、
 *    不恢复。
 *
 * ## 只用 stub 支持的 hooks
 *
 * `scripts/offline-smoke.mjs` 的 React 桩只提供七个 API；`useMemo` 会让整棵树
 * 在 smoke 里 TypeError。本文件只用 `useRef / useCallback / useEffect`。
 */
import { useCallback, useEffect, useRef } from 'react';
import type { ViewStateStore } from '../../components/workspaceViewState.ts';
import { createViewStateStore } from '../../components/workspaceViewState.ts';
import { UNKNOWN_WORKSPACE_KEY, workspaceKeyOf, type WorkspaceKey } from '../../components/workspaceGuard.ts';
import type { FilterState } from './graphFilter.ts';
import type { LayoutMode } from './graphLayoutSpec.ts';
import type { Viewport } from './graphViewport.ts';
import {
  createViewStateWriter, loadRestoredViewState, viewStateSnapshotOf,
  type ViewStateWriter, type RestoredViewState,
} from './graphViewStateWire.ts';

/** 入参：所有视图状态都由组件提供（本 hook 不持有视图状态，只持存储句柄）。 */
export interface GraphViewStateInput {
  /** 当前工作区路径（`undefined` = 还没学到 ⇒ 不记忆，见文件头判据 3）。 */
  workspace: string | null | undefined;
  viewport: Viewport;
  filter: FilterState;
  layoutMode: LayoutMode;
  /** 恢复视口（直接写回手势 hook 的视口）。 */
  onRestoreViewport: (next: Viewport) => void;
  onRestoreFilter: (next: FilterState) => void;
  onRestoreLayout: (mode: LayoutMode) => void;
}

/**
 * 订阅"当前视图态"并分键持久化。
 *
 * 返回 `void`（不返回额外状态）：视图态的唯一权威仍住在组件/hook 里，
 * 本 hook 只做 IO。多返回一个"当前存储值"只会制造第二份真相。
 */
export function useGraphViewState(input: GraphViewStateInput): void {
  const storeRef = useRef<ViewStateStore | null>(null);
  const writerRef = useRef<ViewStateWriter | null>(null);
  /** 已水合的工作区键（null = 一次都没跑过）。undefined 键用字符串哨兵区分。 */
  const hydratedRef = useRef<WorkspaceKey | null>(null);
  /** 恢复之后的"基线签名"：与之相同说明还没有真实变化，不该写盘。 */
  const baselineRef = useRef<string | null>(null);
  /** 用户是否已经动过视图（判据 4 的不抢依据）。 */
  const dirtyRef = useRef(false);
  /** 恢复回调（每次渲染刷新；effect 只读 ref，避免回调引用抖动重建 effect）。 */
  const restoreRef = useRef(input);
  restoreRef.current = input;

  const storeOf = useCallback((): ViewStateStore => {
    const cur = storeRef.current;
    if (cur !== null) return cur;
    // 构造期探测 localStorage 可写性；不可用则内部已降级到内存（不抛错）。
    const fresh = createViewStateStore();
    storeRef.current = fresh;
    return fresh;
  }, []);

  const writerOf = useCallback((): ViewStateWriter => {
    const cur = writerRef.current;
    if (cur !== null) return cur;
    const fresh = createViewStateWriter({ store: storeOf() });
    writerRef.current = fresh;
    return fresh;
  }, [storeOf]);

  const snapshot = viewStateSnapshotOf({
    viewport: input.viewport, filter: input.filter, layoutMode: input.layoutMode,
  });
  const signature = JSON.stringify(snapshot);
  const key = workspaceKeyOf(input.workspace);
  const unknown = key === UNKNOWN_WORKSPACE_KEY;
  const workspace = input.workspace;

  // ── 恢复（挂载 + 切工作区）─────────────────────────────────────
  useEffect(() => {
    if (hydratedRef.current === key) return; // 判据 1：同一键只恢复一次
    const prev = hydratedRef.current;
    hydratedRef.current = key;
    // 切工作区：先把旧键的待写状态落盘，否则旧项目的最后一次调整会丢。
    if (prev !== null) writerRef.current?.flush();
    if (unknown) { baselineRef.current = signature; return; } // 判据 3：不记忆
    const restored = loadRestoredViewState(storeOf(), workspace);
    const hasAny = restored.viewport !== undefined
      || restored.layoutMode !== undefined || restored.filter !== undefined;
    // 判据 4：未知 → 已知且用户已动过 ⇒ 只记键，不把图拽回旧视图。
    const yank = prev === UNKNOWN_WORKSPACE_KEY && dirtyRef.current;
    if (!hasAny || yank) { baselineRef.current = signature; return; }
    const cur = restoreRef.current;
    if (restored.viewport !== undefined) cur.onRestoreViewport(restored.viewport);
    if (restored.filter !== undefined) cur.onRestoreFilter(restored.filter);
    if (restored.layoutMode !== undefined) cur.onRestoreLayout(restored.layoutMode);
    // 基线 = 恢复**之后**的状态（未恢复的字段沿用当前值）。
    baselineRef.current = JSON.stringify(viewStateSnapshotOf({
      viewport: restored.viewport ?? cur.viewport,
      filter: restored.filter ?? cur.filter,
      layoutMode: restored.layoutMode ?? cur.layoutMode,
    }));
  }, [key, unknown, signature, workspace, storeOf]);

  // ── 写入（节流由 writer 负责，见 graphViewStateWire 头注）──────────
  useEffect(() => {
    // 尚未水合：此时写盘会拿初值覆盖磁盘里的视口。
    if (baselineRef.current === null) return;
    // 与基线相同 ⇒ 还没发生真实变化（恢复本身不算"用户的新选择"）。
    if (signature === baselineRef.current) return;
    if (unknown) return; // 判据 3：未知工作区不写
    dirtyRef.current = true;
    writerOf().schedule(workspace, snapshot);
    // 记为新基线：同一次变化不再重复调度（writer 也会按"同值不重置定时器"去重）。
    baselineRef.current = signature;
  }, [signature, unknown, workspace, snapshot, writerOf]);

  // ── 卸载时把待写状态落盘（用户最后调的那一下不能丢）──────────────
  useEffect(() => () => { writerRef.current?.flush(); }, []);
}

/** 恢复结果的形状别名（供单测直接构造；语义见 graphViewStateWire）。 */
export type { RestoredViewState };
