/**
 * 按工作区分键的视图态持久化（cycle-89 · 从 `workspaceGuard.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 为什么要它
 *
 * 缩放/平移/筛选是**用户在这个项目里建立的空间认知**。切到另一个项目后
 * 沿用同一套视口，等于让用户在一个新图上用旧坐标找东西 —— 会迷路。
 * 而切回来时若不恢复，用户每次切项目都要重新定位 —— 同样不可接受。
 *
 * ⇒ 视图态必须**按工作区分键**存储：A 项目记住自己的，A 与 B 互不污染。
 *
 * ## 为什么降级不抛错
 *
 * localStorage 在三种真机环境里会不可用：隐私模式（部分浏览器）、
 * 宿主 webview 的 file:// 源、配额满。抛错会让**整个面板挂掉** ——
 * 而视图态只是一个便利功能，不值得让核心观测面陪葬。
 *
 * 降级是**功能降级不是静默失败**：面板照常工作，只是视图态不跨会话保留。
 */
import { workspaceKeyOf, type WorkspaceKey } from './workspaceGuard.ts';

/** 视图态（形状由调用方定义；本模块只负责存取与分键）。 */
export interface WorkspaceViewState {
  /** 缩放倍数。 */
  zoom?: number;
  /** 平移偏移。 */
  pan?: { x: number; y: number };
  /** 筛选条件（不透明载荷，调用方自己定义形状）。 */
  filter?: unknown;
  /** 布局模式。 */
  layoutMode?: string;
}

/** 视图态存储的最小接口（localStorage 与内存 Map 都实现它）。 */
export interface ViewStateStore {
  get(key: WorkspaceKey): WorkspaceViewState | null;
  set(key: WorkspaceKey, state: WorkspaceViewState): void;
}

/** 内存实现（localStorage 不可用时的降级路径）。 */
export function createMemoryViewStateStore(): ViewStateStore {
  const map = new Map<WorkspaceKey, WorkspaceViewState>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, state) => { map.set(key, state); },
  };
}

/**
 * localStorage 实现（**不可用时静默降级到内存**，不抛错）。
 *
 * 探测可写性放在构造期：配额满 / 隐私模式会在 `setItem` 时抛，
 * 与其在第一次保存时炸掉，不如建 store 时就知道「只能用内存」。
 */
export function createViewStateStore(storageKey = 'anic.viewState'): ViewStateStore {
  const memory = createMemoryViewStateStore();
  const storage = ((): Storage | null => {
    try {
      const g = globalThis as { localStorage?: Storage };
      const ls = g.localStorage;
      if (!ls) return null;
      const probe = `${storageKey}.probe`;
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    } catch {
      return null;
    }
  })();
  if (storage === null) return memory;
  return {
    get: (key) => {
      try {
        const raw = storage.getItem(`${storageKey}.${key}`);
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        return parsed as WorkspaceViewState;
      } catch {
        return null;
      }
    },
    set: (key, state) => {
      try {
        storage.setItem(`${storageKey}.${key}`, JSON.stringify(state));
      } catch {
        // 配额满 → 降级到内存（本会话内仍可用）。
        memory.set(key, state);
      }
    },
  };
}

/** 取某工作区的视图态（不存在 → null，**不返回空对象伪装成「默认值」**）。 */
export function loadViewState(store: ViewStateStore, workspace: string | null | undefined): WorkspaceViewState | null {
  return store.get(workspaceKeyOf(workspace));
}

/** 存某工作区的视图态。 */
export function saveViewState(
  store: ViewStateStore,
  workspace: string | null | undefined,
  state: WorkspaceViewState,
): void {
  store.set(workspaceKeyOf(workspace), state);
}
