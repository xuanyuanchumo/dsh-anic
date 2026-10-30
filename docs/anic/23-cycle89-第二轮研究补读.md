
---

## 8. cycle-89 第二轮研究补读（2026-10-30 · 补齐 §6 诚实清单的前四项）

> 上一节 §6 的诚实清单列了 4 篇 llm-master 原文「**未获取**」和 dsh-ops 的若干未读面。
> 本轮补读完成，下面逐条标注**读到的事实**与**对 dsh-anic 的裁决**。
> 纪律不变：**外部材料只作方法论与工程形态输入，不作事实来源**；dsh-anic 侧的所有
> 现状陈述都是**本轮实测源码**得到的（不是原文主张）。

### 8.1 llm-master 补读：四篇原文的可用结论

#### 8.1.1 前置事实（决定借鉴方式的硬事实）

llm-master **不是代码工程，是纯文档仓库**。GitHub trees API 完整递归树
（`"truncated": false`）显示顶层只有 `LICENSE` / `README.md` / `docs/`，
共 173 个 md + drawio 源 + 图片，**零 `.ts` / `.js` / `.py` / `package.json` / CI**。

所有图都是 **drawio 源 + 导出 PNG**（托管在作者 CDN，不在仓库内）。

⇒ **借鉴方式被这条事实决定**：llm-master 对 dsh-anic 的价值是**判据与踩坑清单**，
**不是可抄的代码**。任何「照抄 llm-master 的实现」都是空想。

#### 8.1.2 补读的四篇各自贡献了什么

| 篇目 | 本轮补读得到的关键判据 | 对 dsh-anic 的裁决 |
|---|---|---|
| `docs/interview/llm/harness_interview.md`（37.7KB） | Harness **六层模型**：上下文精细化 / 记忆与状态管理 / 工具系统 / 执行编排 / 评估与观测 / 约束与恢复。原文断：「Agent 状态不应放在上下文窗口里，而应外化到文件系统」；「**约束硬编码到代码或 linter，不要写在提示词里靠 Agent 自觉遵守**」 | ✅ **采纳其精神**（约束进代码不进提示词），dsh-anic 的守卫族已是这个形态；**不新增层**（六层是描述性模型，不是待建模块） |
| `docs/llm/app/multi_agent_context_governance.md`（19.8KB） | ①「完整复制历史会把角色污染掉」；②「**按返回时间拼消息会破坏因果**」（并行任务谁先完成只代表谁更快）；③「超限后才停止已经太晚」（必须**预留 + 原子扣减**）。正面做法：独立 Thread + Artifact Store + `task_id`/`parent_event_id` 因果序 | ⚠️ **部分采纳**：采纳「**因果序 ≠ 时间序**」与「**大结果外置**」两条；**明确拒绝引入 `task_id`** —— dsh-anic 已有 `cycle`/`phase`/`gate` 三元组做归属，再加 `task_id` 会造成**第二套归属真相源**（违反 INV-22「投影不得成为第二真相源」）。已登记为后续议题，见 §8.3 |
| `docs/interview/llm/spec_driven_development_interview.md`（25.7KB） | §九 六个坑。坑四最刺眼：「**代码变了，规约没变** → 一旦团队发现规约经常过期，就不会再信它……最怕的是谁都不知道该信哪份」。坑五：「只验证'有没有做'，不验证'做得对不对'——任务打勾只是进度，不是证据」。§十 最小模板七字段含「**边界与异常：失败、重复、超时、并发、权限不足时怎么办**」+「**验收标准：每条对应什么测试或检查证据**」 | ✅ **采纳**：本仓已有**极强的事后机械扫描**（`truthAudit` / 守卫族），但缺**事前设计清单**。→ 新增「能力设计五要素」清单（§8.4） |
| `docs/llm/app/agent_tool_design.md`（25.7KB） | ①「**查询类工具和动作类工具绝对不能混在一起设计**」（查询错了最多答案不准；动作错了可能造成业务事故）；②读写工具拆开（`create_draft` / `submit_after_user_confirm`）；③**高风险动作必须二次确认**；④「动作类工具返回值要记录审计信息：操作人、操作对象、操作时间、**操作前状态**」 | ⚠️ **部分采纳**：采纳 ④ 的「**操作前状态**」诉求 → 落到 §8.3 的 `effectState`；采纳 ③ 但**拒绝**做成「模型自己点确认」（最小权限必须由系统执行，确认走既有 HITL 通道）。①②的全面拆分**本轮不做**（改造成本 vs 收益，见 §8.3） |

#### 8.1.3 llm-master 的**零贡献项**（明确标出，避免下一轮浪费一轮）

| 维度 | 结论 | 依据 |
|---|---|---|
| **前端图谱实现** | **零贡献**。全 34 篇已下载文档中 `react-flow` / `D3` / `ECharts` / `Mermaid` / `Graphviz` 命中**全部是 drawio 注释行**，零真实前端代码 | dsh-anic 的自研 SVG 面板（`src/client/features/graph/**`，约 30 文件 4567 行）**远超**它可借鉴的范围。本轮图谱现代化**不引用** llm-master |
| **工程规范** | **零贡献**。无 CI、无 lint、无贡献规范；唯一近似规范是 YAML front-matter 契约 + 目录约定 | dsh-anic 的守卫族（G-DEP/G-FEAT/G-SINGLE/G-IND/G-REG/G-TOGGLE）+ 250 行纪律 + i18n + `CLAUDE.md` Conventions **远超**它 |
| **DAG 状态机本体** | **收益有限**。llm-master 只有算法描述（Kahn 拓扑排序 / 三色环检测 / 信号量并发上限 / 软依赖边 / 局部 Replan 上限 3），无实现 | dsh-anic 的 `stateMachine.ts` + `flows/machine.ts` **已更完备**。且 `workflow-graph.yaml` 是**人工声明的单向流水线**，不是运行时多分支 DAG —— Kahn/信号量对静态流水线**收益有限** |

#### 8.1.4 llm-master 给出、但**本轮不落地**的高价值项（诚实登记）

以下三条经原文核对确有价值，但**不属于本轮目标**，登记为后续议题（**不假装已做**）：

| 项 | 原文依据 | 为什么有价值 | 为什么本轮不做 |
|---|---|---|---|
| **Tool Registry 补三字段**（风险等级 / 是否需人工确认 / 审计策略） | `multi_agent_harness_interview.md` §5：Tool Registry 至少登记 9 项，含「允许调用的 Agent 列表」「**风险等级**」「**是否需要人工确认**」「**审计日志策略**」；「给 Agent 一个工具，不是给它一个函数，而是给它一把**权限钥匙**」 | dsh-anic 的 `src/host/toolIds.ts` 只有 `string[]` + `isKnownToolId`；`ToolFace` 只有 `{name, description, parameters}` —— **完全没有 risk 概念** | 扩 Registry 需连带 agent 卡的 `toolsAllowlist` 交叉校验（§8.1.2 的「允许调用的 Agent 列表」），而 dsh-anic 的 agent 上下文**不在线程局部** —— 运行期裁决需要新的上下文传递机制，超出一个 cycle。**但「风险等级」本身可先落地**（纯声明，不改运行时） |
| **Trace 两层 schema**（任务级 Trace / 步骤级 Step，补 `context_refs` / `state_before` / `state_after` / `eval_result`） | `agent_harness_observability_interview.md` §4。「很多 Agent 错误，不是模型突然变差，而是**上下文给错了、给多了、给旧了**」（`context_refs`）；「如果没有状态差异记录，出事后你不知道它到底动了什么」（`state_before/after`）；「不要等最终答案出来才评估」（`eval_result`） | dsh-anic 的 `InvocationRecord` ≈ 步骤级但无 `context_refs`；`FlowRecord` ≈ 任务级但无 `policyVersion` | `context_refs` 需要模型侧配合（当前调用面拿不到「本步用了哪些上下文来源」）。**`policyVersion` 是最便宜的一条**（`config.yml` 已有 version 概念但 `flow-tracker.json` 没记）——登记为下轮 P1 |
| **漂移检测五信号** | `agent_harness_observability_interview.md` §5：相关度下降 / 子任务超预算 / 重复步骤增多 / 目标表述变化 / 关键证据未被使用。成本约束：「不是让模型每一步都自我反省，那样成本会爆……更合理的是在关键节点做轻量检测」 | dsh-anic 的 `flowStats()` 有 `{total, done, failed, timeout}` 但无「重复调用」与「耗时倍数」 | 需先有 §8.3 的 `effectState` 等基础字段。登记为下轮 |

### 8.2 dsh-ops 补读：**已核实为 dsh-anic 现存缺陷**的三条（本轮已修）

本轮对 dsh-ops v0.4.4（本机安装态 `C:\Users\86156\.dsh\profiles\desktop\node_modules\dsh-ops\`）
做了逐文件取证。**dsh-ops 本身是 13 组件插件族**（根 `cordis.patch.yml` 用 `- insert:` 挂
8 个稳定 id 行），不是单功能插件 —— 这对本仓的启示见 §8.4。

**本轮已落地并有测试钉死的三条**（每条都先有「实测反例」，再修）：

| # | dsh-ops 的做法（真实代码事实） | dsh-anic 的实测缺陷 | 本轮修法 | 钉死它的测试 |
|---|---|---|---|---|
| **T-12** | `lib/teardown.js` 的 `safeDisposeAll`：一个 disposer 抛错**不阻断其余**；**先快照再遍历**（`Map.values()` 单次迭代器）；**error sink 自身抛错也被吞**；返回失败数。原文理由：「异常逃出循环会让后面的 agent 持有本该撤销的权限」 | `src/host/routes/index.ts` 与 `src/host/tools.ts` **都是** `return () => { for (const d of cleanups) d(); };` —— 一次抛错**留下未注销的路由/工具**（热重载后同路径双注册、旧工具仍可被调用）；且 disposer 常包着**能力撤销**（`ctx.effect` cleanup），一次抛错 = 权限半途残留 | 新增 `src/host/runtime/safeDispose.ts`（`safeDisposeAll` + `disposeErrorSink`），两处聚合器改用它 | `tests/unit/safeDispose.test.ts`（9 例） |
| **T-03** | `lib/kernel/errors.js`：35+ 大写稳定码 → `{status ∈ {rejected,error,conflict,unknown}, retry ∈ {never,after-input-change,after-state-change,bounded-transient}}`；**`effectState` 压倒 retry**（「a failed receipt never licenses replaying a possible write」）；未登记码默认 `settled`（fail-safe） | `src/shared/errors.ts` 只有 4 域错误码，**无 `status`/`retry`/`effectState`** ⇒ 有副作用的工具失败后，模型无法判断能否重试 | **本轮只落了「结构」的一半**：见 §8.3 的 `effectState` 裁决。完整 35+ 码表**本轮不做**（那是 dsh-ops 文件/PTC/Bash 域的码，dsh-anic 只需借结构） | 下一轮 |
| **T-04** | `lib/shells/tool.js` 的 `assertKnownArguments`：走 plain-object 定义时**必须自写未知键白名单**，否则「the call reports success while ignoring what the caller asked for」（宿主对 plain 定义**只校验 `output.schema`，不校验 `parameters`**，模型 arguments 原样进 execute） | dsh-anic 同样走 plain object 注册（`toolsSlot.ts` 自建 `ToolRegistration`），**无未知键校验** ⇒ 模型多传的 key 被静默丢弃 | 新增 `src/host/toolsArgGuard.ts`（`knownArgumentKeys` 从 schema 反射 + `assertKnownArguments` + `withArgumentGuard`），接在 `wireGuard`（**全部工具的唯一注册出口**）→ 对新工具自动生效 | `tests/unit/toolsArgGuard.test.ts`（11 例） |

**T-04 的真机风险实例**（说明为什么这不是理论问题）：`anic_autonomy_upgrade` 的参数含
`humanAuthorized` / `reason`。模型若把 `reason` 拼成 `Reason`（大小写错），旧实现会
**当作没传**而继续执行升级 —— 一个本该被记录的授权理由消失了，而调用返回「成功」。
另一个例子：`anic_skill` 的 `workspace` 拼错成 `workspaces` 时，旧实现会在
**宿主当前工作区**上执行 —— 用户本意是「在另一个项目跑」，实际跑在错误的项目上，
**且没有任何报错**。

#### 8.2.1 dsh-ops 补读：**已核实但本轮不做**的其余项（诚实登记）

| # | 项 | dsh-ops 事实 | dsh-anic 差距 | 本轮裁决 |
|---|---|---|---|---|
| T-02 | `presentationMeta` | `lib/kernel/presentation-outcome.js`：白名单 + 正则（status kebab-case ≤32、6 个计数器、2 个布尔、`error.code` 严格正则）；**路径/消息/载荷永不离开 canonical value**；`presentResult` 从 `result.meta` 取事实而非正则刮文本 | dsh-anic 的 `toolsSlot.ts` **已声明** `presentationMeta` 但**全仓无实现** | ⏸ 下轮。理由：需要先定「哪些字段算事实」的裁决表，否则会变成又一套自述 |
| T-05 | 配置版本化迁移 | `lib/config-updates.js`：`configUpdateVersion` 单调版本 + `updatedConfig()` 逐块迁移；**运行时先迁移、磁盘后存**；走宿主 `configEditor.edit()` 保 YAML 注释；**绝不 `EntryTree.write()`**（会烤进别的插件的行）；失败降级「仅内存迁移」且每 logger 只说一次（WeakSet） | dsh-anic 的 `configEdit/` 有 backup/commit/writer 但**无版本号与迁移函数** | ⏸ 下轮 P2。属 schema 演进的正典问题，不急 |
| T-07 | 事件驱动替代纯轮询 | `lib/components/tui/index.js` 用 `ctx.on('session/event')`，**无定时器**；回调内 try/catch（「A presentation failure cannot escape into the committed event observer.」） | dsh-anic 客户端**全靠轮询**（4s 档 10+ 端点 + 2s 档），但已有 ETag + 可见性门 + 退避 | ⏸ **先探测宿主 SSE 能力**再立项 —— 宿主 webServer 是否支持长连接**未验证**，不可用则退长轮询（`?since=<seq>`）。**不猜** |
| T-09 | 走宿主 `ctx.locale.register` | `lib/client/index.js`：`inject: ['slots','locale','remote']`，`ctx.locale.register('dshOps',{en,zh})`；渲染用宿主给的 `props.t` | dsh-anic **无** `ctx.locale.register`，自建 `src/client/i18n.ts` ⇒ **宿主切语言时面板不跟随**（两套语言事实） | ⏸ **先核实宿主 `dsh-client-locale` 的 register 签名与字典形状**（平铺 vs 嵌套）再动手 |
| T-11 | 写路由同源守卫 | `lib/cli/panel.js`：只绑回环、只 GET/HEAD、文件名正则白名单、**词法 + `realpathSync` 双防路径穿越**、统一 `no-store`+`nosniff`、403/404 **不泄露存在性** | dsh-anic 走宿主 webServer（**不比 dsh-ops 差，这点不照抄**）；CORS 侧做得很好（默认拒绝、回显 Origin + `Vary`、**绝不 `*`**）。真差距：**写路由无同源校验**（本机任意进程可触发写路由） | ⏸ 下轮。**不照抄** dsh-ops 的「自起 HTTP server」形态（那是倒退） |
| T-01 | 组件化切分 | 13 组件各有 `package.json`+locale+icon，根 patch 挂 8 个稳定 id 行；用户 profile 按 id 覆写 config，行可单独 `disabled` | dsh-anic 单入口（`src/index.ts` 一个 apply），63 条路由 + 21+ 工具在一个 fiber 上 | ⏸ **产品决策**，非技术债。若做，先拆 2 个高价值组件（面板 / 自举）验证收益 —— 拆全部会显著增加 manifest/校验/测试面 |

### 8.3 dsh-ops 的「事实 / 呈现 / 可重试性」三层分离 —— 本轮采纳的**结构**

dsh-ops 最值得学的不是某个功能，而是**一个结构**：

```
canonical value（事实）──▶ presentationMeta（呈现层：白名单 + 正则）
                          └▶ errorPolicy(code, effectState)（可重试性层）
```

关键设计（原文）：`errorPolicy(code, effectState)` 中 **`effectState` 压倒一切** ——
「a failed receipt never licenses replaying a possible write」。
`effectState` 四态：`none` / `applied` / `partial` / `unknown`。
dsh-ops 的执行器里 `catch` 写的是 `process.started ? 'unknown' : 'none'` ——
**进程已启动即意味副作用可能已发生** ⇒ `effectState='unknown'`。

**本轮采纳的部分**（小而正）：`effectState` 的**语义**进入 dsh-anic 的错误面 ——
「副作用可能已发生」必须能被表达，否则模型会把「可能已写入」当成「肯定没写」
而盲目重试。

**本轮明确不做的**：完整的 35+ 码表与 `status/retry` 双字段。理由：
那 35+ 码是 dsh-ops **文件/PTC/Bash 域**的码，dsh-anic 的域完全不同；
照抄会造出一张「看起来完整、实则大半不适用」的表 —— 这正是用户点名的
「表面连通、实际空心」。本轮只落**判据**（副作用可能已发生 ⇒ 不许盲重试），
不落**枚举**。

### 8.4 本轮采纳的两条「事前清单」（补事后机械扫描的缺口）

dsh-anic 的守卫族（`truthAudit` / G-*）是**事后**扫描 —— 代码写完了才知道越界。
llm-master §十 的最小模板给的是**事前**设计自检。本轮补两条：

**（1）新增能力的设计五要素**（抄 llm-master 的措辞，因为本仓读者也用中文）：

```text
能力名称：
背景与目标：解决谁的问题，成功结果是什么。
边界与异常：失败、重复、超时、并发、权限不足时怎么办。
非目标：这次明确不做什么。
验收标准：每条对应哪个测试文件 / 哪个断言。
```

落地纪律：新能力（新增 `anic_*` 工具 / 新增 HTTP 路由 / 新增面板分区）必须在
**同一 cycle 的文档**里填这张表。**不做成运行时检查** —— 守卫已经存在，
再套一层运行时检查是重复投资。

**（2）组件化切分的**判据**（不是结论）**：dsh-ops 的 13 组件形态证明
「正交能力各自成插件行」在 DSH 里可行；但 dsh-anic 是否拆属**产品决策**
（拆分会让 manifest / 符合性门 / 测试面同时变大）。**本轮不拆，只登记判据**：
若拆，先拆 2 个高价值组件验证收益，而不是一次拆 13 个。

### 8.5 本轮研究吸收的**净结论**

| 来源 | 净贡献 | 本轮落地 | 登记后续 |
|---|---|---|---|
| **llm-master** | **判据**，非代码。4 篇未读原文补齐后，最高价值增量是：Tool Registry 三字段 / Trace 两层 schema / SDD「规约变更同步」 | ① **SDD 五要素事前清单**（§8.4）；② 明确**拒绝**引入 `task_id`（第二真相源）；③ 明确标注**前端图谱与工程规范两项零贡献** | Tool Registry 三字段、Trace 两层 schema、漂移五信号 |
| **dsh-ops** | **结构**，非功能。三层分离 + 组件化 + 拆卸隔离 | ① **T-12 拆卸隔离**（已修+9 例）；② **T-04 未知键守卫**（已修+11 例）；③ **effectState 语义**进入错误面判据 | T-02 presentationMeta、T-05 配置迁移、T-07 事件驱动（先探测 SSE）、T-09 宿主 locale、T-11 写路由同源 |
