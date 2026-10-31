/**
 * 声明图（workflow-graph.yaml）的**解析器**（cycle-94 · 从 `snapshotSource.ts` 拆出）。
 *
 * ## 为什么解析器要独立成文件（不只是行数）
 *
 * `snapshotSource.ts` 回答的是「**从哪里读**」（目录、容忍缺失、tempdir 夹具），
 * 本文件回答的是「**一段文本怎么变成图**」。两者的失效模式与测试方式完全不同：
 *
 * - 读盘层的 bug 是「路径错了 / 目录缺失没容忍」—— 只能用真实 tempdir 测；
 * - 解析层的 bug 是「某条声明没被识别」—— 可以用**纯文本夹具**逐条钉死。
 *
 * cycle-94 的三处关系缺口（`condition` 后字段、`type` 惰性吞掉、`next/on_pass/on_fail`
 * 完全没解析）**全部是解析层 bug**，但此前它们混在一个"读盘文件"里，既不好测也不好读。
 *
 * ## 三层修复的历史（读这段能省下重新踩坑的时间）
 *
 * 1. **第一层**：正则末尾要求 `type` 后立刻 `}` ⇒ 带 `condition` 的 8 条边整条丢弃；
 * 2. **第二层**：放宽末尾后边数恢复了，但惰性 `S+?` 让 `type` 可选组永远跳过 ⇒
 *    15 条边**全部变成 `flow`**（边数对了、语义全丢，比原来更危险）；
 * 3. **第三层**：`next` / `on_pass` / `on_fail` **31 条关系从未被解析**（`grep` 零命中）
 *    ⇒ 宏观主线与微观链压根不在图上。
 *
 * 三层都是"边数看起来够用所以没人怀疑"的形态。这就是为什么
 * `graphRelationCompletenessContract` 必须**跨源逐条对账**（独立提取器 vs 本解析器），
 * 而不是比对"边数 == counts.edges"（那是自证同义反复）。
 *
 * ## 边界
 *
 * 纯函数：吃文本，吐 `{nodes, edges}`。零 IO、零 clock、零 random。
 */

/**
 * 声明图（workflow-graph.yaml）的最小解析（只认技能侧真实形状）。
 *
 * ## ★cycle-94 修复：边正则**不接受 `type` 之后的任何字段**（图谱关系缺口的根因）
 *
 * 旧正则末尾是 `(?:,\s*type:\s*"([^"]+)")?\s*\}` —— 要求 `type` 之后**立刻**是 `}`。
 * 而真实 `.cycles/workflow-graph.yaml` 的门禁链与熔断边都带 `condition`：
 *
 * ```yaml
 * - { from: gate-g0, to: gate-g1, type: "gate-chain", condition: "pass" }
 * ```
 *
 * ⇒ `type` 之后还有 `, condition: "pass"` ⇒ **整条不匹配** ⇒ 边被**静默丢弃**。
 *
 * **实测后果（「图谱关系逻辑不完整」的真因）**：声明 15 条边，快照只有 7 条 ——
 * 丢掉的 8 条恰好是 `gate-chain(3) + phase-transition(1) + circuit-breaker(4)`。
 * 于是：门禁 G0→G1→G2→G3 的**顺序链整条不存在**（4 个门禁成孤点）、
 * 「门禁失败 → 回到微观步骤」的**熔断反馈环整条不存在** ⇒ 真实图裂成
 * **14 个连通分量 / 8 个孤立节点**（一个"工作流"图应是连通的）。
 *
 * ## 为什么这个缺陷特别难查（三条叠加，值得记住）
 *
 * 1. **静默**：不匹配只是不 push，无任何警告 —— 图"看起来正常"，只是少了几条线；
 * 2. **两份解析器**：宿主侧 `stateMachineParse.parseWorkflowGraph`（**能正确解析**，
 *    它用惰性 `([^",}]+)?` 且不要求收尾 `}`）与快照侧本函数是**两份实现**。
 *    同一文件两个真相（15 条 vs 7 条），而**没有任何断言在比这两者**；
 * 3. **既有契约是自证同义反复**：`graphInteractiveContract` 断言「边数 == counts.edges」，
 *    两边都取自**同一份已丢边的数据** ⇒ 永远绿。
 *
 * ## 修法（只放宽，不改语义）
 *
 * `type` 之后用 `[^}]*` 吞掉 `condition` 等任意字段，收尾 `}` 用 `\}?` 容忍截断。
 * **"多一个字段"与"少一条关系"在语义上根本不该有关** —— 丢弃边不该是失败模式。
 *
 * ⇒ 并新增 `tests/contract/graphRelationCompletenessContract.test.ts`：
 * 用真实 yaml **逐条对账**「声明的每一条边都出现在快照里」，这才是"关系完整"的判据。
 */
export function parseWorkflowGraph(text: string): { nodes: { id: string; type: string; label: string }[]; edges: { from: string; to: string; type: string }[] } {
  const nodes: { id: string; type: string; label: string }[] = [];
  const edges: { from: string; to: string; type: string }[] = [];
  let cur: { id: string; type: string; label: string } | null = null;
  let section = '';  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^nodes:/.test(line)) { section = 'nodes'; continue; }
    if (/^edges:/.test(line)) { section = 'edges'; continue; }
    if (/^\S/.test(line)) { section = ''; continue; }
    if (section === 'nodes') {
      const idm = line.match(/^\s*-\s+id:\s*(\S+)/);
      if (idm) { cur = { id: idm[1] ?? '', type: 'phase', label: idm[1] ?? '' }; nodes.push(cur); continue; }
      if (cur) {
        const t = line.match(/^\s*type:\s*(\S+)/);
        if (t?.[1]) cur.type = t[1];
        const l = line.match(/^\s*label:\s*"([^"]*)"/);
        if (l?.[1]) cur.label = l[1];
        /*
         * ★cycle-94 **第三层修复**：`next` / `on_pass` / `on_fail` 三种关系声明。
         *
         * ## 被守卫的缺陷（这才是"关系逻辑不完整"最重的那条）
         *
         * 真实 `workflow-graph.yaml` 用**节点字段**（而不是 `edges:` 段）声明了
         * **31 条关系**：13 个 `next:`、9 个 `on_pass:`、9 个 `on_fail:`
         * （实测 `grep -c`）。而本函数此前**只解析 `edges:` 段**，
         * 对这三个字段零命中 ⇒ **31 条关系全部丢失**。
         *
         * 丢的后果比"少几条线"严重得多：
         *   - 宏观主线 `plan→design→build→test→deploy→maintain→plan` 整条不存在；
         *   - 微观链 `micro-eval→…→micro-retro→micro-eval` 整条不存在；
         *   - 人工门的放行/打回（`human-pr on_pass: deploy / on_fail: build`）不存在。
         *
         * ⇒ 图上只剩 7 条"人类判断门"边 + 8 条门禁链/熔断边，宏观流程**完全不可见**。
         *
         * ## 三个字段的语义映射（为什么这样映射）
         *
         * - `next`      → `next`（顺序推进）：阶段/微观步骤的默认下一步；
         * - `on_pass`   → `on-pass`（裁决为通过时的推进）；
         * - `on_fail`   → `on-fail`（裁决为失败时的回退/打回）。
         *
         * **不把三者合并成一种边**：`next` 是无条件顺序，`on_pass`/`on_fail` 是
         * **有条件分支**（同一个节点两条出边，语义相反）。合并后读者就看到
         * "一个节点指向两个地方"却不知道哪个是成功路径 —— 那等于没画。
         *
         * ## 特殊值 `next-phase` / `plan` 的处理
         *
         * `on_pass: next-phase` 是**占位符**（"推进到下一阶段"，目标由运行时决定）。
         * 它不是节点 id，直接建边会得到悬空边。本函数**跳过**它并如实记录到
         * `unresolved`（调用方可上报），而不是伪造一条指向空节点的边。
         */
        const nextM = line.match(/^\s*next:\s*(\S+)/);
        if (nextM?.[1]) edges.push({ from: cur.id, to: nextM[1], type: 'next' });
        const passM = line.match(/^\s*on_pass:\s*(\S+)/);
        if (passM?.[1]) edges.push({ from: cur.id, to: passM[1], type: 'on-pass' });
        const failM = line.match(/^\s*on_fail:\s*(\S+)/);
        if (failM?.[1]) edges.push({ from: cur.id, to: failM[1], type: 'on-fail' });
      }
    }
    if (section === 'edges') {
      /*
       * 流式形态：`- { from: X, to: Y, type: "t", <任意其他字段…> }`
       *
       * ## 为什么 `from`/`to` 用 `[\w-]+` 而不是惰性 `\S+?`（第二层修复）
       *
       * 第一次只把末尾放宽成 `[^}]*`，结果 15 条边全读到了、但 **type 全变成
       * `"flow"`**：惰性 `(\S+?)` 会**尽量短**地匹配，于是 `to` 只吃掉 `gate`、
       * 剩下的 `-g0, type: ...` 被吞进 `[^}]*` ⇒ 可选的 type 组**永远跳过**。
       * 这是个很隐蔽的坑：边数对了、看上去修好了，而**语义（边类型）静默全丢**。
       *
       * ⇒ 用显式字符类 `[\w-]+`（节点 id 由字母/数字/连字符构成）消除歧义，
       * 再给 `type` 一个独立的 `[^}]*?\btype:` 定位（允许它前面有别的字段）。
       * `type` 缺失时回落到 `flow`（未登记类型，渲染层有 DEFAULT_EDGE 兜底）。
       *
       * ## 为什么 `type` 段是**可选**的（既有契约 `snapshotCore.test` 钉着这条）
       *
       * `- { from: a, to: b }` 这种**不带 type** 的边是合法声明，语义是"未分类关系"
       * ⇒ 兜底 `flow`。把 type 段写成必需会让这类边**整条消失** —— 那正是本轮
       * 要根治的失败模式（"多/少一个字段"不该改变"这条关系是否存在"）。
       * `[^}]*?\btype:` 用 `?` 表示"有就取、没有就走兜底"。
       */
      const EDGE_RE = /^\s*-\s*\{\s*from:\s*([\w-]+),\s*to:\s*([\w-]+)(?:[^}]*?\btype:\s*"([^"]+)")?[^}]*\}?/;
      const m = line.match(EDGE_RE);
      if (m?.[1] && m[2]) edges.push({ from: m[1], to: m[2], type: m[3] ?? 'flow' });
    }
  }
  /*
   * ── 收口：只剔除**已知占位符**，不剔除"端点未在 nodes 里声明"的边 ──────────
   *
   * ## 为什么不能按"端点必须在 nodes 里"过滤（这是一次真实的返工）
   *
   * 第一版按 `nodeIds.has(from) && nodeIds.has(to)` 过滤，本意是剔除
   * `on_pass: next-phase` 这类占位符。但它同时把
   * `- { from: a, to: b }`（节点未在 `nodes:` 段声明、但边是合法声明）也剔掉了 ——
   * 既有契约 `snapshotCore.test` 的「缺 type 的边兜底 flow」当场报红。
   *
   * 更深的问题：**"边引用了未声明的节点"与"这是占位符"是两件事**。
   * 前者是数据不完整（值得上报，但不该由解析器**静默删除**），后者是设计约定
   * （`next-phase` 明确表示"目标由运行时决定"）。
   *
   * ⇒ 本解析器**只剔除一个白名单里的占位符**（`next-phase`），其余一律保留。
   * 端点完整性由**契约**去断言（`graphRelationCompletenessContract` ③ 对声明图
   * 断言连通且无孤立节点）—— 让"数据有问题"表现为**红的契约**，而不是
   * 解析器悄悄少了条边。**静默删除是本轮所有缺陷的共同形态。**
   */
  const PLACEHOLDER_TARGETS = new Set(['next-phase']);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const resolved: { from: string; to: string; type: string }[] = [];
  const byPair = new Map<string, string>();
  /*
   * ## 去重优先级：**显式 `edges:` 声明 > 节点字段声明**（这是第二层返工）
   *
   * 第一次的去重是"先到先得"，结果 `edges:` 段的 `gate-chain` 全部被节点字段的
   * `on-pass` 顶掉 —— 因为**节点段在 yaml 里出现在 edges 段之前**，所以字段声明
   * 总是先入表。实测症状：`gate-g0->gate-g1` 期望 `gate-chain` 实得 `on-pass`，
   * 而契约 ②（边类型不丢）当场把它抓到。
   *
   * ⇒ 不能靠遍历顺序，必须靠**显式优先级**：`edges:` 段（作者写明了类型、还可能
   * 带 `condition`）是**更权威**的声明；节点字段（`next`/`on_pass`/`on_fail`）是
   * **更粗**的声明。两者冲突时以显式为准 —— 但这只发生在"作者两处都写了"的场合，
   * 而那种场合下他一定希望显式的那份生效。
   *
   * 实现：先用 `edgePriority` 记下每个 pair 的来源优先级，只有更高优先级才覆盖。
   */
  const SOURCE_FIELD = 0;  // 节点字段（next / on-pass / on-fail）
  const SOURCE_EDGE = 1;   // edges: 段的显式声明
  const priority = new Map<string, number>();
  for (const e of edges) {
    // 只剔除白名单占位符（见上方「只剔除已知占位符」）。端点完整性交给契约断言。
    if (PLACEHOLDER_TARGETS.has(e.to)) continue;
    const key = `${e.from}\u0000${e.to}`;
    // `next` / `on-pass` / `on-fail` 三种类型来自节点字段；其余来自 edges: 段。
    const src = (e.type === 'next' || e.type === 'on-pass' || e.type === 'on-fail')
      ? SOURCE_FIELD : SOURCE_EDGE;
    const prev = priority.get(key);
    if (prev !== undefined && prev >= src) continue;
    priority.set(key, src);
    const idx = resolved.findIndex((r) => r.from === e.from && r.to === e.to);
    if (idx >= 0) resolved[idx] = e;
    else resolved.push(e);
  }
  // 恢复"声明的原始出现顺序"（edges: 段在前、节点字段在后）：
  // 上面为覆盖做了原位替换，顺序本身已按首次出现稳定。
  return { nodes, edges: resolved };
}
