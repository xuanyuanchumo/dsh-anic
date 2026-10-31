/**
 * 分键视图态的**接线零件**（cycle-95 · WS-C）—— 快照 / 还原 / 节流写入，全部纯逻辑。
 *
 * ## 为什么单独成文件（而不是直接写在 hook 里）
 *
 * 「视口 + 筛选 + 布局模式 → 存储形状 → 再还原回来」这一段是**纯数据变换**，而
 * 「什么时候读、什么时候写」才是 React 的事。把两者混在 hook 里，最要命的几条
 * 判据（脏数据不得让面板崩、pointermove 期间不得写盘、换工作区必须先落旧键）
 * 就只能靠真挂组件才发现——而这几条恰恰是**静默错误**（面板照常渲染，只是
 * 用户切回来发现视图没恢复，或 A 项目的缩放串到 B 项目）。
 *
 * 拆开后：变换与节流可在 node 环境逐档断言（注入时钟与定时器，不真等 300ms），
 * hook 只剩"在 effect 里调两下"。
 *
 * ## 为什么还原要**逐字段校验**而不是整体信任
 *
 * 存进去的是本轮代码写的；读出来的是**上一轮构建产物**写的。宿主升级 / 字段
 * 改名 / 用户手工改 localStorage 都会让读到的东西形状不对。整块 `as` 转型的
 * 后果是 `viewport.scale = "abc"` 直接进 SVG transform —— 整张图消失，而错误
 * 发生在渲染层，与"数据坏了"极难关联。所以逐字段校验、坏字段**逐个丢弃**
 * （保留其它字段），而不是一票否决整份状态。
 *
 * ## 为什么写入是 trailing（尾部触发）+ 速率下限
 *
 * `pointermove` 拖拽一次会产生几十次视口变化。每次变化都写 `localStorage` 会让
 * 主线程在拖拽中同步做 JSON 序列化 + 磁盘写入 —— 用户感受到的是"拖起来发涩"，
 * 而这类卡顿在开发机上永远复现不出来。trailing 写入的含义是：
 * **变化停止 delayMs 之后才落一次盘**；速率下限保证连续两次写至少间隔 delayMs，
 * 避免"抖两下写两次"。
 */
import type { WorkspaceViewState, ViewStateStore } from '../../components/workspaceViewState.ts';
import { saveViewState, loadViewState } from '../../components/workspaceViewState.ts';
import { workspaceKeyOf, type WorkspaceKey } from '../../components/workspaceGuard.ts';
import type { FilterState } from './graphFilter.ts';
import type { LayoutMode } from './graphLayoutSpec.ts';
import { LAYOUT_MODES } from './graphLayoutSpec.ts';
import { clampScale, type Viewport } from './graphViewport.ts';

/** 默认写入延迟（ms）。300 是"拖拽停止感"与"切项目不丢"之间的常用折中。 */
export const WRITE_DELAY_MS = 300;

/** 可持久化的筛选形状校验（坏字段丢弃 ⇒ 回落到默认筛选）。 */
function filterOf(raw: unknown): FilterState | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const types = obj['types'];
  const verdicts = obj['verdicts'];
  const query = obj['query'];
  if (!Array.isArray(types) || !types.every((v) => typeof v === 'string')) return undefined;
  if (!Array.isArray(verdicts) || !verdicts.every((v) => typeof v === 'string')) return undefined;
  if (typeof query !== 'string') return undefined;
  return { types: types as string[], verdicts: verdicts as string[], query };
}

/** 布局模式校验（只认已登记的档位；未知档位丢弃 ⇒ 保持当前模式）。 */
function layoutModeOf(raw: unknown): LayoutMode | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!Object.prototype.hasOwnProperty.call(LAYOUT_MODES, raw)) return undefined;
  return raw as LayoutMode;
}

/** 视口校验（NaN / Infinity 会让整张 SVG 消失，必须挡在还原之前）。 */
function viewportOf(state: WorkspaceViewState): Viewport | undefined {
  const zoom = state.zoom;
  const pan = state.pan;
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) return undefined;
  if (typeof pan !== 'object' || pan === null) return undefined;
  const x = (pan as { x?: unknown }).x;
  const y = (pan as { y?: unknown }).y;
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined;
  if (typeof y !== 'number' || !Number.isFinite(y)) return undefined;
  return { scale: clampScale(zoom), tx: x, ty: y };
}

/** 还原结果的形状（每个字段独立可选：坏字段丢弃、好字段照用）。 */
export interface RestoredViewState {
  viewport?: Viewport;
  filter?: FilterState;
  layoutMode?: LayoutMode;
}

/** 当前视图态 → 存储形状（`pan` 即视口平移，`zoom` 即缩放比例）。 */
export function viewStateSnapshotOf(input: {
  viewport: Viewport;
  filter: FilterState;
  layoutMode: LayoutMode;
}): WorkspaceViewState {
  return {
    zoom: input.viewport.scale,
    pan: { x: input.viewport.tx, y: input.viewport.ty },
    filter: { types: [...input.filter.types], verdicts: [...input.filter.verdicts], query: input.filter.query },
    layoutMode: input.layoutMode,
  };
}

/**
 * 存储形状 → 还原结果（**逐字段校验**，见文件头）。
 *
 * null（没存过）→ 空对象：调用方据此什么都不做。**不返回默认值对象**——
 * 把"没存过"伪装成"存了默认值"会让后续"是否已恢复"的判定永远为真。
 */
export function restoredViewStateOf(state: WorkspaceViewState | null): RestoredViewState {
  if (state === null) return {};
  const out: RestoredViewState = {};
  const viewport = viewportOf(state);
  if (viewport !== undefined) out.viewport = viewport;
  const filter = filterOf(state.filter);
  if (filter !== undefined) out.filter = filter;
  const layoutMode = layoutModeOf(state.layoutMode);
  if (layoutMode !== undefined) out.layoutMode = layoutMode;
  return out;
}

/** 定时器句柄（注入实现时不必关心宿主用的是什么句柄类型）。 */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** 节流写入器的构造入参（时钟与定时器**可注入** —— 单测不真等 300ms）。 */
export interface ViewStateWriterInput {
  store: ViewStateStore;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  now?: () => number;
}

/** 节流写入器：`schedule` 记录最新状态，delayMs 静默后才真正落盘。 */
export interface ViewStateWriter {
  /** 记录一次变化（同键同值 → 完全无操作；换工作区 → 先落旧键再排新键）。 */
  schedule(workspace: string | null | undefined, state: WorkspaceViewState): void;
  /** 立即落盘（换工作区前 / 卸载时用，否则用户最后一次调整会丢）。 */
  flush(): void;
}

/** 一条待写记录（**带工作区原串**：落盘走 `saveViewState` 的分键口径）。 */
interface Pending {
  workspace: string;
  key: WorkspaceKey;
  state: WorkspaceViewState;
  serialized: string;
}

/**
 * 构造节流写入器。
 *
 * 判据三条（都写进单测）：
 * 1. **同键同值不重置定时器** —— 数据 tick 每 4s 重渲一次，若每次都重置，
 *    定时器永远等不到静默期，视图态就永远不落盘（"功能写了但从不生效"）。
 * 2. **换键先落旧键** —— 用户在 A 里调好视口后立刻切到 B；若直接把 pending
 *    覆盖成 B，A 的最后一次调整就丢了（切回 A 还是更旧的视图）。
 * 3. **速率下限** —— 两次落盘至少间隔 delayMs（见文件头）。
 */
export function createViewStateWriter(input: ViewStateWriterInput): ViewStateWriter {
  const delayMs = Math.max(1, Math.floor(input.delayMs ?? WRITE_DELAY_MS));
  const setTimer = input.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = input.clearTimer ?? ((handle) => { clearTimeout(handle); });
  const now = input.now ?? (() => Date.now());
  let pending: Pending | null = null;
  let handle: TimerHandle | null = null;
  let lastWriteAt = 0;

  const write = (item: Pending): void => {
    // 走 `saveViewState` 而不是 `store.set(key, …)`：分键归一（Windows 盘符大小写）
    // 只在 workspaceViewState 里实现一份，直接拼 key 就等于出现第二套口径。
    saveViewState(input.store, item.workspace, item.state);
    lastWriteAt = now();
  };

  const arm = (): void => {
    if (handle !== null) clearTimer(handle);
    handle = setTimer(() => {
      handle = null;
      if (pending === null) return;
      // 速率下限：离上次落盘太近就再等一轮（"抖两下写两次"没有意义）。
      if (lastWriteAt + delayMs - now() > 0) { arm(); return; }
      const item = pending;
      pending = null;
      write(item);
    }, delayMs);
  };

  return {
    schedule: (workspace, state) => {
      const key = workspaceKeyOf(workspace);
      const serialized = JSON.stringify(state);
      if (pending !== null) {
        // 判据 1：同键同值 ⇒ 不动定时器（数据 tick 不该把静默期重置掉）。
        if (pending.key === key && pending.serialized === serialized) return;
        // 判据 2：换键 ⇒ 先把旧键落盘（否则旧项目的最后一次调整丢失）。
        if (pending.key !== key) {
          const old = pending;
          pending = null;
          write(old);
        }
      }
      pending = { workspace: workspace ?? '', key, state, serialized };
      arm();
    },
    flush: () => {
      if (handle !== null) { clearTimer(handle); handle = null; }
      const item = pending;
      pending = null;
      if (item !== null) write(item);
    },
  };
}

/**
 * 读某工作区的视图态（包装 `loadViewState` 并**逐字段校验**）。
 *
 * 单独一个入口是为了让 hook 只有一行调用 —— 反过来，若在 hook 里先 load 再校验，
 * 校验判据就长在 effect 里，既不可单测，也会在下次改动时被当成"多余防御"删掉。
 */
export function loadRestoredViewState(
  store: ViewStateStore,
  workspace: string | null | undefined,
): RestoredViewState {
  return restoredViewStateOf(loadViewState(store, workspace));
}
