/**
 * 工具出口的**无损 JSON** 防线（cycle-82 · 可观测性收口）。
 *
 * ## 为什么需要这一层（真机实测的失败，不是假想）
 *
 * 真实宿主里调用 `anic_status` 直接失败：
 * `Error: tool "anic_status" returned invalid output: value is not lossless JSON`。
 * 根因不是某个字段写错，而是**一整类**结构性隐患：
 *   - `analyzeSkillHealth()` 的 `ScriptHealth.recentSuccessRate?: number` 在「近 7 天
 *     无调用」时是 `undefined`（该字段语义上就是"不可判定"，见 continuousLearning 注释）；
 *   - `FlowRecord` 的 endedAt/exitCode/stdout/stderr/durationMs 全可选（RUNNING 态没有它们）；
 *   - `SkillHealthReport.suggestions` 内的可选字段同理。
 * 这些值被原样塞进工具 canonical value，宿主用 `visitJsonValue` 递归校验，
 * 遇到 `undefined` 直接判非法 —— 整个工具的返回值被丢弃（isError）。
 *
 * ## 为什么是「统一出口」而不是「逐字段修」
 *
 * 逐个字段补 `?? null` 只能修今天已知的三处；下一个人加一个可选字段又漏一次，
 * 而且**漏了不会红**（宿主侧只在真机报错，vitest 里 JSON.stringify 会把 undefined
 * 悄悄吞掉 —— 那正是本仓反复踩的「静态全绿、运行时全灭」形态）。
 * 统一出口 + 契约测试（tests/contract/toolOutputLosslessContract.test.ts）才有保修期：
 * 新工具/新字段一律经过同一道闸门，闸门的语义在此文件里**写死并被单测钉住**。
 *
 * ## 语义裁决（逐条都是刻意的，不是实现细节）
 *
 * | 输入 | 输出 | 理由 |
 * |---|---|---|
 * | 对象里值为 `undefined` 的键 | **删除该键** | 「没有这个字段」与「字段值为 null」是两种语义。
 *   改成 null 会让消费方把"不可判定"读成"判定为空值"（如 recentSuccessRate=null
 *   会被读成成功率 0 —— 那是一个**错误结论**）。删除后消费方看到的正是 TS 里的可选字段形状。 |
 * | 数组里的 `undefined` | `null` | 数组不可以塌缩（塌缩会让下标对齐错位，消费方按 index 取值全错）。 |
 * | 根值 `undefined` | `null` | 工具契约要求 object-rooted 值；`JSON.stringify(undefined)` 连字符串都不返回。 |
 * | `NaN` / `±Infinity` | `null` | JSON 没有这三个字面量；`JSON.stringify` 会静默写成 `null`，
 *   与其让宿主侧不透明地发生，不如在这里显式裁决（可被单测钉住）。 |
 * | `Date` | ISO 字符串 | `Date` 不是 JSON 值；宿主校验会判非法。ISO 保精度且可回合。 |
 * | `BigInt` | 十进制字符串 | `JSON.stringify(1n)` 直接抛 TypeError（比丢值更糟：整个调用失败）。 |
 * | 循环引用 | **抛错** | 在工具出口，环引用是编程错误，必须响亮（静默剪枝会让模型看到
 *   一份"少了半棵树"的值却以为完整 —— 比报错危险得多）。 |
 * | 深度 / 节点数超限 | **抛错** | 防 DoS：异常大对象会把宿主校验栈打爆。上限是**断言**，
 *   不是静默截断（截断 = 无声的数据丢失）。 |
 * | 函数 / Symbol | 对象里删除、数组里 `null` | 与 `JSON.stringify` 的既有行为对齐（它也是丢弃），
 *   只是不静默：本层让它变成**确定**的形状而不是引擎细节。 |
 *
 * ## 零成本可观测（硬要求）
 *
 * 正常输出**必须原样返回**（同一引用），不得被重建 —— 否则每个工具返回值都会被深拷贝一次，
 * 既有 `toBe`/语义对象身份断言与性能都要付代价。故入口先 `isLosslessJson` 判定，
 * 合法即 `return value`（快路径）。健康路径零分配。
 *
 * 纯函数、零依赖、零 IO：本模块不 import 任何仓库内模块（工具出口的最底层）。
 */

/** 取值上限：默认值经实测（本仓最大工具输出 ~120 KB / 深度 < 12），留足 5× 余量。 */
export interface SanitizeLimits {
  /** 最大嵌套深度（根为 0）。 */
  maxDepth: number;
  /** 最大节点数（叶子 + 容器，逐个计数）。 */
  maxNodes: number;
}

/** 默认上限（导出以便测试与调用方覆盖，不散落魔数）。 */
export const DEFAULT_SANITIZE_LIMITS: Readonly<SanitizeLimits> = { maxDepth: 64, maxNodes: 200_000 };

/** 判定上下文（递归期间的共享状态；避免每次递归重建）。 */
interface WalkCtx {
  limits: SanitizeLimits;
  seen: Set<object>;
  nodes: number;
}

function isPlainProto(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * 严格判定「这个值能否无损通过 JSON 回合」。
 *
 * 与 `JSON.stringify` 的差别（刻意的）：stringify 会**静默**把 undefined/函数/Symbol
 * 丢掉、把 NaN 写成 null，然后你拿到"看起来成功"的字符串 —— 正是本仓几次事故的形态。
 * 本判定要求**双向无损**：值 → JSON 文本 → 值，逐层同形。
 *
 * 遇环、超限、Date/BigInt/Map/Set 一律 false（它们都需要显式裁决，不能算"已无损"）。
 */
export function isLosslessJson(value: unknown, limits: SanitizeLimits = DEFAULT_SANITIZE_LIMITS): boolean {
  const ctx: WalkCtx = { limits, seen: new Set<object>(), nodes: 0 };
  const walk = (v: unknown, depth: number): boolean => {
    ctx.nodes += 1;
    if (ctx.nodes > ctx.limits.maxNodes) return false;
    if (depth > ctx.limits.maxDepth) return false;
    if (v === null) return true;
    const t = typeof v;
    if (t === 'boolean' || t === 'string') return true;
    // -0 视作无损：JSON 往返会退化成 0，而 `-0 === 0` 为真、消费方不会观察到差异。
    if (t === 'number') return Number.isFinite(v as number);
    if (t !== 'object') return false; // undefined / function / symbol / bigint
    const obj = v as object;
    if (ctx.seen.has(obj)) return false; // 环：不是无损 JSON
    // 数组单独放行：它的原型是 Array.prototype（不是 Object.prototype），
    // 但数组**是**合法 JSON 值 —— 把它判非法会让快路径对所有列表输出失效
    // （实测后果：每个带数组的工具返回值都被重建，且 legal 值被误判成需要修复）。
    const isArray = Array.isArray(obj);
    if (!isArray && !isPlainProto(obj)) return false; // Date / Map / Set / 类实例：需显式裁决
    ctx.seen.add(obj);
    const ok = isArray
      // 数组必须显式判定每个下标：空洞（splice 留下的 empty）也不是无损 JSON。
      ? obj.length === Object.keys(obj).length
        && obj.every((item) => walk(item, depth + 1))
      : Object.keys(obj).every((k) => walk((obj as Record<string, unknown>)[k], depth + 1));
    ctx.seen.delete(obj);
    return ok;
  };
  return walk(value, 0);
}

/** 深度/节点数守卫（sanitize 专用：超限抛错而不是静默截断）。 */
function bump(ctx: WalkCtx, depth: number): void {
  ctx.nodes += 1;
  if (ctx.nodes > ctx.limits.maxNodes) {
    throw new Error('sanitizeForWire: node budget exceeded (' + String(ctx.limits.maxNodes) + ')');
  }
  if (depth > ctx.limits.maxDepth) {
    throw new Error('sanitizeForWire: depth budget exceeded (' + String(ctx.limits.maxDepth) + ')');
  }
}

/**
 * 把任意值收敛成**无损 JSON**（语义表见文件头注）。
 *
 * @returns 原值（若本就无损，同一引用）；否则返回新的安全形状。
 * @throws 循环引用、深度/节点数超限（工具出口的编程错误，必须响亮）。
 */
export function sanitizeForWire(value: unknown, limits: SanitizeLimits = DEFAULT_SANITIZE_LIMITS): unknown {
  // ★快路径（零成本可观测）：合法就原样返回，不重建、不深拷贝。
  // 这一步同时吃掉了 limits 判定 —— 超限的值会落到下面的 walk 里抛错（响亮）。
  if (isLosslessJson(value, limits)) return value;
  const ctx: WalkCtx = { limits, seen: new Set<object>(), nodes: 0 };
  return walk(value, 0, ctx);
}

function walk(v: unknown, depth: number, ctx: WalkCtx): unknown {
  bump(ctx, depth);
  if (v === null) return null;
  const t = typeof v;
  if (t === 'boolean' || t === 'string') return v;
  if (t === 'number') return Number.isFinite(v as number) ? v : null;
  if (t === 'bigint') return (v as bigint).toString();
  // 根值与数组槽位的 undefined/函数/Symbol 一律 null（数组不允许塌缩，见头注）。
  if (t === 'undefined' || t === 'function' || t === 'symbol') return null;
  const obj = v as object;
  if (ctx.seen.has(obj)) {
    // 环引用：在工具出口这是编程错误。静默剪枝会让模型看到"少一棵子树"的假完整值。
    throw new Error('sanitizeForWire: circular reference detected (tool output must be a tree)');
  }
  if (obj instanceof Date) {
    // 非法 Date 的 toISOString() 会抛 RangeError（错误信息极难读），显式裁决为 null。
    const ms = obj.getTime();
    return Number.isFinite(ms) ? obj.toISOString() : null;
  }
  ctx.seen.add(obj);
  let out: unknown;
  if (Array.isArray(obj)) {
    // 按下标逐个走（不用 map）：map 会**保留空洞**，输出仍是稀疏数组 ——
    // 而稀疏数组不是无损 JSON（stringify 会把空洞写成 null，下标语义被改写）。
    // 逐下标取值把空洞显式收敛成 null，形状确定且可被单测钉住。
    const arr: unknown[] = [];
    for (let i = 0; i < obj.length; i += 1) arr.push(walk((obj as unknown[])[i], depth + 1, ctx));
    out = arr;
  } else if (isPlainProto(obj)) {
    const dst: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      const val = (obj as Record<string, unknown>)[k];
      // ★关键裁决：值为 undefined 的键**删除**（不是变 null）。语义 = "没有这个字段"。
      if (val === undefined) continue;
      // 函数/Symbol 值：与 JSON.stringify 一致地丢弃（保留键会得到一串 null，更误导）。
      const vt = typeof val;
      if (vt === 'function' || vt === 'symbol') continue;
      dst[k] = walk(val, depth + 1, ctx);
    }
    out = dst;
  } else {
    // Map/Set/类实例：按**自有可枚举字符串键**展开（JSON.stringify 同款投影），
    // 但先经过本层裁决 —— 这样 Date 之外的自定义对象不会被静默写成 "{}"。
    const dst: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      const val = (obj as Record<string, unknown>)[k];
      if (val === undefined) continue;
      const vt = typeof val;
      if (vt === 'function' || vt === 'symbol') continue;
      dst[k] = walk(val, depth + 1, ctx);
    }
    out = dst;
  }
  ctx.seen.delete(obj);
  return out;
}
