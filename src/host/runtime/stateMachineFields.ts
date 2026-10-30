/**
 * 工作流图的**节点声明字段**解析（cycle-91）—— `next:` / `on_pass` / `on_fail`。
 *
 * ## 为什么单独成文件
 *
 * `stateMachine.ts` 已有 237 行（T3 上限 250）。本轮要加三个字段的解析
 * + 一套「前驱依赖」判定，塞进去必然破线。
 *
 * 但更重要的理由是**职责**：本文件回答「YAML 里的节点声明字段怎么变成
 * 数据结构」，`stateMachine.ts` 回答「状态怎么推进」。混在一起时，
 * 「`next:` 是顺序还是依赖」这个语义决策会被埋在解析代码里没人看得见。
 *
 * ## ⚠️ cycle-91 实测缺陷：`next:` 完全未被解析（最严重的一个）
 *
 * **实测**（`.cycles/workflow-graph.yaml` 实证）：
 * - YAML 里 **13 处** `next:` 声明了宏观主线（plan→design→build→test→
 *   deploy→maintain→plan）与微观主线（micro-eval→…→micro-retro→micro-eval）；
 * - YAML 里 **10 处** `on_pass:` / `on_fail:` 声明了门禁的条件后继；
 * - 而 `stateMachine.ts` 的 `parseWorkflowGraph` **只认** `id:` / `type:` /
 *   `gate:` / `triggers:` —— **没有 `next:` 分支**（`grep -n "next"` 只命中
 *   注释里的 `nextOffset`）。
 *
 * ⇒ 运行时图里**根本没有宏观主线**，取而代之的只有 `edges:` 段的 15 条边。
 *
 * **实测后果**（数据流实算，22 节点 / 15 边）：
 * - **9 个节点入度 = 0**：`plan`、`design`、`build`、`deploy`、`maintain`、
 *   `micro-plan`、`micro-verify`、`micro-gate`、`micro-retro`；
 * - `gate-g0` 的唯一前驱是 `micro-retro`（入度 0 ⇒ 永不 `done`）
 *   ⇒ `advance('gate-g0')` **恒返回** `{ok:false, reason:'predecessor
 *   micro-retro not done'}` ⇒ **整条 gate-chain（g0→g1→g2→g3）锁死** ⇒
 *   `gate-g3 → test` 这条唯一的出测试边永不触发；
 * - 五个宏观相位节点入度全为 0 ⇒ `POST /anic/cycle/advance` 推进宏观相位
 *   在节点机层面**结构性不可达**。
 *
 * **为什么既有契约测试全绿**：`tests/contract/stateMachineGraphShape.test.ts`
 * 只断言「解析出 N 个节点 / 边是流式形态 / type 小写」——**从不断言
 * 「节点可达」**。⇒ 这是一个**既有契约的覆盖盲区**，不是测试失效。
 *
 * ## 三个字段的语义（**关键区分**）
 *
 * | 字段 | 语义 | 是「依赖边」吗？ | 作用 |
 * |---|---|---|---|
 * | `next:` | **顺序声明**：这个节点之后自然接哪个 | ❌ **不是** | 图谱渲染的顺序线索；可达性分析 |
 * | `on_pass:` | **条件后继**：门禁**通过**后走哪条 | ✅ 是（但**仅在通过时**） | 门禁链推进 |
 * | `on_fail:` | **条件后继**：门禁**失败**后走哪条（熔断回退） | ✅ 是（但**仅在失败时**） | 熔断路径 |
 *
 * ### 为什么 `next:` **不能**直接当依赖边
 *
 * 1. **它成环**：`maintain → plan`（注释明写「回到 Plan，形成宏观循环」）
 *    与 `micro-retro → micro-eval`（「回到评估，形成微观循环」）。
 *    若当依赖边 ⇒ 图里有环 ⇒ 「所有前驱都 done」在环上**永远无法满足**
 *    ⇒ 宏观循环**一次都推不动**。
 * 2. **它不是前置条件**：`plan` 之后是 `design`，但 `design` 并不**要求**
 *    `plan` 先完成才能开始（人工门禁才是那个要求）。
 *
 * ⇒ `next:` 解析为**节点字段** `next`，供图谱与可达性分析使用；
 *   **前驱依赖判定**改用 `on_pass` / `on_fail` + `edges:`。
 */

/** 节点声明里的顺序后继（`next:`）。 */
export interface NodeNextField {
  /** `next:` 声明的后继节点 id（可能指向不存在的节点 ⇒ 读侧须校验）。 */
  next?: string;
}

/** 门禁节点的条件后继（`on_pass:` / `on_fail:`）。 */
export interface NodeConditionalSuccessors {
  /** 通过后继（`on_pass:`）。 */
  onPass?: string;
  /** 失败后继（`on_fail:`）。 */
  onFail?: string;
}

/** 解析结果的一条节点声明（未进入图，只被解析器使用）。 */
export interface DeclaredNode extends NodeNextField, NodeConditionalSuccessors {
  id: string;
}

/**
 * 从一行 YAML 里抽取节点声明字段。
 *
 * @param line  一行原文（已去除行尾空白）
 * @returns 命中的字段；未命中任何字段时返回 null
 *
 * ## 为什么用「白名单正则」而不是通用 YAML 解析
 *
 * 本仓的 `stateMachine.ts` 是**零依赖**的行级解析器（`parseWorkflowGraph`
 * 逐行正则）。引入 YAML 库会破坏「零外部依赖」纪律（CLAUDE.md）并让
 * 宿主/客户端两套编译配置都要带依赖。
 *
 * 白名单的好处是**明确知道认什么、不认什么**：`label:` / `description:` /
 * `artifacts:` / `check_script:` 这些**展示性字段**本轮不解析（它们不影响
 * 状态推进），将来要支持时在这里显式加一条 —— 而不是"碰巧被通用解析器
 * 吃进去了"。
 *
 * ## 注释处理
 *
 * `next: plan  # 回到 Plan，形成宏观循环` —— 行尾注释必须剥掉。
 * YAML 的 `#` 只有在**值之外**才真是注释，但本仓的用法都是行尾注释，
 * 且节点 id 里不含 `#` ⇒ 按第一个 `#` 截断是安全的。
 */
export function parseNodeDeclarationFields(line: string): DeclaredNode | null {
  const withoutComment = line.split('#')[0] ?? '';
  const trimmed = withoutComment.trim();
  if (trimmed === '') return null;

  const nextMatch = trimmed.match(/^next:\s*(\S+)/);
  if (nextMatch?.[1]) return { id: '', next: nextMatch[1] };

  const onPassMatch = trimmed.match(/^on_pass:\s*(\S+)/);
  if (onPassMatch?.[1]) return { id: '', onPass: onPassMatch[1] };

  const onFailMatch = trimmed.match(/^on_fail:\s*(\S+)/);
  if (onFailMatch?.[1]) return { id: '', onFail: onFailMatch[1] };

  return null;
}

