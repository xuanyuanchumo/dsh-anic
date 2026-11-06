/**
 * 披露裁决（cycle-109）—— 把「我们施加了什么」升级为「宿主真的少给了什么」。
 *
 * ## 为什么必须新增这一层（修 O-109-01）
 *
 * `disclosureReadout.ts` 的文件头自己写着诚实边界：
 * > 本模块**不证明**宿主的 `restrict` 真的按 deny 生效。
 *
 * 于是 indexed 披露的「成功」长期是**信任态**：`wired:true` 只说明 `restrict()`
 * 没抛，不说明宿主的可见集真的变小了。A0′ 探针（`.cycles/tech-debt/
 * cycle-73-a0-probe-result.md`）是**人工一次性**的，代码里 `schemas(`/`get(` 调用数为 0
 * （cycle-107 研究输入 L §7 实测）。⇒ 本模块把一次性探针变成**每次接线都采一次**的读数。
 *
 * ## 判据只读**官方文档化** API
 *
 * `ctx.tools.schemas(scope?: ScopeKey): ToolSchema[]`（KB `subsystems/tools.md:568-574`）：
 * 「Project visible definitions onto the allowlisted model-facing schema fields」、
 * 「the viewing scope (the agent); omitted = the global view」、
 * 「one deep-cloned schema per visible tool」。
 *
 * 同页 `:512` 给出**最强的一句**：「one visibility resolver feeds presentation,
 * lookup, and dispatch」——即 `get`/`schemas`/分发共用同一个可见性解析器。
 * A0′ 已在真机证明 `get(name, agent)` 对被 deny 的全局工具返回 absent
 * （`deny` 后 scoped 视图 25→24、`getScopedAfter: "absent"`）⇒
 * **同一个解析器驱动的 `schemas(agent)` 必然也排除 deny 项**。这是 A0″ 的白盒结论，
 * 不需要再跑一次黑盒探针（研究输入 L §7 要求的「A0″」由此闭合）。
 *
 * ## 三态为什么是这三种（而不是布尔）
 *
 * - `verified`：应可见集与实测可见集**完全相等**；
 * - `partial`：有一侧偏差。拆成 `leaked`（该遮蔽却仍在 ⇒ 越权暴露，最危险）与
 *   `missing`（该可见却不见了 ⇒ 遮蔽过头，可能把加载器也遮了 = 自锁）；
 * - `unverified`：**采不到**（宿主无 schemas / 无 scope / 抛错）——
 *   **绝不**把采不到判成通过，也绝不判成失败。
 *
 * 为什么 `missing` 也要单独给：`leaked` 与 `missing` 的补救动作**相反**
 * （前者要收紧、后者要放宽）。合并成一个 "partial" 会让读者不知道该往哪边改 ——
 * 与 `graphExtras.ts` 里 `unreachable`/`tooLong` 必须分开说是同一条纪律。
 *
 * ## 纯函数（零宿主依赖、零 IO）
 *
 * 裁决与采集**分离**：采集在 `toolDisclosureWiring.ts`（需要宿主），判决在这里
 * （可离线穷举测试）。这样「宿主说谎」「采集失败」「集合完全相等」三种形态
 * 都能用数据断言，不必真挂宿主。
 */

/** 披露裁决三态。 */
export type DisclosureVerdict = 'verified' | 'partial' | 'unverified';

/** 一次裁决的完整结果（数字与集合都给——读者既要知道结论也要知道差多少）。 */
export interface DisclosureVerdictResult {
  verdict: DisclosureVerdict;
  /** 应可见（= 全部工具 − deny），按输入序。 */
  expectedVisible: string[];
  /** 实测可见（null = 采不到）。 */
  observedVisible: string[] | null;
  /** 该遮蔽却仍在（deny ∩ observed）——最危险的一类。 */
  leaked: string[];
  /** 该可见却不见了（expected − observed）——遮蔽过头，可能自锁。 */
  missing: string[];
}

/**
 * 计算「应可见集」：全部工具里去掉 deny。
 *
 * 单独导出而不是内联：接线层与解锁路径都要它，两处各写一份必然分叉
 * （与 `artifactArchive.ts` 的「完成判定与 G1 共用同一解析器」同一条理由）。
 */
export function expectedVisibleIds(
  allToolIds: readonly string[],
  deny: readonly string[],
): string[] {
  const denied = new Set(deny);
  return allToolIds.filter((id) => !denied.has(id));
}

/**
 * 裁决一次披露是否真的在宿主侧生效。
 *
 * @param expectedVisible 应可见（`expectedVisibleIds` 的产物）
 * @param observedVisible 宿主 `schemas(scope)` 实测的可见名；`null` = 采不到
 * @param deny            本次施加的 deny 集合（用于算 leaked）
 */
export function classifyDisclosureVerdict(
  expectedVisible: readonly string[],
  observedVisible: readonly string[] | null,
  deny: readonly string[],
): DisclosureVerdictResult {
  const expected = [...expectedVisible];
  if (observedVisible === null) {
    // 采不到 ≠ 失败：宿主无 schemas / 无 scope / 抛错都落到这里。
    // 绝不因「取证失败」把 wired 语义改掉（取证是旁路，不是前置条件）。
    return { verdict: 'unverified', expectedVisible: expected, observedVisible: null, leaked: [], missing: [] };
  }
  const observedSet = new Set(observedVisible);
  const deniedSet = new Set(deny);
  // leaked：deny 里但宿主仍可见（用 observed 序，结果稳定可断言）。
  const leaked = observedVisible.filter((name) => deniedSet.has(name));
  // missing：应可见但宿主没给。
  const missing = expected.filter((name) => !observedSet.has(name));
  // 反向多给的（既不在 expected 也不在 deny）不计入 —— 那是别的插件/宿主自带的工具，
  // 本插件无权判定（多报会让裁决在他人的工具上恒 partial）。
  const verdict: DisclosureVerdict = leaked.length === 0 && missing.length === 0 ? 'verified' : 'partial';
  return { verdict, expectedVisible: expected, observedVisible: [...observedVisible], leaked, missing };
}

/**
 * **重算 deny**：从「全部工具」里移除加载器与已解锁项（cycle-109 从
 * `disclosureActivation.ts` 并入——它与 `expectedVisibleIds` 是同一个集合算术族，
 * 两处各写一份会分叉）。
 *
 * 纯函数（可单测）：顺序稳定（保持 allToolIds 原序）⇒ 同输入同输出。
 */
export function recomputeDeny(
  allToolIds: readonly string[],
  loaderIds: readonly string[],
  unlocked: ReadonlySet<string>,
): string[] {
  const keep = new Set(loaderIds);
  const out: string[] = [];
  for (const id of allToolIds) {
    if (keep.has(id)) continue;
    if (unlocked.has(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * 三态的一句话摘要（只给结论与可见数）—— 日志与读数共用同一句措辞。
 *
 * 为什么要单独一个「轻量版」：`WiringOutcome` 只带 verdict + visible 两个字段，
 * 而 `summarizeVerdict` 需要完整结果对象。为一行日志去伪造 `leaked/missing`
 * 会制造假数据（哪怕只是空数组），故按需给出两个入口，各取所需。
 */
export function describeHostVerdict(verdict: DisclosureVerdict, visible: number | null): string {
  switch (verdict) {
    case 'verified': return `host-side verified (${String(visible ?? 0)} visible)`;
    case 'partial': return `host-side partial (${String(visible ?? 0)} visible — see leaked/missing in readout)`;
    case 'unverified': return 'host-side unverified (scoped schemas() unavailable)';
  }
}

/**
 * 裁决的一行人类可读摘要（进日志 / org-status / 面板）。
 *
 * 为什么三态各自一句话都要有措辞：`verified` 是**正面结论**，必须显式说出来 ——
 * 沉默会让读者把「没报错」当成「没检查」（与 `orgStatus` 的漂移 ✓ 行同一条纪律）。
 */
export function summarizeVerdict(r: DisclosureVerdictResult): string {
  switch (r.verdict) {
    case 'verified':
      return `host-side verified: ${String(r.observedVisible?.length ?? 0)} visible == expected`;
    case 'partial':
      return `host-side partial: leaked=${String(r.leaked.length)}${r.leaked.length > 0 ? ` [${r.leaked.join(', ')}]` : ''}`
        + `, missing=${String(r.missing.length)}${r.missing.length > 0 ? ` [${r.missing.join(', ')}]` : ''}`;
    case 'unverified':
      return 'host-side unverified: scope-scoped schemas() unavailable (capture is a side channel, never a precondition)';
  }
}