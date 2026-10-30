# 23 · 外部研究吸收与 cycle-89 落地设计（自举事实基线 / 三态契约 / 可观测派生率）

> 本档是 cycle-89 的**输入**：三个来源各取一手原文，逐条给出 `来源 → 观察 → 对 dsh-anic 的改法(文件级) → 验收方式 → 优先级`。
> 不是读后感：每条都要能落到一个文件、一条机械判据上。
>
> 研究材料（本机实测 / 一手抓取，逐节附证据位置）：
> 1. **youngyangyang04/llm-master**（GitHub，MIT）—— 本轮抓 `README.md`、`docs/roadmap/README.md`、
>    `docs/llm/app/agent_evaluation.md` 三篇全文；目录结构取 GitHub trees API（`main` @ `78b03ad`）。
> 2. **dsh-plugin-dev-kb**（本机官方文档镜像，`…/node_modules/dsh-plugin-dev-kb/kb`，634 个 md）——
>    本轮实证 `kb/meta/topics.md`（全文）、`kb/site/develop/basic/config.md`（§定义 Config 类型）、
>    `kb/site/develop/framework/service.md`（:8/:24/:27/:35/:39-77 行）。
> 3. **dsh-ops 0.4.4（本机安装态源码）**—— `dsh-plugin.json`（1-120 行）、`package.json`
>    （:35 `exports` / :135 `dsh` / :197 `peerDependencies` / :259 `engines.dsh: ">=0.2.0-rc.2 <0.2.2-0"`）、
>    `lib/` 目录树、`docs/` 清单（含 160KB `CHANGELOG.md`、`benchmark-gates.md`、`result-budgets.md`）。
>
> 纪律不变：外部材料只作**方法论与工程形态输入**，不作事实来源。**未见原文的不写成结论**（§6 逐条登记）。
>
> 命名说明：本档与 `23-cycle89-工作包与边界.md` 同前缀不同用途——那份是**并行分工权威**，本档是**研究输入**。
> 下一轮若重编号，只改文件名，不改引用。

---

## 0. 十条吸收项与本轮目标的对位

| # | 吸收项 | 落点文件 | 对应目标 | 优先级 |
|---|---|---|---|---|
| A1 | 自举三态化：`detect → plan → apply`，plan 零写盘 | `src/host/selfBootstrap.ts` | G1 | **P0** |
| A2 | 评估结果四档（完整/部分/**正确失败**/错误失败） | `src/host/runtime/healthVerdicts.ts` | G1 G8 | P1 |
| A3 | 失败归因：派生率（重复调用/无效调用/超时） | `src/host/runtime/invocationAttribution.ts` + `healthSummary.ts` | G8 | **P0** |
| A4 | 「最低交付标准」当一等数据，而不是只查文件存在 | `src/host/closureAudit/` | G8 | P2 |
| A5 | 知识库三入口 + 每阶段「完成标志」列 | `docs/anic/README.md` | 文档面 | P2 |
| K1 | 插件导出 `Config` + Schemastery 默认值 | `src/index.ts` + `src/host/config.ts` | G4 | P1 |
| K2 | 能力包成 `Service`（`declare module` 接口合并） | `src/host/capabilityIndex.ts`（新 `AnicSnapshotService`） | G3 | P1 |
| K3 | `ctx.effect` 承接定时器（机械审计：禁裸 `setInterval`） | `src/host/runtime/hotReload.ts` 等 | G7 | P2 |
| K4 | 能力三态契约化 definition/provider/consumer | `src/host/capabilityIndex.ts` | **G3** | **P0** |
| K5 | 持久化 `schemaVersion` + 迁移器（幂等+备份） | 新 `src/host/runtime/persistenceMigrations.ts` | G3 G4 | **P0** |
| O1 | 声明式工具命名空间清单 + 与注册表双向差集断言 | 新 `src/host/toolNamespaces.ts` | G3 | P1 |
| O2 | `engines.dsh` 兼容窗口 + 规范门 C13 | `package.json`（**Lead 独占**）+ `scripts/validate-dsh.mjs` | G7 | P1 |
| O3 | 技能调用并发预算（`MAX_ACTIVE_CALLS`） | `src/host/skillInvokerAsync.ts` | 稳定性 | P1 |

（共 14 条，下表逐条展开；§4 给 Top5。）

---

## 1. 来源一：youngyangyang04/llm-master —— 评估的**分档**与**归因**

### A1 · 评估结果必须四档，不能二分「成功/失败」 【P0，本轮最高价值之一】

- **来源**：<https://github.com/youngyangyang04/llm-master> › `docs/llm/app/agent_evaluation.md` §二「任务完成率」。
- **观察**：原文把结果拆成 **完整完成 / 部分完成 / 正确失败 / 错误失败**，并钉死一句判据：
  「**部分完成不是坏事。坏的是：明明只完成了一部分，却装成全部完成。**」
  以及「正确失败 = 识别无法完成的原因，并给出下一步动作」；四档不能算平均分。
  §十「误区四」再补一刀：「指标太多但没人看……**特别是安全问题，不能被平均**」。
- **对 dsh-anic 的改法（文件级）**：
  - `src/host/runtime/healthVerdicts.ts`：现有裁决词表扩为四值 `DONE | PARTIAL | BLOCKED | FALSE_PASS`，
    `BLOCKED` 必带 `reason`（缺哪份证据/哪个命令没跑），`FALSE_PASS` 表示"判了 PASS 但无证据"。
  - `src/host/runtime/healthSummary.ts`：汇总从「成功率」改为**四档计数 + 各自占比**，成功率降为派生值。
  - `src/client/features/diagnostics/`：四档用四个 `data-anic-verdict="…"` 锚点渲染，`FALSE_PASS` 单列红色且不计入平均。
- **验收方式**：单测断言四档互斥且穷尽（同一个输入只落一档）；构造「无证据却 PASS」夹具 → 必落 `FALSE_PASS` 且汇总 `averageScore` 不受它影响；
  `anic_status` 返回体经 lossless JSON 契约仍绿（可选字段走 §21 号文档的出口防线）。
- **为什么值得**：这正是本仓「历史产物压过最新事实」的镜像——`self-bootstrap.json` 停在 `EXHAUSTED / evalScore 0`
  而 cycle-88 eval 全 PASS，本质就是**把「过去的正确失败」当成了「今天的错误失败」**。分档是修这个的语言基础。

### A3 · 失败要归因到「哪一类动作做错了」，而不是只有一个成功率 【P0】

- **来源**：同上 §三「步骤效率」+ §七「评估集怎么设计」+ §十「误区五：没有失败归因」。
- **观察**：原文给出可机械计算的四个率——**平均步数 / 无效工具调用率 / 重复调用率 / 关键路径长度**；
  并给出线上 12 项监控（完成率、追问率、工具调用次数、平均步数、**工具失败率、重复调用率、超时率**、高风险确认率、取消率、接管率、差评率、安全拦截）。
  关键句：「只知道成功率 70%，没用。你要知道失败来自哪里」。
- **对 dsh-anic 的改法（文件级）**：
  - `src/host/runtime/invocationAttribution.ts`：在既有调用记录上派生三个**纯函数**率
    ①`repeatRate`（同脚本 + 同参 30s 内重复）②`invalidRate`（exitCode≠0 且未进入下一相位）③`timeoutRate`（超 `bootstrapBudget` 或脚本默认超时）。
  - `src/host/runtime/healthSummary.ts`：把三率并入健康摘要；`slow`（超时率）先判、`degraded`（成功率）后判——
    **沿用 CLAUDE.md 已记录的判定顺序**（timeout 是 DONE 的子集，先查更具体的）。
  - `src/host/runtime/flowTracker.ts`：无需改形状，只用现成的 `startedAt/endedAt/exitCode` 做输入（避免动 INV 冻结的记录形状）。
- **验收方式**：三率各一条单测（零 clock、零 random，注入时间戳）；
  对 `tests/fixtures` 里"同脚本连跑 3 次全超时"的假数据断言 `timeoutRate===1 && repeatRate>0`；
  再断言 `healthSummary` 的等级判定顺序（slow 优先）不被三率新增打乱。
- **备注**：本条**只读** `.cycles/`，不新增持久化面，1h 内可完成。

### A2 · 分档落到产物裁决（P1，本轮只登记）

- **来源**：同上 §八「自动化评测和人工评测都要有」+ §七「评估集五类样本」。
- **观察**：评估集必须覆盖 **正常完成 / 信息缺失 / 工具失败 / 高风险动作 / 干扰噪音** 五类；
  每个样本标清「用户目标 / 可用工具 / 初始输入 / 标准完成条件 / 允许的工具调用 / 不允许的动作 / 预期失败处理 / 评分规则」。
  自动化只判结构化指标，**LLM-as-judge 只能辅助**（「不要让模型评价模型，然后大家一起自我感动」）。
- **改法（文件级）**：`tests/contract/` 新增一族「样本覆盖契约」，断言技能 `evals` 五类样本各至少 N 条；
  `src/host/closureAudit/` 的产物判据把「预期失败处理」列为必填字段（缺 = BLOCKED 而非 PASS）。
- **验收**：五类样本缺任一类 → 契约红并点名缺的类别。
- **优先级**：P1（要先有 A1 的四档词表，否则没有落点）。

### A4 · 「最低交付标准」是数据，不是口号（P2）

- **来源**：`README.md` §「四个值得写进简历的项目」表：每项目一列 **最低交付标准**（如「有异常处理、Token 统计和自动化测试」）；
  `docs/roadmap/README.md` 每阶段一列 **完成标志**。
- **观察**：该仓库把「完成」定义为**可检验的交付标准**，不是「跑通 Demo」；原文明写「项目不以跑通 Demo 为结束」。
- **改法（文件级）**：`src/host/closureAudit/` 从「这份文档存在吗」升级为「这份文档的第 k 条最低标准满足吗」，
  清单外置为数据（模板目录旁一份 `deliveryStandards.json`），避免把判据写进代码。
- **验收**：cycle-N 缺「eval-report 必须含 16 维」→ 报告点名 `cycle-N: 最低交付标准 #eval-report.16dims 未满足`，而非只说"缺文件"。
- **优先级**：P2（依赖 doc 21 号已建的 artifactsClosure 先稳定一版）。

### A5 · 知识库的三入口结构（P2，纯文档）

- **来源**：llm-master `README.md` §「如何使用这个仓库」+ `docs/README.md`（20KB 全量索引）+ `docs/topics/README.md` + `docs/roadmap/README.md`。
- **观察**：同一套内容给**三种任务**三条入口：「第一次学习 → 路线」「正在做项目 → 专题」「准备面试 → 题库」；
  路线表每行必带 **完成标志**；专题页是枢纽（不复述内容，只给图与跳转）。
- **改法（文件级）**：`docs/anic/README.md` 的 §2 文档地图加一列 **完成标志**（例：18 号的完成标志 = P0-P3 清零裁决入档）；
  §0 前加三个**任务入口**（新人上手 / 做某一域 / 评审与交付）。本轮**只加索引一行**（工作包 §2 边界），
  结构改造留到 cycle-90，避免与 Lead 的 README 计数契约（`tests/contract/readmeNumbers.test.ts`）抢改。
- **验收**：文档地图每行都有完成标志（可机械检查：表格列数一致 + 无空单元格）。
- **优先级**：P2。

---

## 2. 来源二：dsh-plugin-dev-kb —— 宿主能力里我们**没用或用了旧写法**的五处

> 定位路径来自 `kb/meta/topics.md`（§2 Tool / §3 配置 / §4 服务与 DI / §6 生命周期 / §9 能力分层 / §17b 升级与持久化）。

### K5 · 持久化格式变更必须有「版本 + 迁移」通道 【P0】

- **来源**：`kb/meta/topics.md:80-82`（§17b「版本升级与持久化变更」）→ `kb/extra/persistence-changes/`（releases/ + historical-formats/）与 `kb/extra/upgrade-guide/`。
- **观察**：官方镜像把「持久化格式」当**一等公民**：每个破坏性格式变更都有独立记录 + 历史格式留存，
  并有按版本组织的升级指南（topics.md 举例 `schedule-bundle-retired`、`remove-runtime-invariants`、`subpath-plugin-display-manifest`）。
  机制要点：**格式有版本号 → 变更只追加不原地改 → 旧格式可回放 → 迁移步骤可枚举**。
- **dsh-anic 现状（对照）**：`.cycles/` 登记了十三个持久化面（doc 22 §1.2），但**只有 `paths.json` 带 `{version:1}`**；
  其余 `flow-tracker.json` / `self-bootstrap.json` / `workflow-state.json` 无版本字段、无迁移器。
  G3 要给 flow 记录加 `cycle/phase/gate` join key ——**没有迁移器，加字段就等于让 80+ 历史 cycle 的旧记录在新读侧崩**。
- **改法（文件级）**：
  - 新增 `src/host/runtime/persistenceMigrations.ts`：`Map<面名, Array<{from,to,migrate}>>`，硬判据三条 ——
    ① 幂等（`schemaVersion >= 目标` 直接 no-op）② 迁移前同目录 `.bak` ③ 迁移后回读断言字段齐全（失败即 fail-closed，不写"已完成"）。
  - `src/host/runtime/flowTracker.ts` 与 `src/host/selfBootstrap.ts` 读写时带 `schemaVersion: 1`。
  - 不在读侧做"猜测补全"（那是把迁移藏进投影，违反 doc 22「派生不能当真相源」）。
- **验收方式**：造一份 v0 形状的 `flow-tracker.json`（无 join key）→ 迁移后字段齐全、原文件 `.bak` 存在、二次迁移为 no-op；
  再断言"缺版本字段的空对象"**不被静默当 v1**（必须走迁移或响亮失败）。

### K1 · 插件应导出 `Config` + Schemastery schema（默认值写在 schema 里） 【P1】

- **来源**：`kb/site/develop/basic/config.md`（「定义 Config 类型」节，实证代码：`export const Config: Schema<Config> = Schema.object({ greeting: Schema.string().default('Hello'), … })`）。
- **观察**：宿主侧配置是**类型 + schema + 默认值三位一体**；schema 即校验器即默认值来源，缺省值不需要在业务代码里散落 `??`。
- **dsh-anic 现状**：`src/host/config.ts` 是唯一 loader（INV-25），但**插件入口不导出 `Config`**；
  三层合并（用户 prefs > `.cycles/config.yml` > 部署 bundle config）中，**部署层没有 schema 兜底**，
  9 个 flow 开关的默认值以常量形式写在 `shared/flows.ts`，与宿主可校验面脱节。
- **改法（文件级）**：`src/index.ts` 增 `export const Config = Schema.object({...})`（9 开关 + `autonomy_level` + `complexity_budget` 默认值）；
  `src/host/config.ts` 的合并器把 schema 默认值作为**最底层**而非最外层，避免覆盖 `.cycles/config.yml` 的用户值。
  ⚠️ 依赖约束：`@deepseek-ai/schemastery` 属宿主包，按 TD-A1 只能从宿主解析、**不得新增运行时依赖**；
  若解析不到则降级为纯类型导出并响亮记录（fail-closed 到日志，不静默）。
- **验收方式**：`cordis.yml` 写错类型 → 宿主拒绝加载并给出字段路径；完全不写 → 与当前常量默认值逐字段相等（快照断言）。

### K2 · 能力用 `Service` 基类 + `declare module` 接口合并暴露 【P1】

- **来源**：`kb/site/develop/framework/service.md:39-77`（`export default class MetricsService extends Service { static inject = ['llm'] }`、
  `declare module '@deepseek-ai/cordis' { interface Context { metrics: MetricsService } }`）与 `:24-35`（`export const inject = ['tools']`；
  「框架保证：`apply` 执行时 inject 声明的服务已全部就绪」）。
- **观察**：DSH 的服务是**可被别的插件消费的一等能力**，通过 `declare module` 做类型合并，消费者拿到的是接口不是实现。
- **dsh-anic 现状**：全仓**零 Service**。能力面 = 函数 + 路由 + 工具 + 客户端标签；跨模块靠直接 import 单例。
  后果：① 其它插件无法消费 anic 的快照/账本能力；② 无法用 `ctx.get('anic', …)` 做存在性探测（CLAUDE.md 已记 strict 默认会杀死 loading 中的 provider）。
- **改法（文件级）**：把 `src/host/capabilityIndex.ts` 背后的快照构建器包成 `AnicSnapshotService extends Service`（服务键 `anic`），
  在 `src/host/anicRoutesPlugin.ts` 里 `ctx.set`；`src/host/snapshotRoute.ts` 改为**消费者**形态（`ctx.get('anic', false)` 探测）。
  disposer 由 `ctx.effect` 承接（不手工记账）。
- **验收方式**：契约测试两条——`apply` 后 `ctx.get('anic', false)` 返回实例；dispose 后返回 `undefined` 且不抛。
  反向自检：注入一个抛错的 provider → 消费侧必须走 `false` 分支而不是整插件死（钉死 strict=false 的用法）。

### K3 · `ctx.effect` 必须承接定时器（机械审计项） 【P2】

- **来源**：`kb/meta/topics.md:27-29`（§6「生命周期与副作用」，核心 `ctx.effect()` 自动清理）+ `kb/extra/defensive-patterns.md`（生命周期/并发/子进程防御模式）。
- **观察**：官方口径是**副作用一律挂在 effect 上，由框架在 fiber dispose 时清理**；裸定时器/裸监听器是已知事故形态。
- **dsh-anic 现状（未取证，本条给的是审计 + 修法）**：`src/host/runtime/hotReload.ts`、`reloadOrchestrator.ts`、
  `invocationFeed.ts`、以及自动刷新链路都可能持有定时器。**本轮未逐文件核对**，因此本条先落**机械判据**再谈修法。
- **改法（文件级）**：新增 vitest 静态契约 `tests/contract/noBareTimers.test.ts`：
  扫 `src/host/**`，出现 `setInterval(` / `setTimeout(` 且所在文件未出现 `ctx.effect(` → 红。
  命中后逐个包 `ctx.effect(() => { const t = setInterval(fn, ms); return () => clearInterval(t) })`。
- **验收方式**：该契约先红（列出真实命中清单）→ 修完转绿；`dispose` 后假定时器计数归零（`vi.useFakeTimers`）。
- **优先级**：P2（G7 热更新真机复验的前置自查；先让缺口可见，不阻断）。

### K4 · 能力接缝的三层（Definition / Provider / Consumer）—— 正是 G3 的本地化 【P0】

- **来源**：`kb/meta/topics.md:19-21`（§4「服务与依赖注入」，扩展指向 `kb/site/reference/capability-seams.md`：「能力三层：Service Definition / Provider / Consumer」）与 §9「扩展点与能力分层」。
- **观察**：官方把「能力」拆成三层显式角色：**定义（契约）→ 提供者（实现）→ 消费者（使用方）**；
  缺任一层不是"没写完"，而是**结构性空洞**，应当可判定、可报告。
- **dsh-anic 现状**：G3 原话就是「注册→生产→消费三态连通性」。本仓已有 `src/host/capabilityIndex.ts` +
  `capabilityIndexRuntime.ts`，但它是**索引**（我有什么）而非**契约判定**（谁该消费却没消费）。
- **改法（文件级）**：`src/host/capabilityIndex.ts` 每条能力输出三元组
  `{ definition: {id, schemaVersion}, provider: {module, registeredAt}, consumers: [{module, route|tool|panel}] }`；
  判据两条：① `provider` 缺失 = 空洞（注册了定义没人生产）② `consumers.length === 0` = 空转（生产了没人消费）。
  `src/client/features/closure/` 增加「空转清单」视图（复用现有 closure 分区，不新增顶层标签）。
- **验收方式**：构造「注册了但无消费」的假能力夹具 → 报告点名；对真实 `.cycles/` 跑一遍，空转数进快照
  （`counts.danglingCapabilities`），并对快照做完整性断言（三元组字段齐全，不允许 `undefined` 漏到工具出口）。

---

## 3. 来源三：dsh-ops 0.4.4（本机安装态）—— 声明式能力面与三段式动作

### O1 · 工具/提示面是**声明式清单**，且带「在什么条件下发布」 【P1】

- **来源**：`C:/Users/86156/.dsh/profiles/desktop/node_modules/dsh-ops/dsh-plugin.json` 第 51-104 行：
  `contributes["x-prompt-sections"]`（每项 `name` / `order` / `summary`，summary 明写发布条件：
  「published only for Standard-preset sessions when the row is on and promptPolicy is enabled」）与
  `contributes["x-tool-namespaces"]`（`serverName` / `transport` / `source` / `publicPrefix: "ops_"` / `tools: [...]`）。
- **观察**：成熟插件把「我对外提供哪些工具、什么前缀、在什么条件发布」写成**数据**，
  于是宿主/评审可以在**加载前**看到能力全貌；运行时注册只是这份声明的执行。
- **dsh-anic 现状**：工具面靠 `src/host/toolDisclosure.ts`（+`toolDisclosureWiring(Runtime)`）+ `toolsSlot.ts` 运行时注册，
  **没有声明清单**；工具数量、前缀、启用条件只存在于代码与文档描述里（truthAudit T4 还要 glob 扫 `src/host/tools*.ts` 数工具——CLAUDE.md 已记这个坑）。
- **改法（文件级）**：新增 `src/host/toolNamespaces.ts` 作为**唯一声明源**（15+ 工具 → 域/前缀/发布条件/关闭形态），
  `toolsSlot.ts` 与 `toolDisclosure.ts` 从声明读取；契约测试断言「声明清单 == 实际注册清单」（双向差集为空）。
  truthAudit T4 的计数改为读声明，不再 glob 文件。
- **验收方式**：故意让一个工具"注册了但没声明" → 契约红并点名；反之"声明了没注册"也红。
- **配合**：本轮工作包 §2 规定 `toolsSlot.ts`/`tools.ts` 属 Lead 独占 —— 本条只产出**声明文件 + 契约**，
  接线由 Lead 合并（报告里写"新增 1 个声明文件 / 1 条契约"）。

### O2 · `engines.dsh` 明确兼容窗口（可审计的版本区间） 【P1】

- **来源**：`…/dsh-ops/package.json:259` → `"engines": { … , "dsh": ">=0.2.0-rc.2 <0.2.2-0" }`；
  另有 `:197` `peerDependencies`、`:135` `dsh` 字段、`:35` `exports`。
- **观察**：同生态插件用 `engines.dsh` 把**支持哪个宿主区间**写成机器可读的断言，
  配合 `peerDependencies` 表达"宿主提供而不是我带来"的依赖方向。
- **dsh-anic 现状**：README 记载「dsh-anic 零 `@deepseek-ai/dsh*` peer ⇒ 兼容门必过」；
  **本轮未核实 `package.json` 是否已有 `engines.dsh`**（该文件 Lead 独占，我没有读改）。若缺，则 doc 07 的 B1-B11 破坏性变更**无法机械判定影响面**。
- **改法（文件级）**：`package.json` 增 `"engines": { "dsh": ">=0.4.0 <0.5.0" }`（**由 Lead 落**）；
  `scripts/validate-dsh.mjs` 增 C13 门：缺 `engines.dsh` 或区间格式非法 → 红。
- **验收方式**：C13 绿；把区间写成 `"*"` 或删掉 → C13 红（证明确实有判别力）。

### O3 · 长任务要有并发预算，且拒绝发生在副作用之前 【P1】

- **来源**：`…/dsh-ops/lib/kernel/call-budget.js`（doc 22 §2.1 已引：`MAX_ACTIVE_CALLS = 2`、`MAX_WAITING_CALLS = 8`、
  拒绝信息带 `no effects`）；`…/dsh-ops/docs/result-budgets.md` 与 `docs/benchmark-gates.md` 显示预算被**独立成文并带基准**。
- **观察**：预算是**一等机制**（有常量、有错误类型、有拒绝语义），不是散落的 if。
- **dsh-anic 现状**：doc 22 §2.1 已登记缺口（`anic_skill` 无并发上限，同步 `spawnSync` + 异步 `spawn` 两条路径都可能被连点 10 次）。
  本轮文件已就位：`src/host/skillInvokerAsync.ts`（异步）与 `src/host/skillInvoker.ts`（同步）。
- **改法（文件级）**：`src/host/skillInvokerAsync.ts` 内加按 `workspace+script` 的 FIFO 信号量（active 2 / waiting 8），
  超限返回带 `no effects` 语义的结构化错误；**拒绝点必须在 spawn 之前**（与 dsh-ops 同判据）。
- **验收方式**：并发 10 个调用的单测断言 active 峰值 ≤2、第 11 个被拒且 `.cycles/` 零新增文件。
- **优先级**：P1（G3/G8 之外，但 1h 可完成且是真实安全缺口；doc 22 曾排 cycle-84，本轮可顺手收）。

---

## 4. 本轮 Top5（按「价值 ÷ 落地成本」排序，均可在 1-2 小时落地）

| 序 | 吸收项 | 一句话理由 | 目标文件 |
|---|---|---|---|
| **1** | A1 自举三态化 `detect → plan → apply`（plan 零写盘） | G1 要显示「陈旧 / 可重启」，就必须有一个**不写盘、可返回**的 plan 阶段；现在 `selfBootstrap` 只有"跑"和"已跑完"两态，所以陈旧产物一旦落盘就只能靠人删。 | `src/host/selfBootstrap.ts`、`src/host/runtime/artifactArchiveFacts.ts` |
| **2** | K5 持久化 `schemaVersion` + 幂等迁移器 | G3 要给 flow 记录加 cycle/phase/gate join key；**没有迁移器，加字段当天就会让 80+ 历史记录读崩**，这是纯技术债但会立刻兑现。 | 新 `src/host/runtime/persistenceMigrations.ts`、`src/host/runtime/flowTracker.ts` |
| **3** | K4 能力三态契约化 definition/provider/consumer | G3 原话就是"注册→生产→消费三态连通性"，而现有 `capabilityIndex` 只回答"我有什么"，不回答"谁该用却没用"——空转是无声的。 | `src/host/capabilityIndex.ts`、`src/client/features/closure/` |
| **4** | A3 失败归因派生率（重复/无效/超时） | G8 要求"质量闭环"，但只有一个成功率就无法回答"是不是变差了、差在哪"；三率是纯函数，零持久化改动。 | `src/host/runtime/invocationAttribution.ts`、`src/host/runtime/healthSummary.ts` |
| **5** | A1′（A1 的姊妹项）四档裁决 `DONE/PARTIAL/BLOCKED/FALSE_PASS` | 把"诚实失败"与"假通过"分开，直接对治本轮 P0 的病根——`EXHAUSTED/evalScore 0` 的历史产物冒充今天的结论，本质是缺 `FALSE_PASS` 这一档。 | `src/host/runtime/healthVerdicts.ts`、`src/client/features/diagnostics/` |

> 第 6 位（不入 Top5 但同轮可做）：O3 并发预算 —— 1h，`src/host/skillInvokerAsync.ts`，安全缺口，无设计争议。
> 第 7 位：K1 导出 `Config` schema —— 需先确认 `@deepseek-ai/schemastery` 在 TD-A1 下可解析，否则降级为类型导出。

---

## 5. 明确拒绝（避免下一轮重复讨论）

1. **不引入 LLM-as-judge 做评估主判。** llm-master 自己就否掉了这条（§十误区三：「不要让模型评价模型，然后大家一起自我感动」）；
   本仓 doc 12 的 Tier-2 语义评审是**可选增强**，不能进门禁链路。拒绝理由：不可判两态 + 成本不可控 + 宿主不保证结构化输出（doc 18 R-26）。
2. **不把 G0-G3 合成一个加权总分。** 呼应 §十误区四「安全问题不能被平均」；本仓已有 `evalScore` 这类单值，
   **恰好是本轮病根的一半**——单值一失真，整个自举就被历史数字带跑。
3. **不迁移到 `dsh-plugin.json` manifest v0.15。** doc 22 §2.5 已裁决（两套 schema 生态，迁过去要重写 12 项符合性门），本条不重开。
4. **不引 native worker / Windows SID 沙箱。** doc 22 §2.6 已裁决（威胁模型不同），本条不重开。
5. **不在本轮改 `docs/anic/README.md` 的表格结构**（A5 只登记不实施）：该文件有 `tests/contract/readmeNumbers.test.ts` 计数契约，
   结构改造会与 Lead 的收口撞车；本轮只按边界加一行索引。

---

## 6. 未获取 / 未核实（诚实清单，禁止当成结论使用）

| 项 | 状态 | 原因 |
|---|---|---|
| llm-master `docs/llm/app/multi_agent_context_governance.md`（19.8KB）、`docs/interview/llm/spec_driven_development_interview.md`（25.7KB） | **未获取原文** | 时间预算收敛（Lead 30 分钟停线指令）。只从 trees API 知道文件存在，**不据此写任何结论**。若 G3 的 join key 设计需要"跨 agent 上下文治理"的判据，下一轮优先补这两篇。 |
| llm-master `docs/llm/app/agent_tool_design.md`（25.7KB）、`harness_interview.md`（37.7KB） | **未获取原文** | 同上；本轮工具面结论只引 O1（声明式清单）与既有 doc 21/22，不引未读文件。 |
| kb `site/reference/cookbook/adding-a-tool.md`（工具 schema / 判别联合） | **本轮未重读** | 只按 topics.md 路径确认存在。因此**本档不对"工具 schema 判别联合"下任何结论**；若下一轮要做工具输入结构化，先读该文件再立项。 |
| kb `site/reference/capability-seams.md` | **未读原文** | K4 的三层角色表述来自 `kb/meta/topics.md:19-21` 的**摘要行**（已标注出处），未逐字核原文。落地前须读原文确认术语与约束。 |
| dsh-ops `lib/index.js`（主入口）、`docs/CHANGELOG.md`（160KB） | **未读** | 主入口体积大且与 doc 22 已吸收的三条形态重复；CHANGELOG 160KB 不适合整读。 |
| dsh-ops `dsh-plugin.json` 第 121-187 行（`x-components` 后半、其余 contributes） | **未读** | 本轮 O1 只需 1-104 行的两种声明形态，已足证。 |
| dsh-anic `package.json` 是否已有 `engines.dsh` | **未核实** | 该文件属 Lead 独占写域，本轮未读改。O2 的改法里已写明"由 Lead 落"，不假设现状。 |
| `src/host/runtime/hotReload.ts` 等是否已用 `ctx.effect` 承接定时器 | **未核实** | K3 故意先落**机械审计契约**（先红再修），避免凭印象下断言。 |

---

## 7. 与 21/22 号文档的关系（防重复劳动）

- 21 号吸收的是「工具出口必须 lossless JSON」与「循环治理五变量」；22 号吸收的是「state 要有 schema/版本/检查点 + 按需投影」与 dsh-ops 四条工程形态。
- 本档**不重复**上述结论，只补三件它们没覆盖的：**多档裁决语言（A1/A2）**、**能力三态契约（K4）**、**持久化迁移通道（K5）**。
- 22 号 §4.2 曾把「并发预算」排到 cycle-84；本档 O3 把它重新登记为 P1（文件已就位、判据已在 doc 22 想清楚），是否本轮顺手收由 Lead 决定。
