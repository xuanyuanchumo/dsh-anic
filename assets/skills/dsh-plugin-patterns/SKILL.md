---
name: dsh-plugin-patterns
version: 0.1.1
whenToUse: >
   在 dsh-anic（或任何 DSH 插件）里需要设计工具注册面、写 client 半部 UI、处理生命周期
   拆卸、防御式错误处理、分层持久化与可观测性时使用。沉淀自 dsh-ops v0.4.4 与
   dsh-context v0.81.0 源码研究（2026-11-06）与本插件 cycle-107 命令窗口显示修复实战。
   触发词（中文）：工具注册、toolview、slots、生命周期、拆卸、防御式、失败为值、
   持久化、可观测、面板、插件模式。
   Trigger words (EN): tool registration, toolview, slots, lifecycle, teardown,
   defensive, failure-as-value, persistence, observability, panel, plugin patterns.
description: >
   Triggers: tool registration, toolview, slots, lifecycle teardown, defensive
   patterns, failure-as-value, layered persistence, observability, panel, plugin
   patterns. Use when designing dsh plugin tool surfaces, client-side slot UI,
   dispose lifecycle, defensive error contracts, layered persistence, or panel
   observability. Distilled from dsh-ops/dsh-context source research + cycle-107.
---

# DSH 插件工程模式（dsh-plugin-patterns）

## 一句话定位

从 dsh-ops / dsh-context 两个生产级插件源码研究提炼的 **12 条工程模式叶技能**，覆盖
工具注册、client UI、生命周期、防御式编程、持久化、可观测六个面；并以 cycle-107
命令窗口显示修复为第一个实战锚点。

> 只提供操作知识与模式，不改流程脊柱。所有模式都有源码或 KB 出处；KB 快照与实际
> 安装包不一致时以实际安装包为准。

## 硬性规则（12 条模式，均有出处）

### A. 工具注册面

| # | 模式 | 要点 | 出处 |
|---|---|---|---|
| P01 | 能力目录表 | 全部工具集中为一张冻结元数据表（name/description/availability/mutates/concurrencySafe），注册、prompt 呈现、工具计数扫描**从表派生** | dsh-ops `lib/capabilities/registry.js` |
| P02 | description 密集契约 | 边界/默认值/错误码/平台行为写进 description，尾部统一拼失败契约常量（"Failures resolve as {status,error.code}; never throw"） | dsh-ops `lib/capabilities/file.js:115` |
| P03 | 渐进披露 | 常驻只留高频工具，其余经 `discover` 关键词打分按需加载；prompt 只列当前可见工具（absent tools never get advertised） | dsh-ops `lib/discovery/search.js` + `lib/policy.js` |
| P04 | toolview 席位注册 | 内置 Web Client **不消费** presentCall/presentResult；终端卡片必须在 client 半部经 `ctx.slots.inject('tool.call.toolview', cb)` + keyed register（key=wire 工具名）注册，稳定 function component，注册失败回滚不崩 | KB `reference/cookbook/adding-a-tool.md:95` + `reference/subsystems/tools.md:493`；本仓 `src/client/integrations/ToolViewIntegration.ts` |

### B. Client UI 纪律

| # | 模式 | 要点 | 出处 |
|---|---|---|---|
| P05 | 稳定组件 + epoch 守卫 | 组件必须模块作用域声明（React 把变化的类型当另一个组件会卸载整棵子树）；异步刷新用 mounted ref + refreshEpoch 计数双守卫 | KB `extra/defensive-patterns/client-components.zh.md:95`；dsh-ops `runtime-panel.js` |
| P06 | CSS 命名空间 + 主题令牌 | 类名收进插件命名空间（`anic-`/`ops-`）；颜色一律 `var(--dsw-alias-*, fallback)` 消费宿主主题令牌，暗色模式免费 | dsh-ops `styles.js`；本仓 panelTheme.ts |
| P07 | XSS 惰性 + 零内联旁路 | 独立调试页每个值都经 textContent 到达页面，零内联数据，读旁路 JSON | dsh-ops `panel.html` |

### C. 生命周期

| # | 模式 | 要点 | 出处 |
|---|---|---|---|
| P08 | safeDispose | 逐个隔离 throwing disposer（一个抛异常不能阻断后续拆卸）；快照 `[...disposers]` 再迭代（Map.values() 单次迭代器二次消费静默拆零）；promise teardown 显式 .catch | dsh-ops `lib/teardown.js` |
| P09 | effect 带标签 | `ctx.effect(fn, 'dsh-anic: ...')` 每个副作用带字符串标签，崩溃栈可归因 | dsh-ops 全仓惯例 |
| P10 | mountResultLifecycle | WeakMap 按 ctx.root 记 owner + mounts 计数（多挂载最后一个才拆）；监听 session/disposed 与权限面变化即 abort 在飞任务 | dsh-ops `lib/kernel/result-lifecycle.js` |

### D. 防御式与失败契约

| # | 模式 | 要点 | 出处 |
|---|---|---|---|
| P11 | 失败为值 + nextAction | 统一 `{status, error:{code, nextAction}}`；副作用不确定时给 `effectState:'applied'`（结果未知但写盘可能已发生）；错误类型同查 instanceof **和** code（prototype 丢失/序列化后仍归因正确） | dsh-ops `lib/policy.js` + #235 |
| P12 | 断言未知键 | 严格拒未知参数键（plain register 只校验 output schema，参数原样到达 execute，静默忽略键会假成功）；每会话调用预算 FIFO 防重入打爆产物目录 | dsh-ops `assertKnownArguments` + `call-budget.js` |

### E. 持久化与可观测

| # | 模式 | 要点 |
|---|---|---|
| P13 | 分层持久化 + 显式 bounds | 常驻缓存只放精简摘要，明细按需重聚合；events/nodes/fileOps 带**显式 bounds**（如 400/2000）内存有界；detailRev 失效标记 + 水位线 |
| P14 | 读官方投影不自算 | 能用宿主投影（如 contextPressure）就不自算，数字永与宿主一致；TS module augmentation 挂投影键 |

## 实战锚点：cycle-107 命令窗口显示修复

**问题**：anic_* 工具调用在会话窗口只落 generic 行，命令+cwd+输出+退出码不可见——
host 侧 `presentation.ts` 构造的 TerminalCallView/ResultView 内置 UI 不消费（官方契约）。

**修复链**（三步，全部有契约测试钉死）：
1. 工具名清单下沉 `src/shared/anicToolIds.ts`（client tsconfig include shared；host 再导出保持契约测试 import 零变更）；
2. client 新增 `ToolViewIntegration`：`slots.inject('tool.call.toolview', cb)` + keyed register
   每个工具名一条，稳定组件 `AnicToolCard` 从 wire ToolCallBlock 防御式派生 props（phase/start/result）；
3. 冒烟契约同步演进：tab 注册（conversation.view）与 toolview 注册（tool.call.toolview）**分开断言**，
   toolview 期望数从共享清单字面量投影（`snapshotToolCount`），不硬编码 24。

**冒烟契约演进纪律**（本次实锤）：架构演进（新增注册路径）后，「总数恰一次」型断言会
从守卫退化为抖动源——改为按语义单元（slot name）分桶断言，期望数从真相源投影而非硬编码。

## 排错速查

| 症状 | 根因 | 处方 |
|---|---|---|
| 工具调用落 generic 行无终端卡片 | client 半部未注册 tool.call.toolview | 按 P04 补注册；J0 探针查 `__ANIC_TOOLVIEW__.count` |
| 卡片渲染后闪烁/卸载 | 组件渲染期内联定义 | 按 P05 模块作用域声明 |
| 热重载后注册翻倍 | 无幂等守卫 | `slots.entries()` 反查已占 key 跳过（ToolViewIntegration.ts:85） |
| 拆卸时部分 listener 残留 | disposer 抛异常阻断 | 按 P08 safeDispose 隔离 |
| 沙箱内 spawnSync stdio:'pipe' EPERM | DSH 沙箱文档化边界（pipe 捕获被拒） | 改 fd 式捕获：`fs.openSync` + `stdio:['ignore',fd,fd]`；或用 inherit |
| 块注释里写 glob `**/*.ts` 提前终止注释 | `*/` 序列终止块注释 | 注释里改写为「目录下全部 TS 文件」措辞（toolIds.ts 教训） |

## 证据与脚本

- 证据落点：`.cycles/tech-debt/`、`.cycles/gates/ledger.json`
- 研究全文：`.cycles/research-inputs/dsh-ops-context-research-2026-11-06.md`
- 模式源码研究方法：先读 package.json → 入口 apply → 每个 effect 标签 → dispose 路径
  → client apply → CSS 挂载 → 持久化 bounds，逐文件记录出处行号
