/**
 * 折叠偏好（cycle-71 T-7131 用户要求核心：面板默认只展开**最近一次已完成调用**
 * 与**运行时调用可视化**，静态产物分区默认收纳）。
 *
 * 存储形态：复用 prefsDrawer 的 PREFS_KEY（`dsh-anic.prefs.v1`），在既有
 * `{version:1, flows:{…}}` 上**增 `folds` 段**——version 不升：parseRawPrefs
 * 只校验 version===1 与 flows 存在性，加键零回归（旧读者忽略 folds，
 * 新读者缺 folds 走默认空表）。
 *
 * 内存权威 + 读穿（工程裁决）：受控 `open` 的正确性依赖「写后读回同值」。
 * 若只依赖 localStorage，隐私模式/配额写失败会让下一轮渲染读回默认值 →
 * 受控 value 与用户操作反向 → 2s/4s tick 把用户刚折叠的分区**弹回展开**。
 * 故：写路径先更新内存（无条件），storage 仅在可用时尽力落盘；storage
 * 不可用或写失败后内存即成权威（本次会话内折叠记忆仍一致，诚实降级）。
 * 原文变化（其它写者如 prefsDrawer 写 flows）→ 重新解析，不吞外部写入。
 */
import { PREFS_KEY } from '../../../shared/flows.ts';

/** 内存态折叠记忆；null = 尚未加载。 */
let memory: Record<string, boolean> | null = null;
/** 上次读到的原文（外部写入检测）。 */
let seenRaw: string | null = null;
/** storage 可用性（读或写失败即 false → 内存权威，不再回读）。 */
let storageOk = true;

/** storage 句柄（无 DOM/沙盒 → null；不抛）。 */
function store(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    storageOk = false;
    return null;
  }
}

function readRaw(): string | null {
  const s = store();
  if (s === null) { storageOk = false; return null; }
  try {
    return s.getItem(PREFS_KEY);
  } catch {
    storageOk = false;
    return null;
  }
}

/** 原文 → 顶层对象（非对象/版本不符 → 空对象，与 parseRawPrefs fail-safe 同源）。 */
function shapeOf(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    return obj.version === 1 ? obj : {};
  } catch {
    return {};
  }
}

/** folds 段（非布尔值逐项丢弃——与 flows 段「非法值回默认」同纪律）。 */
function foldsOf(obj: Record<string, unknown>): Record<string, boolean> {
  const seg = obj.folds;
  if (!seg || typeof seg !== 'object' || Array.isArray(seg)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(seg as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** 当前折叠偏好表（读缓存；storage 不可用时为内存权威表）。 */
export function readFoldPrefs(): Record<string, boolean> {
  const raw = readRaw();
  const reload = memory === null || (storageOk && raw !== seenRaw);
  if (reload) {
    memory = foldsOf(shapeOf(raw));
    seenRaw = raw;
  }
  return memory ?? {};
}

/** 单分区折叠记忆；undefined = 无记忆（调用方回落 defaultOpen）。 */
export function foldPrefOf(id: string): boolean | undefined {
  return readFoldPrefs()[id];
}

/**
 * 记忆单分区折叠态。读-改-写合并 fs 全量（flows + 既有 folds 都保留）；
 * 内存先行（无条件），storage 落盘 best-effort（失败静默——隐私模式降级）。
 */
export function writeFoldPref(id: string, open: boolean): void {
  const raw = readRaw();
  const obj = shapeOf(raw);
  const folds = foldsOf(obj);
  folds[id] = open;
  const flows = obj.flows && typeof obj.flows === 'object' && !Array.isArray(obj.flows)
    ? (obj.flows as Record<string, unknown>)
    : {};
  const next = JSON.stringify({ version: 1, flows: { ...flows }, folds });
  memory = folds;
  seenRaw = next;
  const s = store();
  if (s === null) { storageOk = false; return; }
  try {
    s.setItem(PREFS_KEY, next);
  } catch { /* 写失败：内存态仍权威（下一次读回同值，不弹回） */ }
}
