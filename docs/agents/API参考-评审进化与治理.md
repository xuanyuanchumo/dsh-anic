# dsh-anic API 参考 · 评审、进化与治理

> 本册覆盖 **review**（条件性 LLM 接入）、**evolution**（trust / autonomy / breakers / tech-debt 生成与消费 / 自主级回退）、**governance**（archive / budget / sweep / prune）、**native**（7 个脚本的原生等价物）与 **flows**（流程状态机观测面 + 运行面），共 28 个端点（另：invocations/live 的端点定义写在本册 §6，总索引归属数据面行）。
>
> 公共约定见 [API参考.md](API参考.md)。读取本文件的时机：调用或修改评审、自主级别、熔断、治理、原生脚本与流程状态机端点时。

## 1. review 域

### POST `/anic/review`

| 项 | 值 |
| --- | --- |
| 常量 | `REVIEW_ROUTE`（`src/host/routes/reviewRoute.ts:13`） |
| 注册签名 | `registerReviewRoute(register, opts)`（`reviewRoute.ts:28`） |
| 聚合位置 | `src/host/routes/index.ts:73-83` |

**这是全项目唯一使用位置参数式 `register(method, path, handler)` 的模块**，因此 `index.ts:77` 需要一层适配闭包把它转成对象式。`register` 与 `opts` 的完整形状：

```ts
registerReviewRoute(
  register: (method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void,
  opts: {
    getAgentCards: () => Map<string, AgentCard>;
    probeCtx: unknown;
    defaultProvider?: string;
    defaultModel?: string;
  },
): void
```

**条件性接入的两层降级**（头部注释：「条件性 LLM 接入：probe → Tier-2 / 降级 → Tier-1。INV-23 fail-closed + INV-24 不进 inject。」）：

```ts
const runtime = probeLlm(opts.probeCtx);           // 非 null → LLM 路径
runtime ? await runLlmReview(runtime, card, request, provider, model)
        : heuristicReview(request);                 // null → Tier-1 启发式
```

provider / model 的取值：`typeof body.provider === 'string' ? body.provider : (opts.defaultProvider ?? 'default')`，model 同理。

**Body**：`{ gate: string; role: string; evidence?: { id: string; content: string }[]; provider?: string; model?: string }`。`evidence` 被过滤为 `id` 与 `content` **都是字符串**的条目，其余静默丢弃。

**这是全项目唯一用 `t()` 生成本地化错误文本的路由模块**（`import { t } from '../i18n.ts'`），也是唯一用 `for await (const chunk of req)` 读 body、用裸 `res.writeHead` / `res.end` 而**不走 `sendJson`** 的模块。

| 码 | 条件 | 体 |
| --- | --- | --- |
| 400 | body 无法 JSON.parse | `{ error: 'INVALID_JSON', message: t('review.badJson') }` |
| 400 | body 非对象，或 `gate` / `role` 非字符串 | `{ error: 'INVALID_REQUEST', message: t('review.missingFields') }` |
| 404 | `cards.get(\`anic.agent.${gate}.${role}\`)` 为 undefined | `{ error: 'AGENT_NOT_FOUND', message: t('review.cardNotFound', { cardId }) }` |
| 200 | 正常 | `ReviewVerdict` 对象；响应头额外带 **`X-ANIC-Review-Tier: verdict.tier`** |
| 500 | 外层 catch | `{ error: 'INTERNAL', message: err instanceof Error ? err.message : String(err) }` |

**卡 id 的拼接形状是契约**：`anic.agent.${gate}.${role}` —— 因此 `gate` / `role` 必须与 `assets/agents/*.json` 的卡 id 段严格对应。

`X-ANIC-Review-Tier` 头是消费方判断「本次走的是 LLM 还是启发式」的唯一通道 —— 不要从响应体推断。

**评审结论时效性（cycle-38 · G5，doc19 §5 吸收④）**：`src/host/llm/reviewLedger.ts` 落地「结论绑定证据指纹」——每次评审在 `{workspace}/.cycles/reviews/ledger.json` 记一条摘要（gate/role/verdict/tier/**evidenceDigest**/evidenceIds/provider/model/timestamp，滚动保留 200 条）。`evidenceDigest` 复用 `reviewEngine.buildAttribution(...).promptDigest`（sha256 前 16 位，由门/角色/证据 id+内容决定，刻意不含 provider/model/时间戳）。响应体新增两个字段：

- `review.freshness`：`'none'`（无历史结论）| `'fresh'`（历史结论依据的证据指纹与本次相同）| `'stale'`（证据已换——**提示而非裁决**：不改变本次 verdict，只是把「你正在覆盖一个基于不同证据的历史结论」显式说出来）；
- `review.previous`：被覆盖的那条历史结论摘要。

**设计来源**：`dsh-plugin-veriscope`「PASS 只说明归档指标通过所绑定门禁」+ `dsh-negative-ledger`（提纲出处，npm 查无此包）「precondition 变化 → 结论 stale」+ `dsh-continual-evolve`「回滚靠账本」。测试钉：`tests/unit/reviewLedger.test.ts` 14 用例 + `tests/unit/skillLifecycleRoute.test.ts` 4 用例（none→fresh→stale 全链路）。

---

## 1a. 治理底座三模块（cycle-38 · doc19 §5 吸收①③）

**`src/host/governance/factBaseAnchors.ts` + factBaseVerify 重写（吸收①）**：事实基座核验的三态分离——`verified`（file:line 锚点可核）/ `missing`（声明的东西源码里没有）/ `unscannable`（**核不了不是缺失**——源码树不可扫描等形态，不进风险分母）。来源：`dsh-model-everything`「结论带 file:line，核不了的直接说明，不猜」+ `dsh-plugin-veriscope`「缺失不补零」。`riskScore` 分母因此从 `total` 改为 `verified + missing`（`bootstrapEngineIntegration.ts`）——72% 的 unscannable 噪声不再稀释风险信号。

**`src/host/toolIds.ts`（吸收③）**：19 个 `anic_*` 工具 id 的**单一清单**——`assets/agents/*.json` 的 `toolsAllowlist` 此前只有形状校验（`anic_ghost_tool` 能混进白名单）。现在两级校验：id 正则 + **存在性**（与注册代码投影双向比对）。15 张角色卡已按最小只读面重填。测试钉：`tests/contract/toolIdsContract.test.ts` 10 用例（集合相等/幽灵 id 被拒/只读面约束）。

**`src/host/selfBootstrap.ts` 表驱动重构（吸收②）**：自举状态机迁移表 `BOOTSTRAP_TRANSITIONS`（9 条）是 status 的**唯一权威**——`transitionBootstrap` 非法触发词拒绝且状态原样（fail-closed）；中间态 EVALUATING/GATE_CHECKING/FIXING/VERIFYING 在编排器四相位边界真实落盘（`bootstrapOrchestrator.ts` 的 `enterPhase`）；cycle-38 re-gate 环收尾后 VERIFYING 真实重跑 gate-check（复检非伪造）。来源：`dsh-per`「transition-table 是唯一权威」+ `dsh-state-graph`「非法转移拒绝」。步骤执行器拆分至 `bootstrapSteps.ts`（T3 ≤250 行纪律）。

---

## 2. evolution 域

`src/host/routes/evolutionRoute.ts`。注册签名 `registerEvolutionRoute(ctx: SnapshotCtx, send: SendFn): Array<(() => void) | null>`，`!ctx.webServer` 时返回 `[]`。

本地 `reg(path, method, handler)` 的 `method` 参数**不被传给宿主**（宿主只按 path 注册），因此**四个端点都没有方法检查**。

**四个端点全部只返回 200** —— 没有 404，没有 400。无工作区也不报错。

### 2.1 GET `/anic/api/trust`（`evolutionRoute.ts:40`）

**Query**：`entries` —— 一个 **JSON 字符串**，被 `JSON.parse` 成 `LedgerEntryForTrust[]`。解析失败**静默退化成空数组**（不是 400）。

**响应 200**：`{ trustScores: [...scores.values()], count: result.length }`。

### 2.2 GET `/anic/api/autonomy`（`evolutionRoute.ts:53`）

**Query**：

- `band` —— 默认 `'L2'`，经 `/^L[1-4]$/` 校验，**非法值回退 `'L2'`**（不是 400）。
- `trust` —— 默认 `50`，`parseInt`。

**响应 200**：`{ current: band, trustScore, recommended }`（`recommendBand(band, trustScore)` 的推荐级别）。

### 2.3 POST `/anic/api/breakers`（`evolutionRoute.ts:63`）

**Body**（数字字段经 `Number(parsed.x ?? 0)`，布尔字段经 `Boolean(parsed.x)`，缺省即 0 / false）：

```
consecutiveFixFails, hasDoubt, userDataUnisolated, destructiveNoRollback,
perfUnrecovered, humanRequestsL3, unattendedHours, contextUsagePercent,
totalRetries, totalBreakerTrips
```

**Query**：`band`。

**响应 200**：`{ breakers, action, downgradedBand }` —— 内部流程 `checkBreakers(body)` → `decideAction(band, breakers)` → action 为 `'downgrade'` 时 `downgradeBand(band)`。

**注意布尔强制转换的后果**：`Boolean(parsed.hasDoubt)` 意味着字符串 `'false'` 会被转成 `true`。传参时必须用真正的 JSON 布尔值。

### 2.4 POST `/anic/api/tech-debt`（`evolutionRoute.ts:114`）

**Body**：`results` —— `EvalResult[]`。
**响应 200**：`{ techDebt: entries, count: entries.length }`。

**注意**：本端点只从请求体**生成**提案并返回，**不落盘**。

### 2.5 GET `/anic/api/tech-debt/list`（`evolutionRoute.ts:97`，cycle-16 G-C3 消费侧读面）

**列出 `.cycles/tech-debt/` 全部提案**。读面用独立子路径而非与 POST 生成面共用 `/anic/api/tech-debt`：webServer 的 exact 表对同 path 双注册（GET+POST 各一条）的覆盖语义未在官方文档钉死，分路径零歧义（源码头注）。

**响应 200**：`{ open: TechDebtFile[], openCount, resolvedCount, skipped: [{file,reason}] }`——open = 未消费提案（人/上游 agent 执行修复的工作队列）；resolved = 已消费（带 consumedAt/consumedBy 审计字段）；skipped = 非 TechDebtEntry 形态文件（fix-loop 数组已展开，自由形态如实跳过）。

| 码 | 条件 | 体 |
| --- | --- | --- |
| 500 | 无工作区 | `{ error: { code: 'ANIC_ROUTE_NO_WORKSPACE' } }` |
| 200 | 正常 | 三分流列表 |

### 2.6 POST `/anic/api/tech-debt/consume`（`evolutionRoute.ts:123`，cycle-16 G-C3 消费侧写面）

**语义**：标记 `.cycles/tech-debt/` 下的提案已消费——**只做记账（resolved=true + consumedAt/consumedBy 审计字段），绝不执行修复**（R-31 红线：自动执行队列是 15 号文档建议的原始形态，本工程裁决为「提案→人工/上游执行→记账」闭环，见 `src/host/evolution/techDebtQueue.ts` 头注）。

**Body**：`{ ids: string[]（必填，提案 id 列表）, consumedBy?: string（≤200 字符，缺省 'unknown'） }`。

| 码 | 条件 | 体 |
| --- | --- | --- |
| 400 | `ids` 缺失/空数组 | `{ error: { code: 'ANIC_ROUTE_BAD_REQUEST', message: 'ids[] required...' } }` |
| 500 | 无工作区 | `{ error: { code: 'ANIC_ROUTE_NO_WORKSPACE' } }` |
| 200 | 正常 | `markTechDebtConsumed` 结果（逐 id 消费/未找到计数） |

**配套读取面**：`GET /anic/api/tech-debt/list`（§2.5）。

### 2.7 POST `/anic/autonomy/downgrade`（`evolutionRoute.ts:149`）

**证据化自主级回退**（R3 阶段 1 余量）——与 2.3 breakers 的纯决策视图不同，这是技能 `cmdAutoFallback` 的插件等价物，**真正写入 config.yml**。

**执行链**：`runAutonomyFallback(root)`（`src/host/evolution/autonomyActions.ts`）——breakerSignals 从真实工件采集八熔断信号（`.cycles/incidents/` 文件名 / 账本 / band-history / config.yml）→ `decideAction` → 降级时写 config.yml + **Post-Verify 回读断言** + 事故留痕 incident（技能 S-7「效果即记录」纪律）。

| 码 | 条件 | 体 |
| --- | --- | --- |
| 500 | 无工作区（`resolveWorkspaceRoots` 抛） | `{ error: { code: 'ANIC_ROUTE_NO_WORKSPACE' } }` |
| 200 | 全部路径（含拒绝） | `runAutonomyFallback` 结果 |

**拒绝一律 200 + action 字段区分**——「无熔断证据」「已在 L1/L2 地板」「config 缺失」的结局是**维持不动**，不是 HTTP 层错误；调用本身被正确执行了（头部注释即契约）。DSH 工具面等价物：`anic_autonomy_downgrade`（`toolsEvolutionGateway.ts:27`）。

---

## 3. governance 域

`src/host/routes/governanceRoute.ts`。注册签名 `registerGovernanceRoute(ctx: ServerContext, send: SendFn): Array<(() => void) | null>`。

**本域的两处刻意例外，改动前必须知道**：

1. **自带 `resolveRoot(ctx)`**（`governanceRoute.ts:22-28`）：只试 `workspaceRegistry.list()` 再试 `sessions.list()`，**不回退 `process.cwd()`**（与 `snapshotRoute.ts:44` 的 `resolveWorkspaceRoots` 不同）。
2. **无工作区返回 500 而非 404**：`{ error: 'ANIC_ROUTE_NO_WORKSPACE' }`。因为解析不到根在本域被视为服务端错误。

无 `.cycles` 时返回 404 `{ error: 'ANIC_ROUTE_NO_CYCLES' }`。

### 3.1 POST `/anic/governance/archive`（`governanceRoute.ts:42`）

**Body**：`ArchiveOptions`。**响应 200**：`archiveOldCycles(cyclesDir, body)` 的结果。

### 3.2 GET `/anic/governance/budget`（`governanceRoute.ts:54`）

**Query**：`warn` → `thresholds.warnBytes`，`alert` → `thresholds.alertBytes`，两者都 `parseInt`。
**响应 200**：`checkBudget(cyclesDir, thresholds)` 的报告。

### 3.3 POST `/anic/governance/sweep`（`governanceRoute.ts:73`）

**Body**：`SweepOptions`。**响应 200**：`sweepCycles(cyclesDir, body)` 的结果。

### 3.4 GET `/anic/governance/prune`（`governanceRoute.ts:85`）

**响应 200**：`pruneCheck(cyclesDir)` 的报告。**用 GET 做「检查」而非「执行」** —— prune 是只读预检，实际清理走 sweep / archive。

---

## 4. native 域

`src/host/routes/nativeRoute.ts`，头部标注「原生实现路由（7 脚本原生等价物）」。注册签名：

```ts
registerNativeRoute(ctx: unknown, deps: {
  send: SendFn;
  getWorkspaceRoot: () => string | null;
  agentCards: Map<string, AgentCard>;
}): Array<(() => void) | null>
```

`const log = createScoped('anic:route:native')` —— 本模块用 scoped logger。

**两个贯穿全域的约定**：

1. **每个 handler 都调 `newRequestId()` 并把 `rid` 作为 `send` 的第 4 个参数**，因此本域**每个响应都带 `X-ANIC-Request-Id`**。
2. 每个 handler 无工作区时返回 404 `{ error: 'no workspace' }`。

**本域用原生 TS 实现替代了 7 个 skill 脚本**，因此它**不需要** `.dsh/skills/` 已安装 —— 这是与 self / skill 域的关键差异。

### 4.1 POST `/anic/hitl-audit`（`nativeRoute.ts:37`）

**响应 200**：`runHitlAudit(root)` 的结果。

### 4.2 GET `/anic/band-detect`（`nativeRoute.ts:46`）

**Query**：`score` —— 经正则 `r?.url?.match(/score=([0-9.]+)/)` 提取，默认 `1.0`，再 `Math.max(0, Math.min(1, parsed))` 夹取到 `[0,1]`。

**响应 200**：`runBandDetection(root, score)` 的结果。

**正则提取意味着非数字输入静默回退到 1.0** —— 不会 400。示例：`/anic/band-detect?score=0.75`。

**cycle-21 双 schema 收敛**：`runBandDetection` 追加写入时**保留 band-history.json 全量原始数组**（文件主体是技能 `band-detector.mjs` 写入的质量带 entry，过滤覆写会摧毁技能仍在消费的历史）；`cycle` 编号与 `trend`/`weViolations` 统计只取自主带子序列（`bandHistory.ts` 的 `autonomyEntries`/`loadRawHistory`）。消费方语义详见 `bandHistory.ts` 模块注释。

### 4.3 GET `/anic/org-status`（`nativeRoute.ts:59`）

**响应 200**：`runOrgStatus(root, {})` 的结果。这是客户端 `ORG_STATUS_URL`（`src/client/WorkflowGraphPanel.ts:30`）消费的端点，也被 `src/host/tools.ts:195` 作为工具返回的指针 URL。

### 4.4 GET `/anic/fact-base`（`nativeRoute.ts:68`）

**响应 200**：`runFactBaseVerify(root)` 的结果。

### 4.5 GET `/anic/plan-sync`（`nativeRoute.ts:77`）

**响应 200**：`runPlanSync(root)` 的结果。

### 4.6 POST `/anic/multi-agent-gate`（`nativeRoute.ts:86`）

**Body 被完全忽略** —— handler 的参数名是 `_req`。

```ts
const evidenceByGate: Record<string, { content: string; id: string }[]> = {};
const results = runAllGates(deps.agentCards, evidenceByGate);
send(res, 200, { gates: results, allPassed: results.every((g) => g.passed) });
```

源码注释：`// 简化：运行全部门禁`。因此**当前无法按 gate 传入 evidence** —— 无论请求体里传什么，都是对全部 gate 跑一次空证据评估。若需要按 gate 定向评估，必须改这个 handler，而不是改调用方。

**响应 200**：`{ gates, allPassed }`。

### 4.7 POST `/anic/fix-loop`（`nativeRoute.ts:128`）

**Body 被忽略**（`_req`）。验证函数消费真实事实（cycle-16 前的旧文档描述「只检查账本文件存在」已过时）：

```ts
const chain = verifyLedger(cyclesDir);                 // 哈希链校验
const verdicts = latestConvergenceVerdicts(cyclesDir); // G0-G3 最新裁决
const passed = chain.ok && missing.length === 0;
```

**响应 200**：`runFixLoop(root, verifyFn)` 的结果——验证报告含「哈希链校验通过（N 条）+ G0-G3 全绿」或失败明细（链断裂原因 / 缺失门名单）。

---

## 5. flows 域 · 流程状态机

`src/host/routes/flowsRoute.ts`（R3 阶段 2-5）。注册签名 `registerFlowsRoute(ctx, send, deps)`，`deps = { getWorkspaceRoot }`。头部注释记录设计裁决：运行入口按流程 id **静态分派**（第 4 个流程实例到达后仍维持——各流程参数域差异大，抽象的参数税大于分派税）。

**观测面三端点**（无工作区时 `/anic/flows` 与 `/anic/flows/status` 仍可用，`state` 返回 500）：

### 5.1 GET `/anic/flows`（`flowsRoute.ts:66`）

**响应 200**：`{ flows: [...listFlows().map(descriptorView)], total }`。descriptorView 是描述子的可序列化投影（id / labelKey / states / initial / transitions[{from,to,trigger,guard}] / persistence / engine / scriptFallback）。

### 5.2 GET `/anic/flows/status`（`flowsRoute.ts:74`）

**一站式观测面**（客户端面板 `FLOWS_STATUS_URL` 消费的端点，`src/client/WorkflowGraphPanel.ts:38`）：全部注册流程 + 各自当前投影。**无投影 = 从未运行过，如实为 null，不伪造 IDLE**（IDLE 的默认态不落盘——投影只记已发生的事实）。

**响应 200**：`{ flows, total, running, terminal, neverRun }`。

### 5.3 GET `/anic/flows/state?flow=<id>`（`flowsRoute.ts:93`）

**Query**：`flow`（缺省 `'gate-check'`）。未知 flow → 404 `ANIC_ROUTE_UNKNOWN_FLOW:<id>`。
**响应 200**：`{ flowId, projection, descriptor }`——projection 形状见 `src/host/flows/persistence.ts`（`{ flowId, current, history, updatedAt, ledgerHead }`，投影文件 `.cycles/flows/<id>.json` 可丢弃可重算，INV-13 replay === online）。

**运行面四端点**（全部无工作区 500 `ANIC_ROUTE_NO_WORKSPACE`；`readBody` 流式兼容）：

### 5.4 POST `/anic/flows/gate-check/run`（`flowsRoute.ts:109`）

**Body**：`{ mode?: 'script'|'native'|'diff'（缺省 script）, gate?: 'all'|'G0'-'G3'（非法 400 ANIC_ROUTE_BAD_GATE）, quality?: boolean（缺省 true）, record?: boolean, timeoutMs?: number }`。

**三模式**：script 正典（技能脚本是账本正典写入者）/ native 原生判定（record 时按同一去重语义入账）/ diff 双跑对账（**观测专用永不写账本**，防双写）。执行错误（技能目录缺失等）不推进状态机，500 `ANIC_ROUTE_FLOW_ERROR:<原因>`。

**响应 200**：`GateFlowRunResult`（`src/host/flows/gateCheckFlow.ts:67-84`）——含 gates/quality 逐门裁决、allPass、exitCode、drift（diff 模式分叉面，null=语义全等）、stdout（script 模式观测）、recorded（native+record 实际入账门）。差分契约：`tests/contract/flowDifferential.test.ts`。

### 5.5 GET `/anic/flows/macro-phase/status`（`flowsRoute.ts:133`）

**只读**：宏观六相视图（plan/design/build/test/deploy/maintain）。**不落盘、不 inferPhase 回写**——技能 workflow-state 的 inferPhase 回写对 deploy/maintain 永远推不出来，是技能侧缺陷不复制（`macroPhaseFlow.ts` 头注）。

### 5.6 POST `/anic/flows/macro-phase/advance`（`flowsRoute.ts:140`）

**Body**：`{ mode?: 'script'|'native'（缺省 script）, target?: 相位名（非法 400 带有效相位名单）, dryRun?: boolean }`。`dryRun + script` 组合 → 400 `ANIC_ROUTE_DRYRUN_NATIVE_ONLY`（dryRun 只算不写是 native 引擎能力）。

**响应**：守卫拒绝（门未过等）→ 422；成功 → 200。6 相 15 条前向边全带 phase-gates-passed 守卫；**禁回退由图形状承载**（全部 from 序 < to 序）。差分契约：`tests/contract/macroPhaseDifferential.test.ts`。

### 5.7 POST `/anic/flows/archive/run`（`flowsRoute.ts:166`）

**Body**：`{ mode?: 'native'（缺省）|'script', cycle?: number（非法 400）, clean?: boolean, keep?: number, timeoutMs?: number }`。**无参缺省 list**（只读安全缺省）；archive 需显式 cycle，clean 需显式 `clean:true`。

**响应**：ok→200 / 拒绝→422。归档是写动作：isCycleComplete **与 G1 共用 parseTaskRows**（「G1 说完成、归档说没完成」分叉的根治面）；拒绝路径零文件系统写入；账本逐字节不变（INV-9）；clean 只删 archive/ 子树，active 循环永不触碰。差分契约：`tests/contract/archiveDifferential.test.ts`（孪生夹具——归档不能同目录双跑）。

### 5.8 POST `/anic/flows/hitl/run`（`flowsRoute.ts:191`）

**Body**：`{ mode?: 'native'（缺省）|'script', gate?: 'all'|'H1'-'H4'（非法 400）, timeoutMs?: number }`。

**状态码语义**：pass→200 / fail→422 / **circuit→409**（exit 2 = 需要人类介入，BLOCKED）。三段编排：Phase0 全审计落审计行 → 无熔断二元判定 → Phase1 仅熔断门修复 → Phase2 全修复成功才重审；fix 失败不重审不落 incident（`hitlThreePhase.ts`）。差分契约：`tests/contract/hitlDifferential.test.ts`。

### 5.9 POST `/anic/flows/auto-fix/run`（`flowsRoute.ts:213`）

**Body**：`{ mode?: 'native'（缺省）|'script', maxRetries?: 1-10 整数, testCmd?: string, timeoutMs?: number }`。

**状态码语义**：pass→200 / **circuit→409**（重试耗尽需人类介入）/ 前置错误→400。流程状态机 IDLE→RUNNING→ITERATING↺→CONVERGED/CIRCUIT，ITERATING 自环轨迹进投影 history（迭代过程可回放）。报告计数双格式解析（正典管道表优先 + 旧键值回退，D-1103）。差分契约：`tests/contract/autoFixDifferential.test.ts`。

**DSH 工具面等价物**：`anic_flows_gate_check` / `anic_flows_advance` / `anic_flows_archive` / `anic_flows_hitl` / `anic_flows_auto_fix`（toolsFlowsGateway.ts / toolsHitlGateway.ts / toolsAutoFixGateway.ts）。

---

## 6. invocations · 实时调用流

### GET `/anic/api/invocations/live`（`invocationRoute.ts:27`）

动态白盒数据面（cycle-97）：`InvocationFeed` 实时调用环回缓冲（drop-oldest，limit 50）的只读快照。**无工作区依赖**；feed 缺失时**显式 500**（诚实失败，不伪造空列表）。注册位置 `routes/index.ts:68`（data 域内，端点总索引也归数据面行）。

---

## 相关文档

- 公共约定与端点总索引 → [API参考.md](API参考.md)
- 数据面 → [API参考-数据面.md](API参考-数据面.md)
- 周期面 → [API参考-周期面.md](API参考-周期面.md)
- 自举 / 技能 / 安装 / 双自举面 → [API参考-自举与技能.md](API参考-自举与技能.md)
- 轨迹可见性与 invocationFeed 接线 → [可观测性与轨迹可见性.md](可观测性与轨迹可见性.md)
