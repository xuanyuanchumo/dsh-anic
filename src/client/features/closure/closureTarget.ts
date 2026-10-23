/**
 * 闭环体检 target 工厂（cycle-72 T-7207）。
 *
 * 为什么**单列**而不是并进 panelLiveTargets：那一组是「挂载 + 手动刷新」的轻量快照
 * （snapshot/step-trace/self-check，毫秒级）；闭环体检要**全仓扫描**（实测 ~7s），
 * 混进去会让面板首屏被它拖住。故单独一个 pollMs=0 档，与其余一次性档同用
 * usePanelFetch 的防抖/降级/学头机制。
 *
 * 失败语义（与 cycle-71 T-7117 同纪律）：onFail 记端点级失败键 'closure'，分区侧
 * 经 sectionFailure 聚合——此前这类观测面「失败静默」的形态不允许复发。
 */
import type { PanelFetchTarget } from '../../components/usePanelFetch.ts';
import type { PanelActions } from '../../components/panelActions.ts';

/** 面板动作层（本域只消费三个 setter；入参用完整动作层，调用点零解构）。 */
import { isClosureView, type ClosureView } from './renderClosure.ts';

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
