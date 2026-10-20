# UI 功能域与界面组件规划

> cycle-38 产出（T-3809）。研究方法：context7 MCP（TanStack Query 轮询纪律 + WAI-ARIA APG live region 模式）+ 14 个 feature 模块逐个盘点。
> 本文回答三个问题：现在有什么（§1）、数据面如何演进（§2）、缺口按什么顺序补（§3）。

## 1. 功能域现状矩阵（14 分区 + 壳层）

面板装配在 `src/client/WorkflowGraphPanel.ts`（233 行，纯编排）；每分区一个 feature 模块（T3 纪律：全部 ≤250 行）。

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

**组件层**（components/）：`usePanelFetch`（统一轮询钩子——cycle-38 起 ETag+visibility，见 §2）、`sectionShell`（分区壳：数据行+降级文案）、`dataRow`、`statusDot`、`panelTheme`（宿主主题解析）、`sectionIds`（实例唯一 id）。

## 2. 数据面演进（cycle-38 已落地）

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

## 3. 缺口与排期

| 优先级 | 缺口 | 说明 | 状态 |
|---|---|---|---|
| W-3 | **「为什么」层（最小版已落地）** | gate-event 节点携带账本 `detail` → 点击节点详情抽屉可见「这一门为什么 PASS/FAIL」 | ✅ cycle-38 快档（snapshotCore 提取 detail + 面板传递 + renderNodeDetail 渲染） |
| W-3 全档 | test-report 行投影 | 把测试报告的 通过/失败/错误 行解析后投影到 G2 事件节点详情（数字 + 分层结果行，复用 gateArtifacts 语义） | ✅ cycle-39（snapshotCore testReport 提取 + renderNodeDetail 测试报告分区 + 失败/错误计数红显） |
| V-1 | ETag 条件请求 | 见 §2.1 | ✅ cycle-38 |
| R-1 | @container 断点表验证 | 响应式基础已有（@media + flex wrap），@container 查询断点表未验证 | 排期 |
| — | aria-live 状态行的节流 | 刷新按钮的 status 行每次轮询都可能变更文案；高频播报干扰（APG live region 实践：变更要有意义） | 观察项——当前文案仅 source/line 变化时改，实际频率低 |
| — | 图区缩放/平移 | 76+ cycle 规模下纵向滚动深 | M3 范畴（doc11 已排期） |

## 4. 设计令牌与主题

令牌块在 `src/shared/tokens.ts`（`token()` 读取 + `[data-anic-theme='dark']` 语义层切换）；`useShellTheme()` 解析宿主主题写 `data-anic-theme`。分区壳/状态点/裁决色全部经令牌，不硬编码。**新增分区必须走令牌**——对比度契约（contrastContract.test.ts 10 用例）钉死。

## 5. 维护责任

- §1 矩阵：每新增/删除分区时更新（feature 模块数 14 是装配面事实）。
- §3 排期：每轮 cycle 挑任务时刷新状态列。
