# dsh-anic CHANGELOG

## v0.10.0 — 2026-10-17

R3 路线图阶段 3 后半：**archive 归档流程**（第 3 个专属流程状态机）+ 真实宿主验证揭出的两个 P0：**P0-GOV-ROOT**（4 条治理路由自 M5-a 起在真实宿主恒 400 空体——从未工作过）与 **P0-BODY 残留三处**。测试 684→713 用例（52→55 文件）。真实宿主验证：flows 注册表 3 流程、governance 4 路由复活（400→200）、J0 8/8。

### P0-GOV-ROOT：治理路由真实宿主整体死亡（cycle-8 发现并修复）

- **根因**：governanceRoute 的本地 `resolveRoot` 裸读 `ctx.workspaceRegistry` 属性 —— 真实 Cordis fiber 中该服务不在静态 inject（postmortem-0001 R2 同款），**属性访问本身抛异常** → dsh-host-webserver 统一 catch 后回 `400 空体`。**archive/budget/sweep/prune 全部 4 条治理路由自 M5-a 起在真实宿主从未工作过**。桩宿主 ctx 是普通对象（无 getter），属性访问不抛 → 测试全绿假象。快照路由的同款访问有 try/catch 包裹（snapshotRoute.ts:69-75），故该模式从未在其他路由暴露。
- **修复**：删除本地 resolveRoot，治理路由改用 `buildRouteContext` 共享 `getWorkspaceRoot`（cycle-3 硬化版）——顺带获得 X-ANIC-Workspace 桌面多会话纠偏。
- **实证**：真实宿主 budget/prune 400→200；POST archive list 返回 65 active 循环。

### P0-BODY 残留三处（cycle-6 修复清单的漏网）

- governanceRoute 的 archive/sweep 两 handler 与 selfInitRoute 的 `--name` 透传仍读 `req.body`（真实宿主恒 undefined → 体参数静默丢弃）。全部改 `readBody` 流式兼容；httpBodyStreaming +2 流式守卫钉死（sweep 用例走临时工作区——`removeEmptyDirs` 无条件运行，绝不能在真实 .cycles 上跑测试）。

### R3 阶段 3 后半：archive 流程（第 3 个专属流程状态机）

- **archiveEngine.ts**：技能 archive-cycle.mjs（146 行）逐字语义。isCycleComplete **与 G1 共用 gateArtifacts.parseTaskRows**（「G1 说完成、归档说没完成」分叉的根治面）；拒绝路径零文件系统写入；归档后账本逐字节不变（INV-9）；clean 数值序留新（keep 默认 5，只删 archive/ 子树——active 循环永不触碰）。
- **archiveFlow.ts**：IDLE→RUNNING→DONE/BLOCKED 状态机 + **BLOCKED→RUNNING 重试恢复边**（修复任务后重跑无需手动 reset——无此边时成功重跑的事件会被丢弃，状态机与引擎事实脱节）；守卫 engine-ok/engine-blocked 消费引擎裁决（INV-28：失败永远进不了 DONE）；script 模式消息 stdout 空时回退 stderr（技能 console.error 通道事实）。
- 接线：builtin.ts 聚合（3 流程）；flowsRoute +POST /anic/flows/archive/run；**第 16 个 DSH 工具 anic_flows_archive**；governanceRoute /anic/governance/archive 委托新引擎。
- **孪生夹具差分契约**（archiveDifferential 4 用例）：归档是写动作不能同目录双跑——两份相同夹具各跑一侧（spawn 真技能脚本 vs native 引擎），比对落盘归档目录与拒绝消息逐字相等。
- **旧 archiver.ts 删除**：阈值式批量判据与技能不同、扫描目录层级错误（.cycles 顶层而非 .cycles/cycles/——标准工作区恒空转）、无 clean/list；P0-GOV-ROOT 使其在真实宿主从未可达。死代码删除而非并存。

### 技能行为事实两则（差分测试逼出，忠实保留不美化）

- 归档成功的循环重跑报 `not found`（技能检查顺序：existsSync(源) 先于 existsSync(归档目标)——源目录已移走必先撞 not-found 分支）。
- 技能把错误打在 stderr（console.error）——script 模式消息需 stderr 回退。

### 验证

- typecheck exit 0；**run-tests ALL GREEN（55 文件 713 用例）**；smoke 19/19；validate 12/12；build 成功。
- 真实宿主（dsh 0.2.0-rc.2 web 3080）：flows 注册表 3 流程；archive list 65 active；cycle-999 双模式（native/script）拒绝消息**逐字相等**；BLOCKED→RUNNING 重试边现场触发；gate-check diff 回归 drift=null；**governance 4 路由复活**；J0 8/8 PASS。

## v0.9.0 — 2026-10-17

R3 路线图阶段 3 前半：**macroPhase 宏观循环流程**（第 2 个专属流程状态机）+ 两项 P2 债务收口（bandDetector Western Electric 8 规则逐字移植、multiAgentGate trustScore 语义对齐）。测试 632→684 用例（48→52 文件）。真实宿主验证：flows 注册表 2 流程、macro-phase 双模式 advance 消息与技能逐字相等、J0 8/8。

### R3 阶段 3：macroPhase 流程（各流程插件化 × 专属状态流转机 × 模块引擎）

- **macroPhaseEngine.ts**：PHASES 6 相表逐字同技能 workflow-state.mjs:17-28（plan[G0]/design[G0]/build[G1]/test[G2]/deploy[G3]/maintain[]）；advanceMacro 全语义（回退拒/同相拒/未知 target/非法当前相位/末相 final exit 0/门未过 exit 1 带 passed 名单/dryRun 零写入；失败路径零写入）；readGateResults 用技能「曾通过语义」（任一历史 PASS 放行——与 gateEvidence.latestConvergenceVerdicts 的「每门最新」刻意并存，不偷偷收紧）。
- **macroPhaseFlow.ts**：15 条前向边（5 邻接 advance + 10 跳相 jump:from:to）全带 phase-gates-passed 守卫；**禁回退由图形状承载**（全部 from 序 < to 序，无运行时回退检查）；native/script 双模式（script=workflow-state.mjs 正典写入者；守卫拒绝时 drift=true）；statusMacroPhase 只读（不复制技能 cmdStatus 的 inferPhase 回写——该回写对 deploy/maintain 永远推不出来，是技能侧缺陷不复制）；replayEvents 重建全等（INV-13）。
- **builtin.ts** 聚合（避免 gateCheckFlow←macroPhaseFlow 反向依赖）；flowsRoute +2 路由（macro-phase/status 只读 + macro-phase/advance）；第 15 个 DSH 工具 **anic_flows_advance**（target/mode/dryRun）。
- **孪生夹具差分契约**（macroPhaseDifferential 5 用例）：advance 是写动作不能同目录双跑——两份相同夹具各跑一侧（spawn 真技能脚本 vs native 引擎），比对落盘 workflow-state.json 逐字段全等。

### P2 双修

- **bandDetector WE 8 规则**（band-detector.mjs:117-203 逐字移植）：单点 3σ / 2-of-3 同侧 2σ / 4-of-5 同侧 1σ / 8 点中心线同侧 / 6 点单调 / 14 点交替 / 15 点 1σ 内（变异过小）/ 8 点 1σ 外（变异过大）；stdDev=0 或空序列短路；BandResult 增 weViolations（中文 desc 与技能同形）。
- **multiAgentGate trustScore 语义对齐**（multi-agent-gate.mjs:221-222）：`approve/total*100` → `Math.round(avgConfidence*100)`。行为变更（诚实方向）：全 approve 低置信度集从谎报 100 分变为诚实 60 分，升级判定更保守。

### 修复的两个缺陷（一个源码 + 一个测试设计）

- 源码：runMacroPhaseFlow dryRun 分支漏拼 `to`（dryRun 结果可观测性缺失）。
- 测试：replay 全等用例原设计「重置状态回 plan 再跑」会重复 plan→design 而非推进 design→build——改为连续两次推进（plan→design→build），事件序列 rebuild 后 rejected=[]。

### 验证

- typecheck exit 0；**run-tests ALL GREEN（52 文件 684 用例）**；smoke 19/19；validate 12/12；build 成功。
- 真实宿主（dsh 0.2.0-rc.2 web 3080）：flows 注册表 2 流程完整描述子；macro-phase/status 读真实验证场（complete/cycle-92/48 条相位史）；advance native 422 与 script 模式拒绝消息**逐字相等**（`Invalid current phase: complete`——技能 parity 现场实证）；dryRun-on-script 400；gate-check diff 回归正常；J0 8/8 PASS。

## v0.8.0 — 2026-10-17

R3 路线图阶段 2 落地：FlowRegistry/FlowMachine/ModuleEngine 流程状态机骨架 + gate-check 首个专属流程 + **P0-BODY 真实宿主请求体修复**（全插件 11 个 POST 路由的体参数在真实宿主被静默丢弃的 P0 缺陷）。测试 551→632 用例（42→48 文件）。真实宿主（网页端 3080）验证：三模式 flows 路由 + diff 双跑 drift=null（native/script 引擎逐字段语义全等现场实证）+ J0 8/8。

### P0-BODY：真实宿主 POST 请求体全丢失（cycle-6 发现并修复）

- **根因**：真实宿主 `dsh-host-webserver` 的 handler 收到原始 Node IncomingMessage —— body 以 'data'/'end' 事件流式到达，**宿主没有任何 body 解析层**（lib 源码逐字验证零命中）。旧 `parseBody` 只读 `req.body`（永远 undefined）→ **11 个 POST 路由的体参数在真实宿主全部静默丢弃**：flows 的 mode/gate/quality/record、skill/invoke 的 script/args、breakers 的全字段、tech-debt 的 results、self/iterate 的 maxRounds、ledger/append 与 seg-ledger/append 的 gate/result、cycle/init|advance|close 的参数。桩宿主测试直接挂 body 对象 → **全绿假象**（reviewRoute 的 `for await (chunk of req)` 是仓库内唯一正确先例）。
- **修复**：`routeContext.ts` 新增 `readBody(req, limit=1MB)` 双形态兼容 —— 桩宿主（req.body 对象/字符串）同步解析零改动；真实宿主（req.on 流式）收集 data 块至 end/error/close 或上限；损坏 JSON fail-safe {}。11 个 POST handler 全部改为 `void readBody(req).then(body => ...)` 异步分派。
- **回归守卫** `tests/unit/httpBodyStreaming.test.ts`（10 用例）：流式分片重组 / error settle 不悬挂 / 无 end 靠上限 settle / 路由级端到端（EventEmitter 假 req → breakers 字段真实进入熔断计算、tech-debt 分片 results 重组）。
- **发现途径**：真实宿主 POST mode=native 返回 mode=script —— 正是「真实环境验证」纪律抓住的 stub/real 契约分叉。

### R3 阶段 2：流程状态机引擎（FlowRegistry / FlowMachine / ModuleEngine）

- **架构分层**（`src/host/flows/`，docs/anic 06 状态机引擎设计落地）：
  - `contracts.ts`（L0）：FlowDescriptor{states,initial,transitions,persistence,engine?,scriptFallback?} / FlowTransition{from:S|'*',to,trigger,guard?} / GuardResult{ok,reason?,refusal?:'SELF_REFUSAL'} / ModuleEngine{lifecycle:'long'|'per-call',step,verify?}。四大纪律：guard 引用键禁内联闭包；apply 唯一写点；投影禁成第二真相源（INV-22）；引擎不持流程状态。
  - `machine.ts`（L1 纯函数）：validateDescriptor / findTransition（精确边优先通配）/ canTransition（未知守卫名 fail-closed 拒绝）/ applyTransition（唯一写点）/ replayEvents（事件 from≠折叠态 → rejected 不推进；replay 不跑守卫）—— **INV-13 replay(events) 与在线状态全等**。
  - `registry.ts`（L3）：registerFlow 非法描述子拒绝；同 id 首个胜出 + no-op disposer（ctx.skills.register 同款 HMR 语义）。
  - `persistence.ts`（L2）：投影唯一写者原子写；损坏/形状不对 → null 绝不部分采信；isProjectionStale 按 ledgerHead 指纹。
- **首个流程实例 gate-check**（`gateCheckFlow.ts` + `gateCheckRunners.ts`）：状态图 IDLE→RUNNING→PASSED/FAILED（RUNNING 自环崩溃恢复；PASSED/FAILED→reset→IDLE）；守卫 gate-verdict-all-pass/any-fail 消费引擎裁决负载（INV-28：FAILED 的引擎结果永远进不了 PASSED）。三执行模式：**script 正典**（技能脚本是账本正典写入者）/ **native 原生**（gateEngine 判定 + recordNative 与脚本 :204-214 同一去重语义入账）/ **diff 双跑对账**（双不写账本防双写，判定面取脚本侧正典，drift 字段报告分叉）。
- **原生引擎** `gateEngine.ts` + `gateArtifacts.ts`：G0-G3 + 质量门判定**逐字对齐技能 gate-check.mjs**（parseTaskRows / 裁决行正则 / 汇总表正则 / QUALITY_CHECKS 映射 / SKIP|行缺失=unevaluated 不能关门 / config 缺失 fatal）；**差分契约** `tests/contract/flowDifferential.test.ts`（5 用例：全绿/红/质量三态/config 缺失/单门，同 fixture 双跑逐字段比对 pass+detail）。
- **接线**：`src/index.ts` 第 4 个 effect（registerBuiltinFlows）；flows 域 3 路由（GET /anic/flows 注册表观测面 / GET /anic/flows/state 投影（无投影=null 不伪造）/ POST /anic/flows/gate-check/run）；第 14 个 DSH 工具 **`anic_flows_gate_check`**（toolsFlowsGateway.ts 一域一文件，mode=script|native|diff）。
- **真实宿主实证**：POST mode=diff → **drift=null**（native 与 script 引擎在真实 codegraph 工作区逐字段语义全等）；mode=native 正确到达；breakers 流式体字段真实进入熔断计算（consecutive_fix_fail tripped=true, action=pause）。

### 结构与守卫

- T3 结构守卫第三次拦人：gateCheckFlow.ts 256 行 > 250 → 按域拆出 gateCheckRunners.ts（引擎侧执行器层）而非放宽守卫。
- scriptParsers.ts 新增 parseGateLines（脚本输出 `[PASS] G0: ...` / 两格缩进质量行解析，与实跑输出验证）。
- snapshotRoute.test.ts 路由清单 +3（flows 三条，54 条）；effect 调用数 3→4。
- truthAuditChecks.ts walker ENOENT 容忍延续。

### 验证

```
typecheck   client 0  host 0
vitest      632/632  (48 test files)
smoke       19/19 ALL PASS
validate    12/12
build       dist/client.js + dist/host.js OK
真实宿主    flows 3 路由 + 三模式 + diff drift=null + breakers 流式体 + J0 8/8
```

## v0.7.0 — 2026-10-17

R3 路线图阶段 1 余量收口：HITL 四检查语义对齐（P0）+ 自主级决策落盘（P1）+ 真实性审计 walker 竞态修复。测试 504→551 用例（42 文件）。真实宿主（网页端 3080）端到端验证：维持路径（codegraph 工作区零写入）+ 降级写入路径（一次性夹具工作区 L4→L3 + 事故留痕）+ J0 8/8。

### HITL H1-H4 语义对齐（R3 阶段 1 余量 P0，对齐技能 hitl-audit.mjs:53-155）

- **旧四检查全部错位**：旧 H1=敏感文件名扫描（无 .gitignore 保护判定）；旧 H2=.gitignore 三字面量覆盖（实为技能 H1 的子检查）；旧 H3=diff 破坏性命令扫描（技能没有的检查）；旧 H4=verifyLedger 哈希链（技能 H4 的证据子项）。
- **重写 `host/governance/hitlAudit.ts`**（evaluateH1-H4 纯函数核心 + IO 包装）：
  - H1 敏感数据保护（技能 53-87）：变更文件（git diff HEAD~1 → 失败回退 git status --porcelain，技能同款回退链）命中 `['.env','credentials','secret','password','token','api_key']` 且未被 .gitignore 保护（basename/全路径两路）→ fail+熔断；.env 落盘独立通道。
  - H2 破坏性操作/回滚保障（技能 89-113 + 插件增强）：无破坏性短路 pass；>10 文件 fail；有变更无 git 历史 fail；**插件增强**：diff 新增行破坏性命令扫描（rm -rf/DROP TABLE/DELETE FROM/TRUNCATE/git push --force/git reset --hard）保留且优先报。
  - H3 门禁全绿 + 审计日志（技能 115-131）：无 cycle/无账本 fail；账本末 4 条 slice(-4) 须 G0-G3 全 PASS；最新 cycle 须有 审计日志.md。
  - H4 门禁裁决仲裁（技能 133-155 + 插件增强）：末 4 条 FAIL 且无 detail → 冲突 fail+熔断；**插件增强**：保留哈希链校验（INV-20），冲突优先于链断裂报告。
  - `HitlResult` 新增 `circuit: boolean`（对齐技能熔断语义）；`runHitlAudit` 返回 `{ checks, allPassed, anyCircuit }`。
- 新契约套件 `tests/unit/hitlAuditContract.test.ts`（26 用例）钉死对齐语义，任何一条被改回旧形态立刻变红。

### 自主级决策落盘（R3 阶段 1 余量 P1，对齐技能 org-status.mjs cmdAutoFallback:549-660）

- **新 `host/evolution/autonomyActions.ts`**：`runAutonomyFallback(workspaceRoot)` 完整流程 = collectBreakerSignals（cycle-4 八熔断采集层）→ checkBreakers → 地板判定（L1/L2 触发熔断也拒绝，技能 exit 1 对齐，判定先于 decideAction）→ decideAction → 降级写入 → **Post-Verify 回读**（技能 S-7 纪律：写入 → 回读 → 按回读事实判定，绝不无条件声称已降级）→ 事故留痕。
- 降级路径：L4→L3 / L3→L2 一步；事故文件 `incident-auto-fallback-<ts>.md` 对齐技能命名与内容结构（只陈述回读到的真实级别）。
- 无证据不动作（INV-28 精神）：零熔断信号 → maintained，config 与 incidents 均零写入（真实宿主实测 codegraph 工作区零写入）。
- 边界（登记于交付清单）：不把自主级事件写 gates/ledger.json（混入 AUTONOMY 条目会污染 H3 的 slice(-4) 门窗口——技能同款「两载体」缺陷，修复属 R3 阶段 2 FlowRegistry）；技能 Phase 1/2 诊断/自动修复（技能侧自身实现是坏的）R3 阶段 4 再补。
- **新 DSH 工具 `anic_autonomy_downgrade`**（第 13 个，`host/toolsEvolutionGateway.ts` 进化域网关一域一文件）：模型可调用 = 轨迹可见；动作有证据围栏。
- **新路由 `POST /anic/autonomy/downgrade`**（evolutionRoute.ts）：与 POST /anic/api/breakers 的纯决策视图互补——这是技能 cmdAutoFallback 的插件等价物（写入 + 回读 + 留痕）。

### 修复

- **真实性审计 walker 竞态（P2）**：`truthAuditChecks.ts` 的 collectTsFiles/countFilesRecursive 在并行 vitest 下 statSync 撞上 skillReplaceE2E 清理 tmp 夹具 → ENOENT 崩测试。walker 改为 ENOENT 容忍（消失中的条目跳过——消失的夹具不是真实性发现）。
- `snapshotRoute.test.ts` 路由清单契约 +1（/anic/autonomy/downgrade，48→49）。
- T3 结构守卫真实拦人记录：autonomyActions.ts 初版 254 行被拦 → 压缩头注释至 247 行（守卫不改，改代码）。

### 验证

- typecheck exit 0；validate 12/12；vitest 42 文件 551 用例全绿（+47：hitlAuditContract 26 + autonomyActions 21）；smoke 19 ALL PASS。
- 真实宿主（dsh 0.2.0-rc.2 web 3080）：`POST /anic/autonomy/downgrade` 两路径实测——codegraph 工作区 `{action:'maintained', currentBand:'L4', trippedBreakers:[]}` 零写入；一次性夹具工作区（L4 + human_override:true）`{action:'downgraded', observedBand:'L3'}` + config 改写 + incident-auto-fallback-*.md 落盘（磁盘事实验证）。J0 探针 8/8 PASS。

## v0.6.0 — 2026-10-17

R3 路线图阶段 1（L4 自主性执行点落地）：八熔断信号采集层 + SELF_REFUSAL 授权带 + 2×P3。测试 485→504 用例（40 文件）。真实宿主（网页端 3080）端到端验证 + J0 8/8。

### L4 自主性修复（R3 缺口矩阵 P0 两项收口）

- **八熔断信号采集层**（`src/host/evolution/breakerSignals.ts` 新建，133 行）：此前 `orgStatus.ts` 用 `DEFAULT_BREAKER_INPUT`（全零）喂 `checkBreakers`——8 条判定实现了但**输入恒零，真实工作区上熔断从未触发过**。现从真实文件采集（正则与技能侧 `org-status.mjs:25-82` CB1-CB8 逐字对齐）：CB1 `.cycles/incidents/` 文件名含 `auto-fix-fail` 计数→consecutiveFixFails；CB2 账本末 4 条 `result==='FAIL'` 且 detail 空/含 ambiguous→hasDoubt（包裹/裸数组双形态，损坏 fail-safe 归零）；CB3/CB4 文件名 `H1|H2`+`circuit`；CB5 band-history 末 2 条 `band==='alarm'`；CB6/CB7 config 原文 `/human_override:\s*(L3|true)/i` 与 `/session_timeout:\s*(\d+)/`；CB8 `circuit`>3 / `retry` 计数。**诚实性纪律**：`contextUsagePercent` 恒 0——宿主不向插件暴露上下文占用，没有来源就不伪造。
- **SELF_REFUSAL 授权带执行点**（`multiAgentGate.ts`）：`runGate`/`runAllGates` 新增 `options.currentBand`——卡片 `autonomyBand` 超出当前带的 agent **拒绝出裁决**（doubt/0 分/空证据，notes 前缀 `SELF_REFUSAL` + 中文说明）。此前 AgentCard.autonomyBand 字段存在且被校验 `/^L[1-4]$/`，但**全仓无代码把它与当前自主级比较**——L4 卡片在 L2 工作区照样投票。`nativeRoute.ts` 的 `POST /anic/multi-agent-gate` 从 config.yml（INV-25 唯一 loader）读 `autonomy_level` 传入；响应体新增 `currentBand` 字段。不传 currentBand 等价旧行为（向后兼容）。
- **P3 FlowTracker INVOKING 死值**：`startFlow` 现写 `'INVOKING'`（原直接 RUNNING），新增 `markRunning()` 幂等推进 INVOKING→RUNNING；`toolsSkillGateway.ts` 的 anic_skill 在 invokeSkillScript 前（spawn 分界）调用。docs/anic/17:103 声称的 INVOKING→RUNNING 两相跟踪首次真实落地；`activeFlows` 含 INVOKING+RUNNING。
- **P3 bandTrend 硬编码**：`orgStatus.ts` 的 trend 从硬编码 `'stable'` 改为 `detectTrend(bandHistory.map(e => e.score))`——`bandDetector.detectTrend` 早已实现却从未被接线（R3 双真相源审计 #10）。

### 测试与验证

- vitest **40 文件 504/504**（+breakerSignals 10 用例 +SELF_REFUSAL 6 用例 +flowTracker 两相 3 用例 +orgStatus 信号流入 2 用例；修复装卡瘦身 Map 假绿隐患——只装 {id} 的 Map 会让授权带断言因 `BAND_ORDER[undefined] > n === false` 静默假绿）。
- truthAuditChecks requiredFiles 补登 `orgStatus.ts`/`breakerSignals.ts`（真实性审计随结构演进同步）。
- 真实宿主（dsh 0.2.0-rc.2 web 3080，新 bundle 重启加载）：`GET /anic/org-status` → `currentBand=L4/configuredBand=L4`（config 读出）+ trend 由真实 band-history 推导；`POST /anic/multi-agent-gate` → `currentBand=L4` + `evidenceCounts={intent:1,spec:1,plan:1,pr:5,release:8}` + 真实裁决（release reject：cycle-99 缺审计日志.md 与非功能验证报告.md——真实工件缺失，未伪造 PASS）。
- **J0 探针 8/8 PASS**。
- gate-check `--record`：All gates PASSED（G0 16 rows / G1 8 tasks / G2 504 零失败 / G3 build passed + Q1-Q8 全过）。

## v0.5.0 — 2026-10-17

前端体验族 P1 全量收口 + 两大 P2 修复。测试 465→485 用例（+2 文件）。全部经真实宿主（网页端 3080）功能级验证。

### P1 修复（前端体验族）

- **P1-1 零响应式**：新建 `shared/panelCss.ts` PANEL_CSS 静态样式块（3442 字符）——容器查询（`@container` 640/420 断点）+ `:hover`/`:active`/`:focus-visible` 交互态 + `prefers-reduced-motion`/`forced-colors` 媒体逃逸 + `.anic-sr-only`；颜色全经 `var(--token, fallback)` 同源回退；与 `tokenCssBlock()` 同一 `<style>` 注入点。工具栏三按钮改 `.anic-btn` 类（smoke 三断言不变）。
- **P1-2 图键盘可达性（roving tabindex）**：169 个节点从各持 `tabIndex=0`（169 个 Tab 停靠点反模式）改为容器唯一停靠点 + 节点 `tabindex=-1`；新建 `features/graph/graphKeyboard.ts` 纯函数（ArrowRight/Down 前进环绕、Left/Up 后退、Home/End 首尾）；svg 根 `role='group'` + `aria-label`（含节点/边计数）+ `<desc>` 操作说明。真实宿主实测：svg.focus→ArrowRight→wf:plan→ArrowDown→wf:design→End→aux:auto→Home→wf:plan→Enter 打开详情抽屉。
- **P1-3 图文本替代**：新建 `features/graph/graphDataTable.ts` sr-only 数据表（caption + 174 行节点四列：id/类型/裁决/标签），与图渲染同源数据无第二份排序。
- **P1-5 org 数据丢失**：`renderOrgStatus` 补齐 ledger 分区（条目数 83 + 完整性校验 ✓/✕）+ 快照时间戳行 + `configuredSuffix`（配置级自主级 ≠ 运行级时显式标注）。
- **P1-7 autoRefresh 未接线**：面板 `flows['flow.autoRefresh']` → `useInvocations(pollMs=on?2000:0)`；关闭时不排定时器（pollMs<=0 守卫）；manualKey 支持手动重拉；`getHeaders` 函数式传参（对象入 effect 依赖会逐渲染重轮询——useRef 收窄）。
- **P1（i18n 收尾）**：客户端全部用户面文本经 `t()`——fetchLive 四分支/工具栏/分区标题/renderInvocations 状态文案/renderStepTrace（含死代码删除 `i===steps.length-1?null:null`）/renderDiagnostics/prefsDrawer（SOURCE_LABEL 表改 sourceLabelOf 函数）/renderOrgStatus 全量。

### P2 修复

- **P2 桌面多会话工作区纠偏**：`resolveWorkspaceRoots` 新增第 0 优先级 `X-ANIC-Workspace` 请求头（URL 解码→knownRoots 命中采信→未命中但含 `.cycles` 采信→否则静默回落原链——「选择器」不是「任意路径入口」）；`getWorkspaceRoot: (req?)` 签名贯通 snapshotRoute/stepTraceRoute/selfCheckRoute/nativeRoute；客户端 `workspaceRef` 从首个成功快照响应头学得工作区 + `wsHeaders()` 四 fetch 全带。真实宿主实测：头声明 dsh-anic 自身（registry 不知道它）→ 采信返回 32 节点；声明不存在路径 → 静默回落。
- **P2 子进程环境清洗（KB R19）**：`adapters/index.ts` 新增 `sanitizeEnv()`（键名命中 `/(KEY|SECRET|TOKEN|PASSWORD)/i` 剥除、undefined 跳过）；`exec.run` 的 spawnSync 传清洗后 env——宿主凭据不进技能脚本子进程。

### 测试与验证

- vitest **39 文件 485/485**（+adapters 8 用例 +snapshotRoute X-ANIC-Workspace 5 用例 +graphRoving 6 用例 +clientI18n 9 用例 等）。
- 真实宿主（网页端 3080，重启后新 bundle）：P1 全功能面 9 分区全在（toolbar/graphSvg/graphTable/live/stepTrace/diagnostics/org/nodeDetail/ledger 行）+ 键盘导航全链路 PASS + autoRefresh 开关 localStorage 持久化 PASS。
- **J0 探针 8/8 PASS**（标签可见/标签共存 4/遥测 registerCount=1/图渲染 174 圆 226 线/来源如实/热卸载恢复/kill-switch/开关恢复）。
- CORS 端到端：同源无 ACAO 头；公网 Origin 拒；回环 Origin 回显具体值 + `Vary: Origin`；任何情况下不出现 `*`。

## v0.4.0 — 2026-10-17

深度研究驱动的优化迭代：三路研究（docs/anic 差距矩阵 / DSH 官方规范取证 / context7 UI 规划）落地为 10 项 P0 修复 + 7 项 P1 + 文档体系 + 双端真实验证。测试 380→465 用例（+6 文件）。

### P0 修复（全部带回归测试）

- **P0-1 `purpose:'review'` 违反宿主闭合枚举**：`GenerateOptions.purpose` 收紧为 `'compaction'|'session-title'`（`dsh-llm types.d.ts:530`），评审传输不再传 purpose；归因走 ANIC 自有通道 `buildAttribution`（provider/model/promptDigest/evidenceIds，调用前可得）。
- **P0-2 多门评审恒 doubt**：`nativeRoute` 原空证据 map → 新建 `host/llm/gateEvidence.ts` 从真实账本（G0-G3 按 timestamp 取最新）+ 工件（intent/spec/plan 两代路径容差）+ 哈希链校验装配证据；fix-loop 的 verifyFn 从 `existsSync` 伪自信改为 `verifyLedger` + 收敛门全绿判定。真实工作区五门裁决：intent/spec/plan/pr approve、release 真实 FAIL（cycle-99 缺审计日志/非功能验证报告）。
- **P0-7 中文关键词判 PASS/FAIL**：`multiAgentGate` 删 `['通过','失败']`；`EvidenceItem.result` 结构化通道优先 + 语言中立标记（❌✗FAIL / ✅✓PASS）兜底；纯中文输入落 SKIP→doubt。
- **P0-8（工具）pr 门阈值**：`GATE_THRESHOLDS{intent:2,spec:2,plan:2,pr:3,release:3}` 对齐技能侧 `GATE_AGENTS`（原 pr 错为 2）。
- **P0-9（工具）空裁决集 NaN**：`aggregateVerdicts` 空集显式返回 `{verdict:'doubt',trustScore:0,passed:false}`（原 `0/0*100`=NaN 污染升降级、序列化成 null）。
- **P0-8（安全）CORS 通配符**：新建 `host/cors.ts` 默认拒绝+显式放行（回环正则锚定/环境变量 `ANIC_ALLOWED_ORIGINS`/工作区 `anic.allowedOrigins`）；配置 `*` 不重开通配符；绝不返回 `*`；17 用例含 13 种伪装来源攻击面。
- **P0（工程）typecheck 覆盖漏洞**：adapters/errors 从未被任何 tsconfig 覆盖 + 7 个类型错误潜伏 → include 修正（shared→client；host+adapters→host）+ `tests/contract/typecheckCoverage.test.ts` 穷举守卫（每个 src 文件恰好落一个 tsconfig）+ 证伪演练两条。
- **P0（i18n）客户端零 t()**：新建 `client/i18n.ts` 零依赖（JSON import + 回退链 当前语言→zh→键名 + {param} 插值）；locale 双语 +133 键。
- **P0（反馈）自举按钮零反馈**：四态（idle/running/ok/failed）+ aria-live 播报 + 409 已初始化语义修正（原误报失败）+ `features/selfinit/useSelfInit.ts` 特性模块。
- **P0（兼容）DSH 宿主下限真正生效**：`engines.dsh` 不被任何代码读取（兼容性门只读 peerDependencies 的 `@deepseek-ai/dsh*` 条目，`dsh-app-boot/lib/index.js:286-313`）→ peerDependencies 补 `"@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.4.0"`（semver 实测：写 `>=0.2.0` 会误杀 rc.2 宿主）。

### P1 修复

- **autonomy 双投影矛盾**（图 L4 vs org L2 硬编码）：`orgStatus` 读 `.cycles/config.yml`（INV-25 唯一 loader）+ `configuredBand` 字段；真实宿主复验 L4/L4 一致。
- **F39 错误码分派**：可重试码（CONTEXT_WINDOW_EXCEEDED 族）缩证据重试恰一次；不可重试码（QUOTA 族）标注；notes 记录重试轨迹。
- **T3 守卫真实拦人两次**：`reviewEngine` 303→196+134 行（拆 `reviewTransport.ts` 传输层）——「拆分而非放宽」。
- **SKILL.md 补 `whenToUse`**（`dsh-skill types.d.ts:52` 目录条目路由提示）。
- **交互态令牌**：`anic-surface-hover/active`（DECORATIVE）+ `anic-focus-ring`（NON_TEXT_ROLES，双档对比度实测 4.94/3.454）；contrastContract 穷举分类登记。

### 文档

- 新增三篇：`docs/agents/DSH多代兼容与双端适配.md`（兼容性门真实现/探测矩阵 D1-D8/双端差异实测/B1-B6）、`可观测性与轨迹可见性.md`（三通道/双相配对/诊断计数/验证记录）、`质量属性与全生命周期评审体系.md`（E/Q 维度/G0-G3/六项质量属性/五层金字塔）。
- `docs/agents/README.md` 文档地图 +3；G-IND 过时表述修正（机械守卫已存在）。
- `docs/anic/` 22 篇研究文档族入库；README 工具数 9→12 修正。

### 真实宿主验证（网页端 3080 + 桌面端 19387）

- 动态白盒三通道 PASS：宿主「轨迹」标签 + ANIC 面板实时调用 + feed API（anic_status 31ms t13/s1；diagnostics sessionEvents:14/anicCalls:1）。
- 裁决记录：`sessionEvents:0` ≠ scope 过滤问题（普通 `ctx.on` 正常收事件，勿加 `{global:true}`）。
- 桌面端：12 工具 + 路由 200 + ANIC 标签（用户确认）；新发现 P2——多会话宿主工作区解析取 sessions 首条 cwd。
- G0-G3 全过（gate-check --record 记账 `.cycles/gates/ledger.json`）。

### 验证

typecheck exit 0 · vitest **37 文件 465/465** · smoke 19/19 · validate 12/12 · build OK · 双端真实验证 PASS。

## v0.3.0 — 2025-01-30

技能内联 + 7 脚本原生插件化 + 双向自举 + 9 DSH 工具 + 透明性连通性增强 + 数据结构优化 + 适配器层 + 真实性审计（自举目标）。

### 真实性审计（T1-T4）
- `host/evolution/truthAudit.ts` + `truthAuditChecks.ts`：T1 真实性（22 必需目录/文件存在性检查）/ T2 准确性（src/test/agent/skill 文件计数 + 版本）/ T3 结构性（250 行模块限制 + 域分离）/ T4 逻辑性（路由注册 + index 导入 + 工具数 ≥9）。
- `dualBootstrap.ts` 评估权重 60% 基线 + 40% 审计分（真实性作为自举目标，用户 m04764）。
- GET `/anic/api/truth-audit` 路由 + 6 单元测试。
- vitest 147→153。

### 新增

- **技能内联**：`assets/skill/` 63 文件全量内联；`POST /anic/skill/install` 自动安装/更新（幂等版本比对）；`GET /anic/skill/status` 查询来源（workspace/repo/inline）；`resolveSkillScriptsDir` 三层混合查找。
- **7 原生等价物**：hitlAudit (H1-H4) / bandDetector / orgStatus / factBaseVerify / planSync / multiAgentGate (5门×3角色) / fixLoop (verify→diagnose→fix→re-verify)。7 路由注册。
- **双向自举**：`dualBootstrap.ts` DualBootstrapState {plugin, skill, crossProposals}；evaluatePluginSelf + evaluateSkillSelf + advanceDualBootstrap（不互相改码 R-31）。3 路由。
- **9 DSH 工具**：原 6 + anic_hitl + anic_install + anic_status。
- **透明性连通性**：面板新增 org status 全景区（cycle 列表 + 信任分 + 自主级 + 熔断 + 带检测 + 警告），并行 fetch 四数据源。
- **测试**：`tests/unit/native.test.ts` 20 例（bandDetector 2 + multiAgentGate 7 + fixLoop 3 + hitlAudit 2 + factBaseVerify 1 + planSync 1 + orgStatus 1 + skillInvoker 3）。
- **数据结构优化**：`snapshotCore.ts` cycleDirs.find O(n)→Map.get O(1) + nodes.some O(n)→Set.has O(1)（消除两处 O(n²) 热点）；`stateMachine.ts` parseWorkflowGraph 直接引用替代 find O(n)→O(1) + buildGraphIndex(nodeMap+predecessors) advance 热路径 O(n)+O(e)→O(1)。
- **适配器层**：`adapters/index.ts` FsAdapter/ExecAdapter/HttpAdapter 三接口 + createNodeAdapters 生产实现（Q5 架构约束：外部服务隔离，eval-runner PASS）。
- **模块化**：WorkflowGraphPanel.ts 303→~140 行，纯渲染提取至 `features/graph/renderGraph.ts`（155 行，12 §3.1 特性模块制）。
- **lint 脚本**：package.json scripts.lint = validate-dsh.mjs（Q7 修复）。

### 变更

- `package.json` version 0.2.0→0.3.0。
- `routes/index.ts` 注册 nativeRoute + skillInstallRoute + dualBootstrapRoute。
- `tools.ts` 6→9 工具。
- `WorkflowGraphPanel.ts` 新增 org status fetch + 渲染区。

### 验证

typecheck 0/0 · vitest 147/147 · smoke 19/19 · validate 12/12 · build OK。

## v0.2.0 — 2025-01-30

自举闭环 + 跨项目技能调用 + DSH 工具注册 + 结构优化。

### 新增

- **M7 自举闭环**：`host/selfBootstrap.ts` 状态机（IDLE→EVALUATING→GATE_CHECKING→FIXING→VERIFYING→CONVERGED/EXHAUSTED）+ `host/skillInvoker.ts` 15 脚本白名单 + 路径遍历防护 + 4 路由（self/evaluate + gate-check + iterate + status）。不自我改码（R-31），只产 tech-debt 提案。
- **M8 跨项目+DSH 工具**：`host/tools.ts` 6 DSH 工具注册（anic_evaluate / iterate / gate_check / bootstrap / snapshot / self_check），inject 扩展为 ['tools','webServer','sessions']；skillRoute 4 路由（skill/list + invoke + evaluate + iterate），支持 workspace 参数跨项目调用。
- **M9 结构优化**：routes/index.ts 从 135 行瘦身至 ~75 行纯组合层；提取 routeContext.ts（makeSend + getWorkspaceRoot + loadFlows 单一职责）；六域分区（data/cycle/review/evolution/governance/self）。

### 路由清单（34 条）

| 域 | 路由 | 数 |
|---|---|---|
| data | workflow-snapshot / step-trace / self-check / self-init | 4 |
| cycle | cycle/init+advance+close+state+list / ledger+append+verify / stack-probe / seg-ledger+init+append+verify | 13 |
| review | review | 1 |
| evolution | trust / autonomy / breakers / tech-debt | 4 |
| governance | archive / budget / sweep / prune | 4 |
| self | self/evaluate+gate-check+iterate+status / skill/list+invoke / evaluate / iterate | 8 |

### 验证

- typecheck 0/0 · vitest 127/127 · smoke 19/19 · validate-dsh 12/12 · build OK

---

## v0.1.0 — 2025-01-30

首个里程碑版本。从 v0.0.1（M0-① spike）演进至全功能面实现。

### 新增

- **M1 全功能面**：四路由（workflow-snapshot / step-trace / self-check / self-init）+ 三面板（图 / 步骤追踪 / 诊断）+ 九开关（三层：用户 prefs > 工作区 config.yml > 部署 bundle）+ 十五 agent 卡（5 门 × 3 角色）+ 配置唯一 loader + scoped logger + 四域错误码。
- **M2-a 运行时接管**：工作流状态机（前驱检查 + gate 需 approved）+ 哈希链账本（sha256 canonical 六字段键序 + 原子写 + 幂等查重）+ 多栈探测（node/cargo/python/go/generic）+ cycle 生命周期（init/advance/close）+ 9 路由。
- **M2-b 规模地基**：分段账本（head.json + seg-NNNNNN.jsonl 只追加，O(1) append）+ 4 路由。
- **M3 可视化完整版**：门禁三态色（PASS 绿 / FAIL 红 / doubt 黄 / pending 灰）+ FAIL 脉冲动画（prefers-reduced-motion 禁用）+ 控制带 2σ3σ 边框 + 节点点击详情抽屉。
- **M4 LLM 评审引擎（条件）**：ctx.get('llm', false) 探测（INV-24 不进 inject）+ 闭合 JSON 协议校验（INV-23 fail-closed → doubt）+ Tier-1 启发式降级（诚实标注「非模型评审」）+ POST /anic/review 路由。
- **M5 动态自主进化引擎**：TrustModel（信任度累积 → 自主级别推荐）+ AutonomyGovernor（8 熔断条件，先修复后降级）+ PatchEngine（技术债务提案，不自我改码）+ 4 路由。
- **M5-a 规模治理**：Archiver（归档旧 cycle，移动不删除）+ Budget（三级阈值预算检查）+ Sweep（清空目录与过期 .tmp）+ Prune（孤儿工件识别）+ 4 路由。
- **M6 通用性收口**：i18n 双语（zh + en）+ 版本升至 v0.1.0 + CHANGELOG。

### 路由清单（26 条）

| 方法 | 路径 | 里程碑 |
|------|------|--------|
| GET | /anic/api/workflow-snapshot | M1 |
| GET | /anic/api/step-trace | M1 |
| GET | /anic/api/self-check | M1 |
| POST | /anic/self/init | M1 |
| POST | /anic/cycle/init | M2-a |
| POST | /anic/cycle/advance | M2-a |
| POST | /anic/cycle/close | M2-a |
| GET | /anic/cycle/state | M2-a |
| GET | /anic/cycle/list | M2-a |
| GET | /anic/api/ledger | M2-a |
| POST | /anic/api/ledger/append | M2-a |
| GET | /anic/api/ledger/verify | M2-a |
| GET | /anic/api/stack-probe | M2-a |
| GET | /anic/api/seg-ledger | M2-b |
| POST | /anic/api/seg-ledger/init | M2-b |
| POST | /anic/api/seg-ledger/append | M2-b |
| GET | /anic/api/seg-ledger/verify | M2-b |
| POST | /anic/review | M4 |
| GET | /anic/api/trust | M5 |
| GET | /anic/api/autonomy | M5 |
| POST | /anic/api/breakers | M5 |
| POST | /anic/api/tech-debt | M5 |
| POST | /anic/governance/archive | M5-a |
| GET | /anic/governance/budget | M5-a |
| POST | /anic/governance/sweep | M5-a |
| GET | /anic/governance/prune | M5-a |

### 测试

- validate-dsh：12/12 PASS
- vitest：115/115 PASS（8 文件）
- offline-smoke：19/19 PASS
- typecheck：client 0 / host 0
- build：dist/client.js + dist/host.js OK
