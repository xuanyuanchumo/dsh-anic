# dsh-anic API 参考 · 数据面

> 本册覆盖 **data 域**：snapshot / step-trace / self-check / self-init + invocations（实时调用流），共 5 个端点。除 `self-init`（bootstrap 动作）外全部只读。
>
> 公共约定（注册机制、响应形状、状态码语义、无工作区解析链、磁盘形状）见 [API参考.md](API参考.md)。周期面（cycle / ledger / stack-probe / seg-ledger）见 [API参考-周期面.md](API参考-周期面.md)。
>
> 读取本文件的时机：调用或修改数据面端点时。

## 1. GET `/anic/api/workflow-snapshot`

| 项 | 值 |
| --- | --- |
| 常量 | `SNAPSHOT_ROUTE`（`src/host/snapshotRoute.ts:22`） |
| 注册 | `registerSnapshotRoute(ctx)`（`src/host/snapshotRoute.ts:81`） |
| 聚合位置 | `src/host/routes/index.ts:57-62` |

**Query**：无（workspace 由 `resolveWorkspaceRoots` 在服务端解析）。

**响应 200**：`buildWorkflowSnapshot(cyclesDir)` 的结果 —— `{ nodes, edges, autonomy, counts }`（构建器见 `src/shared/snapshotCore.ts:1-6`；客户端类型见 `src/client/workflowGraphData.ts:12-30`，其中 `WorkflowNode.type` 是 8 值联合 `'phase'|'micro-step'|'gate'|'human-gate'|'cycle'|'gate-event'|'incident'|'autonomy'`；cycle-38 起 `WorkflowNode` 可携带 `detail?: string`——gate-event 节点的账本 detail，W-3「为什么」层的数据源）。

**响应头**（cycle-38 V-1 起）：

- `ETag`：`"sha256前16位"`——**语义指纹**（nodes/edges/autonomy/counts，**刻意排除 `generatedAt`**：响应体每次都带新时间戳，覆盖它则 ETag 永不相等、304 形同虚设）
- `X-ANIC-Snapshot-Digest`：与 ETag 同指纹（老消费方的廉价判据通道保留）
- `X-ANIC-Workspace`：`encodeURIComponent(root)`

**条件请求（cycle-38 新增）**：请求带 `If-None-Match` 且与当前语义指纹相等 → **304**（空体 + ETag/Workspace 头保留）。省的是响应体与二次渲染，不是快照构建——构建总是要跑的（诚实边界）。数据真变（如账本追加）→ 指纹变 → 旧 ETag 不命中 → 200 全量。测试钉：`tests/unit/snapshotRoute.test.ts` 的 `V-1 ETag 条件请求` describe（6 用例）。

**状态码**：

| 码 | 条件 | 体 |
| --- | --- | --- |
| 304 | `If-None-Match` 命中当前语义指纹 | 空（null） |
| 404 | `<root>/.cycles` 不存在 | `{ error: 'no .cycles in current workspace', workspace: root }` |
| 200 | 正常 | 快照对象 |
| 500 | 构建抛错 | `{ error: message }` |

## 2. GET `/anic/api/step-trace`

| 项 | 值 |
| --- | --- |
| 常量 | `STEP_TRACE_ROUTE`（`src/host/routes/stepTraceRoute.ts:13`） |
| 注册 | `registerStepTraceRoute(ctx)`（`stepTraceRoute.ts:16`） |

**为什么在服务端组装**（`stepTraceRoute.ts:3-5`）：「客户端拿不到文件句柄，这是白盒透明化的数据面」。服务端把四源投影拼好后整体下发。

**四源**（`src/shared/stepTrace.ts:4-5`）：声明图（`workflow-graph.yaml`）× 节点状态（`workflow-state.json`）× 账本裁决（`gates/ledger.json`）× 周期工件（`cycles/cycle-N` 元数据）。

**响应 200**：`buildStepTrace(snap, { cyclesDir })` 的结果。逐项形状（`stepTrace.ts:18-31`）：

```ts
type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';
type StepBasis  = 'structured' | 'heuristic';
interface TraceStep {
  nodeId: string;
  name: string;
  kind: string;
  status: StepStatus;
  basis: StepBasis;
  sources: string[];                                  // 四源中实际参与判定的
  ledgerVerdict: { result: string; timestamp: string } | null;
}
```

**两条承重契约**（`stepTrace.ts:7-13`，改动时必须保留）：

1. **cycle 归属只用位置法** —— 绝不从账本 `detail` 自由文本解析 cycle 号；账本只按 gate 取「最近一次裁决」。
2. **INV-27 诚实标注** —— 推断出来的状态必须 `basis: 'heuristic'`，只有结构化来源给的事实才是 `basis: 'structured'`；任一源缺失标 `'absent'`，不伪造空数据。

**状态码**：404 `{ error: 'no .cycles in current workspace', workspace: root }`（`stepTraceRoute.ts:28`，与 snapshot 同形）；200；500 `{ error: message }`。

## 3. GET `/anic/api/self-check`

| 项 | 值 |
| --- | --- |
| 常量 | `SELF_CHECK_ROUTE`（`src/host/routes/selfCheckRoute.ts:28`） |
| 注册 | `registerSelfCheckRoute(ctx, { send, getWorkspaceRoot, agentCardsDir })` |

**响应 200**：`{ checks: ProbeResult[], allOk: boolean, requestId: string }`，其中

```ts
interface ProbeResult { id: string; inv?: string; ok: boolean; detail: string }   // selfCheckRoute.ts
```

**九个只读探针**（`runSelfChecks(input: { workspaceRoot, agentCardsDir, inlineSkillRoot?, installedSkillRoot? })`）：

| id | 不变量 | 判定 |
| --- | --- | --- |
| P1 | INV-13 确定性 | 用固定时间戳 `'2025-01-01T00:00:00.000Z'` 构建快照两次，比较 `sha256(JSON.stringify(x)).slice(0,16)`；无 `.cycles` 时标 `'absent'` |
| P2 | INV-21 结构化身份 | `STRUCTURED_PREFIXES = ['wf:', 'cycle:', 'evt:', 'inc:', 'aux:']`；无 `.cycles` 时空过 |
| P3 | INV-25 配置单入口 | `loadWorkspaceConfig(cyclesDir).source !== 'missing' && !== 'legacy'` |
| P4 | agent 卡可加载 | `loadAgentCards(input.agentCardsDir)` 且 `agents.errors.length === 0` |
| P5 | INV-18 step-trace 可复现 | 仅当 `<cyclesDir>/workflow-graph.yaml` 存在时跑，同一固定时间戳；否则空过 |
| P6 | INV-26 诊断域隔离 | **硬编码 `ok: true`**，detail `'self-check is read-only by construction (no write path in this module)'` |
| P7 | 能力索引同步 | `capabilityIndex` 漂移检查：索引与工具面集合一致（`drift.ok`） |
| P8 | 工具披露模式 | 渐进式披露模式（`full` / `index`）与索引字节数；默认 `full` 零行为变更 |
| P9 | **技能双轨一致性**（cycle-77） | `verifySkillInstall(live, inline)`：`dualTrack=in-sync` 才 ok；`extraDrift`/`manifestStale`/字节不符即红；**inline 或 live 缺失时 `skipped: true`（不假绿）** |

P6 是形态声明而非运行时探测 —— 它不检验任何东西，只是把「本模块无写路径」写进响应。真正的保证来自源码守卫与评审。
P9 是 cycle-77 新增：把「发行源 `assets/skill` ↔ 运行副本 `.dsh/skills/…`」漂移变成可读回的探针结果，
`skipped` 项不计入 `allOk`（缺证据 ≠ 通过）。

**每个探针独立 try/catch**，抛错转成 `ok: false` + `detail: 'threw: …'`，不向上传播。

**状态码（刻意的不对称）**：

| 码 | 条件 |
| --- | --- |
| 404 | 无工作区 → `{ error: { code: 'ANIC_ROUTE_SELF_CHECK_NO_WORKSPACE', message: 'no workspace resolvable' } }` |
| **200** | 探针失败 —— 逐项 `ok: false`，整体仍 200 |
| 500 | 探针**机制**本身抛错 → `{ error: message }` |

头部注释即契约（`selfCheckRoute.ts`）：「失败不抛异常：逐项 ok:false + detail，整体 200（诊断端点的诚实形态——探针本身不可用才是 500）」。**不要「修正」成失败即 5xx** —— 那会让一个探针的失败掩盖其余五个的结果。

## 4. POST `/anic/self/init`

| 项 | 值 |
| --- | --- |
| 常量 | `SELF_INIT_ROUTE`（`src/host/routes/selfInitRoute.ts:21`） |
| 注册 | `registerSelfInitRoute(ctx, { send, getWorkspaceRoot, loadFlows })` |

**Body**：`{ name?: string }` → 非空时转成 CLI 参数 `['--name', name.trim()]`（注释引 `init-workflow.mjs:66` N-6）。

**实际执行**（`selfInitRoute.ts`）：

```ts
spawnSync(process.execPath, [join(scriptsDir, 'init-workflow.mjs'), root, ...nameArg],
          { cwd: root, encoding: 'utf-8', timeout: 60_000 })
```

**状态码 —— 判定顺序有语义，不可重排**：

| 顺序 | 码 | 条件 | 体 |
| --- | --- | --- | --- |
| 1 | 405 | `(r?.method ?? 'GET') !== 'POST'` | `{ error: 'POST only' }` |
| 2 | 403 | `!deps.loadFlows().selfInit` | `{ error: { code: 'ANIC_ROUTE_SELF_INIT_DISABLED', message: 'flow.selfInit is switched off (workspace/deployment layer)' } }` |
| 3 | 404 | 无工作区 | `{ code: 'ANIC_ROUTE_SELF_INIT_NO_WORKSPACE' }` |
| 4 | 409 | `<root>/.cycles/config.yml` 已存在 | `{ code: 'ANIC_ROUTE_SELF_INIT_ALREADY', message: '.cycles/config.yml already exists at this workspace — self-init is refuse-to-rerun (idempotent by design)' }` |
| 5 | 404 | `resolveSkillScriptsDir(root)` 为 null | `{ code: 'ANIC_ROUTE_SELF_INIT_SKILL_MISSING' }` |
| 6 | 200 / 500 | `result.status === 0` / 否则 | 见下 |

**成功体**：`{ ok, requestId, durationMs, stdout, stderr, configPath: ok ? configPath : null, digest: ok ? sha256(stdout).slice(0,16) : null }`。

**409 是设计而非意外** —— 注释写明 `refuse-to-rerun (idempotent by design)`：自举只在空工作区发生，重复调用必须响亮拒绝而不是静默覆盖已有配置。

**INV-26 声明**（`selfInitRoute.ts` 头部）：「本路由自身错误只进日志/响应，**绝不写 `.cycles/incidents/`**」。

## 5. GET `/anic/api/invocations/live`

| 项 | 值 |
| --- | --- |
| 路径常量 | `invocationRoute.ts:27` |
| 注册签名 | `registerInvocationRoute(ctx, { send, feed })` |
| 聚合位置 | `src/host/routes/index.ts:68` |

**动态白盒数据面**（cycle-97 建立；cycle-47..48 扩展诊断与结果预览）：返回 `InvocationFeed` 实时调用环回缓冲（drop-oldest，limit 50）的只读快照，供调试「调用没显示」类问题。

> **同步触发器**（cycle-67）：本节三张字段表与源码接口（宿主 `invocationFeed.ts` ⇄ 客户端 `renderInvocationsTypes.ts`）由 `tests/contract/apiDocShapeContract.test.ts` 三腿钉死——加字段不同步本表即测试红（cycle-66 手工补录欠账的结构性根治）。

### 响应体形状

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `invocations` | `InvocationRecord[]` | 环回缓冲内条目（时间序，最新在后） |
| `total` | `number` | 当前缓冲条目数（≤50） |
| `generatedAt` | `string`(ISO) | 快照生成时刻——面板 in-flight 已进行时长的时钟基准（cycle-64：与 startedAt 同为宿主进程时钟） |
| `diagnostics` | `FeedDiagnostics \| null` | 通道计数（cycle-47）；`null`=旧宿主无此字段（协议三态见下） |

### InvocationRecord 字段（14）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `callId` | `string` | 宿主调用 ID（tools/result 按 exec.callId 配对） |
| `name` | `string` | 工具名（`anic_*` 前缀或 `skill`） |
| `argumentsPreview` | `string` | 模型原始参数串（未解析），截断 200 字符 |
| `turn` / `step` | `number?` | 会话轮/步坐标（如 `t8/s1`） |
| `startedAt` | `number` | epoch 开始时刻（in-flight 已进行时长的基准） |
| `endedAt` | `number?` | epoch 结束时刻（in-flight 未落定则缺省） |
| `status` | `'in-flight' \| 'done' \| 'error'` | 三态生命周期 |
| `error` | `{name, code, reason?}?` | error 态的错误三元组 |
| `durationMs` | `number?` | done/error 态耗时（终态精确值；in-flight 不设） |
| `resultPreview` | `string?` | 结果内容预览（cycle-48，截断 200 字符对齐 argumentsPreview；提取自 tools/result 的 content 文本块；错误调用无此字段） |
| `possiblyOrphaned` | `boolean?` | in-flight 超 15 分钟：结束事件大概率永不到来，如实标记 |
| `cycle` | `string?` | **流程归属**（cycle-71 T-10501）：**该调用发生瞬间**的 `.cycles/workflow-state.json` 的 `currentCycle`（如 `cycle-71`）——白盒四元组「流程流向」元的 join key。宿主在 `tool/call` 到达时解析（`invocationAttribution.ts`，TTL 2s 缓存）。**响应期不重算**（对已结束的调用补当前相 = 伪造，INV-27）。解析不到（多会话歧义/文件缺失/JSON 损坏）→ 缺省不落 |
| `phase` | `string?` | 同上的 `currentPhase`（宏观六相：plan/design/build/test/deploy/maintain） |

> **归属字段的时序语义（重要）**：`cycle`/`phase` 描述的是**调用发生那一刻**的流程坐标，
> 不是**你读取响应那一刻**的坐标。同一调用在不同时刻查询得到**相同**归属（值在事件到达时
> 沉淀进记录）；若某条记录缺这两个字段，说明当时**无法无歧义地确定工作区**——宿主
> **刻意不兜底**（多会话宿主上用 `process.cwd()`/首条注册表项会归错工作区 = 伪造）。

### FeedDiagnostics 五计数（排障语义：feed 空时区分「事件没到」与「到了被过滤」）

| 字段 | 说明 |
| --- | --- |
| `sessionEvents` | 订阅后看到的 session/event 事件总数（任意类型） |
| `sessionToolCalls` | 其中 `tool/call` 事件数（任意工具名） |
| `toolsResults` | `tools/result` 事件总数（任意工具） |
| `anicCalls` | 通过过滤、进入 feed 的开始相位数 |
| `anicResults` | 结束相位到达且 feed 内有对应记录的次数 |

全 0 = 事件没到（宿主未派发/监听未接线）；`sessionToolCalls>0` 但 `anicCalls=0` = 到了但被过滤（调用不属本插件能力面）。两者排障动作不同。

### 语义要点

- **过滤面**：`isAnicInvocation` = 工具名 `anic_*` 前缀，或工具名 `skill` 且参数 JSON 解析后 `name === 'ai-native-iteration-cycle'`（解析失败回退子串——误报优先于漏报）。
- **per-host 进程语义**：feed 是宿主进程内存态——主宿主的调用只出现在主宿主本路由的响应里，测试宿主看不到（cycle-47 实证：双宿主并行时各自计数独立）。跨进程调用史查 flow-tracker（磁盘持久化）。
- **协议三态**：新字段（`diagnostics`/`resultPreview`）缺省=旧宿主（渲染层跳过不伪造）；`diagnostics: null`=路由已知无数据。客户端契约见 [UI功能域与界面组件规划.md](UI功能域与界面组件规划.md) §2.6-§2.11。
- **本端点无工作区依赖**（实时缓冲在内存，不读磁盘工件）。与 flow-tracker（`.cycles/flow-tracker.json`，持久化调用史）互补：invocations/live 是**当下**的环回窗口，flow-tracker 是**持久**的审计记录。接线细节见 [可观测性与轨迹可见性.md](可观测性与轨迹可见性.md)。

| 码 | 条件 | 体 |
| --- | --- | --- |
| 200 | feed 可用 | 环回缓冲快照 |
| 500 | `feed` 为 null（插件装配未传入） | 诚实失败，不伪造空列表 |

## 6. POST `/anic/api/reload`

| 项 | 值 |
| --- | --- |
| 路径常量 | `hotReloadRoute.ts` 的 `HOT_RELOAD_ROUTE` |
| 注册签名 | `registerHotReloadRoute(ctx, { send, getWorkspaceRoot })` |
| 聚合位置 | `src/host/routes/index.ts`（runtime 域） |
| 同源实现 | 与工具 `anic_reload_self` 共用 `runtime/hotReload.ts` 的 `reloadSelf`（单一实现） |

**运维/外部触发插件热重载**（cycle-80）：本插件是 `link:` 安装，`dist/` 正是宿主 hmr 服务
`reconcileProfile` 命中的 linked package target。新 dist 部署后，本端点让「改完代码生效」不必
进模型会话，也不必人工重启宿主。

**请求体**（可选字段，均可省略）：`{ reason?: string, force?: boolean, requiredIds?: string[] }`。
`reason` 会写入 `.cycles/reload-history.json`；`force` 仅测试/演示用（dist 已最新时仍重载）。

### 响应体与状态码

| 码 | `action` | 含义 |
| --- | --- | --- |
| 200 | `scheduled` | 已受理并调度重载（重载异步执行；200 = 请求被接受） |
| 409 | `unavailable` | 当前 profile 无 hmr 服务（headless/SDK）——**零写入**，不假装成功 |
| 412 | `refused` | 前置条件不成立：dist 已最新，或史账不可写（无审计证据则不重载） |
| 404 | — | 解析不到工作区（与其余路由同口径） |
| 500 | — | 重载编排抛错（响亮失败，不返回半截结论） |

体形状（`ReloadResult` + 回显）：`{ action, reason, fromRevision, stale, handshake,
revision?, scheduledAt?, history?, workspace, requestId }`。

### 跨实例 in-flight 握手（为什么 200 不代表「已重载」）

重载会卸载/替换本实例，**事后没有进程能补写「我请求过重载」**。因此顺序被钉死：
①先写 `status:'in-flight'` 进 `.cycles/reload-history.json` → ②`setTimeout(0)` 触发
`ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile(requiredIds))`（不 await：续体可能永不执行）
→ ③新实例启动时 `finalizeInFlight` 把它改写成 `reloaded`（`toRevision` = 新 dist 指纹）。
**证据在史账里，不在响应里**——响应只说「已调度」。

`ctx.hmr` 只经 `ctx.get('hmr', false)` 可选探测，**绝不写进 `inject`**（headless profile 无 hmr，
硬 inject 会让整条 fiber pending，cycle-74 P0 教训）。只读投影见 `org-status.reload`
（`stale` / `revision` / 最近一次重载），它不触发任何重载。

## 7. POST `/anic/api/archive/baseline`

**归档基线重置**（cycle-83 产物治理）：把**全部可完成**的活跃循环批量移入
`.cycles/archive/`，让主视图以当前项目事实重新开始，而不是让 79 轮历史摊满面板。

**为什么是「移动」而不是「删除」**：账本是只追加哈希链（INV-9）。按 detail 删条目会让
后续所有 `previousHash` 指向幽灵，下一次 `verifyLedger` 必报 CHAIN_BREAK，整条链从此不可信。
归档**只移动目录，永不触碰账本**；历史不是被删除，而是被移出主视图（读侧同时认
`cycles/` 与 `archive/`，归档轮在快照里合成 1 个摘要节点继续可见）。

**请求体**（可选字段）：`{ dryRun?: boolean, includeIncomplete?: boolean, actor?: string }`。
- `dryRun: true` —— 只回报「将归档哪些轮 + 哪些留下及逐条原因」，**零写入**（不建 archive 目录）；
- `includeIncomplete` —— 默认 false：移动未完成的轮会让任务清单从活跃区消失，与"让当前事实清晰"相反；
- `actor` —— 写入审计记录 `archive/baseline-reset.json`（谁按的按钮）。

**准入判据（与 G1 共用同一任务行解析器）**：`total > 0 && pending === 0` 才算可归档。
`total === 0`（清单存在但零任务行）判 `empty-task-list`——**不可归档但不阻塞基线重置**，
且如实点名，不是静默 false（旧判据会让这类轮次永久不可归档）。

**响应体**：`{ ok, dryRun, archived[], kept[{name,reason,detail}], alreadyArchived, manifest, ledger{entries,chainHead,unchanged}, warnings[] }`。
`kept[].reason` ∈ `missing-cycle-dir` / `missing-task-list` / `empty-task-list` / `has-pending`。
`ledger.unchanged` 恒应为 true——它不是"我们试过没改"，而是**写前/写后两次只读读数的比对证据**。

| 码 | 含义 |
| --- | --- |
| 200 | 预览或真写完成（`ok` 由字段表达，不是 HTTP 层错误） |
| 400 | 参数形态错误（`dryRun`/`includeIncomplete` 非布尔、`actor` 非字符串）——**校验先于副作用** |
| 404 | 解析不到工作区（与其余路由同口径） |

**可重入**：重复调用是 no-op（`alreadyArchived: true`，`archived: []`），manifest 不产生第二条同名条目。

## 8. GET `/anic/api/archive/inventory`

**归档盘点**（只读）：活跃/归档清单 + 逐轮体积 + 可归档判定。

响应体：`{ active[{name,files,bytes,complete,reason}], archived[{name,files,bytes,archivedAt}],
sizes{activeBytes,archivedBytes}, archivable, blocked, manifest }`。
`complete=false` 时 `reason` 与上一条的 `kept[].reason` **同一判据**（同一函数产出，
不是两处各写一套）。

| 码 | 含义 |
| --- | --- |
| 200 | 盘点完成 |
| 404 | 解析不到工作区 |

## 相关文档

- 公共约定与端点总索引 → [API参考.md](API参考.md)
- 周期面（cycle / ledger / stack-probe / seg-ledger） → [API参考-周期面.md](API参考-周期面.md)
- 评审 / 进化 / 治理 / 原生脚本面 → [API参考-评审进化与治理.md](API参考-评审进化与治理.md)
- 自举 / 技能 / 安装 / 双自举面 → [API参考-自举与技能.md](API参考-自举与技能.md)
