# 21 · 外部研究吸收与 cycle-82 落地设计

> 本档记录 cycle-82 的**输入**：我们从哪些外部材料里学到了什么、为什么采纳、为什么拒绝，
> 以及据此定下的四条落地战线与验收判据。
>
> 研究材料（两类，均已逐段阅读，非二手转述）：
> 1. **dsh-plugin-dev-kb**（本机挂载的 DSH 官方文档知识库镜像，`kb/meta/source.json` 记录了来源 commit）
>    —— 用于核实 DSH 插件契约的**当前真相**（工具出口 lossless JSON、能力接缝、子系统）。
> 2. **youngyangyang04/llm-master**（GitHub 开源大模型全栈教程，MIT）
>    —— 用于吸收**工程方法论**（Loop Engineering / Harness 可观测性），它对"一个自进化循环
>    应该被怎样观测与收敛"给出了可直接映射到本仓的判据。
>
> 纪律：外部材料只作**方法论输入**，不作事实来源。凡涉及 DSH 运行时行为的断言，
> 必须回到 `kb/` 镜像或安装包实测；凡涉及本仓行为的断言，必须落到可执行的断言上（本档每节都有）。

---

## 1. 从 dsh-plugin-dev-kb 学到的最硬的一条：工具出口必须是 lossless JSON

出处：`kb/extra/cookbook/adding-a-tool.md`

> "**Declare and return one canonical JSON value.** `output.schema` uses `ValueSchemaSpec` …
> `execute` returns only the inferred value; the registry snapshots it as **lossless JSON**,
> validates it, freezes it… **Throwing or returning an invalid value means `isError`**."

以及 `kb/extra/subsystems/ptc-runtime.md` 与安装包 `app.asar` 内的实现（Lead 用字节定位复核过）：

```js
function isRemoteJsonValue(value) { return visitJsonValue(value, new Set()); }
```

`visitJsonValue` 递归拒绝 `undefined` / `NaN` / `±Infinity` / 函数 / 符号 / 循环引用。

### 1.1 本仓的实测故障（不是推测）

真实宿主上调用 `anic_status` 工具直接整条失败：

```
Error: tool "anic_status" returned invalid output: value is not lossless JSON
```

根因（Lead 用探针脚本对真实 `.cycles/flow-tracker.json` 实测定位）：

```
undefined paths in report: [
  '.scripts[4].recentSuccessRate',
  '.scripts[5].recentSuccessRate',
  '.scripts[6].recentSuccessRate'
]
```

`analyzeSkillHealth()` 的 `ScriptHealth.recentSuccessRate?: number` 在「近 7 天无调用」时
（cycle-57 刻意设计的 `undefined` 语义）被原样塞进了工具 canonical value。
**一个正确的语义决定，在传输边界上变成了整条工具链路的致命错误。**

同类隐患清点（同一形状，只是还没触发）：`FlowRecord` 的 `endedAt/exitCode/stdout/stderr/durationMs`、
`SkillHealthReport.suggestions` 的可选字段、任何未来新增的可选字段。

### 1.2 采纳的修法：**出口防线**，不是逐字段修补

拒绝"把 `recentSuccessRate` 改成 `null`"这类点修：
点修只修今天的一个字段，下一个人加一个可选字段就再炸一次，而且炸在用户面前。
采纳 `src/host/runtime/jsonSanitize.ts` 的**统一出口防线**：

| 输入形态 | 处理 | 理由 |
| --- | --- | --- |
| 对象里值为 `undefined` 的键 | **删除键** | 语义是"没有这个字段"，变 `null` 会把"未知"说成"值为空" |
| 数组元素为 `undefined` | 变 `null` | 数组不能塌缩，下标即语义 |
| `NaN` / `±Infinity` | 变 `null` | JSON 无此值；`null` 是唯一诚实的替身 |
| `Date` | ISO 字符串 | 工具输出是数据不是对象图 |
| `BigInt` | 十进制字符串 | 同上 |
| 循环引用 | **抛错** | 在工具出口出现循环引用是编程错误，必须响亮 |
| 超深度/超节点数 | **抛错** | 防 DoS；上限显式声明 |

并且**零成本快路径**：先 `isLosslessJson(v)` 判断，合法直接返回原引用（正常路径零分配、
零语义变化）。这条是"防线不改变既有行为"的机械保证。

### 1.3 验收判据（机器可证伪）

- `tests/contract/toolOutputLosslessContract.test.ts`：**逐个工具**跑 `execute` →
  `JSON.stringify` roundtrip 深比较 + 递归扫描无 `undefined`。抽样的不算。
- 反向自检：去掉 sanitize，`anic_status` 用例必须红（否则测的是空气）。

---

## 2. 从 llm-master 学到的：Loop Engineering 的五变量 → 本仓的五个抓手

出处：`docs/interview/llm/loop_engineering_interview.md`（Loop 五变量：上下文 / 状态 / 预算 / 工具集 / 终止）
与 `docs/interview/llm/agent_harness_observability_interview.md`（七类可观测对象：目标 / 计划 /
上下文 / 工具 / 状态 / 成本 / 评估）。

这两篇讲的是"Agent 循环进生产会怎么裂、怎么治"。**ANIC 本身就是一个 Agent 循环**
（`.cycles/` 是它的状态，`anic_*` 工具是它的工具集，macro 六相是它的终止判据）。
于是"循环治理五变量"可以直接逐条对照本仓，找缺口：

| Loop 变量 | llm-master 的判据 | 本仓现状（cycle-81 末实测） | cycle-82 动作 |
| --- | --- | --- | --- |
| **上下文** | 要选、要压、要截，不能无脑全拼 | 工具面已有 `toolDisclosure`（indexed 模式按需激活）；面板分区默认折叠 | 已达标，不新增 |
| **状态** | 独立存储、跨圈传递、原始目标单独钉住 | `.cycles/` 全量落盘 + `workflow-state.json` + `ledger.jsonl`；**但"状态在哪、是否越界"不可见** | ★ 新增 `isolation.ts`：逐项断言每条读写路径都由 workspace 相对推导 |
| **预算** | 步数/Token/时间多重上限，触顶优雅退出 | `bootstrapBudget`、`complexity_budget`（band-detector）、`/anic/governance/budget` 已有 | 已达标，仅在配置编辑器里暴露 `complexity_budget` |
| **工具集** | 按阶段动态收放，危险工具加二次确认 | 23 工具全量注册 + `toolDisclosure` 两档 | 已达标 |
| **终止** | 模型信号 + 外部校验 + 硬兜底三层 | G0–G3 门禁 = 外部校验；熔断器 = 硬兜底；`band-detector` = 预算 | 已达标 |
| **可观测** | 每圈结构化记录、可回放 | ★ 三条真缺口见下 | ★ 三条战线的落点 |

### 2.1 三条真缺口（llm-master 判据照出来的）

**缺口 A：`.cycles/` 文档生命周期没有"生产矩阵"。**
llm-master 说"状态要独立存储、要能传递"，但只说对了一半——**存储的东西本身也要被审计**。
本仓 `.cycles/cycles/cycle-N/` 下有 15 类模板文档（cycle-plan / plan / spec / task-list /
eval-report / test-report / audit-log / page-state / non-functional-report / delivery-checklist /
retrospective / review / incident / intent / PULL_REQUEST_TEMPLATE），
模板在 `assets/skill/assets/templates/`，但**没有任何一处断言"某个 cycle 缺了哪份文档"**。
门禁 G0 只查评估报告、G1 只查任务清单、G2 只查测试报告——其余 12 类文档是"写了也没人看，
不写也没人管"。这正是 llm-master 说的"失败没有沉淀成资产"。
→ cycle-82 新增 **artifactsClosure（第五族）**：模板注册 → 每 cycle 生产（是否存在）→ 消费（谁读）。

**缺口 B：跨项目隔离只有实现，没有判定。**
用户诉求原文："不同项目使用本插件要隔离显示不能污染。"
现状：所有状态都从 `<workspace>/.cycles` 相对推导，逻辑上是对的；但
`resolveWorkspaceRoots` 末位有 `process.cwd()` 兜底，且**没有任何测试断言"绝不写到 workspace 之外"**。
一个 `process.cwd()` 兜底在单项目机器上永远看不出问题——多项目机器上就是污染。
→ cycle-82 新增 **isolation.ts**：列出 13 条状态路径的来源推导链，任一条不能相对推导即 violation。

**缺口 C：可观测面自己不可观测。**
面板有 13 个分区，但**图区是最重要的那一个，却是最不可用的那一个**：
188 节点 × 固定 380px 列 × 46px 行 = 高约 5600px 的细长条，无法缩放、无法平移、
无法搜索、无法筛选、悬停无反馈。用户原话："目前感觉不是很好，要可交互的图谱，功能很贫乏。"
→ cycle-82 新增布局压缩 + viewport + filter + 邻接高亮。

---

## 3. 第四条战线：配置与路径的可视化编辑

不是外部材料照出来的，是用户诉求直接点名的："配置/路径支持自定义可视化编辑等"。

现状：⚙ 抽屉只能切 `flow.*` 布尔开关（用户层 localStorage）；
`config.yml` 的 `autonomy_level`、`complexity_budget`、六个命令、`allowedOrigins`、
`toolDisclosure` 只能手改 YAML。手改 YAML 的风险在本仓有前科：
`autonomyActions.ts` 的文件头就写着"唯一做法是手改 config.yml：无前置判定、无回读断言、无审计记录"。

### 3.1 为什么不引 yaml 依赖

- 运行时零依赖是硬纪律（`package.json` 的 `dependencies` 至今为空）。
- 更重要：**`config.yml` 里全是中文注释**（cycle-77 往 `complexity_budget` 上写了 4 行注释解释
  为什么显式写默认值）。任何 `parse → stringify` 的库都会**把注释全丢掉**。
  配置文件的注释是"为什么这么配"的唯一载体，丢掉它比丢字段更糟。

### 3.2 采纳的修法：行级手术式 patch

按「段 + 缩进」定位那一行，原位替换值；缺失则在段尾插入。注释、空行、未知键、键顺序全部保留。
判据是机械的：**改动前后注释行集合必须完全相等，且差异行数 = 改动的字段数。**

写路径串：`干跑 diff → 原子写 → 同目录 .bak（留 3 份）→ 回读断言 → 不符则回滚`。
回读断言不是装饰：`autonomyActions.ts` 已有同族先例（改完回读断言 `autonomy_level` 真的变了）。

安全边界：自定义路径只接受「realpath 后仍含于 workspace 内且无 `..`」。
这是**路径可视化**，不是任意文件浏览器——把后者提供出来就是把插件变成一个写任意路径的入口。

---

## 4. 落地战线与写作用域（并行三队 + Lead 收口）

| 战线 | 责任 | 写作用域 | 禁止触碰 |
| --- | --- | --- | --- |
| G（图） | graphLayout / graphViewport / graphFilter / GraphInteractive + 契约测试 | `src/client/features/graph/`、`src/shared/panelCss.ts` | 面板装配层、locale、host |
| C（配置） | configSchema / yamlPatch / paths / configRoute / features/config/ | `src/host/configEdit/`、`src/host/routes/configRoute.ts`、`src/client/features/config/` | `routes/index.ts`（Lead 接）、面板装配层、locale |
| O（可观测） | jsonSanitize / 出口防线 / artifactsClosure / isolation | `src/host/runtime/jsonSanitize.ts`、`tools*Gateway.ts`、`closureAudit/*`、`features/closure/closureArtifacts|Isolation.ts` | locality、`.cycles/`、既有契约断言 |
| Lead | 装配接线（`routes/index.ts`、`WorkflowGraphPanel`、`panelSections`、`panelState`）、locale 合并、版本/CHANGELOG/README、全量验证、热重载真机复验、`.cycles/cycle-82` 全套文档 | 装配层 + 文档 | 三队作用域 |

写作用域**互斥**——这是并行不打架的前提，不是建议。

---

## 5. 为什么"拒绝"了另外三件看起来该做的事

诚实登记，避免下一轮重复讨论：

1. **不引图布局库（dagre / elkjs / d3-force）。**
   理由：① 运行时零依赖纪律；② 本图的数据形态是"分类型 lane"而非任意有向图，
   确定性分层 + lane 内折列已经能达到目标压缩比；③ 力导向布局**不确定**，
   无法写"同输入同输出"的断言，也就无法写契约测试——不可测的布局等于不可维护。
2. **不做"筛选即隐藏"（把不匹配节点从 DOM 移除）。**
   理由：smoke 与多个契约测试钉死"渲染的 circle 数 == snapshot.counts.nodes"。
   "隐藏"改成 `opacity + pointer-events` 表达，视觉等价、可访问性更好（AT 仍能遍历全图）、
   且不破坏既有不变量。**这是刻意的取舍，不是没做。**
3. **不在本轮把 `.cycles/` 文档生命周期接进门禁阻断。**
   理由：先做**观测**（artifactsClosure 报告缺哪份），后做**阻断**。直接阻断会让 78 个历史
   cycle 立刻全红，门禁失去区分度。先让缺口可见，下一轮再按族灰度。

---

## 6. cycle-82 验收清单（每条都可机器证伪）

- [ ] `anic_status` 在真实宿主返回合法值（curl 实测，不再 invalid output）
- [ ] 逐工具 lossless 契约绿（非抽样）
- [ ] 图总高度 ≤ 原高度 60%（对 `artifacts/workflow-snapshot.json` 实测断言）
- [ ] 图上节点/边一个不少（smoke 的 circle/line 计数不变量仍绿）
- [ ] 缩放/平移/筛选/邻接高亮的边界钳制有单测
- [ ] `config.yml` patch 后注释行集合完全相等（差异行数 = 改动字段数）
- [ ] 非法配置值被拒；回读失败回滚；`.bak` 留 3 份
- [ ] 路径逃逸（`..` / workspace 外）被拒并给出原因
- [ ] `artifactsClosure` 能点名「cycle-N 缺哪份文档」
- [ ] `isolation` 能点名任何 workspace 外的读写路径
- [ ] `pnpm run typecheck && pnpm run test && pnpm run build` 全绿
- [ ] 真机 `anic_reload_self` 后新路由可访问、**旧路由零回归**
