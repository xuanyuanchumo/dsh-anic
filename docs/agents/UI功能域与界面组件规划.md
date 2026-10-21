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

**留账（下轮候选，按 ROI）**：写侧 actions 收口（bindPanelActions 具名动作+announce 回读进动作层，~20 个 setState 写点散布 4 文件——大重构另开轮次）；panelSections.ts 185 行/12 分区按近期节奏约 3 轮触 250 纪律——新分区应直落 features/<域>/；panelStore.ts:60 通知全监听器扇出无切片级过滤（当前 ~25 监听器成本可忽略，分区翻倍后重估）。

## 3. 缺口与排期

| 优先级 | 缺口 | 说明 | 状态 |
|---|---|---|---|
| W-3 | **「为什么」层（最小版已落地）** | gate-event 节点携带账本 `detail` → 点击节点详情抽屉可见「这一门为什么 PASS/FAIL」 | ✅ cycle-38 快档（snapshotCore 提取 detail + 面板传递 + renderNodeDetail 渲染） |
| W-3 全档 | test-report 行投影 | 把测试报告的 通过/失败/错误 行解析后投影到 G2 事件节点详情（数字 + 分层结果行，复用 gateArtifacts 语义） | ✅ cycle-39（snapshotCore testReport 提取 + renderNodeDetail 测试报告分区 + 失败/错误计数红显） |
| V-1 | ETag 条件请求 | 见 §2.1 | ✅ cycle-38 |
| Top2 | 根组件全树重渲（2s tick 打根） | 见 §2.4——panelStore 外置 + 订阅薄组件，只重渲订阅分区 | ✅ cycle-42 |
| Top4 | useDeferredValue 陈旧指示 | live 分区可中断渲染 + stale 视觉标记（data-anic-live-deferred） | ✅ cycle-42（static 渲染直通钉；滞后路径真机旅程覆盖） |
| R-1 | @container 断点表验证 | 响应式基础已有（@media + flex wrap），@container 查询断点表未验证 | 排期 |
| — | aria-live 状态行的节流 | 刷新按钮的 status 行每次轮询都可能变更文案；高频播报干扰（APG live region 实践：变更要有意义） | 观察项——当前文案仅 source/line 变化时改，实际频率低 |
| — | 图区缩放/平移 | 76+ cycle 规模下纵向滚动深 | M3 范畴（doc11 已排期） |

## 4. 设计令牌与主题

令牌块在 `src/shared/tokens.ts`（`token()` 读取 + `[data-anic-theme='dark']` 语义层切换）；`useShellTheme()` 解析宿主主题写 `data-anic-theme`。分区壳/状态点/裁决色全部经令牌，不硬编码。**新增分区必须走令牌**——对比度契约（contrastContract.test.ts 10 用例）钉死。

## 5. 维护责任

- §1 矩阵：每新增/删除分区时更新（feature 模块数 14 是装配面事实）。
- §3 排期：每轮 cycle 挑任务时刷新状态列。
