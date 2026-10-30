/**
 * 快照投影窗口的**配置解析与合法性闸门**（cycle-83 · 产物治理）。
 *
 * ## 为什么窗口大小必须可配、且非法值必须回落（不能"尽量用"）
 *
 * 窗口是「主视图放最近几轮」的唯一旋钮。它若被一个坏值污染，后果不是报错而是
 * **静默改变读者看到的项目事实**：`snapshotWindow: 0` 会让主图里一轮都没有
 * （面板看起来像刚初始化），`snapshotWindow: 999` 等于没有窗口（回到 296 节点全摊）。
 * 两种形态都不会抛异常——这正是本仓反复踩的「坏配置被读成正常数据」。
 *
 * 所以判据是**闭区间闸门**：整数、≥1、≤MAX。任何越界（字符串 `'8'`、负数、超大值、
 * 小数、空）一律回默认值，并**如实产生一条 warning** 进快照的 `window.warnings`
 * ——静默回缺省会让"用户以为设了 64、实际在 8"永远不可见。
 *
 * 为什么有 MAX 而不只是"正数"：窗口上限保护的是**投影本身的承诺**。
 * 本模块存在的理由是"避免过度产物影响判断"，一个比全部历史还大的窗口会让
 * 承诺变成空话（且节点数会重新爆到几百）。MAX 是这条承诺的可断言上界。
 *
 * 纯函数、零 IO：配置文件的读取归 `host/config.ts`（INV-25 唯一入口），
 * 本模块只回答"这个原始值能不能用"。
 */

/** 缺省窗口（最近 8 轮）。选 8 的依据：一屏可读 + 覆盖"正在进行的这一周"。 */
export const DEFAULT_SNAPSHOT_WINDOW = 8;

/**
 * 窗口上限。
 *
 * 64 不是美学数字：它是「最近两个月左右的迭代轮次」量级，同时也是
 * `tests/contract/archiveResetContract.test.ts` 里"主图节点 ≤60"承诺的边界
 * （macro 22 + 64 轮 + 若干聚合节点仍在一屏可读范围附近）。超上限回缺省。
 */
export const MAX_SNAPSHOT_WINDOW = 64;

/** 解析结果：可用的窗口值 + 必须如实上报的告警（空数组 = 干净）。 */
export interface SnapshotWindowResolution {
  recent: number;
  warnings: string[];
}

/**
 * 原始配置值 → 窗口值。
 *
 * `raw` 允许 `string`（YAML 原始文本）与 `number`（已解析）两种形态：调用方可能是
 * 唯一配置 loader（给字符串），也可能是测试（直接给数字）。两者走**同一条判据**，
 * 否则"配置路径合法、注入路径非法"会分叉——那是双真相源。
 */
export function resolveSnapshotWindow(raw: unknown): SnapshotWindowResolution {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { recent: DEFAULT_SNAPSHOT_WINDOW, warnings: [] };
  }
  const text = typeof raw === 'number' ? String(raw) : String(raw).trim();
  // 严格十进制整数：`8abc` / `0x10` / `1.5` / `+8` 全部拒绝。
  // 为什么不用 Number.parseInt：它会把 `8abc` 读成 8（坏配置被"尽量理解"成合法值），
  // 也会把 `1.5` 读成 1——两种都是静默改变语义。
  if (!/^-?\d+$/.test(text)) {
    return {
      recent: DEFAULT_SNAPSHOT_WINDOW,
      warnings: [`snapshotWindow '${text}' is not an integer — falling back to ${String(DEFAULT_SNAPSHOT_WINDOW)}`],
    };
  }
  const n = Number(text);
  if (n < 1) {
    return {
      recent: DEFAULT_SNAPSHOT_WINDOW,
      warnings: [`snapshotWindow ${String(n)} < 1 (empty window) — falling back to ${String(DEFAULT_SNAPSHOT_WINDOW)}`],
    };
  }
  if (n > MAX_SNAPSHOT_WINDOW) {
    return {
      recent: DEFAULT_SNAPSHOT_WINDOW,
      warnings: [`snapshotWindow ${String(n)} > ${String(MAX_SNAPSHOT_WINDOW)} — falling back to ${String(DEFAULT_SNAPSHOT_WINDOW)}`],
    };
  }
  return { recent: n, warnings: [] };
}
