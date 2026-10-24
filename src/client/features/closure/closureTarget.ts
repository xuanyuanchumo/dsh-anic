/**
 * 闭环体检 target 工厂（cycle-72 T-7207；cycle-75 T3 收口形状守卫来源）。
 *
 * 为什么**单列**而不是并进 panelLiveTargets：那一组是「挂载 + 手动刷新」的轻量快照
 * （snapshot/step-trace/self-check，毫秒级）；闭环体检要**全仓扫描**（实测 ~7s），
 * 混进去会让面板首屏被它拖住。故单独一个 pollMs=0 档，与其余一次性档同用
 * usePanelFetch 的防抖/降级/学头机制。
 *
 * 失败语义（与 cycle-71 T-7117 同纪律）：onFail 记端点级失败键 'closure'，分区侧
 * 经 sectionFailure 聚合——此类观测面「失败静默」的形态不允许复发。
 *
 * **守卫来源（cycle-75 契约 §2）**：`guard` 必须取自 closureTypes.ts 的逐字段
 * fail-closed 守卫，**不是** renderClosure 里的旧粗判。理由：半截响应（缺
 * producedKind / truncation / 三分类计数）在旧判据下会**混进渲染面**，把一个
 * 不完整的投影当成「零缺口」呈现——正是「有壳无表体」的近亲。fail-closed 后
 * 这类响应走 onFail → 分区渲染可见失败行，且旧数据不被污染。
 *
 * 类型与形状同源：`ClosureView` 也只从 closureTypes 取（renderClosure 再导出同类型
 * 以满足既有消费者 import 路径零变更）。host/client 隔离：本文件只 import client 域
 * 与共享机制，绝无 host 侧引用（G-IND / tsconfig 分离编译）。
 */
import type { PanelFetchTarget } from '../../components/usePanelFetch.ts';
import type { PanelActions } from '../../components/panelActions.ts';

/** 面板动作层（本域只消费三个 setter；入参用完整动作层，调用点零解构）。 */
import { isClosureView, type ClosureView } from './closureTypes.ts';

export const CLOSURE_AUDIT_URL = '/anic/api/closure-audit';

/** 闭环体检写侧依赖（动作层子集——结构性兼容）。 */
export type ClosureSetters = Pick<PanelActions, 'setClosure' | 'markFetchFailure' | 'clearFetchFailure'>;

/** 闭环体检单 target（pollMs=0 由调用方决定；失败不静默）。 */
export function closureTarget(s: ClosureSetters): PanelFetchTarget[] {
  return [
    {
      url: CLOSURE_AUDIT_URL,
      guard: isClosureView,
      apply: (v) => { s.setClosure(v as ClosureView); },
      onFail: (f) => { s.markFetchFailure('closure', f); },
      onRecover: () => { s.clearFetchFailure('closure'); },
    },
  ];
}
