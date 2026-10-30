/**
 * **多项目隔离**（cycle-89 · 从 flowJoin.ts 拆出，守 T3 ≤250 行）。
 *
 * ## 为什么隔离是独立一层（不是 join 逻辑的一小段）
 *
 * 「流程归属」与「流程属于哪个项目」是**两个正交的问题**：
 *   - 归属（cycle/phase/gate）：这条流程跑在哪个循环的哪个相位 —— 判据是
 *     `attribution.source`，错了会把孤儿刷绿；
 *   - 隔离（workspace）：这条流程属于哪个项目 —— 判据是**路径归一后的相等**，
 *     错了会把**别的项目的流程**倒给用户看。
 *
 * 后者的失败后果更重（跨项目泄露 + 指标张冠李戴），但它的判据与归属判据
 * 毫无关系。混在一个文件里会让两个失败模式共享一个改动人 —— 加归属规则时
 * 手滑改了隔离归一，或反之。拆开即隔离。
 *
 * ## fail-closed 纪律
 *
 * 空 workspace → 返回**空数组**（不是「全部」）：拿不到工作区时把所有项目的
 * 流倒给调用方，正是「串味」事故本身；空集至少是诚实的「不知道」。
 *
 * ## 边界
 *
 * 零 IO、零 clock、零 random：纯函数，可独立单测。
 */
import type { FlowRecord } from '../runtime/flowTracker.ts';

/** 工作区归一：反斜杠→斜杠、去尾斜杠、Windows 下大小写不敏感。 */
export function normalizeWorkspace(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  // 仅对含盘符的 Windows 路径做小写化；POSIX 路径大小写有意义，保持原样。
  return /^[a-zA-Z]:\//.test(unified) ? unified.toLowerCase() : unified;
}

/** 两个工作区是否同一个（归一后比较；空串永不相等）。 */
export function sameWorkspace(a: string, b: string): boolean {
  if (!a || b === '') return false;
  return normalizeWorkspace(a) === normalizeWorkspace(b);
}

/**
 * 按请求工作区过滤记录（多项目隔离的机械守卫）。
 *
 * 空 workspace → 返回空数组（fail-closed）：拿不到工作区时把**全部**项目的流
 * 倒给调用方，正是「串味」事故本身；空集至少是诚实的「不知道」。
 * 同时兼容 `encodeURIComponent` 过的查询参数（面板可能整体编码后透传）。
 */
export function filterByWorkspace(records: readonly FlowRecord[], workspace: string | null | undefined): FlowRecord[] {
  if (!workspace) return [];
  const target = normalizeWorkspace(decodeSafe(workspace));
  if (!target) return [];
  return records.filter((r) => typeof r.workspace === 'string' && normalizeWorkspace(decodeSafe(r.workspace)) === target);
}

/** 解码失败（非法 % 序列）时原样返回——绝不能因为一个坏参数把请求打成 500。 */
function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
