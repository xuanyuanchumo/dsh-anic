# dsh-anic — AI-Native Iteration Cycle（DSH 插件）

ANIC 技能（`.dsh/skills/ai-native-iteration-cycle/`）插件化的**独立工程**。可行性研究、
需求分析、架构与里程碑见 [`docs/anic/`](../docs/anic/)（README + 01–17 + spike 报告）。

> 定位：通用插件（零项目假设）。本仓库只是它的第一个验证场——快照数据来自本仓库真实的
> `.cycles/`，但生成器只读结构化字段（INV-21 合规），不解析自由文本。

## 安装（DSH ≥ 0.2.0-rc.2，网页端与桌面端）

```sh
dsh plugin --profile <你的 profile> add github:<owner>/dsh-anic
```

安装后重启对应宿主（bundle 在启动时装载），会话页即出现 `ANIC` 顶层标签。插件声明
`engines.dsh: ">=0.2.0-rc.2 <0.4.0-0"` 与 `peerDependencies: @deepseek-ai/dsh`——
宿主不在该范围时 pnpm 会先拒绝。首次使用时插件会把内联技能（`assets/skill/`，含
SHA-256 安装清单）自动安装到工作区 `.dsh/skills/ai-native-iteration-cycle/`；`anic_install`
工具与 `POST /anic/skill/install` 路由提供等价的显式安装 / 状态查询 / 损坏修复入口。

- 19 个 `anic_*` LLM 工具（评估 / 门禁 / 自举 / 流程状态机 / 技能网关 / 完整性修复）
- 62 个 HTTP 路由（六域分区：data / cycle / review / evolution / governance / self）
- 白盒面板：工作流图 + 实时调用流 + 自主级仪表带 + 技能健康 + 门禁账本 + HITL 队列

截图见 `docs/screenshots/`（市场详情页通过仓库根 `screenshots.json` 自动展示）。

### 不用 DSH？技能-only 分发（npx）

Claude Code / Codex / 任意 MCP 客户端用户可不装宿主，一条命令把技能装进项目：

```sh
npx dsh-anic init <project-dir> --name "<项目名>" [--framework claude|codex] [--dry-run]
```

只做两件事（「插件装引擎，入口装工作流」）：① `assets/skill/` 65 文件 → `<project-dir>/.dsh/skills/ai-native-iteration-cycle/`（与插件内 `anic_install` 同构落点，含幂等与版本锚点检测）② `.cycles/` 工作流骨架脚手架。之后让模型读 `SKILL.md`，或把 `scripts/mcp-server.mjs`（15 工具）注册为 MCP server。零依赖，`--dry-run` 只打印不写盘。


## 当前形态（M1..M11 + R3 流程状态机，v0.17.0）
- **布局根解析统一 + 自举链双缺陷根除（v0.17.0 / cycle-15，P0-DIR-ROOT/D-1415）**：真机验证暴露 truthAuditRoute 的 `resolve(file,'../../../')` 在 dist 单文件布局下审计了**仓库父目录**（T1-T4 全 MISSING、version vunknown——且源码布局下也错，两种布局从未正确工作过；旧测试只断言路由注册故恒绿），dualBootstrap 同病。新建 `src/host/pluginRoot.ts` 标记驱动向上查找（package.json name=dsh-anic），四处调用点（truthAudit/dualBootstrap/agents/skill）统一，根未解析双路由显式 500；pluginRoot 9 用例双布局钉死 + truthAuditRouteBehavior 行为级回归钉（T2 version=真实版本、15 cards——修复前必红）。真机复验 truth-audit **T1-T4 全 100**、dual-evaluate 双向真实数据。收口期再抓两枚同型漏网：band-detector.mjs:141 越界变量 `v`（ReferenceError——规则 2 首真触发即崩，历史快照统计量漂移使其「时好时坏」）+ eval-runner checkComplexity `|| true` fail-open（D-1404 漏网同型）→ execFileSync 直跑非零取 stdout。E1/E2 自举诚实化（intent 模板桩 → 真实三件套）。自举评估 **15 PASS + 1 结构性 SKIP**（历史最佳）；71 文件 863 用例全绿。
- **自举评估链主平台复活（v0.16.0 / cycle-14，D-1401~D-1408）**：eval-runner 的质量门在 Windows（DSH 宿主主平台）上此前系统性失明——四子检查 `grep|wc` shell-ism 恒 SKIP、环检测 madge 恒 SKIP 且真环被 `|| true` 吞掉（fail-open）、依赖审计 npm audit 无 true 命令恒 SKIP、秘钥扫描 138 命中全假阳性（design-token 惯用形态误伤）。本轮全部根治：scanSourceLines 纯 Node 行扫描、importGraph 纯 Node import 图 + DFS 三色环检测（scripts/lib/importGraph.mjs，零外部依赖）、pnpm audit 回退链（npmmirror 无 bulk 端点 → registry.npmjs.org）、秘钥两段式精筛（pre 粗筛 + 紧邻赋值精筛）。供应链修复：tinypool critical×2 + valibot high（全 dev 链）经 pnpm-workspace.yaml overrides 清零（824 包污染锁 → 239 包）。**自证闭环**：修复后首次真实环检测在自家仓抓到 truthAudit↔truthAuditChecks 真环（type 回边），类型下沉 truthAuditTypes.ts 断环复验 PASS。自举审计 16 维度 14 PASS + 2 结构性 SKIP（历史最佳）；69 文件 852 用例全绿。

- **双格式报告解析 + 抖动加固（v0.15.0 / cycle-13，D-1103/F-T1/F-T2）**：auto-fix 报告计数此前只认旧键值「失败：N」，而正典模板与 G2 门禁规定的是 §2 汇总管道表「| 失败 | N |」——两套正典解析器互不相交，正典报告被读成 0（fail-open 假绿）；现技能脚本（auto-fix-loop.mjs v1.8.5-fork）与原生引擎（autoFixAnalyze.parseReportContent）双侧支持管道表优先 + 键值回退，且引擎侧重复解析器消重为单一源；差分第 4 场景红→绿实证（命令过 + 正典报告 3 失败 → 双侧 circuit/exit 2/repeating），真实宿主（3080）script 模式端到端 409 circuit。F-T1：atomicWriteFileSync rename 瞬时错误重试（EPERM/EACCES 类，1/5/25ms 退避）；F-T2：macroPhaseDifferential 补 afterEach 清理（原先每轮泄漏 ~20 个临时目录）。69 文件 849 用例全绿。

- **终态重入四流程修复（v0.14.0 / cycle-12，D-1101）**：task 型流程终态后可重新入轮——gate-check（PASSED/FAILED→RUNNING）、archive（DONE→RUNNING）、hitl（PASSED/FAILED→RUNNING）三流程补 run 边，macro-phase 经正典比对排除（maintain 是末相无 reset 语义）；`tests/unit/flowTerminalReentry.test.ts` 四层 9 用例（描述子齐全性/机器层放行/集成层二轮/排除钉）。**桌面端宿主实证（D-1102）**：桌面宿主上插件 fiberPhase active、anic_* 工具真实执行、org-status/workflow-snapshot 路由 200、plugin_manager 禁用→启用往返无 duplicate-route（R12 HMR 安全性真机实证）；v0.13.0+ 新面受 Node 模块缓存限制需宿主自然重启生效。67 文件 837 用例全绿。

- 客户端贡献：`conversation.view` 顶层标签 `ANIC`（`kind:'list'` 可叠加，不顶掉既有标签）。
- 渲染真实 `.cycles/`：138 节点 / 164 边 / 57 cycles / 56 条账本事件（`autonomy L4`）。
- 流程状态机（R3）：FlowRegistry 5 流程（gate-check/macro-phase/archive/hitl/auto-fix）专属状态机 + 模块引擎；面板 flows 分区实时可视化；Tier-2 多智能体 LLM 评审通道（真模型逐门逐角色）。
- 零 bundle 依赖（react 之外全部外置或内联）；SVG 渲染，无布局引擎。

### M1 四路由 + 三面板区 + 九开关 + 十五 agent 卡

| 域 | 路由 / 面板 | 说明 |
|---|---|---|
| **V 可视化** | `GET /anic/api/workflow-snapshot` | 现场构建快照（与嵌入快照共用 `snapshotCore.ts`），no-store + CORS + digest 头 |
| **W 白盒** | `GET /anic/api/step-trace` | 四源投影（workflow-graph × state × ledger × cycle 工件）；cycle 归属只用位置法（INV-27） |
| **自检** | `GET /anic/api/self-check` | 6 探针（INV-13 确定性 / INV-21 结构化 / INV-25 配置单入口 / agent 卡装载 / INV-18 投影可重算 / INV-26 只读） |
| **B 自举** | `POST /anic/self/init` | flow.selfInit 门控；定位技能 init-workflow.mjs 并 spawnSync；幂等（已有 config→409） |
| **面板** | 工具栏三动作 | 刷新（data-anic-refresh）/ 偏好抽屉（data-anic-prefs-toggle）/ 自举（data-anic-self-init） |
| **开关** | `src/shared/flows.ts` | 9 flow 开关三层合并（user prefs > workspace config > deployment > 默认 true）；核心链路不可关（INV-29） |
| **agent** | `assets/agents/*.json` | 5 门 × 3 角色 = 15 张资产卡（闭合 JSON 输出协议 + evidenceIds 禁编造 + doubt 语义，INV-23） |

### M2-a 运行时接管：状态机 + 账本 + 多栈 + cycle 生命周期

| 域 | 路由 / 模块 | 说明 |
|---|---|---|
| **F1 状态机** | `host/runtime/stateMachine.ts` | parseWorkflowGraph / initState / advance（前驱检查 + gate 需 gateApproved）/ checkStrict |
| **F2 账本** | `host/runtime/ledger.ts` | 哈希链（sha256 canonical 六字段键序）/ appendEntry 原子写 / verifyLedger / isDuplicate 幂等查重 |
| **F3 多栈** | `host/runtime/stackProbe.ts` | 探测 node/cargo/python/go/generic → 生成建议 config.yml |
| **F8 cycle** | `host/runtime/cycleRunner.ts` | initCycle / advanceCycle（状态机 + 账本）/ closeCycle（严格门禁 + 账本验证）/ listCycles 数值序 |
| **F15 单写者** | `POST /anic/api/ledger/append` | 幂等查重 + 哈希链追加；与 tool 面同一路径 |
| **路由** | 5 cycle + 3 ledger + 1 stack-probe | `POST /anic/cycle/{init,advance,close}` + `GET /anic/cycle/{state,list}` + `GET /anic/api/ledger` + `POST /anic/api/ledger/append` + `GET /anic/api/ledger/verify` + `GET /anic/api/stack-probe` |

- **配置管理**：`host/config.ts` 唯一 loader（canonical `.cycles/config.yml` → legacy `cycle-config.yml` 告警 → 缺失响亮，INV-25）。
- **日志错误**：`host/logger.ts` scoped 前缀 `[dsh-anic]` + requestId 贯穿；四域错误码 `ANIC_{ROUTE|FETCH|RENDER|CONFIG}_*`；诊断域隔离（插件错误永不写 `.cycles/incidents/`，INV-26）。
- **原子写**：`shared/fs-safe.ts` write-then-rename（INV-7 前置）。
- **M2-b 分段账本**：`host/runtime/segmentedLedger.ts` head.json + seg-NNNNNN.jsonl 只追加（O(1) append，消除单文件 O(n²) 重写）；4 路由 init/append/verify/read。
- **M3 可视化完整版**：`client/features/graph/gateColors.ts` 三态色（PASS 绿/FAIL 红/doubt 黄/pending 灰）+ FAIL 脉冲 CSS（prefers-reduced-motion 禁用）+ 控制带 2σ/3σ + 节点详情抽屉；`renderGraph` 接受 verdicts map + onNodeClick。
- **M4 LLM 评审引擎（条件）**：`host/llm/reviewEngine.ts` probeLlm（ctx.get('llm', false)，INV-24 不进 inject）+ 闭合 JSON 协议校验（INV-23 fail-closed → doubt）+ Tier-1 启发式降级（诚实标注「非模型评审」）；`POST /anic/review`。
- **M5 动态自主进化引擎**：`host/evolution/trustModel.ts` 信任度累积（阈值 L2→L3 ≥70 / L3→L4 ≥85）+ `autonomyGovernor.ts` 8 熔断（先修复后降级）+ `patchEngine.ts` tech-debt 提案（不自我改码 R-31）；4 路由。
- **M5-a 规模治理**：`host/governance/` Archiver（移动不删除）+ Budget（三级阈值）+ Sweep（删空+过期 .tmp）+ Prune（孤儿检测）；4 路由。
- **M6 通用性收口 v0.1.0**：i18n 双语（zh + en，panel/flows/gate 三域）+ CHANGELOG.md + private:false。
- **M7 自举闭环**：`host/selfBootstrap.ts` 状态机 IDLE→EVALUATING→GATE_CHECKING→FIXING→VERIFYING→CONVERGED/EXHAUSTED + `host/skillInvoker.ts` 15 脚本白名单 + 路径遍历防护；4 路由。
- **M8 跨项目+DSH 工具**：`host/tools.ts` + `toolsPointerGateway.ts` + `toolsSkillGateway.ts` + `toolsEvolutionGateway.ts` + `toolsFlowsGateway.ts` 共 16 DSH 工具（anic_evaluate/iterate/gate_check/bootstrap/snapshot/self_check/hitl/install/status/skill/bootstrap_cycle/bootstrap_analyze/autonomy_downgrade/flows_gate_check/flows_advance/flows_archive）+ skillRoute 4 路由；inject=['tools','webServer','sessions','skills']。
- **M9 结构优化**：`host/routes/routeContext.ts` 提取共享依赖 + `routes/index.ts` 瘦身至 ~75 行纯组合 + 六域分区（data/cycle/review/evolution/governance/self）。
- **M10 发布 v0.2.0**：CHANGELOG + README + package.json 0.2.0。
- **M11 技能内联+原生等价物+双向自举**：`assets/skill/` 63 文件内联（安装即用）+ `skillInstallRoute` 自动安装/更新 + 7 原生模块（hitlAudit/bandDetector/orgStatus/factBaseVerify/planSync/multiAgentGate/fixLoop）+ `dualBootstrap.ts` 双向自举（插件⇄技能）+ org 面板。
- **真实性审计（自举目标）**：`host/evolution/truthAudit.ts` + `truthAuditChecks.ts` — T1 真实性（文件存在）/ T2 准确性（计数+版本）/ T3 结构性（250 行模块限制）/ T4 逻辑性（路由注册+工具数）；`dualBootstrap` 评估权重 60% 基线 + 40% 审计分；GET `/anic/api/truth-audit`。
- **数据结构优化**：snapshotCore O(n²)→O(n)（Map 替 find/some）；stateMachine O(n)→O(1)（buildGraphIndex nodeMap+predecessors 邻接表）。
- **适配器层**：`adapters/index.ts` — FsAdapter/ExecAdapter/HttpAdapter 三接口隔离外部依赖（Q5 架构约束，eval-runner PASS）+ spawnSync env 清洗（`*KEY*/*SECRET*/*TOKEN*/*PASSWORD*` 剥除）。
- **模块化**：WorkflowGraphPanel 303→~140 行，纯渲染提取至 `features/graph/renderGraph.ts`（155 行）。
- **P0-BODY 真实宿主请求体修复（v0.8.0）**：真实宿主 webServer 的 handler 收到的是 Node IncomingMessage 流（`dsh-host-webserver` 无 body 解析层），旧 `parseBody` 只读 `req.body` → 11 个 POST 路由的体参数在真实宿主**全部静默丢弃**（桩宿主挂对象故测试全绿）。修复：`routeContext.ts readBody()` 双形态兼容（桩对象同步 / 流式 on('data')/'end'/'error'/'close' 收集 + 1MB 上限），11 个 POST handler 全部改造；回归守卫 `tests/unit/httpBodyStreaming.test.ts`（流式分片/error settle/上限/路由级端到端）。
- **R3 阶段 2 流程状态机引擎（v0.8.0）**：`host/flows/` — `contracts.ts`（L0：FlowDescriptor/FlowTransition/GuardFn 引用键禁内联闭包/ModuleEngine long|per-call）+ `machine.ts`（L1 纯函数：apply 唯一写点/replayEvents 崩溃恢复 INV-13/未知守卫 fail-closed）+ `registry.ts`（L3：同 id 首个胜出 no-op disposer，HMR 语义）+ `persistence.ts`（L2：投影唯一写者原子写，禁成第二真相源）+ `gateCheckFlow.ts`（首个实例：IDLE→RUNNING→PASSED/FAILED，守卫消费引擎裁决 INV-28）+ `gateCheckRunners.ts`（script 正典/native 原生/diff 双跑对账，双不写账本防双写）+ `gateEngine.ts`/`gateArtifacts.ts`/`gateTypes.ts`（G0-G3 判定逐字对齐技能 gate-check.mjs）；3 路由（GET /anic/flows、GET /anic/flows/state、POST /anic/flows/gate-check/run）+ 第 14 个工具 `anic_flows_gate_check`；**差分契约** `tests/contract/flowDifferential.test.ts`（同 fixture native vs script 逐字段全等）+ 真实宿主 diff 模式 drift=null 现场实证。
- **R3 阶段 4 前半 Tier-2 LLM 评审通道（v0.11.0）**：`multiAgentTier2.ts` 逐门逐角色真模型评审（证据接地 INV-23 幻觉引用过滤 + 授权带越界不烧配额 + 单角色失败独立降级）+ `llm/jsonExtract.ts`（围栏/花括号平衡扫描，闭合 schema 不放松）+ `llm/providerResolve.ts`（宿主无名 default 事实下的诚实解析）+ LlmChunk/GenerateOptions 契约按 dsh-llm 权威类型重写（systemPrompt 槽位 + ContentBlock[] + reason.failure 终点）+ `GET /anic/flows/status` 一站式 + 面板 flows 分区（第 10 开关）+ org band.weViolations（rule:number）接线；真机 15 角色全走真 LLM 通道实证（MISSING_CREDENTIAL 诚实终态）。
- **R3 阶段 4 后半 HITL 三段修复流程（v0.12.0）**：`host/governance/hitlFix.ts`（H1-H4 修复器逐字对齐技能 hitl-audit.mjs：H1 .gitignore 模式族追加 / H2 git init 基线或拒绝 / H3 指向 gate-check 或建审计日志 / H4 append-only 永拒——改历史毁哈希链）+ `hitlThreePhase.ts`（Phase0 全审计落审计行 → 无熔断二元判定 → Phase1 仅熔断门修复 → Phase2 全修复成功才重审；fix 失败不重审不落 incident）+ `flows/hitlFlow.ts`（**第 4 流程状态机**：IDLE→RUNNING→PASSED/FAILED/BLOCKED，BLOCKED→RUNNING 重试恢复边；投影 `flows/hitl.json`）+ 路由 `POST /anic/flows/hitl/run`（状态码语义 pass→200/fail→422/circuit→409）+ 第 16 工具 `anic_flows_hitl` + 面板 flows 分区卡片；**存量 P1 连带修复**：`latestCycleDir` 绝对路径 bug（H3 审计日志检查自 cycle-5 起从未工作过）+ J0-2 遥测陈旧（`syncTelemetryCounts`——live 到达后遥测如实反映渲染面，「渲染=遥测」强不变量）；差分契约 `tests/contract/hitlDifferential.test.ts`（孪生夹具 native vs script 逐字节/逐字段对账）；真机双模式实证（BLOCKED/exit 2/suggestedNextStep=autonomy-fallback，面板卡片实时态）。
- **R3 阶段 5 自动修复循环流程（v0.13.0）**：`evolution/autoFixAnalyze.ts`（纯函数：报告计数解析/失败识别/repeating-cascading-transient 三模式，技能 mjs:57-140 逐字）+ `autoFixEngine.ts`（IO+编排：test→失败识别→retest→判定主循环 + onProgress 逐轮回调）+ `autoFixReport.ts`（落盘三件：审计行/incident/修复报告）+ `flows/autoFixFlow.ts`（**第 5 流程状态机**：IDLE→RUNNING→ITERATING↺→CONVERGED/CIRCUIT；ITERATING 自环轨迹进投影历史——迭代过程可回放；终态重入边 CONVERGED/CIRCUIT→RUNNING——真机发现「终态不可重入」框架级 P1 后当场修复）+ 路由 `POST /anic/flows/auto-fix/run` + 第 17 工具 `anic_flows_auto_fix` + 差分孪生契约；**双 fork 修复（上游技能缺陷）**：H3 per-gate-latest（gate-check 去重×末4条窗口互斥——cycle-10 发现的结构性误熔断，双侧同步修）+ auto-fix-loop readdirSync 未 import（test-reports 目录存在时 ReferenceError，真机复现修复）；**面板轮询修复**（`usePolledSection.ts`）：org/flows 分区从静态单拉改 4s 轮询——POST 后 6s 内卡片 CIRCUIT→CONVERGED 实时更新实证（动态白盒补全）。
- 冒烟 19/19 PASS · 规范门 12/12 · vitest 153/153 · typecheck 0/0 · **v0.3.0**。

## 热加载与热更新（三层机制）

| 层 | 机制 | 生效方式 |
|---|---|---|
| **bundle 热更新** | `link:` 安装（Junction 指向本工程）——宿主加载的就是 `dist/client.js` 本体 | `pnpm --dir dsh-anic run build:watch`（tsdown `--watch` 重建 + 自动重 wrap）→ 保存源码 → 浏览器刷新即生效；**无需重装/重启宿主** |
| **数据热更新** | 宿主路由现场构建快照 + 面板 live fetch + 「刷新」按钮 | `.cycles/` 一变（新 cycle/新账本事件），点刷新即见；路由不可用时自动回退嵌入快照 |
| **运行时热卸载** | 遥测句柄 + kill-switch | DevTools：`__ANIC_TAB_SPIKE__.unregister()` / `.reregister()`；`localStorage['anic-workflow-tab']='off'` 零注册 |

## 构建

```bash
pnpm --dir dsh-anic run snapshot      # .cycles/ → src/client/workflowGraphData.ts（已生成）
pnpm --dir dsh-anic run typecheck     # client + host（0 错误）
pnpm --dir dsh-anic run build         # dist/client.js + dist/host.js
pnpm --dir dsh-anic run build:watch   # 热更新开发模式（watch + 自动重 wrap）
pnpm --dir dsh-anic run test          # 全链离线测试：规范门 12 + vitest 147 + 冒烟 19
```

> typecheck/build 依赖父工作区 `node_modules`（typescript/tsdown/@types/react 走目录向上解析）。

## 测试体系

四层金字塔（`node scripts/run-tests.mjs` 一条命令，fail-fast，`--only=<id>` 单跑）：

| 层 | 命令 | 内容 | 数量 |
|---|---|---|---|
| L1 规范门 | `pnpm run validate:dsh` | C1-C12 DSH 清单/exports/locale/icon/产物契约（依据 docs/anic/07 §2 asar 取证，每条注出处） | 12 |
| L2 单元 | `pnpm run test:unit` | snapshotCore + snapshotRoute + runtime（ledger/stateMachine/stackProbe/cycleRunner）+ segmentedLedger + reviewEngine + evolution + governance + native + dshConformance | 132 |
| L3 契约守卫 | （同上，vitest 内） | 源码形状守卫：register 原型形态（禁未绑定提取，放行 disposer 捕获）/inject 回调形态/disposer 不丢弃/遥测+kill-switch/src 零 console.*；**反向自检 + 样例拼接构造** | 15 |
| L4 机制冒烟 | `pnpm run test:smoke` | stub 宿主 19 断言（__ModuleLoader__ 契约/138 点 164 线/热卸载/kill-switch） | 19 |
| L5 真实宿主 | `pnpm run j0` | j0-probe.mjs 经 CDP(9222) 六判据：标签可见/共存/图渲染/遥测/来源如实/热卸载+恢复/kill-switch | 8 |

测试环境脚本（派生自父工程 `scripts/start-dsh-test.mjs` 895 行，实测修复全保留；PID/日志改 `dsh-anic-*`，遮蔽预检针对 dsh-anic）：

```bash
pnpm run test:dsh:start     # 启动 DSH(3080) + 调试 Chrome(9222)，捕获认证 URL
pnpm run test:dsh:stop|restart|status|check
pnpm run test:live          # = run-tests --live（离线三层 + j0-probe）
```

**纪律**：j0-probe 绝不启动/杀死宿主进程（前置 = start-dsh-test 启动的调试 Chrome）；本脚本与父工程
脚本共用 3080，同时只跑一个测试宿主，切换前先 `stop`；`check` 只读评估端口，绝不越权杀进程。

## 安装（已完成：web + desktop 双 profile）

**网页端**（`%USERPROFILE%\.dsh\profiles\web\`）：`dependencies["dsh-anic"] = "link:D:/Projects/TraeProjects/dsh-codegraph-visualizer/dsh-anic"`
+ `dsh.profile.bundles` 追加 `"dsh-anic"`，`pnpm install` 完成（Junction 已验证，
`node_modules/dsh-anic/dist/client.js` 经链接可达且语法可解析；父插件链接未受影响）。

**桌面端**（`%USERPROFILE%\.dsh\profiles\desktop\`，2026-10-13 同步）：同款 `link:` 依赖 + bundles 末尾追加；
`pnpm install` 后 Junction、served bundle `node --check`、locale/icon 可达性全部验证；18 个既有 bundle 行
逐一在 node_modules 解析通过（4 个 `@deepseek-ai/*` 行是宿主内建，从安装锚点解析，不在 profile 依赖里——安装前后一致）。
dsh-anic 无 `@deepseek-ai/dsh*` peer 依赖 ⇒ 兼容门必过；桌面端是 dsh-anic 在 0.4.x 生态宿主上的首次挂载（07 §3 unknown 宿主姿态的实测场）。

**两端生效都需要重启对应宿主**（bundle 在启动时装载）；`link:` 安装下重启后再次 `build` 即热更新。

### J0 验证清单（重启宿主后逐条勾）

1. 顶层标签栏出现 `ANIC`，可点击，SVG 图渲染 138 圆点 / 164 边线；
2. 底行显示 `live …`（宿主路由生效）；把 `.cycles/` 里造一个变化后点「刷新」→ 数字变化；
3. DevTools：`window.__ANIC_TAB_SPIKE__.registered === true`，`nodes/edges/autonomy` 与快照一致；
4. 既有「对话 / 代码图谱」等标签不受影响（`kind:'list'` 共存）；
5. `__ANIC_TAB_SPIKE__.unregister()` → 标签消失；`reregister()` → 重现（dispose 干净）；
6. 停用开关：`localStorage['anic-workflow-tab'] = 'off'` 后重载 → 零注册、零遥测副作用；
7. 卸载 = 从 profile `package.json` 移除依赖与 bundle 行 + `pnpm install` + 重启（无残留注册）。

### 观察点（CLAUDE.md 纪律）

- `ctx.slots.register` 必须保持原型方法调用（否则 per-plugin disposal 失效）；
- apply() 内不做能力快照门控；slots 缺失走 `skipped='slots-absent'` 响亮降级；
- 路由注册经 `ctx.effect`，disposer 不丢弃（插件级卸载 = 路由注销）。

## 目录

```
dsh-anic/
  package.json            # name=dsh-anic, manifestVersion 1, client.platform web, inject=['slots']
  icon.svg  locale/       # DSH 清单资产（en/zh）
  src/index.ts            # 宿主入口：inject=['webServer','sessions']，注册四路由（ctx.effect）
  src/host/snapshotRoute.ts         # GET /anic/api/workflow-snapshot（现场构建，no-store+CORS）
  src/host/routes/selfInitRoute.ts  # POST /anic/self/init（自举，flow.selfInit 门控）
  src/host/routes/selfCheckRoute.ts # GET /anic/api/self-check（6 探针）
  src/host/routes/index.ts          # 路由聚合 + makeSend（requestId 头）
  src/host/config.ts                # C 域唯一 loader（canonical/legacy/missing，INV-25）
  src/host/logger.ts                # scoped logger + requestId（M2 宿主日志服务唯一缝）
  src/host/agents.ts                # agent 卡 loader（5 门 × 3 角色，闭合 schema 校验）
  src/shared/snapshotCore.ts        # 快照构建唯一实现（生成器与宿主路由共用）
  src/shared/stepTrace.ts           # 四源投影（INV-27 诚实标注，位置法归属）
  src/shared/flows.ts               # 9 flow 开关三层合并（INV-29 核心不可关）
  src/shared/errors.ts              # 四域错误码 anicError()（client/host 共用）
  src/client/index.ts     # 客户端入口（name='dsh-anic-client'，inject=['slots']）
  src/client/integrations/WorkflowTabIntegration.ts
  src/client/WorkflowGraphPanel.ts  # 取数组件 + 三工具栏按钮 + 三面板区（stepTrace/diagnostics/prefs）
  src/client/features/stepTrace/renderStepTrace.ts    # 纯渲染：步骤轨迹树
  src/client/features/diagnostics/renderDiagnostics.ts # 纯渲染：自检探针行
  src/client/features/prefs/prefsDrawer.ts            # 纯渲染：偏好抽屉 + localStorage 读写
  src/client/workflowGraphData.ts   # 生成文件（嵌入快照）
  assets/agents/                    # 15 张 agent 资产卡（{gate}-{role}.json）
  scripts/generate-snapshot.mjs     # 薄封装（import snapshotCore.ts，Node≥22.18 原生 TS）
  scripts/build-client.mjs          # 构建 + --watch 热更新模式
  scripts/wrap-client-bundle.mjs    # 与父工程同契约的包装器（styleId=dsh-anic-styles）
  scripts/offline-smoke.mjs         # 机制冒烟（stub 宿主，19 断言）
  scripts/validate-dsh.mjs          # L1 规范门 C1-C12（--json 可选）
  scripts/run-vitest.mjs  vitest.config.ts   # L2/L3 测试执行器与配置（pool=forks）
  scripts/run-tests.mjs             # 测试编排器（validate→vitest→smoke[→j0]，fail-fast）
  scripts/start-dsh-test.mjs        # 测试宿主环境（DSH 3080 + 调试 Chrome 9222，PID/日志隔离）
  scripts/j0-probe.mjs              # L5 真实宿主探针（CDP 六判据，绝不启停宿主）
  tests/unit/snapshotCore.test.ts   # 13 用例
  tests/unit/snapshotRoute.test.ts  # 8 用例
  tests/contract/dshConformance.test.ts  # 15 用例（含源码形状守卫）
  artifacts/workflow-snapshot.json  # 快照留档（审计/复现）
```

## 与父插件的关系

- **独立工程**：不 import 父项目源码；tsconfig 严格分立（client/host 隔离沿用父纪律）。
- 父插件 `src/` 保持零变更（本切片未触碰）；两插件可并存（bundle id / 样式 id / 标签 id 均隔离）。
- 评测产物（契约套件、基准、技能快照）在 `.anic-skill-evo/`，不放本工程。

## M11 技能内联 + 原生插件化 + 双向自举（v0.3.0）

> 来源：用户 m04286「将项目技能实现原生插件，安装即用，双向自举自进化」。

### 技能内联与自动安装

- `assets/skill/`：技能全量内联（63 文件），安装插件即含技能底座。
- `POST /anic/skill/install`：自动安装/更新技能到工作区 `.dsh/skills/`（幂等版本比对）。
- `GET /anic/skill/status`：查询已安装版本 / 来源（workspace / repo / inline）。
- `resolveSkillScriptsDir` 三层混合查找：workspace `.dsh` → repo `.dsh` → inline `assets/skill`。

### 7 脚本原生等价物

| 脚本 | 原生模块 | 路由 |
|---|---|---|
| hitl-audit | `governance/hitlAudit.ts` | `POST /anic/hitl-audit` |
| band-detector | `evolution/bandDetector.ts` | `GET /anic/band-detect` |
| org-status | `evolution/orgStatus.ts` | `GET /anic/org-status` |
| fact-base-verify | `governance/factBaseVerify.ts` | `GET /anic/fact-base` |
| plan-sync-check | `governance/planSync.ts` | `GET /anic/plan-sync` |
| multi-agent-gate | `llm/multiAgentGate.ts` | `POST /anic/multi-agent-gate` |
| auto-fix-loop | `evolution/fixLoop.ts` | `POST /anic/fix-loop` |

### 双向自举

- `dualBootstrap.ts`：`DualBootstrapState { plugin, skill, crossProposals }`。
- `evaluatePluginSelf`：统计 src/test 文件比 → 综合分。
- `evaluateSkillSelf`：检查 `.cycles/` 工件完整性 → 综合分。
- `advanceDualBootstrap`：推进一轮，失败时产跨向提案（不互相改码，R-31）。
- 3 路由：`POST /anic/self/dual-evaluate` / `POST /anic/self/dual-advance` / `GET /anic/self/dual-status`。

### 18 DSH 工具

`anic_evaluate` / `anic_iterate` / `anic_gate_check` / `anic_bootstrap` / `anic_snapshot` / `anic_self_check` / `anic_hitl` / `anic_install` / `anic_status` / **`anic_skill`**（15 脚本通用网关，M10-a 流程跟踪）/ **`anic_bootstrap_cycle`** / **`anic_bootstrap_analyze`**（M10-b/c 自举链）/ **`anic_autonomy_downgrade`**（R3 阶段 1：证据化自主级回退——评估八熔断信号，仅证据支持时降一级，Post-Verify 回读 + 事故留痕；无熔断维持不动，L1/L2 地板拒绝）/ **`anic_flows_gate_check`**（R3 阶段 2：gate-check 流程状态机运行入口，mode=script 正典 / native 原生 / diff 双跑对账）/ **`anic_flows_advance`**（R3 阶段 3：宏观循环相位推进，6 相 15 条前向边 + phase-gates-passed 守卫，mode=native/script，dryRun 仅 native）/ **`anic_flows_archive`**（R3 阶段 3 后半：归档流程——cycle 归档已完成循环 / clean 清旧 / list 清单；完成判定与 G1 共用解析器；账本永不触碰 INV-9）/ **`anic_flows_hitl`**（R3 阶段 4 后半：HITL 三段修复流程——Phase0 审计 → Phase1 仅熔断门修复 → Phase2 全修复才重审；gate=all|H1..H4；mode=native 缺省/script）/ **`anic_flows_auto_fix`**（R3 阶段 5：自动修复循环流程——test→失败识别→retest→判定主循环，maxRetries 1-10；报告计数双格式解析 D-1103；ITERATING 自环轨迹进投影可回放）。工具计数守卫见 `truthAuditChecks.ts`（扫描 `src/host/tools*.ts` glob，不硬编码单文件——**新增工具后必须同步本清单与计数**，cycle-16 审计 P2-3 教训）。

### 透明性 + 连通性增强

- 面板新增 **org status 全景区**：cycle 列表 + 信任分 + 自主级 + 熔断 + 带检测 + 警告。
- 并行 fetch snapshot / step-trace / self-check / org-status（各自 404 降级，不伪造空数据）。

### 验证

```
typecheck   client 0  host 0
vitest      147/147  (10 test files)
smoke       19/19 ALL PASS
validate    12/12    (dsh-anic@0.3.0)
build       dist/client.js + dist/host.js OK
```
