/**
 * 闭环体检第五族（.cycles 文档生命周期）的**客户端投影**
 * （cycle-82：artifactsClosure.ts 拆分之一，守 T3 ≤250 行）。
 *
 * 从 artifactsClosure.ts 下移——该文件承载「扫描 + 投影」双职责，加入逐循环矩阵
 * 后越界。本文件只做**服务端汇总 → 客户端视图**的降维：不扫盘、不含判据。
 *
 * 消费者 import 路径零变更：artifactsClosure.ts 再导出本文件的全部公开名。
 *
 * 安全纪律（与 closureView.ts 同源）：去 rootDir —— 本地绝对路径不出服务端。
 */
import type { ArtifactScope, ArtifactsReport } from './artifactsSpecs.ts';

/**
 * 真实循环数上限（投影体积控制）。
 *
 * 为什么必须有：本仓 `.cycles/cycles/` 已有 79 个循环 × 11 个 cycle 级模板 =
 * 869 个矩阵格。全量上报会让响应体翻倍，而客户端只渲染"最近若干轮"。
 * 与 closureView 的 UNCONSUMED_VIEW_LIMIT 同一纪律：**明细受限，计数完整**。
 */
export const ARTIFACTS_VIEW_CYCLES = 24;

/**
 * 投影用的窄视图。
 *
 * 矩阵用紧凑编码 `cycle-81:1` 而不是对象数组：客户端只做"这一格打勾没有"的渲染，
 * 对象数组（`{cycle, present, evidence}`）会把同样信息膨胀数倍。
 */
export interface ArtifactsView {
  cyclesScanned: string[];
  totals: ArtifactsReport['totals'];
  items: Array<{
    id: string;
    label: string;
    gate: string;
    scope: ArtifactScope;
    registered: boolean;
    consumed: boolean;
    /** cycle 级：覆盖率；project 级：不存在时 0，存在时 1；ondemand：null（见 occurrences）。 */
    coverage: number | null;
    /** 按需类累计发生次数（0 = 从未触发，**不是**缺失）；其他作用域为 null。 */
    occurrences: number | null;
    /** 项目级模板：仓库根是否存在；其他作用域为 null。 */
    projectPresent: boolean | null;
    /** 逐循环存在位（`cycle-81:1` / `cycle-80:0`），仅含窗口内的循环。 */
    matrix: string[];
    /** 缺失点名（窗口内）；窗口外的是历史，不逐条推到面板待办里。 */
    missing: string[];
  }>;
}

/** 服务端汇总 → 客户端投影（纯函数，确定性：同输入同输出）。 */
export function toArtifactsView(rep: ArtifactsReport): ArtifactsView {
  const recent = rep.cyclesScanned.slice(-ARTIFACTS_VIEW_CYCLES);
  const keep = new Set(recent);
  return {
    cyclesScanned: recent,
    totals: { ...rep.totals },
    items: rep.items.map((it) => ({
      id: it.id,
      label: it.label,
      gate: it.gate,
      scope: it.scope,
      registered: it.registered,
      consumed: it.consumed,
      // 项目级的 coverage 在扫描侧是 null（没有循环可摊），投影成 0/1 更便于客户端排序，
      // 但保留 projectPresent 原值以免把"不适用"与"缺失"混成一个读数。
      coverage: it.projectPresent === null ? it.coverage : (it.projectPresent ? 1 : 0),
      occurrences: it.occurrences,
      projectPresent: it.projectPresent,
      matrix: it.cycles
        .filter((c) => keep.has(c.cycle))
        .map((c) => c.cycle + ':' + (c.present ? '1' : '0')),
      missing: it.missing.filter((m) => !/^cycle-\d+\//.test(m) || keep.has(m.split('/')[0] as string)),
    })),
  };
}
