# 22 · 外部研究吸收与 cycle-83 落地设计（产物治理 / 视觉现代化 / 配置补全）

> 本档记录 cycle-83 的**输入**：从三份材料里学到了什么、映射到本仓哪条缺口、为什么采纳、为什么拒绝。
>
> 研究材料：
> 1. **dsh-plugin-dev-kb**（本机挂载的 DSH 官方文档镜像）—— 核实宿主契约的当前真相。
> 2. **dsh-ops**（`~/.dsh/profiles/desktop/node_modules/dsh-ops`，v0.4.1，MIT AND Apache-2.0，**本机安装态源码**）
>    —— 学习**同生态成熟插件**的工程形态（kernels/capabilities 分层、并发预算、预览-执行两段式、宿主令牌消费）。
> 3. **youngyangyang04/llm-master**（GitHub 开源大模型全栈教程，MIT）—— 学习**方法论**。
>    本轮新读：`docs/interview/llm/graph_engineering_interview.md`（Graph Engineering：节点/边/状态/检查点）。
>
> 纪律不变：外部材料只作**方法论与工程形态输入**，凡涉及本仓行为的断言必须落到可执行判据上。

---

## 1. 从 llm-master「Graph Engineering」学到的最关键一句

出处：`docs/interview/llm/graph_engineering_interview.md` §3「状态：别再把 transcript 当数据库」

> 「上下文是给模型推理用的，不是可靠数据库。它会被截断、压缩、稀释，也不适合跨进程恢复。
> **state 要有 schema、版本和检查点；模型需要时再把与本步相关的 state 投影成上下文。**」

### 1.1 为什么这句直接命中本轮的 P0

本仓的 `.cycles/` 就是 state（schema 有：config.yml / ledger.json / workflow-state.json / flow-tracker.json）。
但**读侧从来没有做「投影」这一步**——`buildWorkflowSnapshot` 把全部 79 个 cycle 目录、全部 194 条账本记录
**平铺**成 296 个节点。实测分布：

```
phase 6 · micro-step 7 · gate 4 · human-gate 5 · cycle 79 · gate-event 194 · autonomy 1
                 ↑ 273 / 296 = 92% 是历史
```

于是面板打开后 92% 的像素在讲三周前的事。这不是"信息量大"，这是**没有投影**：
把数据库整表倒进视图，等于没做视图。

对照那句原文：**"本步相关的 state"** = 当前轮 + 最近若干轮 + 未完成的轮；
**"投影成上下文"** = 折叠成摘要节点 + 可展开的证据。
所以本轮的修法不是"删历史"（那是数据库层的事，且 INV-9 禁止），而是**在读侧加一层投影窗**。

### 1.2 采纳的形态（task-4）

| Graph Engineering 的判据 | 本仓落地 |
| --- | --- |
| state 要有 schema | `.cycles/` 十三个持久化面已有登记表（`isolationScan.WORKSPACE_PATHS`） |
| state 要有版本 | `config.yml` 有 version 概念；`.cycles/paths.json` 本轮引入 `{version:1}` |
| state 要有检查点 | 已有：`ledger.json`（append-only 哈希链）+ `workflow-state.json`（相位）+ `flows/*.json`（状态机投影） |
| **按需投影，不是全量倾倒** | **本轮新增**：`snapshotProjection/projectionWindow.ts` 决定哪些轮进主图、哪些折叠 |
| 投影必须可回溯 | 折叠不是删除：`windowedOut` 计数 + 归档摘要节点 + 节点详情可展开原证据 |

### 1.3 「节点越无聊越好」→ 本仓的节点类型分级

原文 §3「节点：越'无聊'越好」：

> 「好节点应该**无聊**。它只做一件清楚的事，所以能单测、能缓存、能重试、能替换。」
> 「以『能否单独测试、缓存、重试、替换』为边界。」

这句给了图区视觉设计一个**非美学**的判据：节点在视觉上应该**一眼看出它是什么能力单元**，
而不是 296 个同质圆点。本仓的 8 种节点类型恰好对应 8 种能力单元
（phase / micro-step / gate / human-gate / cycle / gate-event / incident / autonomy），
其中「能否单独测试」都可判：gate 有 G0–G3 的判定器、human-gate 有审批队列、cycle 有任务清单解析器。
→ task-5 的「尺寸按类型分级 + 两行标签（主标签 / 次标签=裁决）」正是这条判据的视觉落点。

### 1.4 「边是决策」→ 本仓的边语义化

原文 §3「边：把'下一步'从模型脑子里拿出来」：

> 「边不只是连线。**边是决策。**」
> 「确定边：规则、权限、阈值、测试结果直接决定 / 条件边：根据 state 选择分支 / 模型边：模型在受限选项中判断」

本仓的边类型天然就这么分：

| 本仓 edge.type | Graph Engineering 分类 | 语义 | 当前渲染 |
| --- | --- | --- | --- |
| `cycle-seq` | 确定边 | 轮次前后相继（纯时序，无判断） | 细实线（与另两类无区别） |
| `evidences` | 确定边 | 某条门禁事件是该门的证据 | 细实线（与另两类无区别） |
| `event-seq` | 确定边 | 账本内事件流顺序 | 细实线（与另两类无区别） |
| `human-gate` | 条件边（人判） | 阶段 → 人工门 | 细实线 |
| `micro-entry` / `micro-exit` | 条件边 | 宏观阶段 ↔ 微观七步 | 细实线 |

**缺陷**：六种语义，一种视觉。读者无法从图上区分"这是时序"还是"这是证据关系"——
而这两件事在图论上的读法完全不同。→ task-5 的「按 type 分线型/颜色/曲率」是这条的直接修复。

---

## 2. 从 dsh-ops（本机安装态源码）学到的四条工程形态

dsh-ops 是同生态的成熟插件（v0.4.1，承载 native 文件操作 / PTC / Windows bash 运行时）。
逐目录读过 `lib/`，有四条值得吸收、两条明确不学。

### 2.1 采纳：并发预算是一等公民

`lib/kernel/call-budget.js`：

```js
export const MAX_ACTIVE_CALLS = 2;
export const MAX_WAITING_CALLS = 8;
// FIFO permits are scoped to one host and session, shared by Native and PTC bridges.
```

要点：**每个 host + session 一条 lane**，active 上限 2、等待队列上限 8，超了直接
`CallBudgetError('CANCELLED', '...; no effects.')` —— 注意最后三个字 **no effects**：
拒绝发生在**任何副作用之前**，所以拒绝是安全的。

对照本仓：`anic_skill` 有同步版（`spawnSync`，阻塞事件循环）和异步版（`spawn` + AbortSignal），
但**没有任何并发上限**。同一会话里连续调 10 个技能脚本 = 10 个 node 子进程同时跑，
每个都是 60–240s 的长任务。这是真实缺口（本轮登记，不修——见 §4.1）。

### 2.2 采纳：预览-执行两段式（plan → execute）

`lib/client/runtime-panel.js` 的交互骨架：

```
snapshot()  ← 拉当前事实
plan(action) ← 出预览（"将要发生什么"，不写盘）
execute()   ← 真写
```

三段各有 busy 态、错误态、`mounted`/`epoch` 竞态守卫（`refreshEpoch.current` 防过期响应覆盖新状态）。

对照本仓：配置编辑器已有 dryRun（cycle-82 的 `planPatch` 阿 dryRun 与真写共用同一条实现），
但**归档（`POST /anic/api/archive/baseline`）与路径覆盖（本轮新增两个写面）没有预览段**。
→ task-4 与 task-6 都要求 `{dryRun?:boolean}` 走同一条 plan 路径。

### 2.3 采纳：宿主令牌当 fallback 上游，而不是新调色板

`lib/client/styles.js` 全是 `var(--dsw-alias-label-primary, inherit)` 形态——
宿主令牌在前、**必有 fallback**、全部走 CSS 类（无内联 style）、单一 `.ops-settings` 作用域、
一处 `@media(max-width:440px)` 降级。

对照本仓：`shared/tokens.ts` 已有 46 个 `anic-*` 语义令牌 + 对比度契约测试。
**正确的合并方式**是把宿主令牌挂在 fallback 链的**上游**：

```css
var(--anic-text, var(--dsw-alias-label-primary, #1f2328))
```

`anic-*` 永远最外层（保住对比度契约），宿主令牌次之（主题跟随更准），字面量垫底。
→ task-5 采用此形态，**不是**换成宿主令牌名（那会让 46 个令牌的对比度契约全部失效）。

### 2.4 采纳：结果缓存的落点判据（信任边界）

`lib/kernel/result-storage.js` 头注一句话值得抄：

> 「Trusted cache metadata comes from the **host, never tool arguments or selected operation roots**.」

即：**"该往哪写临时文件"这个决定权不能来自调用方参数**。本仓对应的是
`isolationScan.judgePath`（路径必须由 workspace 根相对推导，不接受任意绝对路径）。
两条是同一个安全判据的不同表达。本轮 task-6 的路径覆盖表继续沿用（realpath + 无 `..` + workspace 内）。

### 2.5 明确不学：manifest v0.15 那套 `dsh-plugin.json`

dsh-ops 用的是 `dsh-plugin.json` + `facets` + `permissions`（声明式权限清单），
`manifestVersion: "0.15"`。本仓用 `package.json` 的 `dsh.manifestVersion: 1`（`validate-dsh.mjs` 的 C2 门禁）。
**迁移没有收益**：v0.15 schema 是另一套生态（`dsh-std`），迁过去要重写全部 12 项符合性门，
而当前宿主（0.2/0.4 线）同时认两套——遵守已有的那套更省。本条登记为"评估后拒绝"。

### 2.6 明确不学：`native/` 原生 worker + isolation

dsh-ops 有 `native/`（Rust/C++ worker 做文件操作）+ `lib/compat` + Windows SID 沙箱
（`/^S-1-4-([1-9][0-9]*)-([1-9][0-9]*)-1$/` 校验临时目录的写入 SID）。
这是为了"在 Windows 上安全地做文件操作"付出的重工程。
本仓的文件操作全部是 **Node 单进程内同步原子写**（`shared/fs-safe.ts` 的 `atomicWriteFileSync`），
威胁模型不同（我们不做任意路径 IO，只写 workspace 内的 `.cycles/`）。
**引原生 worker = 引入构建矩阵与签名问题，收益为零。** 本条登记为"评估后拒绝"。

---

## 3. 从 dsh-plugin-dev-kb 复核的三条

| 契约 | 出处 | 本轮用法 |
| --- | --- | --- |
| 工具出口必须 lossless JSON | `extra/cookbook/adding-a-tool.md` | cycle-82 已修（`jsonSanitize` + `wireGuard`）；本轮新增的工具/路由继续遵守 |
| 能力接缝：插件应在宿主已知工作区内闭环 | `reference/capability-seams.md` | task-6 路径覆盖表的边界判据 |
| `ctx.effect` 生命周期与 disposer 承接 | `develop/framework/lifecycle.md` | 新增路由沿用 `registerXxxRoute` 返回 disposer 的既有形态 |

---

## 4. 四域落地与拒绝项

### 4.1 本轮四条战线

| 战线 | 责任 | 写作用域 | 关键判据 |
| --- | --- | --- | --- |
| **A 产物治理** | 归档基线重置 + 窗口化投影 | `runtime/artifactArchive.ts`、`snapshotProjection/`、`shared/snapshotCore.ts`、`routes/archiveResetRoute.ts` | 账本一字节不变；归档≠丢失；`windowedOut` 可读 |
| **V 视觉现代化** | 卡片节点 / 语义边 / tooltip / minimap / 面包屑 | `features/graph/`、`panelCss.ts`、`tokens.ts` | circle 数==节点数；压缩率不退；tooltip 键盘可达 |
| **C 配置补全** | 路径覆盖表 / 冲突可见 / 备份回滚 | `configEdit/`、`routes/configRoute.ts`、`features/config/` | 非法覆盖全忽略；冲突三态；回滚复用唯一写入器 |
| **L 收口** | 接线 / 词表合并 / 真实基线重置 / 版本 / 全量验证 / 文档 | 装配层 + 文档 + `.cycles/cycle-83/` | 四层金字塔 ALL GREEN；真机复验 |

### 4.2 明确拒绝（本轮评估后不做）

1. **不做「归档即删除」**。用户说「归档产物重新开始」，直觉解是 `rm -rf .cycles/cycles`。
   拒绝理由：① INV-9 只追加；② 删了就没法用「最新项目事实」做差分基线——**差分需要两端都在**；
   ③ 本仓有 `gate-ledger --verify` 依赖历史链。正确解是**移出主视图但保留可回溯**。
2. **不给 `snapshotProjection` 做「智能重要度排序」**（比如按门禁失败次数加权）。
   理由：重要度排序**不可判两态**——"这条为什么被折叠"如果靠启发式，用户永远无法反驳。
   窗口化用**时间序 + 未完成态**两个硬判据，任何人看一眼就知道自己那轮在不在窗口里。
3. **不引原生 worker / 不迁 manifest v0.15**（见 §2.5 / §2.6）。
4. **本轮不加技能调用的并发预算**（见 §2.1 的缺口）。理由：它要改 `skillInvoker` 的调用栈
   （同步 + 异步两条路径 + 工具层 + 路由层四处），与四域作战线正交；单独一轮做才干净。
   登记为 cycle-84 候选，判据已想清楚（照 dsh-ops 的 `MAX_ACTIVE_CALLS` + 拒绝在副作用之前）。

---

## 5. cycle-83 验收清单（每条可机器证伪）

- [ ] 归档 76 个可完成循环后：`ledger.json` 字节数与哈希链**完全不变**
- [ ] 归档后快照 `counts.archivedCycles > 0`，归档摘要节点在场（历史仍可查）
- [ ] 窗口化后节点数从 296 降到 ≤60，且 `windowedOut` == 真实被折叠数（不是约等于）
- [ ] `cycle-1` / `cycle-75`（`total=0`）给出 `empty-task-list` 原因，而非静默 false
- [ ] 重复归档是 no-op（不产生第二个 manifest 条目）
- [ ] 节点视觉：每节点 1 circle + 1 rect + 2 text；circle 总数 == 节点数
- [ ] 边：至少 3 种不同 dasharray/曲率形态，按 type 区分
- [ ] tooltip：pointerenter 出现 / focus 出现 / pointerleave 消失（jsdom 真实事件）
- [ ] minimap 点击改变视口（纯函数 `worldToViewport` 可单测）
- [ ] 布局压缩率仍 ≤ 60% × 5626px（变尺寸后重新验证）
- [ ] 路径覆盖表非法时解析结果**逐项等于**默认值
- [ ] 配置冲突三态（无冲突 / 磁盘变了 / 用户改回原值）各有断言
- [ ] 回滚后 `config.yml` 注释与原备份逐行一致
- [ ] 回滚复用唯一写入器（静态断言：全仓只有一处写 `config.yml`）
- [ ] `node scripts/typecheck.mjs && pnpm run build && node scripts/run-tests.mjs` 全绿
- [ ] 真机 `anic_reload_self` 后新路由可达、旧路由零回归
