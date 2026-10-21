# UI 功能域与界面组件规划

> cycle-38 产出（T-3809），cycle-42 增补（T-4207：数据面 store 化，见 §2.4）。研究方法：context7 MCP（TanStack Query 轮询纪律 + WAI-ARIA APG live region 模式 + cycle-42 增补 /react/react useSyncExternalStore 与 /pmndrs/zustand v5 selector 纪律）+ 14 个 feature 模块逐个盘点。
> 本文回答三个问题：现在有什么（§1）、数据面如何演进（§2）、缺口按什么顺序补（§3）。

## 1. 功能域现状矩阵（14 分区 + 壳层）

面板装配在 `src/client/WorkflowGraphPanel.ts`（229 行，纯编排——cycle-42 起只持 UI 态，数据态全数入 store）；每分区一个 feature 模块（T3 纪律：全部 ≤250 行）。分区经 `panelSections.ts` 订阅薄组件装配（§2.4）。

| # | 分区 | 模块 | 数据源（URL） | 轮询档 | 开关键 | a11y 基线 |
|---|---|---|---|---|---|---|
| 0 | 工具栏 | WorkflowGraphPanel.ts | — | — | — | role=toolbar + role=status aria-live |
| 1 | 图区 | features/graph/renderGraph.ts | /anic/api/workflow-snapshot | 挂载+手动 | — | svg desc + roving tabindex + 裁决双通道（色+线型字形） |
| 2 | 实时调用（动态白盒） | features/live/renderInvocations.ts | /anic/api/invocations/live | 2s | autoRefresh | 状态点 + prefers-reduced-motion 逃逸 |
| 3 | Cycle 时间线 | features/cycles/renderCyclesTimeline.ts | /anic/cycle/list + /anic/cycle/state | 4s | autoRefresh | — |
| 4 | 步骤流程 | features/stepTrace/renderStepTrace.ts | /anic/api/step-trace | 挂载+手动 | flow.stepTrace | section 壳 |
| 5 | 诊断 | features/diagnostics/renderDiagnostics.ts | /anic/api/self-check | 挂载+手动 | flow.diagnostics | section 壳 |
| 6 | 自主级仪表带 | features/autonomy/renderAutonomyGauge.ts | /anic/org-status | 4s | — | L1-L4 色带 |
| 7 | org 全景 | features/org/renderOrgStatus.ts | /anic/org-status | 4s | — | — |
| 8 | 技能健康 | features/skillhealth/renderSkillHealth.ts | /anic/skill/health | 4s | — | — |
| 9 | 流程状态机 | features/flows/renderFlows.ts | /anic/flows/status | 4s | flow.flowsView | — |
| 10 | 账本事件流 | features/ledger/renderLedger.ts | /anic/api/ledger + /anic/api/ledger/verify | 4s | — | 分页「显示更多」 |
| 11 | HITL 审计队列 | features/hitl/renderHitl.ts | /anic/hitl-audit | 4s | flow.approvals | 只读队列 |
| 12 | 治理预算 | features/budget/renderBudget.ts | /anic/governance/budget | 4s | — | 预算条 |
| 13 | 节点详情抽屉 | features/graph/gateColors.ts（renderNodeDetail） | 图区点击 | — | — | role=region + Esc 关闭 + 焦点还原 |
| 14 | 开关抽屉 | features/prefs/prefsDrawer.ts | localStorage | — | — | disclosure aria-expanded/controls |

**组件层**（components/）：`usePanelFetch`（统一轮询钩子——cycle-38 起 ETag+visibility，见 §2）、`panelStore`（cycle-42：外部 store + usePanelSlice 订阅入口，见 §2.4）、`panelSections`（cycle-42：分区订阅薄组件层）、`sectionShell`（分区壳：数据行+降级文案+可折叠 details）、`dataRow`、`statusDot`、`panelTheme`（宿主主题解析）、`sectionIds`（实例唯一 id）。数据切片形状见 `src/client/panelState.ts`（PanelState 19 切片，cycle-45 起 fetchState 嵌套切片拆为 fetchSource+fetchLine 两顶层切片）。

## 2. 数据面演进（cycle-38 轮询纪律 / cycle-42 store 化）

**研究来源**：context7 `/tanstack/query`（refetchIntervalInBackground 缺省语义、replaceEqualDeep 结构性共享、focusManager 可见性门）+ W3C ARIA APG（live region 实践：异步更新的可感知性）。

### 2.1 ETag 条件请求（服务端+客户端闭环）

- 快照端点带语义 ETag（排除 generatedAt）；`If-None-Match` 命中 → 304 空体。
- 客户端 `usePanelFetch` 学 ETag、回带条件头；**304 = 数据未变**：不重放 apply（结构性共享语义——引用不变，消费方 setState 不触发重渲染）、不算失败、触发 onRecover。
- 收益：4s 档 8 端点在数据稳定期的响应体与渲染成本显著下降。

### 2.2 可见性暂停

- `document.visibilityState !== 'visible'` → 跳过本轮拉取（定时器照排，可见自然恢复）。
- 语义对应 TanStack Query 的 `refetchIntervalInBackground=false` 缺省（标签不可见不轮询）；jsdom/无 fetch 沙盒无此 API → 静默缺省。

### 2.3 既有语义（保持不变）

- 暂停：`pollMs<=0`（autoRefresh 关）只首拍；防抖：inFlight 不重入；降级三分类：http/malformed/network；`onResponse` 学 `X-ANIC-Workspace`（桌面多会话纠偏）。

### 2.4 数据面 store 化（cycle-42 已落地，Top2 债务关闭）

**研究来源**：context7 `/react/react`（useSyncExternalStore 并发安全契约：渲染后重调 getSnapshot 与渲染值 Object.is 比较，getSnapshot 必须纯且便宜）+ `/pmndrs/zustand` v5（selector 返回新引用 → Maximum update depth exceeded；官方首推每值独立订阅）。

**根因（Top2 债务）**：根组件曾持 ~15 个数据 useState，2s invocations tick 的 setState 发生在根 → 每 tick 全树重渲（图区 SVG + 九分区全量重建）。ETag 304 只消掉「数据未变」的重渲，「数据变了」仍是全树。

**架构（三文件分工）**：

- `panelStore.ts`（78 行）——机制层：`createPanelStore<T>`（getState / setState(Partial<T>) 浅合并按顶层 key 替换 / subscribe）+ `usePanelSlice(store, selector)`（uSES 订阅入口）。**两条硬契约**（违反 → 无限重渲）：selector 引用必须稳定（模块级函数）；selector 必须返回切片**原引用**（禁止组装新对象）。
- `panelState.ts`（81 行）——状态层：`PanelState` 19 切片与原 useState 一一对应（回归红线：逐字段对齐初始值；cycle-45 T-4502a：fetchState 嵌套 → fetchSource+fetchLine 顶层两切片，扁平化）；`PanelDataStore` 类型别名。
- `panelSections.ts`（185 行）——订阅层：模块级 selector×18 + memo 薄组件×11（每分区订阅自己的切片，store 更新只重渲订阅组件自身——SyncLane 不波及邻居）。

**语义与收益**：

- 全等补丁不通知（setState 每个 key 都 Object.is 相同 → 零监听器回调）——与 ETag 304 跳过 apply 同一「结构性共享」语义，两层叠加。
- 2s tick 落到 invocations 切片 → 只有 LiveInvocationsSection 重渲；图区/账本等九分区零重渲。
- `useDeferredValue`（LiveInvocationsSection）：重列表可中断渲染；`value !== deferredValue` 驱动陈旧指示（`data-anic-live-deferred` stale/fresh + opacity 0.75）——高频 tick 下用户看到的列表是可中断的滞后版，陈旧态有视觉标记（T-4204）。
- 零依赖：手写 zustand vanilla 等价物（8 行 useStore 形态），不引第三方包——G-IND 独立性守卫与「运行时依赖为零」纪律不破。
- 根组件 229 行（重写前 249 行）：UI 态（prefsOpen/flowTick/selectedNode/reloadKey/ledgerLimit）留本地——低频交互态不需要跨分区订阅。
- 测试钉：`panelStore.test.ts` 11 用例（浅合并引用保持/全等不通知/退订/快照迭代序/uSES static 渲染接线/函数式补丁三态）+ `panelSections.test.ts` 10 用例（三态卡片/pollError 如实呈现/hasMore 自算/门控形态/ToolbarStatusLine 直测三态）。

### 2.5 store 演进第一轮（cycle-45 T-4502，研究驱动）

**研究来源**：panelStore 演进子代理（zustand v5 vanilla 最佳实践对照 + 全写侧审计）。达标项确认：uSES 防撕裂、模块级 selector 返回原引用、每值独立订阅、**per-instance store 是正确选型**（勿改 zustand 式模块单例——i18n 初始文案时机与多面板隔离会回退）。落地两项：

1. **T-4502a 函数式补丁 + fetchState 扁平化**：`setState(patch | ((s) => patch))`（updater 先解引用，读-改-写显式原子）；原唯一嵌套切片 `fetchState:{source,line}` 拆为顶层 `fetchSource`/`fetchLine` 两切片——写侧曾每次新建整个对象令「全等补丁不通知」对它恒失效（靠 uSES 字符串 selector 兜底）。现在 source 单独变化零通知 line 订阅者；announce 回读（useInvocations）与 malformed 保 source（panelLiveTargets）均改函数式补丁。接线点：`WorkflowGraphPanel.ts:96` setFetchLine 桥接、`panelSections.ts` selFetchLine。
2. **T-4502b usePanelSlice dev 双调自检**：DEV 构建对同一快照双调 selector，Object.is 不等 → WeakSet 去重的一次性 console.warn（浏览器面诊断，非 host 日志域；dshConformance console 守卫按文件豁免并注释域理由）。**生产零开销实证**：tsdown 把 `import.meta.env?.DEV` 编译为 falsy 并死代码消除整段（dist/client.js 无 devWarn 残留）。类型形状补 `src/client/importMetaEnv.d.ts`（本仓不经 Vite，最小声明）。

### 2.6 store 演进第二轮：actions 写侧收口（cycle-46 T-4601）

zustand v5「actions live in the store」的手写等价物——`src/client/components/panelActions.ts`（143 行）把全部写路径收口为具名动作：

- **`classifyFailure(f): string`** 唯一三分类 classifier（http→routeUnavailable / malformed→malformedNotUsed / network→message），原散布 useInvocations 的降级文案规则收拢单源。
- **`bindPanelActions(store): PanelActions`** 返回 17 具名动作：快照域 setGraph/setFetchLine（复合 updater）；步骤流程/自检域 setTrace(v,line)/setCheck(v,line)（**行文案与数据两切片一次写**——setTraceLine/setCheckLine 独立通道删除）；实时调用域 applyInvocations（announce 回读不变量进动作层）/failInvocations/recoverInvocations；4s 档静默域九个单切片直写（setOrgStatus/setFlowsStatus/setCycleList/setCycleState/setSkillHealth/setBudget/setLedgerList/setLedgerVerify/setHitlAudit）。
- **接线面收敛**：useInvocations 的 apply/onFail/onRecover 改调动作（钩子只留轮询编排与 lastTotalRef）；panelLiveTargets 的 PanelLiveSetters 从 6 setter 通道收窄为 4 动作引用 + 2 ref 通道（learnWorkspace/workspaceKnown 非 store 写留在接口）；WorkflowGraphPanel 根组件内联 setter 闭包清零（快照组 4 动作引用 + 4s 档 actions 绑定一次）；governanceTargets 的 GovernanceSetters 收窄为 `Pick<PanelActions, 'setLedgerList'|'setLedgerVerify'|'setHitlAudit'>` 类型别名。
- **契约测试**：`tests/unit/panelActions.test.ts` 10 用例（三分类逐字/announce 回读两态/fail+recover 往返数据保留/复合写 malformed 保 source/同值补丁零通知/双切片一次写/九切片直写往返）。

**留账（按 ROI 重估）**：panelSections.ts 185 行/12 分区约 3 轮触 250 纪律——**新分区必须直落 `features/<域>/`**（本册维护约定，接住 ui-research 风险警告）；panelStore.ts 通知全监听器扇出无切片级过滤（~25 监听器成本可忽略，分区翻倍后重估）。

### 2.5a 原 §2.5 留账状态更新（cycle-46）

写侧 actions 收口 → ✅ 本轮落地（见 §2.6）。

#
## 2.7 live 域动态白盒补录（cycle-47..50 三轮连续落地）

实时调用分区的白盒能力在四个维度完成闭环（本节为 cycle-48/49 的文档欠账补录）：

| 维度 | 落地轮 | 交付物 | 真机证据 |
|---|---|---|---|
| **通道诊断计数**（「事件没到」vs「到了被过滤」区分） | cycle-47 T-4702 | `renderInvocationsTypes.ts` `FeedDiagnosticsJson` + `renderInvocations.ts` `feedDiagnosticsLine()`（`data-anic-feed-diagnostics` 契约标记，空态/列表态双渲染）+ zh/en `live.diagnostics` 键 | 测试宿主两态对比：调用前「事件 0 · 工具调用 0 · 结果 2 · anic 调用 0」→ 调用后「事件 15 · 工具调用 1 · 结果 3 · anic 调用 1 · anic 结果 1」 |
| **结果预览**（动态白盒三元组「参数→状态→**结果**」最后一元） | cycle-48 T-4801（代码）+ cycle-49 T-4901（真机） | 宿主 `InvocationRecord.resultPreview`（`invocationFeedPreview.ts` `extractResultPreview` 纯函数——官方冻结载荷 `content` 文本块提取，200 字符对齐 argumentsPreview；isError 不提取）+ 客户端 `InvocationJson.resultPreview` + done 态渲染（`⇒` 前缀独立行，`data-anic-invocation-result` 标记，flexBasis 100%）+ zh/en `live.resultPreview` 键 | DOM 断言：`anic_status 完成 88ms t3/s1 {"flowLimit": 3} ⇒ {"statusUrl":"…","desktopNote":"…dsh-app://…"}`——参数与结果成对呈现；anic-cycle49-result-preview.png |
| **契约权威源**（宿主 asar 考古） | cycle-48 T-4801a | dsh-tools `materializeFinalResult` 完整契约编码进 `invocationFeedPreview.ts` 注释：`{content: ContentBlock[], meta?, additionalContexts?, isError, error?, concludesTurn?, value}` deepFreeze 后派发，observer 收 (exec, result) 双参 | asar 定向读取（marker 字符串定位） |
| **latestCycle 数值序**（Cycle 全景行数据真实性） | cycle-50 T-5001 | `orgStatus.ts` reduce 数值序取最新（字典序假象「最新 cycle-9」修复——缺陷潜伏 40 轮） | DOM 前后对比：修复前「最新 cycle-9」→ 修复后「最新 cycle-50」 |

结果预览的排障语义（三负例钉死，见 invocationsRender.test.ts）：
- done 无预览（空结果/旧 feed）→ 不渲染节点（不伪造空预览）；
- error 态 → 不渲染（error 三元组已有专属行）；
- in-flight 态 → 不渲染（尚未有返回）。
渲染层不做二次截断——截断是宿主提取层单一职责（数据面/渲染面分离）。

## 2.8 tech-debt 域：债务队列第十分区（cycle-54 落地）

**背景**：宿主 GET /anic/api/tech-debt/list（G-C3 消费侧读面）自 cycle-16 存在，但 src/client 零消费——「纯后端白盒不是白盒」。本轮收口为面板第十分区。

| 维度 | 决策 | 落点 |
|---|---|---|
| 数据形状 | TechDebtListingJson 对齐宿主 techDebtQueue.ts（open/resolved/skipped 三段+计数） | features/techdebt/renderTechDebt.ts |
| 渲染分三段 | open 工作队列（severity 徽标着色与 skillhealth 同源——债务语义面统一视觉）/ resolved 计数行（>0 才渲染）/ skipped 如实报告（title 悬停带文件名+原因——「如实报告不吞」） | renderTechDebt() |
| 截限纪律 | TECH_DEBT_RENDER_CAP=12（同 GROUP_RENDER_CAP 语义——渲染有界，数据在路由） | 常量 |
| 空队列语义 | 零欠债是合法状态（评估失败维度才产提案）——渲染零欠债行而非空态引导 | data-anic-techdebt-empty |
| 旅程排序 | 技能健康之后（「技能健康」→「欠了什么债」相邻——改进建议语义簇） | panelSections TechDebtSection |
| 轮询档位 | 4s 治理档（技能健康同档——健康与债务同节奏观测） | WorkflowGraphPanel 4s target |
| i18n | techdebt 域 6 键+fold.techdebt（zh/en parity） | locale/{zh,en}.json |
| 测试 | 7 用例（null/守卫/空队列/open 契约/截限/resolved·skipped title/零计数） | tests/unit/techDebtPanel.test.ts |

**真机证据**：分区壳「技术债务」默认 open=true（details 9→10）；summary「待处理 0 · 已消费 0 · 跳过 2」；skipped title 带 self-bootstrap 文件名与原因（本仓两个自举轮自由形态提案如实归类）；截图 .cycles/cycles/cycle-54/anic-cycle54-techdebt.png。

**留账收口（cycle-55）**：health 建议→tech-debt 提案落盘通道已落地——healthDebtBridge（src/host/evolution/healthDebtBridge.ts）在 skillHealthRoute 读面旁路落盘 .cycles/tech-debt/health-<date>.json（同日幂等/跨日恶化新提案可追踪/损坏重建/落盘失败不阻塞读面）；severity 映射 critical→critical/warn→medium/info→low；dimension=skill:<script>。真机：面板 summary「待处理 0→4」（workflow-state critical+三脚本 medium），8s 复验幂等。

## 2.9 skillhealth 域：时间窗健康（cycle-57 T-5702 落地）

**背景**：cycle-53 加了计数窗（last-8）没加时间窗——脚本修复落地后若再无网关调用（脚本直跑/CI 不进 flow-tracker），计数窗里的旧失败**永不出窗**，面板永久 degraded/critical 标红。「修复从未被健康面承认」的结构性根因。

| 维度 | 决策 | 落点 |
|---|---|---|
| 时间窗 | RECENT_MAX_AGE_MS=7 天（一周朴素语义——非按当日面板表现调参；3-5 天前的失败仍在窗内属诚实） | continuousLearning.ts |
| 窗口交集 | 时间窗 filter（含未来时间戳排除 nowMs-t≥0）→ **按 startedAt 时间升序排序** → slice(-8)（追加序≠时间序——FlowTracker 跨天多轮交错写入） | computeScriptHealth |
| recentSuccessRate | 可 undefined：number=近期值 / **null=新宿主「近 7 天无网关调用」**（路由显式转 null——JSON 序列化丢弃 undefined，协议三态可辨）/ 字段缺省=旧宿主（回落全史零回归面） | ScriptHealth + skillHealthRoute 序列化 |
| 分级 | 时间窗空 → level='insufficient'（当前状态不可判定——不拿全史冒充近期）；suggestFromHealth insufficient 不生成建议（无近期数据≠当前故障，历史欠账归 tech-debt 队列管） | 分级链 |
| 面板陈旧态 | ◦7d 徽标（data-anic-skill-health-stale，title=health.noRecentData）——undefined 态可视化 | renderSkillHealth.ts |
| 双量纲 | formatHealthSummary「近期 X%/全史 Y%」，数值相等时单值形态（cycle-57 修：旧代码拿 '100%' 与 '100' 字符串比较恒不等——单值形态从不出现） | formatHealthSummary |
| 测试 | 时间窗 5 钉（insufficient/窗内失败/未来时间戳/乱序排序回归钉/建议不催修）+ 面板陈旧态 2 钉 | continuousLearning.test.ts 22/22 + skillHealthPanel.test.ts 12/12 |

**真机证据（API 直查）**：eval-runner/gate-ledger/org-status 三脚本转 **insufficient**（窗内样本量不足——诚实降级替代「全史统计钉死」）；gate-check 0.625（尾 8=5D3F，3 条 10-18 失败距今 3 天仍在窗内）；quick-validate 0.5（含 10-20 真实失败不洗白）。7 天后无新调用的脚本将自然转 insufficient。

**两缺陷同轮修复**（夹具驱动发现——「夹具暴露实现缺陷时修实现非改夹具迁就」教训）：①formatHealthSummary 单值形态字符串比较 bug；②乱序数组 slice(-8) 取「最晚追加」而非「最近发生」。

## 2.10 共享层落位：G-FEAT 特性边界收口（cycle-58 T-5801a 落地）

**背景**：doc12 §3.2 特性模块制「跨特性只经共享层与编排器」——但 `isObjectLike`（4 行纯类型守卫）落位 `features/live/fetchJson.ts`，造成 budget/hitl/ledger/skillhealth/techdebt 五域 `../live/` 跨特性深 import；`OrgStatusJson` 类型定义在 org 域，autonomy 域跨域 import type。G-FEAT 守卫建立（guardRegistry.test.ts）当轮把真违规清零。

| 共享物 | 原落位 | 新落位 | 消费域 |
|---|---|---|---|
| fetchJsonGuarded / isObjectLike / isFlowStatus / syncTelemetryCounts | features/live/fetchJson.ts | **components/fetchJson.ts**（唯一实现） | live（经 re-export 垫片）+ budget/hitl/ledger/skillhealth/techdebt + panelLiveTargets/WorkflowGraphPanel |
| OrgStatusJson 接口 | features/org/renderOrgStatus.ts | **components/panelTypes.ts**（单一事实源，org 域 re-export type） | org + autonomy |

- `features/live/fetchJson.ts` 转 re-export 垫片（域内 useInvocations 与 fetchJson.test.ts 路径不破坏；G-SINGLE 守卫语义「唯一实现在 components」）；
- 类型 import 无运行时耦合，但 G-FEAT 守卫按文件路径机械判定——类型共享同样需中立落位（panelTypes.ts 只收**跨域消费**类型，YAGNI）；
- 守卫面：guardRegistry.test.ts G-FEAT 块 3 用例（零跨特性 import 扫描/扫描集非空下限/共享工具落位存在性）。

## 2.11 live 域：turn 组时间范围（cycle-60 T-6001 落地）

**背景**：feed 条目自带 epoch 时间戳（startedAt/endedAt，宿主 InvocationRecord），但面板只显示 t3/s1 步进坐标——「这组调用发生在几点、持续多久」的**绝对时序**不可见（用户目标「数据/流程流向/运行状态白盒量化」的时序维度缺口）。

| 决策点 | 选择 | 理由 |
|---|---|---|
| 边界语义 | 组内首末 **startedAt**（非 endedAt） | in-flight 的结束时间未落定——用开始时刻描述组边界是诚实陈述；跨度描述组内节奏而非单条耗时（行内 durationMs 已有单条耗时，不冗余不误导） |
| 合法性门槛 | startedAt > 0 | epoch 0 = 1970-01-01 非真实调用时刻——旧 feed/夹具 0 值占位渲染 08:00:00 是本地时区巧合的伪造时序，宁可跳过（零伪造；首版 >=0 被 5 新钉 1 失败暴露后收紧） |
| 时间格式 | HH:MM:SS 两位补零 | 分钟粒度足够、秒保调用密集区分度 |
| 乱序语义 | min/max 边界 | feed 追加序 ≠ 时间序（cycle-57 同款教训）——数组 slice 会取错边界 |
| 落位 | invocationGrouping.ts（T3 拆分） | renderInvocations.ts 267 行触 250 纪律先红后拆——分组/时序纯逻辑（groupByTurn/mostRecentCompletedKey/turnTimeRange）独立成 83 行零 React 依赖模块，「算什么」与「怎么渲」分离 |

真机证据：测试宿主真实模型调用 anic_status(flowLimit=3) 后 Turn 4 组 summary「Turn 4（1 次调用） · 01:43:35–01:43:35 · 跨度 0s」实锤（cycle-60 测试报告 §5）。

## 3. 缺口与排期

| 优先级 | 缺口 | 说明 | 状态 |
|---|---|---|---|
| W-3 | **「为什么」层（最小版已落地）** | gate-event 节点携带账本 `detail` → 点击节点详情抽屉可见「这一门为什么 PASS/FAIL」 | ✅ cycle-38 快档（snapshotCore 提取 detail + 面板传递 + renderNodeDetail 渲染） |
| W-3 全档 | test-report 行投影 | 把测试报告的 通过/失败/错误 行解析后投影到 G2 事件节点详情（数字 + 分层结果行，复用 gateArtifacts 语义） | ✅ cycle-39（snapshotCore testReport 提取 + renderNodeDetail 测试报告分区 + 失败/错误计数红显） |
| V-1 | ETag 条件请求 | 见 §2.1 | ✅ cycle-38 |
| Top2 | 根组件全树重渲（2s tick 打根） | 见 §2.4——panelStore 外置 + 订阅薄组件，只重渲订阅分区 | ✅ cycle-42 |
| Top4 | useDeferredValue 陈旧指示 | live 分区可中断渲染 + stale 视觉标记（data-anic-live-deferred） | ✅ cycle-42（static 渲染直通钉；滞后路径真机旅程覆盖） |
| R-1 | @container 断点表验证 | 断点表契约测试落地：panelBreakpointContract.test.ts 9 用例钉死 640/420 两档+容器查询锚点+reduced-motion/forced-colors 逃逸（三要素逐条钉+反向自检+非空下限）；真机窄面板三态旅程实锤 | ✅ cycle-61 |
| — | aria-live 状态行的节流 | 刷新按钮的 status 行每次轮询都可能变更文案；高频播报干扰（APG live region 实践：变更要有意义） | 观察项——当前文案仅 source/line 变化时改，实际频率低 |
| — | 图区缩放/平移 | 76+ cycle 规模下纵向滚动深 | M3 范畴（doc11 已排期） |

## 4. 设计令牌与主题

令牌块在 `src/shared/tokens.ts`（`token()` 读取 + `[data-anic-theme='dark']` 语义层切换）；`useShellTheme()` 解析宿主主题写 `data-anic-theme`。分区壳/状态点/裁决色全部经令牌，不硬编码。**新增分区必须走令牌**——对比度契约（contrastContract.test.ts 10 用例）钉死。

## 5. 维护责任

- §1 矩阵：每新增/删除分区时更新（feature 模块数 14 是装配面事实）。
- §3 排期：每轮 cycle 挑任务时刷新状态列。
