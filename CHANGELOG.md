# dsh-anic CHANGELOG

## v0.48.0 — 2026-10-27（cycle-82：可交互图谱 + 配置可视化编辑 + 可观测性收口）

> 用户诉求四条：①「要可交互的图谱，功能很贫乏」②「配置/路径支持自定义可视化编辑」
> ③「确保连通性逻辑性、不同项目使用要隔离不能污染」④「热更新重载插件」。
> 本轮按四域并行推进（三队写作用域互斥 + Lead 装配收口），研究输入见
> `docs/anic/21-外部研究吸收与cycle-82落地设计.md`。
>
> 落地后全量：**typecheck / 185 测试文件 · 2436 用例 / smoke / trigger 全绿**，
> 真实宿主 curl 复验新端点与新响应键。

### ① 工具出口 lossless JSON —— 真机 P0，`anic_status` 整条失败（修复）

**真机现形**：`Error: tool "anic_status" returned invalid output: value is not lossless JSON`。

根因（探针脚本对真实 `.cycles/flow-tracker.json` 实测）：`analyzeSkillHealth()` 的
`ScriptHealth.recentSuccessRate?: number` 在「近 7 天无调用」时是 `undefined`（cycle-57 刻意
设计的语义），被原样塞进工具 canonical value；宿主 `visitJsonValue` 递归拒 `undefined`。
**一个正确的语义决定，在传输边界上变成整条工具链路的致命错误。**

修法**不是点修字段**（点修的保修期只到下一个可选字段）：新增 `runtime/jsonSanitize.ts`
统一出口防线，挂在 `toolsSlot.wireGuard()` + `createFaceRecorder.reg`——聚合器 23 个工具
全经此一处。语义写死在头注表：对象 `undefined` **删键**（变 `null` 会被读成"成功率 0"）、
数组→`null`（不塌缩）、`NaN/±Infinity`→`null`、`Date`→ISO、`BigInt`→字符串、
**循环引用/超限抛错**；合法值走快路径返回**同一引用**（零重建、零语义变化）。

配套：`toolOutputLosslessContract` **逐个**工具 execute → roundtrip 深等 + 递归无 undefined，
并加「运行前后账本条数/字节不变」自检（初版曾让 `anic_bootstrap` 经 cwd 兜底真写账本 4 条，
已删并复验 `hash chain intact`）。

### ② 交互式工作流图（用户诉求核心）

**改造前**：188 节点 × 5 固定列 × 46px 行 ⇒ 1520×5626 的细长条（宽高比 0.30），
无缩放、无平移、无搜索、无筛选、悬停无反馈——「功能很贫乏」是准确的。

| 指标 | 改造前 | 改造后 |
|---|---|---|
| 画布 | 1670 × 5626 | **1048 × 570** |
| 宽高比 | 0.30 | **1.84**（近 16:9） |
| 高度 | 100% | **10.1%**（验收线 ≤60%） |
| 节点/边 | 188 / 292 | **188 / 292（零丢失）** |

三个**纯函数核**（无 DOM、确定性、可单测）：`graphLayout`（分类型 lane + `balancedChunks`
均衡折列，9 列）、`graphViewport`（`clampScale` 0.25–4 / `zoomAt` 锚点守恒 1e-9 /
`panBy` / `clampPan` 四向 margin / `fitToView`）、`graphFilter`（类型+裁决+文本+**无向**
邻接，三档 visibility）。

交互：滚轮缩放（以指针为锚）、拖拽平移、双击适配、键盘 `+/−/0`、`Escape` 清筛选、
搜索框、类型 chips（带计数）、裁决下拉、邻接高亮开关、`<output>` 播报比例、
三个真 `<button>`（放大/缩小/适配）。

**筛选不删节点**（刻意取舍）：只改 `opacity + pointer-events`。理由 ① smoke 与契约钉死
「circle 数 == 节点数」② AT 没有"淡出"概念，移出 DOM 等于让屏幕阅读器用户再也遍历不到。

可访问性不退反进：svg 仍是**唯一** Tab 停靠点（roving tabindex）、`aria-describedby` 指向
键盘说明、每个新控件有 `aria-label` + focus-visible、`prefers-reduced-motion` 与
`forced-colors` 两档样式。stub-hooks 源码级守卫（只允许 smoke 桩支持的 7 个 hook，
用真实 `useMemo` 注入证明有判别力后还原）。

过程中自行发现并修掉三个**只有真挂载才现形**的缺陷：① `pointer-events` 作为 SVG 属性
不落到 DOM（改 `style.pointerEvents`）② 交互态沿用包围盒尺寸导致放大后被 SVG 自身
viewBox 裁掉（画布改视口尺寸，裁剪交给 CSS）③ `<g data-anic-graph-world>` 缺 key。

### ③ 配置与路径的可视化编辑（用户诉求「配置/路径支持自定义可视化编辑」）

**改造前**：⚙ 抽屉只能切 `flow.*` 用户层布尔；`config.yml` 的 `autonomy_level`、
`complexity_budget`、七个命令、`allowedOrigins`、`toolDisclosure` 只能手改 YAML——
而本仓 `autonomyActions.ts` 头注就写着「手改 config.yml：无前置判定、无回读断言、无审计记录」。

**不引 yaml 依赖**（运行时零依赖纪律 + 更重要的原因）：`config.yml` 里全是中文注释
（cycle-77 为 `complexity_budget` 写了 4 行解释）。任何 `parse→stringify` 都会**丢注释**，
而注释是"为什么这么配"的唯一载体。

新增 `src/host/configEdit/`：`configSchema`(189) 22 字段的**单一真相源**（渲染与校验同一张表，
`anic.flow.*` 由 `FLOWS` 展开不手抄）、`yamlText`(198) 行级文字原语（EOL/引号状态机剥行内注释/
内联数组/块标量遮蔽）、`configRead`(117) 段键定位（读写共用，防"写进去读不回来"）、
`yamlPatch`(194) `planPatch` 纯函数、`yamlDiff`(72) 行级 LCS、`configWriter`(224)
备份→原子写→**回读断言**→不符回滚、`paths`(182) 19 项路径表 + realpath 边界。

新路由 `GET/POST /anic/api/config`：GET 带 `schema`（同一张表驱动渲染，杜绝"表单允许的值被后端
拒绝"）+ `paths` + `rawHash` + `backups`；POST `{patch, dryRun}`，**dryRun 与真写共用
`planPatch`**（预览不是第二条实现，否则"预览说改一行/实际改五行"会分家）；非法值一律 400 且
**零写入**（半套配置比没改更危险）。

判据都是机械的：**改动前后注释行集合完全相等**、差异行数 = 改动字段数、`.bak` 留 3 份、
`allowedOrigins` 用**裸逗号**（实测 `parseAnicSection` 不剥方括号，写 `[a, b]` 会被读成
`[a`/`b]` 两个坏来源——这一处按验证事实偏离了任务书，并加反向自检钉死）。

客户端 `features/config/`：纯渲染编辑器（分组字段、脏标记、预览差异、结果/错误分离反馈、
路径表含复制），**草稿进 store 不进组件**——因为 4s 轮询会在用户打字中途返回新事实，
草稿合并不变量（「与旧事实不同」保留、「与旧事实相同」丢弃）是能开轮询的前提；
全保留会覆盖别人的改动，全丢弃会擦掉用户正在打的字。

### ④ `.cycles` 文档生命周期（第五族）与跨项目隔离判定

**缺口 A**：`assets/skill/assets/templates/` 有 15 类 .cycles 文档，但只有 G0/G1/G2 三类被门禁读
——其余 12 类「写了没人看、不写没人管」。真值却是：**79 条缺失**（可点名到 `cycle-N/文件名`）。

新增 `closureAudit/artifactsClosure`(218) + `artifactsSpecs`(119) + `artifactsView`(91)：
模板注册 → 逐循环矩阵 → 消费三态。三种 scope **分开**：`cycle` 进矩阵并点名缺失；
`project`（intent/spec/plan/REVIEW/PR）只判单份；`ondemand`（incident/retrospective）
**零发生是健康的**，报 `occurrences` 不进缺失清单（否则每个健康循环背一条假待办）。
空目录不算产出（`test-reports/` 有目录无 .md ⇒ 未产出——`init-cycle` 先建空目录正是最常见的假绿）。

**缺口 B**：跨项目隔离只有实现、零判定（`resolveWorkspaceRoots` 末位还有 `process.cwd()` 兜底
——单项目机器上永远看不出问题，多项目机器上就是污染）。

新增 `closureAudit/isolation`(167) + `isolationScan`(158)：12 条持久化路径逐项断言来自
`.cycles/` 相对推导；`inWorkspace` 用 `relative()` 而**非** `startsWith()`（后者把 `/a/proj-evil`
判成在 `/a/proj` 内）；三类违规 `escape`/`cwd-fallback`/`absolute-literal` 各自点名。
真实仓 **violations=0**；`.cycles/evals` 是**死登记**（登记了但源码零锚点），单列 `dangling`
而不混进 `violations`——两者处置动作相反（一个改路径来源，一个改登记表）。

两族接进 `GET /anic/api/closure-audit` 的两个**新键**（既有键零变更，
`assertExtraSurfacesPresent` 守"摘掉键就红"）；客户端投影去绝对路径。

### ⑤ 装配 / 词表 / 判据收口

- **`panelDataLegContract` 判定核重构**（本轮最重要的守卫修复）：旧版靠三个互相独立的正则
  猜源码结构，一次普通重构（数据面拆出 `panelPeriodicTarget.ts`、写侧搬进 `ConfigSection.ts`）
  就让 **11 条同时假红**——目录约定、工厂名捕获组 `…Target)s?` 与 `…Targets?)` 拼写不一致、
  形参名硬编码 `s.`、只认单行补丁。现改为**可达性判定**：装配基座 → import 传递闭包 →
  动作调用面（排除定义处）；切片词表直接解析 `PanelState` interface（不手抄）。
  三条反向自检：抹接线 / 移出可达集 / 移出调用面。
- **词表**：新增 `graph.*`（14 字面 + `graph.lane.*` / `graph.verdict.*` 两族）、
  `config.*`（62 条）、`closure.artifacts/isolation`（22 条）、`fold.config`，zh/en 各 **425 键全等**。
  修一个真缺陷：`cfgText()` 曾写 `t(CONFIG_I18N_PREFIX + suffix)` ——闭包扫描器只认
  「`t(` 后首个实参是**引号字面量**且以 `.` 结尾紧跟 `+`」，经常量中转认领 0 个前缀 ⇒
  `config.*` 55 条全判死键。改内联字面量并加回归钉（反向断言"经常量中转认领 0 个"）。
  locale 合并用**文本尾部插入**而非 JSON 往返：`localeKeyAnchors` 按行号定位，
  `closureEvidenceAnchorContract` 钉死 `trace.statusDone=101`，重排即漂移。
- **判据棘轮校准**：`closureAuditTruthContract` 路由总数从写死 64 改为从实测派生（判据语义是
  "删一条少一条"）；动态计算键前缀集从"只允许 `budget.status_`"改为**显式白名单**并逐条注
  来路（`budget.status_` / `config.` / `graph.lane.` / `graph.verdict.`）——认领 = 免死键通行证，
  必须来路明确；`i18nDeadKeyContract` 键数上限 320→460（+125 条真实功能面）。
- **计数同步**：路由 64→65（README 与 `objectiveConformance ⑧` 两条**独立**计数器同时改，
  改成从 README 读回会退化成同义反复）；`snapshotRoute` 的 `ALL_ROUTES` 同步。
- **T3 行数**：图域 12 文件全 ≤250（`renderGraph` 拆 `graphVerdicts`）；`panelSections` 拆出
  `features/graph/GraphSection.ts` 并再导出；根组件拆出 `panelPeriodicTarget.ts`（233 行）；
  `closureAudit` 六处拆分全部**保持既有导出名不变**（re-export 门面，照 `runtime/hotReload.ts`）。

### 验证

```
node scripts/typecheck.mjs                     exit 0（client + host）
node scripts/run-tests.mjs                     ALL GREEN
  ✅ validate  ✅ vitest（185 文件 / 2436 用例）✅ smoke（ALL PASS，188 圆点/292 边/单 svg）
  ✅ trigger（28/28 正例召回，0/14 负例误报）
pnpm run build                                 dist/client.js + dist/host.js
真机 curl /anic/api/closure-audit              HTTP 200，新键 artifacts + isolation 在场
```


> cycle-80 交付了热重载能力，但**从没在真实宿主上按用户流程跑过**。本轮用户要求"热重载插件"，
> 我实际执行了一遍 —— 结果两个**只有真跑才会现形**的缺陷当场暴露。本版本就是这两处的修复。
> 完整证据链见 `.cycles/cycles/cycle-81/审计日志.md` §3（9 步真实响应）。

### ① 拒载判据错位：`dist vs src` → **运行实例 vs dist**（P0）

**真机现形**：改源码 → build（dist 已最新）→ 点重载 ⇒ 旧判据返回
`refused: dist is up to date`，**但运行中的实例仍是旧代码** —— 恰好拒绝在最该重载的时刻，
用户诉求退化成"先 build 再人工重启"。

新判据比较「**运行实例**启动时加载的 revision」与「当前 dist revision」，四态语义各自点名下一步：

| 情形 | 动作 | reason 告诉用户做什么 |
|---|---|---|
| dist 落后源码 | `refused` | `run build before reloading`（重载点到旧产物等于白做） |
| 实例 == dist | `refused` | `nothing to reload`（避免无谓拆装打断会话） |
| 实例 ≠ dist | **`scheduled`** | —（这才是用户要的情形） |
| 实例未知 | **放行** | 读不到 ≠ 已同步；多一次无害重载 ≪ 误拒一次真重载 |

### ② 运行实例标记跨模块不可见（P0）

新判据要读「实例跑的是哪个 revision」，而真机显示路由模块**读不到** `apply` 写入的内存值
（两次调用 `fromRevision: null`）⇒ 判据退化成"永远放行"。

新增 `runtime/runningRevision.ts`（83 行，一域一文件）两级载体：
- **内存**（同模块实例，零成本）；
- **工作区旁路** `.cycles/running-revision.json`（跨模块实例可见，原子写，带 `at`）；
- **TTL 24h 过期即弃**：停机后留下的旧标记不可用来否决本次重载；读不到 = 未知 ⇒ 放行。

同时把 `reloadOrchestrator` 从 292 行拆回 210 行（T3/⑪ ≤250 硬限）。

### ③ P8 探针 fail-open 修复（P1）

`self-check` 的 P8 原实现**恒写 `ok: true`** —— `indexed` 模式缺加载器（自锁 ⇒ 模型拿不到任何
schema，整工具面失能）时诊断端点照样报绿。现改为与 `activationReady` **同源**：
`indexed && !ready ⇒ ok:false` 并点名缺哪些加载器；`full` 模式保持恒绿（零行为变更）。

**诚实边界**：`captureRegisteredFaces()` 恒注册全部 23 工具（含加载器），故自锁**当前不可达** ——
本修复钉的是"判据接线正确"（未来注册面缩水时探针立刻红，而修复前永远不会红）。

### 真机验证链（本版本的核心交付物）

```text
修前（旧判据）实例 69380d77 / dist c13d32da → refused: dist is up to date      ❌ 错拒
force 引导                                    → scheduled → 12s 后 reloaded      ✅
再 build（851d6b84）无 force                  → scheduled（fromRevision=null）   ✅ G-02 现形
                                              → 14s 后 reloaded + 旁路写 851d6b84 ✅
再请求（实例 == dist）                        → refused: nothing to reload（零写入）✅ 新判据生效
```

### 验证基线

```
typecheck: 0 错          validate: 12/12        vitest: 171 files / 2096 tests 全绿
smoke: ALL PASS          trigger: 28/28          eval: E1-E8 + Q1-Q8 16 维 PASS
gates:  G0-G3 全 PASS（四门 §cycle-81，G3 带 [dist=851d6b84]）
fresh:  stale=false      revision 851d6b84bf8c7d61
```

### 已知边界

- **首轮热重载需一次 `force` 引导**：新判据代码必须先被加载才能用新判据（固有鸡生蛋，非缺陷）。
- GUI 浏览器级验证仍受宿主 web 认证（401）阻断。
- 覆盖率未重跑（沿用 87.17/82.89）。
- 面板 reload 小节视觉/位置仍未真机核对。

## v0.46.0 — 2026-10-27（cycle-80：热更新重载插件 —— ctx.hmr 消费闭环 + 部署一致性守卫）

> 用户本轮新增限定：**热更新重载插件**。起点是**真机取证**（不是猜）：
> `plugin_manager list` 显示宿主 `@deepseek-ai/dsh-hmr` **fiberPhase=active**，
> 服务契约为 `ctx.hmr.runExclusive(op)` + `ctx.hmr.reconcileProfile(requiredIds?)`（cordis inspect 原文）；
> 而本插件 `grep -rn "ctx.hmr" src/` **零命中** —— 宿主有能力、插件从不使用，于是每次改代码都要人工重启宿主
> （README 此前自认"新面受 Node 模块缓存限制需宿主自然重启生效"）。

### ① 热重载核心：注册 → 生产 → 消费全链闭环（P0）

新增三文件（一域一文件，全部 ≤250 行、单向依赖）+ barrel：

```
runtime/buildRevision.ts    (98)  computeBuildRevision / buildFreshness
runtime/reloadHistory.ts   (110)  readReloadHistory / appendReloadHistory / finalizeInFlight（有界 50 条 FIFO + 原子写）
runtime/reloadOrchestrator.ts (174)  probeHmr / reloadSelf / reloadSummary
runtime/hotReload.ts        (20)  barrel（消费者 import 零变更）
```

`reloadSelf` 的四步语义（每条都被测试钉住）：

1. `probeHmr` 不可用 ⇒ `action='unavailable'`，**零写入**（headless/SDK 诚实降级，绝不假装成功）；
2. `buildFreshness().stale === false` 且无 `force` ⇒ `action='refused'`，**零写入**（dist 已是最新，没必要重载）；
3. **先**写 `in-flight` 记录，**再**触发重载 —— 重载会杀掉当前实例，事后没有任何活着的实例能写这条记录；
4. `setTimeout(() => hmr.runExclusive(() => hmr.reconcileProfile(ids)))` **不 await** —— 续体可能永不执行；
   状态由**新实例启动时的 `finalizeInFlight`** 补全（`in-flight → reloaded` + `toRevision` + `finalizedAt`）。

**为什么 `hmr` 不进硬 `inject`**：headless/SDK profile 无此服务，硬依赖会让整条 fiber PENDING
（cycle-74 P0 真实事故），因此用 `ctx.get('hmr', false)` 可选探测。

**接入面**（三处同一实现）：
- 工具 **`anic_reload_self`**（第 23 个）：参数 `reason`（必填）/`force?`/`workspace?`/`requiredIds?`；
- 路由 **`POST /anic/api/reload`**（运维/外部通道，响应即结果对象；已进 `channelRegistry` 四元组声明）；
- `org-status.reload` + 面板小节（见 ②）。

### ② 可观测性：构建新鲜度 + 重载史 + 面板（P1）

- `org-status` 只增 `reload` 段：`{stale, revision, historyCount, lastStatus, lastAt, error, hmrProbeHint}`；
- 面板新小节「构建新鲜度 / 最近重载」（`renderOrgReload.ts`，127 行）：锚点 `data-anic-org-reload`、
  `data-anic-reload-row=freshness|last`、stale=警示色 / fresh=通过色 / 失败 `role="alert"`、
  行 flex-wrap、**空历史不渲染空壳但 fresh 状态必显**（它是当前事实而非历史）；
- 启动握手：`src/index.ts` 第 6 个 `c.effect` 调 `finalizeInFlight`（info 日志）+ `stale` warn（含 newestSrcFile），全程 scoped logger 无裸 console。

### ③ 部署一致性守卫：把"改 src 忘 build"变成红（P1，本轮最有价值的一条）

`deployFreshnessContract` 4 例：真实仓库 **`stale` 必须为 false**、tmp 夹具反向自检、dist 缺失诚实。
**本轮实证**：收口期间该守卫**真实抓到 3 次**「改了 src 没重建」（`capabilityIndex.ts` / `reloadOrchestrator.ts`），
迫使按序 build —— 它抓的是事实，不是误报。

插件**不自动重建 dist**（设计选择，已写进注释与文档）：会引入 tsdown 运行时依赖与 `build-client` 的 F-09 删窗风险；
`stale` 只做「可见 + 契约红 + 日志 warn」，构建仍由人/CI 决定。

### ④ 技能侧同类守卫（P2）

- `quick-validate --freshness`（默认关闭、纯增量、关闭时 stdout 逐字节一致）：scripts 索引双向完整性 + 版本锚一致 + 行数声明比对；
- `gate-check` 的 G3 detail 追加 **`[dist=<rev8>]`**（与宿主同口径：`sha256(host)+":"+sha256(client)` 前 16 取前 8），
  `dist` 缺失 ⇒ `[dist=absent]` 诚实标注；native(`gateEngine`) 与 script **逐字全等**（差分契约钉死）。
- 真实账本：`G3 PASS | Build passed: node scripts/build-client.mjs §cycle-80 [dist=69380d77] [Q3:PASS,Q4:PASS]`。

### ⑤ 工程化收口

- 注入面体积：23 工具后 2062 B > 2048 上限 → 精简 4 条 summary → **2025 B**（A9 硬棘轮 2304 仍留余量）；
- README「热加载与热更新」**三层 → 四层**（新增 host bundle 热重载层，headless unavailable 诚实说明）；
- 工具面参考补第 23 工具；能力索引重生成（23 工具、`--check` OK、**幂等验证通过**）；
- 新增 locale 键 12 个（zh/en 等键）。

### 验证基线（本轮收口）

```
typecheck: 双 tsconfig 0 错
validate:  12/12 PASS
vitest:    171 files / 2092 tests 全绿（本轮 +26）
smoke:     ALL PASS
trigger:   23 tools · recall 28/28 = 100% · FPR 0/14
eval:      E1-E8 + Q1-Q8 16 维全 PASS
gates:     G0-G3 全 PASS（四门带 §cycle-80，G3 带 [dist=69380d77]）
freshness: stale=false · revision 69380d778aad8953
lifecycle: cycle-80 close → plan→design→build→test→deploy→maintain
skill:     2.6.1 · --freshness 4/4 OK · live in-sync
build:     client.js 303,031 B + host.js 592,949 B（原子替换）
```

### 已知边界（诚实登记）

- **真机热重载未自证**：调用链/握手有 9 例测试，但"真实宿主上换掉代码"必须由人确认；
  GUI `GET /` → **401**（宿主 web 认证，agent 无会话 token）⇒ 浏览器级验证仍受阻。
- 面板新小节视觉/位置未真机核对；`force` 仅演示用、`requiredIds` 未真机验证。
- 覆盖率未重跑（沿用 cycle-79 87.27/83.26）。
- **过程债**：多 agent 并发写在同一文件冲突一次（`capabilityIndex.ts`），收口前冻结写面 + 顺序 build 解决，已登记。

## v0.45.0 — 2026-10-26（cycle-79：账本循环身份 + 覆盖证据链 + 词表零死键 + 账本形状归一）

> L4 全自主第 79 轮。起点是**宿主重启后的真机复核**：v0.44.0 已生效（closure `channelDeclared=46`、
> org-status `L4 + historyCount=2` 且带 `trustExemption`、self-check 9 探针 P9 in-sync）。本轮攻的是
> 上一轮审计日志与待排期台账点名的"**证据链缺口**"，并把覆盖率从"声明"变成"可测量且达标"。

### ① 账本循环身份：跨循环不再静默去重（P0 可审计性）

**实测证据**：`.cycles/gates/ledger.json` 里 cycle-78 的 G2/G3 仍是 cycle-77 记录——去重键 `(result, detail)`
不含循环身份，detail 是循环无关字符串 ⇒ 跨循环同结论被静默 dedup，本循环**没有自己的审计条目**。

- `gate-check.mjs`：G1/G2/G3 的 detail 追加 `§cycle-N`（G0 已含 `in cycle-N`，保持）；环境/质量段/退出码语义不变；
- `gateEngine.ts`（native 侧）：detail 与脚本**逐字全等**（差分契约钉死）；`checkG1/G2/G3` 导出面套同一后缀；
- 判别力：HEAD 旧脚本同夹具第二轮 → G1/G2/G3 全部 `unchanged, not re-recorded`（账本 5 条）；新脚本 → 8 条；
- 契约 `ledgerCycleIdentityContract` 4 例：跨循环各记 4 条 / 同循环 dedup / 反向自检（剥身份必红）/ native=script 逐字。

**真实账本**：cycle-79 四门各一条，G1/G2/G3 detail 末尾 `§cycle-79`；cycle-78 缺的 G2/G3 无法回填（append-only），
本循环起不再发生。

### ② 覆盖率证据链（P1 测试体系，本仓首次可测量）

**被守卫缺陷**：`.cycles/config.yml` 声明 `gates.G2.coverage_threshold`（lines 80 / branches 65），
但 `@vitest/coverage-v8` 从未安装、G2 只查测试报告与 journey 覆盖——**声明阈值却不测量 = 装饰性声明**。

- 安装 `@vitest/coverage-v8@3.2.7`；`vitest.config.ts` 配 v8 provider / `all:true` / json-summary，
  产物落 `.cycles/cycles/cycle-79/coverage/`（不污染仓库根）；
- 新增 `scripts/coverage.mjs`（163 行）：跑测量 → 读摘要 → 打印四指标 + 最差 5 文件 → **现场阈值判定**（读 config.yml）；
- **真实结果：lines 87.27% / branches 83.26% / functions 88.69% / statements 87.27%（≥ 80/65，达标）**；
- `coverageEvidenceContract` 5 例：工件存在（缺失即**明确失败，不 SKIP**）、阈值与 config 双向绑定、达标断言真读 JSON、
  反向自检 + 防伪造（合计==total / 路径须在 src/ / 文件数≥100）；
- 两个实测坑固化：`reportOnFailure`（证据不能在红时消失）、`clean:false`（同一次运行内契约假红）；
- 插桩下性能棘轮（⑫ <2500ms）实测 2.7s → `pnpm run coverage` 注入 `DSH_ANIC_COVERAGE=1` 仅该次放宽到 6000ms，
  **常规测试仍守 2500ms**（旧 7.9s 实现在两种预算下都必红）。

### ③ 词表卫生：39 条死键 → 32 删 / 7 具名 RESERVED（P1）

- i18n 族 `unconsumed 39 → 7`（键数 332→300）；逐键复核含**动态前缀审计**（无 `'gate.'+x` / 模板串构造），
  确认无引用才删；zh/en 同键删除；
- 保留 7 条全部具名 + reason：`meta.description`（类元数据、宿主按属性路径读）+ `panel.selfInitOff(-Title)`
  （关闭态零说明：功能缺口）+ `trace.statusActive/Failed/Skipped/Pending`（渲染裸英文 token：功能缺口）；
- `i18nDeadKeyContract` 5 例：未消费集 ⇄ RESERVED **双向相等**、reason 校验、反向自检（注入 `__probe__.deadKey` 必红；
  发现"RESERVED 写完整引号字面量会被测试自身算作消费"的自指陷阱，改用拼接）、zh/en 全等、非空下限。

### ④ 硬化：流程层超时 cap 统一 + 技能账本形状归一（P2）

- 4 条流程（archive / gate-check / hitl / macro-phase）的 cap 从写死 120000 → `MAX_SKILL_INVOKE_TIMEOUT_MS`（240s），
  默认值语义不变；静态守卫精确区分"cap 位"与 `??` 默认位；
- `lib/ledger.mjs` 新增唯一读取实现 `readLedger`：包裹 / 裸数组 / 缺失 / 坏 JSON / 形状不认识五态；
  裸数组链头由末条 hash 重建（`--verify` 结论与包裹一致）；不可读时 `gate-ledger --list/--verify` 输出
  `[SKIP] ledger unavailable — 原因` + exit 1，**绝不 `Valid: YES`**；`appendEntry` 不可读时**拒绝追加**（防覆盖历史）；
- 判别力：旧实现裸数组 → `No gate entries recorded.` / `Total entries: 0 / Valid: YES`（假健康）；新实现 → 真实 2 条 + 链头重建说明；
- `ledgerShapeNormalization` 14 例（真 spawn + HEAD/变异反向自检 + 4 文件 cap 静态守卫）。

### ⑤ 工程化与证据

- 技能版本 **2.6.0 → 2.6.1**（四锚一致）：账本循环身份 + 形状归一是行为变更；`scripts-reference.md` 补 `§cycle-N`
  去重须知与 gate-ledger `[SKIP]` 语义；
- 文档：`API参考-周期面.md`（读账本须知 §cycle-N）、`测试指南.md` §9 覆盖率证据链、`闭环三态真值契约.md`（删键说明）；
- 安全：新增 coverage 工具链带入 `glob <10.5.0` [high] 传递漏洞 → `pnpm-workspace.yaml` override 钉 10.5.0，
  **high 1→0**（moderate 3 = vitest 已知跨大版本项，维持登记）。

### 验证基线（本轮收口）

```
typecheck: 双 tsconfig 0 错
validate:  12/12 PASS（dsh-anic@0.45.0）
vitest:    168 files / 2066 tests 全绿
smoke:     ALL PASS（20 条）
trigger:   22 tools · recall 27/27 = 100% · FPR 0/14
coverage:  lines 87.27% · branches 83.26% · functions 88.69%（≥80/65 达标）
eval:      E1-E8 + Q1-Q8 16 维全 PASS
gates:     G0-G3 全 PASS（G1/G2/G3 detail 含 §cycle-79；账本 176 条 valid）
lifecycle: cycle-79 close → plan→design→build→test→deploy→maintain 自动推进
skill:     2.6.1 · ok=true / in-sync / extras=[]
build:     client.js 297,131 B + host.js 574,931 B（原子替换）
```

### 已知边界（诚实登记）

- J0 探针未跑；**GUI 浏览器级验证受宿主 web 认证阻断**（agent 浏览器无会话凭据）——面板继续以真渲染 + 契约锚点取证。
- 覆盖率分母含 0% 的 client 文件（`WorkflowGraphPanel.ts` 等），真实最差文件已列明，不宣称"全面高覆盖"。
- `.cycles/` gitignore ⇒ 覆盖率工件不随仓库分发；契约"缺失即明确失败"。
- i18n 消费面含 `tests/` 引用（`trace.statusDone` 类），词表覆盖率可能被测试字面量抬高（登记待收窄）。
- `multi-agent-gate.mjs` 对不可读账本文案仍写 `ledger(empty)`（同族文案瑕疵，未修）。
- vitest 自身 3 条 moderate 漏洞（修复版 4.1.11，跨大版本，维持既有登记）。

## v0.44.0 — 2026-10-26（cycle-78：全生命周期相位自动化 + 熔断可达性 + 通道声明 + 自主级时间线）

> L4 全自主第 78 轮。起点是**宿主重启后的真实复核**（cycle-77 交付已生效：`?workspace=` 查询选择器、
> self-check 9 探针含 P9、org-status `L4 + historyCount=2`），因此本轮攻的是"机制已通但**不可达/不可视/不流转**"三类缺口。
> 6 名实施队员（4 并行 + 2 续接）分域作业，Lead 统一集成与真实世界取证。

### ① 全生命周期：宏观相位不再是死的（P0）

**被守卫缺陷**（实测）：`.cycles/workflow-state.json` 的 `currentPhase` **77 轮停在 build**；
机制齐备（`advanceMacro` 带逐相门禁守卫、`anic_flows_advance` 工具在）但**没有任何自举链调用它**——
`initCycle` 只建目录、`closeCycle` 只查节点状态与哈希链、`advanceCycle` 写盘还会把相位字段整段抹掉。

- `initCycle` → 相位归零 `plan`（`currentCycle` 同步，旧相留痕带 `note:'cycle-init'`，首次建状态不伪造退出记录）；
- `closeCycle` → 读门禁账本，**G0-G3 全 PASS 才逐相推进**（build→test→deploy→maintain），被卡即停、缺门零写入、末相幂等；
- `advanceCycle` 写盘保全 `currentPhase/phaseHistory`（原只写 `{nodeStatus}`）；
- **双证据源显式分离**（只增字段）：`gatesLedgerPassed`（门禁账本）+ `closeEvidence`（both/workflow-graph/gate-ledger/none）
  —— 自举循环只跑门禁协议，`nodeStatus` 空是**证据缺席**而非门禁失败，不再让读者靠猜；
- 技能 `init-cycle.mjs` 同语义（双实现，契约 `cycleLifecyclePhaseContract` ② 真 spawn 对钉）。

**真实世界证据**：`closeCycle(repo/.cycles, 77)` → `phaseFrom:build → phaseTo:maintain, phaseAdvanced:true`，
phaseHistory 追加 build/test/deploy 三条真实 `exitedAt`；随后 `init-cycle` 建 cycle-78 → `currentPhase=plan`、
旧相 `maintain` 留痕。**这是本仓首次出现相位随循环真实流动。**

### ② 熔断可达性：CB5 从 fail-open 修到可触发（P0，宿主 + 技能双实现）

`band-detector` 写入的 `band-history.json` 条目形状是 `{timestamp,totalScore,avgScore,fileCount,overBudgetCount}`
——**没有 `band` 字段**；而宿主 `breakerSignals.bandUnrecovered` 判 `band==='alarm'`、技能 `org-status.mjs` 读
`history.snapshots`（真实是裸数组，`.length` 抛错被 catch 吞）⇒ **CB5 两侧都永不触发**，文档却宣称有效。

- 宿主：`entryUnrecovered` 双形状（`band==='alarm'` 或 `overBudgetCount>0`），末 2 条都命中才触发；
- 技能：`normalizeBandHistory` + `bandEntryUnrecovered` 与宿主同语义，check 与诊断共用同一归一；
- **技能侧 CB2 同族（更严重：崩溃）**：`ledger.entries.slice(-4)` 遇裸数组直接 TypeError 崩掉整个 org-status
  （`.entries` 是 `Array.prototype.entries` 函数）→ `loadLedgerEntries` 归一 + 三态 `TRIGGERED|OK|SKIP`，
  账本不可用时明确 `[SKIP]` 点名原因（不 fail-open、不崩溃）；顺带修空工作区 `org-status review` 必崩（两出口形状不一致）。
- 反向自检：用 `git show HEAD:` 旧脚本跑同夹具 ⇒ 旧 CB5 静默 OK、旧 CB2 裸数组崩溃（证明修的是真缺陷）。

### ③ 可观测性诚实化：报警 ≠ 执行失败

`band-detector` 在 WARNING/WE 违规时 `exit 1`，被 FlowTracker 记为 FAILED、健康面降级（实测 `1/1 failed`）。
WE 规则 7/8 在近常数过程（σ=0.16）必然常亮——报告内容不该等于执行成败。

- **默认（报告模式）**：只要产出报告即 `exit 0`（告警作为数据输出）；**`--strict`（门禁模式）**：告警即 `exit 1`；
- 执行失败（目录/配置/历史损坏）仍非零且 stderr 点名（原先历史损坏静默清空 ⇒ WE 规则永不触发，同修）；
- 同步超时 cap 收敛：`MAX_SKILL_INVOKE_TIMEOUT_MS = BOOTSTRAP_STEP_TIMEOUT_MS`(240s) + 纯函数
  `resolveSkillInvokeTimeout`（防 Infinity/NaN），`skillInvoker` 弃 `Math.min(timeoutMs,120000)`；
- 技能版本 **2.5.2 → 2.6.0**（四锚一致，quick-validate PASS）。

### ④ 白盒：46 条通道独占路由的机器可读声明（声明 ≠ 豁免）

闭环三态矩阵此前把 `routes: 63 / 17 代码消费 / 46 未消费` 平铺——46 条是外部 curl / 运维 / MCP / 人工面，
机器面前却与死代码不可区分。

- 新增 `closureAudit/channelRegistry.ts`：46 条四元组声明 `{route, owner, docRef, reason}`；
  `docRef` 三重机器校验（文件存在 + 锚点命中真实标题 + 该章节正文含路由字面量）⇒ **46/46 全绿**；
- 分类学第 6 桶 `declaredChannel`：`unconsumed = declaredChannel + consumedGap + producedGap`，
  `consumed = code + dynamicClaimed + channelOnly`（逐族强制，不只验总和）；
- **未声明棘轮**：未消费路由未声明即点名红；反向自检（删声明/篡改 docRef/伪造新路由）真判红；
- 关键陷阱修复：声明表自身的路由字面量会被当成"生产代码调用方"把缺口**洗成绿**（实测 consumed 335→390），
  已在消费面显式排除声明表自身，并用空集下限兜住退化；
- 新 totals：`registered 433 / consumed 348 / unconsumed 85 / declaredChannel 46 / consumedGap 0 / producedGap 39 / ghost 0`
  —— **consumedGap 46→0 不是放水，是把"真缺口"重分类为"已声明的通道面"**；面板新增
  `data-anic-closure-declared`（通道声明 46 / 未声明 0）。

### ⑤ 可视化：自主级审计时间线进面板

后端的 `org-status.autonomy.history` 一直存在，但客户端类型把它丢弃 ⇒ UI 永远看不见"L4 是谁授权的"。

- `OrgStatusJson.autonomy` 只增 `history/historyCount/historyError`（含 `trustExemption`）；
- `renderOrgStatus` 新增时间线：`data-anic-org-autonomy-history` / 每行 `data-anic-autonomy-transition` /
  豁免标记 `data-anic-autonomy-exempt`，倒序取 5 + `+N`，`historyError` 走 `role="alert"`，
  行内 `flex-wrap`（窄面板不溢出）、`ul/li` 语义 + `aria-label`；i18n zh/en 各 +9 键；
- host 侧补漏：`summarizeHistory` 此前丢掉 `trustExemption`（UI 分支只能靠 fixture 看见）——审计信息不得在投影层择优丢失；
- **实测真账**：`org-status` 摘要现在带 `L3→L4` 的 `trustExemption {avg:84, threshold:85}`。

### ⑥ 质量属性横向证据（本轮实测）

| 指标 | 值 |
|---|---|
| 工具 / 路由 / 技能 | 22（22 消费）/ 63（17 代码 + 46 声明 + 0 幽灵）/ 16（16 消费） |
| 闭环分类 | registered 433 · consumed 348 · unconsumed 85 · declaredChannel 46 · consumedGap 0 · ghost 0 |
| 测试 | 164 files / **2036 tests**（+67 用例，全部带反向自检） |
| 中文注释 | **226/226 文件（100%）**，8,378 注释行 |
| 模块纪律 | 0 个 >250 行（src）；运行时 import 环 0 |
| 构建 | `dist/client.js` 299,203 B + `dist/host.js` 573,550 B |
| 技能版本 | 2.6.0（四锚一致） |

### 验证基线（本轮收口）

```
typecheck: tsconfig.client + tsconfig.host 双配置 0 错
validate:  12/12 PASS（dsh-anic@0.44.0）
vitest:    164 files / 2036 tests 全绿
smoke:     ALL PASS（20 条）
trigger:   22 tools · recall 27/27 = 100% · FPR 0/14 = 0%
eval:      E1-E8 + Q1-Q8 共 16 维全 PASS
gates:     G0-G3 全 PASS（账本含逐维质量裁决）
lifecycle: cycle-78 close → plan→design→build→test→deploy→maintain 自动推进
build:     staging → 原子替换成功
```

### 已知边界（诚实登记）

- 真实宿主 J0 探针未跑（需重启宿主加载本轮 dist；纪律禁止启停宿主）；面板新增行需重建 dist + 重启后可见。
- `@vitest/coverage-v8` 未安装 ⇒ coverage 产物缺失（G2 coverage_threshold 本轮仍无证据；登记为债务）。
- 4 条流程层（archive/gate-check/hitl/macro-phase）仍各有 120s cap（技能两入口已对称；流程层待统一）。
- `assets/skill/scripts/lib/ledger.mjs loadLedger` 与 `gate-ledger.mjs --list/--verify` 仍只认包裹形状
  （裸数组账本静默清空 → 同族 fail-open），属 lib/ 文件域，登记待下一轮。
- `nodeStatus` 节点账长期为空（play 协议未被自举链使用）：本轮只做到**如实分离两种证据**，不做协议统一。

## v0.43.0 — 2026-10-25（cycle-77：L4 自主级可审计 + 账本质量维入账 + 完整性/连接性缺口六连修）

> 本轮由 **L4 全自主模式**（用户指令授权，`humanAuthorized` + `trustExemption` 如实入账）
> 驱动自举循环，按用户限定的质量评审体系（功能性 + 非功能性 + 设计约束 + UX/UI + 工程化规范）
> 从**项目自己的机器**取证缺口，修完复跑复验。4 名 teammate 并行实施（写作用域互斥）。

### ① F-04 质量维裁决入账（P0：账本 fail-open）

**被守卫缺陷**：`gate-check.mjs` 的 `--record` 落账发生在质量检查**之前** ⇒ G0 基本判定 PASS、
Q5 FAIL 时账本留下 `G0 PASS`，与最终裁决矛盾——读账本会误判「上次全过」。
**修法**：质量先行；账本 `result`=最终裁决、`detail` 追加逐维证据。
真实账本条目（本轮 G0-G3 复跑）：

```
G0 PASS | Evaluation report found in cycle-77 (16 dimension rows) [Q1:PASS,Q5:PASS]
G1 PASS | All 14 tasks completed [Q7:PASS]
G2 PASS | Zero failures, zero errors (测试报告.md + journey coverage verified) [Q2:PASS]
G3 PASS | Build passed: node scripts/build-client.mjs [Q3:PASS,Q4:PASS]
```

原生侧同族修复：`gateEngine.evaluateQualityGate` + `gateCheckRunners.recordNative` 消费质量裁决
（`finalPass = gate.pass && quality.pass`），差分契约逐字节全等。回归：`gateQualityLedgerContract` 6 例
（真跑脚本 + 账本读回；用 HEAD 旧脚本同夹具实测旧行为判红）。

### ② 自主级变更可审计（P0：L4 激活不再手改配置）

**被守卫缺陷**（`docs/anic/spike/evolution-replay-simulation.md` P0）：incidents 声称 2 次 L4→L3，
账本 0 条；本次实测配置又已悄悄变成 L2 —— **级别变更发生在任何可审计载体之外**，且只有降级工具、无升级路径。

- 新增 `src/host/evolution/autonomyHistory.ts`：`.cycles/autonomy-history.json`，结构化身份
  `{from,to,at,actor,reason,authorization,evidence,trustExemption?,atCycle}`；原子写 + 写后回读；
  坏 JSON **响亮拒绝覆盖**（不抹既有审计线索）；有界 50 条 FIFO 并返回 `dropped`。
- 新增工具 **`anic_autonomy_upgrade`**（第 22 个）：相邻档 / 无 tripped 熔断 / 信任阈值 / 人类授权
  四条件机器判定；拒绝**零写入**并点名缺失前置；成功走 Post-Verify（observed≠intent ⇒ `upgrade-failed`
  且不写成功记录）。降级路径同步留痕（补齐"降级无审计"）。
- `org-status` 追加 `autonomy.history`（最近 5 条）+ `historyCount` + 坏账 `historyError`。
- **本仓实际激活（两步相邻）**：L2→L3（信任 84 ≥ 70，`authorization: system`）→
  L3→L4（84 < 85，**人类显式授权豁免**，`authorization: human` + `trustExemption: {avg:84,threshold:85}`）。
  当前 `org-status` 实测 `currentBand=L4 / configuredBand=L4 / historyCount=2`。

### ③ 双轨漂移 + extras + manifest 新鲜度（F-07/F-08，P1）

线上复现：`skillIntegrity.ok=false`（`mcp-server.mjs` hash、`quick-validate.mjs` size 不符），
extras 三个顶层旧副本、manifest 停在 2.3.0（真实版本 2.5.2）。

- `verifySkillInstall` 新增只增字段：`extraDrift[]`（同名不同哈希的散落副本 ⇒ **判红但不删除**）、
  `manifestStale` + `MismatchKind 'manifest-version'`、`dualTrack`（`in-sync`/`live-behind`/`live-diverged`/`unknown`）。
- `repairSkillInstall` 重写清单并刷新 `version`/`generatedAt`；显式跳过清单层 mismatch（不当普通文件复制）。
- self-check 新增 **P9-skill-dual-track**：真装才探；inline 缺失 ⇒ `skipped:true` 不计 `allOk`（缺证据 ≠ 通过）。
- **工作区实修**：`repair` 同步 3 文件（`scripts/gate-check.mjs` / `scripts/mcp-server.mjs` / `scripts/quick-validate.mjs`），
  清理顶层**旧版** `mcp-server.mjs`（16,093 B，仍是 `execSync` 命令注入前形态；`scripts/` 版 20,109 B 为 `spawnSync` 修复版，
  且全仓无任何引用）⇒ 复验 `ok=true / dualTrack=in-sync / manifestVersion=2.5.2 / extraDrift=0`。

### ④ build 删窗消除（F-09，P1）

**被守卫缺陷**：`build-client.mjs` 非 watch 路径先 `rmSync(distDir)` 再构建 ⇒ 构建失败时宿主运行目录
`dist/` 被整体删除（2026-10-23 真实事故）。
**修法**：staging 目录构建 → 失败 `exit(1)` 且 `dist/` **零动作** → 成功才逐文件 `renameSync` 同卷原子替换。
新增 `buildWindowContract` 6 例：词法感知解析语句顺序（非整文件字符串位置猜测），断言非 watch 路径
`dist` 删除=0、client/host 构建 < exit < promote、cleanup > promote；反向自检三类违例判红。

### ⑤ 连接性：`?workspace=` 查询选择器被忽略（P1）

工具面（`anic_status` / `anic_snapshot` / `anic_self_check`）宣传 `/anic/...?workspace=<abs>`，
而 `resolveWorkspaceRoots` 只读 `X-ANIC-Workspace` 头 ⇒ 查询参数被静默忽略、回落宿主 cwd。
实测：查询参数 → `cycles.total=0`；加头 → `73`。**修法**：查询参数升为**同等级选择器**，
与头**共用同一个** `acceptClaim` 校验（`knownRoots ∪ 真含 .cycles`），优先级 头 > 查询 > registry > sessions > cwd；
"选择器不是任意路径入口"的安全边界不变。`workspaceSelector` 7 例（每例带反向自检）。

### ⑥ 自举超时默认值收敛（F-06，P2）

`bootstrapOrchestrator.ts` / `bootstrapOrchestratorAsync.ts` / `bootstrapEngineIntegration.ts` 三处裸
`timeoutMs = 60000` → 引用单一事实源 `BOOTSTRAP_STEP_TIMEOUT_MS`（240000，4× 测试金字塔）。
新增静态守卫：runtime 编排器不得再出现裸 `60000` 默认值。

### ⑦ 测试编排器自述漂移（F-05，P2）

`run-tests.mjs` 头注自称 `[1/3]…[3/3]` 三层 + "21 断言"，实现是 4/5 层、smoke 20 条 PASS。
修法：头注只描述能力不重复数字；`testRunnerSelfDescriptionContract` 6 例静态守卫
（A 类禁硬编码层编号/层数/断言数；B 类要求横幅由 `STEPS.length` 派生）+ 反向自检。

### ⑧ 质量属性量化与工程化同步

- `非功能验证报告.md`（cycle-77）：19 项质量属性量化——工具 22/22 消费、路由 63（ghost 0）、
  技能 16/16、连通性 6 跳全通、闭环体检 423–460 ms（并发负载最差 21.96 s，如实披露）、
  中文注释 222/222 文件（100%，7,995 行）、0 个 >250 行文件、运行时 import 环 0、high/critical 漏洞 0。
- 生产/消费三态矩阵：**420 注册 / 335 消费 / 85 未消费 / ghost 0**；46 条未消费路由为**通道独占**
  （外部 HTTP / 运维 / MCP 客户端），39 条未消费 locale 键为**声明未消费**（无幽灵键）。
- 文档同步：README（22 工具 + `### 22 DSH 工具` + 升级工具条目）、`测试指南.md`（四层离线 + 第 5 层 live）、
  `docs/agents/README.md`、`CLAUDE.md`、`API参考-数据面.md`（P7/P8/P9 探针）。
- 配置补齐：`.cycles/config.yml` 显式 `complexity_budget: 100`（消除 band-detector 的"未设预算"提示噪声）。

### 验证基线（本轮收口）

```
typecheck: tsconfig.client + tsconfig.host 双配置 0 错
validate:  12/12 PASS（dsh-anic@0.43.0）
vitest:    159 files / 1969 tests 全绿
smoke:     ALL PASS（20 条 PASS）
trigger:   22 tools · recall 27/27 = 100% · FPR 0/14 = 0%
eval:      E1-E8 + Q1-Q8 共 16 维全 PASS
gates:     G0-G3 全 PASS（账本含逐维质量裁决）
build:     dist/client.js 287,211 B + dist/host.js 547,572 B（staging 原子替换）
```

### 已知边界（诚实登记）

- 真实宿主 J0 探针未跑（需重启宿主加载本轮 dist；纪律禁止本会话启停宿主）。
- `tsdown` 失败路径无端到端测试（静态守卫 + 零动作实现兜底）。
- `skillInvoker` 同步入口 120s cap 与异步 240s 仍不对称（既有登记）。
- `band-detector` 报警语义未与执行失败区分（WARNING/WE ⇒ exit 1 ⇒ FlowTracker FAILED）——
  本轮登记为 `.cycles/tech-debt/cycle-77-band-detector-alarm-semantics.md`，未改判定语义。

## v0.42.0 — 2026-10-25（cycle-76：连通性维度 + 质量属性评审缺口补齐 + 扫描算法提速 17.5×）

### ⓪ 质量属性与全生命周期评审（Q1-Q8），用**项目自己的机器**取证并补缺

用户诉求新增限定：「从软件质量保障/质量属性与全生命周期评审体系进行分析，对缺口进行完善补充」。
做法是**不靠自述**：直接跑项目自带的 `eval-runner.mjs --dimensions Q1..Q8`，
以它的裁决为缺口清单，修完再复跑。

**首跑结果（真实）**：

```
Q2 测试体系   | FAIL | No test reports
Q4 安全与合规 | FAIL | 1 high vulnerabilities
（Q1/Q3/Q5/Q6/Q7/Q8 PASS）
```

| 缺口 | 根因取证 | 处置 |
|---|---|---|
| **Q2 无测试报告** | `.cycles/cycles/cycle-76/test-reports/` 为空——**测试跑了但没留证据**（违反 R05 证据纪律） | 产出 `test-reports/最终测试报告.md`，全部数字取自实际命令输出 |
| **Q4 1 高危** | `undici < 8.12.2`（DoS via excessive content-encodings）。路径：`jsdom@30.1.2 → undici@^8.11.2`（devDependency） | `pnpm update undici` → **8.12.1 → 8.12.3**，锁文件**仅 4 行**变更；复测 **high 归零** |

**影响面诚实判定**：dsh-anic 的 `dependencies` 为**空**，运行时仅依赖宿主提供的可选 peer
⇒ 该 undici **不进出厂产物**（测试工具链风险）。即便如此仍**实际消除**而非豁免（R06 不降级）。

**复跑结果**：**Q1-Q8 全部 PASS，E1-E8 全部 PASS**。

### ⓪′ 性能：修掉 O(项数 × 全仓行数) 的算法缺口（17.5× 提速）

根因：`collectRefs` 让**每一项资产**都把**每个文件的每一行**扫一遍 ⇒
`419 项 × 519 文件 × 156 行 ≈ 34 M 次行判定`，实测 **7933 ms**，而裸 I/O 仅 142 ms（**放大 56×**）。
面板闭环分区是一次性拉取，7.9 s 同步扫描会直接卡住渲染面。

- 新增 `closureAudit/evidenceIndex.ts`：**一次扫描建三张倒排表**
  （`anic_*` 工具 id / `/anic/*` 路由 token / 点分引号字面量 → 证据 `file:line`），
  查询降为「哈希查表 + 短列表过滤」。
- **实测 7933 ms → 453 ms（17.5×）**，每项 18.9 ms → **1.08 ms**；相对裸 I/O 的放大 56× → **3.2×**。
- **建表不设 cap**（实测教训）：初版设 `EVIDENCE_CAP=12` 导致**语义回退**——按文件顺序截断，
  若某 token 前 12 次出现全在 docs/tests（被消费面排除），真实消费者证据位被吃掉
  ⇒ tools consumed 21→15、routes 19→16。截断只能发生在**过滤后**的查询侧。

### ⓪″ 提速路上顺手抓到的两个真实缺陷

1. **注释假阳性（判定纪律⑥此前从未在路由/工具族落实）**：旧实现把 JSDoc 头注里列举的
   端点当成「有人消费」。复核出 2 条：`/anic/self/evaluate ← selfBootstrapFlow.ts:4`、
   `/anic/self/status ← selfBootstrap.ts:12` ⇒ **routes 未消费 44 → 46 是纠正**。
   新增守卫「证据锚点不得来自注释（去注释后 token 必须仍在）」，并显式跳过
   `dynamic=true` 的计算键认领项（其证据按设计指向模板行）。
   已知边界如实登记：`generate-snapshot.mjs` 在**模板字符串**里生成 JSDoc 提到端点，
   词法扫描无法区分「文档写进字符串」，不在判据内也不因此放宽判据。
2. **运行时 import 环（Q5）**：索引化造成 `scanPrimitives ↔ evidenceIndex` 双向 import，
   被 `skillConvergenceContract` 的 importGraph 守卫**当场抓到**。修法：把
   `stripComments`/`quoteClasses` 下沉到无依赖的 `textScan.ts`，两模块共用
   （判定口径仍单一实现，未复制）。

### ⓪‴ 质量属性横向证据（量化）

| 指标 | 值 |
|---|---|
| 中文注释 | **213/213 文件（100%）**，7548 注释行，**零纯英文注释文件** |
| 运行时 import 环 | 0（215 源文件） |
| 超 250 行文件 | 0 |
| 响应式断点 / ARIA | 9 处 / 41 处 |
| 依赖高危漏洞 | 1 → **0** |
| 全量体检耗时 | 7933 ms → **453 ms** |


> 主题（用户诉求新增限定）：「确保**连通性逻辑性**」。cycle-75 把 `produced` 修正为
> 「存在**真注册调用点**」，但那仍只证明「某处写了 `reg({path})`」——**不证明那段代码会被执行**。

### ① 被补的盲区：空心注册（静态全绿、运行时永不达）

一个注册器若**没被聚合器调用**，里面所有 `reg()` 都是空心注册：**注册了、生产了、甚至有消费方**，
三态矩阵**全绿**，运行时却到不了。与本仓既有事故同族——`headless 下整条 fiber pending`
是「注册了但没激活」，这条更隐蔽：**代码静态存在、测试全绿、面板显示完全健康**。

### ② 判定链（6 跳，任一断即不可达）

```
src/index.ts apply
  ├─ wireRoutes()  ──► anicRoutesPlugin ──► registerAnicRoutes()
  │                                        └─ registerXxxRoute() ──► reg({path})
  ├─ registerAnicTools() ──► tools.ts ──► registerXxxTools() ──► tools*.ts 网关
  └─ registerRuntimeSkill()
```

- `wireRoutes` 的**两条路径都认**（cycle-74 P0 后优先走子 fiber `ctx.plugin(anicRoutesPlugin)`，
  服务缺席回落直连）——只认一条会把正确实现判成孤儿。
- `callLine()` **排除定义行**（`export function foo(` ≠ `foo(`）：否则「自己定义自己」
  就成了「自己被接线」，正是假绿形态。
- `callLine()` **自带去注释**（本契约 ② 实测抓到的形态：`// wireRoutes(ctx) 在注释里`
  曾被判成真接线）。

### ③ 真机结论（实测）

```
6 跳全通 · 路由注册器 19/19 接线 · 工具网关注册器 9/9 接线 · 孤儿 0 · connected = true
```

**今天是对的，但此前零守卫**——新加一个注册器忘了挂进聚合器，所有既有守卫仍全绿。

### ④ 变异测试（证明守卫有牙，两态可分）

| 变异 | 结果 |
|---|---|
| 注释掉聚合器里的 `registerClosureAuditRoute(c, { send })` | ❌ `orphanRegistrars = ["registerClosureAuditRoute"]` + 跳红 |
| 注释掉入口 `wireRoutes(ctx, …)` | ❌ `entry→routes` 断 |
| 注释掉工具 hub 的 `registerHitlTools(` | ❌ 孤儿 + `tools→gateways` 断 |
| 注释掉入口 `registerRuntimeSkill(ctx)` | ❌ `entry→skill` 断 |

变异**只在内存副本**上做（R-31 只读），且每条都断言「变异前绿 / 变异后红」。

### ⑤ 白盒可见（不只是一个没人调的模块）

- 投影新增 `connectivity`（结论 + 逐跳状态 + 孤儿名单 + 接线计数），
  **不含本地绝对路径**（`hops[].at` 是仓内相对 file:line）。
- 面板新增连通性行：`data-anic-closure-connectivity=ok|broken`；
  断链时显示断几跳 + **点名空转注册器**。
- 客户端守卫**在场则严格、缺席则放行**（向前兼容：新增观测面不得把既有面板打瞎）：
  `hops` 非空（空链不许冒充全通）、`wired ≤ total`（超了即自相矛盾）。

### 结构（T3 ≤250 行）

新增 `closureAudit/connectivity.ts`(226)、`client/features/closure/closureConnectivityTypes.ts`(62)；
`closureTypes.ts` 拆出连通性后 249；`renderClosure`(247)。**消费者 import 路径零变更**。

### 守卫

`closureConnectivityContract`（10 例）：真机全通 / `callLine` 不误判定义 / 空扫描集抛错 /
**四处定向变异各自变红** / 投影无绝对路径 / 客户端守卫两态 / 渲染三态（ok·broken·缺席）。

### 实测总账

```
测试 150 files / 1882 tests ALL GREEN · validate 12/12 · smoke ALL PASS · trigger 26/26 recall 0/14 FPR
build OK（client.js 253,249 B）· typecheck OK · quick-validate 四锚一致 2.5.2
连通性 6 跳全通 / 19+9 注册器全接线 / 孤儿 0
```

## v0.41.0 — 2026-10-24（cycle-75：闭环体检从「自述」到「真值」+ 第四族 + 渲染腿收口）

> 主题：用户诉求「**确保技能插件的所有功能业务的注册、生产与消费**，同时要**白盒透明化、
> 可视化流动**等可观测性」。本轮不加新功能面，而是把已有的观测面**改成可信的**，
> 并把用户点名的「技能 skill / MCP」维度补进矩阵。**不发布 npm**（发布边界留人工门）。

### ① 硬缺陷：闭环体检的三个数**没有一个可信**（实测取证后重写）

`registered / produced / unconsumed` 在路由族上同时失真，且**三处错误互相掩盖**：

| 指标 | HEAD 实测 | 真值 | 根因 |
|---|---|---|---|
| registered | 63（其中 **10 条代码里根本不存在**＝幽灵注册） | **63**（逐条核验为真） | 扫描器把路由文件里**任意** `/anic/…` 字面量当注册——JSDoc 头注、错误消息、响应字段全被算进去 |
| produced | **1 / 63** | **63 / 63** | 判据是「`routes/index.ts` 是否含该 id 子串」；真实注册在各路由文件**内部**，`index.ts` 只调注册器 ⇒ 恒为 1（唯一命中的那条还是**注释**里的路径） |
| 未消费 | 44（含 10 条幽灵） | 44（逐条可核） | 由上面两个错数派生 |

- **重写** `scanRouteDefs`：只认真注册调用；**四种形态全覆盖**（`webServer.register({path})`
  ＋ 局部 `reg(path,h)` ＋ `reg('GET',path,h)` ＋ `register('POST',IDENT,h)`），`path: IDENT`
  回溯同文件常量；**去注释后再扫**；`declaredAt` / `producedAt` 双锚点分开记。
- **兼容包装** `scanRouteAssets()` 保留，id 集与 `scanRouteDefs` **完全同源**（单一实现）。
- **双向交叉验证**：与本仓**另一套独立计数器**（`readmeNumbers.test.ts` 的 grep 版）逐 id 一致
  ——两套实现互证比一套自证可信（README 的「63 条路由 / 21 个工具」确为真值）。

### ② 硬缺陷：`produced` 无证据、无棘轮 ⇒ 换成**逐项可查的产出锚点**

新增 `ProducedKind` 四态：`register-call` / `handler-in-file` / `declaration-only` / `no-write-point`，
每项带 `producedAt` + `producedEvidence`（≤3 条 `file:line`）。**一个数字没有证据就是自述**。
`producedByKind` 由**逐项单向派生**（`tallyProduced`），并断言「合计 = total」，防各构造点自报漂移。

### ③ 未消费清单从「平铺」改成**五分类**（可行动）

上一版把 86 条未消费平铺成一张表，读者无法据此行动（形式上白盒、语义上是噪声）。
现按**互斥且穷尽**五类呈现，合计恒等于项数：

| 类 | 判据 | 实测 |
|---|---|---|
| `code` | 生产代码内真消费 | 314 |
| `dynamicClaimed` | 计算键认领（非字面量证据） | 3 |
| `channelOnly` | **仅**测试/agent 卡引用（无生产消费者） | 2 |
| `consumedGap` | 已生产但无人读 ⇒ **真缺口** | 44 |
| `producedGap` | 只声明/无写入点 ⇒ 未读取 | 42 |

**关键区分**：`dynamicClaimed` / `channelOnly` **不在未消费里**（它们已被计入 consumed）——
四键并列会被误读成「未消费的四等分」（44+42+3+1=90 ≠ 86），故渲染层**分两层**呈现并各自标明语义。

### ④ 新增**第四族**：技能脚本 + MCP 传输层（此前**零覆盖**）

用户点名「技能 skill、mcp 等工具」，而闭环矩阵此前只扫 tools/i18n/routes 三族，
`assets/skill/scripts/` 与 MCP 面**一条都没审**（实测 `capability-index.json` 提到 mcp **0 次**）。

- 注册表 = **真实文件清单**（15 业务脚本 + 1 传输层），不是手写数组；白名单差集**恰为** `{mcp-server}` 并断言。
- 实测 `skills: total=16 produced=16 consumed=16 unconsumed=0`。
- **MCP 面专项结论**：15 个工具「清单 ⇄ 分发 ⇄ runScript」**三方成对**（15/15/15，无幽灵工具、无看得见调不动）；
  但**本仓内没有任何代码启动它**——唯一引用是 `bin/anic-init.mjs:75` 的用户指引文本 ⇒
  `consumed=true` 但 `evidenceKind=channel`（**通道级**，不是生产代码消费）。`mcpSurface()` 如实标注。
- 剔除三类**假消费源**并逐条实测：`capability-index.json` 的 scripts 数组（**投影回声**：
  生成器从 `listSkillScripts()` 抄出，零读取方据此调用）、`src/host/closureAudit/*`（**扫描器自指**）、
  同名路由冒充（`/anic/org-status` 曾让 `org-status` 看起来被路由消费）。
- `assertClustersPresent` 由三族扩到**四族**——缺族响亮抛错（技能面此前正是「零覆盖却不被任何断言发现」）。

### ⑤ 词表族：一个**反的契约前提**被实测推翻

我原以为「真实值 45 / 被误降到 42」，实测证明**反了**：A/B（同文件集只换实现）显示
落差 3 项**全部**是 `budget.status_normal/_warn/_alert`，由 ``t(`budget.status_${data.status}`)``
真实消费（`renderBudget.ts:122`）⇒ **42 是真值，45 才是假阳性值**。契约已按实测反向修正。

- **死分支确证并修复**：原 `indexOf(BACKTICK + '${')` 搜「反引号紧接 `${`」——反引号在首位、
  `${` 在中段 ⇒ 模板分支**恒不命中**（最小样例 `HEAD hits = 0` → `FIXED = 1`）。
- **新根因**（契约原文未点名）：`indexOf('t(')` **无词法边界** ⇒ `agentCards.get(...)` 的 `get(`
  尾串被当成 i18n 调用，凭空造出 `anic.agent.` 前缀。今日认领 0 键故无害，
  但一旦新增 `anic.agent.*` 键，Map 查表就会被冒充成词表消费。已加 `isTranslationCall()` 边界。
- `assets/**` 收窄为**假消费**（技能脚本以**目标项目**目录为根探测词表，不是本插件 `locale/zh.json` 的读取方）。
- **注释证据**（判定纪律⑥）：`collectRefs` 此前在原始文本取证据 ⇒ evidence 锚到注释行（实测 4 处），已改在去注释文本上取。

### ⑥ 扫描器**实测缺陷**（由「守卫有牙」反查出来，已修）

T5 的变异测试 M5 抓到：形态 A 用 **600 字固定窗口** + `handler:` 截断定位 `path`。
任何把 `path:` 推远的**无害重构**（长注释——`stripComments` 保留长度、参数增补、换行风格）
都会让注册**静默漏报**，`registered/produced/unconsumed` 三数同时漂移。实测 path 推远 700 字后 produced 直接为空。
- **改为括号配平取实参**（`balancedBraces`，带引号状态机保护）。六例回归：常规 / 推远 700 字 /
  相邻两条不串台 / 嵌套对象 / 常量引用 / 字符串内花括号。

### ⑦ 白盒渲染：补上「**渲染腿**」——有壳无表体的同一个洞

既有三腿契约只覆盖「装配（被 createElement）+ 数据（切片→setter 接线）」，
**没有任何一条断言 `renderClosure` 真的产出了内容**——若它返回空树/只有标题，
三条腿**全绿**。新增 `closureRenderOutputContract`（8 例）**对着渲染树**取词：
摘要四计数、四类分组锚点、逐项明细、新族 `skills` 标签、截断态**两个数**都在、
零未消费显式空态、失败行可见（`data-anic-failed-closure`）、未知族/未知 kind **回落显示原 id**、
无绝对 URL、**反向自检**（有内容命中 / 空树不命中，证明判据非恒真）、真机投影端到端可渲染。

同时：投影**明细截断**（上限 80，**总数永不截断**）如实上报 `truncation{shown,total,truncated}`，
并按「真缺口优先」排序——截断必须截掉最不需要立即行动的部分，否则等于把缺口藏起来。
投影体积 31 KB → **17.9 KB**。

### ⑧ 技能包：陈旧版本横幅（**守卫结构上看不见**）

`mcp-server.mjs:449` 运行期横幅印 `v1.6.0`，而三处版本锚点均为 `2.5.2`（落后 9 个次版本）。
`quick-validate` 的版本守卫只认 3 锚，**第 4 个版本位不在守卫面** ⇒ 不跑起 MCP server 永不暴露。
- **先扩守卫**（新增 `MCP Server vX.Y.Z` 运行期横幅为第 4 锚，锚点下限 3→4，少一个即报错），
  跑出 `[ERROR] Version drift: … (runtime banner)=1.6.0 …`（守卫**先红**，证明有牙）；
- **再修横幅** → `[OK] Version consistent across 4 anchors: 2.5.2`、`VALIDATION PASSED`。

### 实测总账（HEAD → 本轮）

```
totals   registered 371 → 402      produced 22 → 100      consumed 285 → 316
         unconsumed 86 → 86（不变：没有靠改判据刷绿，只是把错的算对、把缺的补上）
         ghost 0 → 0
         新增分类 consumedGap 44 / producedGap 42 / dynamicClaimed 3 / channelOnly 2
routes   produced 1/63 → 63/63（幽灵注册 10 → 0）
skills   0（零覆盖）→ 16/16
i18n     unconsumed 45(HEAD) → 42（3 项为计算键真消费，非放宽判据）
view     31 KB → 17.9 KB（明细截断 80/86，总数完整）
```

### ⑩ 「可视化流动」落地：注册 → 生产 → 消费 流向图

白盒诉求里**唯一还缺的一块**。此前面板只有**静止矩阵**（一堆计数 + 未消费清单），
看得出「有多少缺口」，但看不出**缺口发生在哪一段**——是登记了没生产？还是生产了没人读？
两者补救动作完全不同（补接线 vs 接消费方）。

- 新 `closureFlowGraph.ts`（纯函数 + 纯渲染，无第二真相源）：每族一条流，
  **两种形态由数据自决、不硬编码族名**：
  - `viaProduction`（有真产出锚点）：`registered → produced → consumed`，旁挂 `notProduced` / `producedNotConsumed`
  - `directRead`（无独立写入点，如词表 `t()` 纯查找）：`registered → consumed`，
    **如实跳过生产段**而不是编一个 0 产出节点
- **恒等式钉死**：`notProduced + producedNotConsumed === registered − consumed`（逐族、含真机四族）
  ——流不能凭空造缺口或吞缺口。
- 已消费按**证据强弱**分层同屏：生产代码 / 计算键认领 / 仅通道引用。
- 守卫 `closureFlowGraphContract`（7 例）：恒等式 / 两形态 / **数据驱动**（改簇名节点随变）/ 空输入显式空态 /
  缺口段锚点 / 反向自检 / 真机端到端。渲染腿守卫追加「流向图**真的挂在分区里**」断言。

### 结构（模块纪律 T3：单文件 ≤250 行，本轮新增/拆分均达标）

`closureAudit/`：`closureModel`(85) `closureBuckets`(61) `closureTotalsTypes`(32) `closureSummary`(25)
`closureView`(109) `scanPrimitives`(222) `routeScanPrimitives`(78) `assetClosure`(204)
`i18nClosure`(233) `skillClosure`(248) `localeKeyAnchors`(约 110) `registryClosure`(161，纯编排 + 再导出)。
`client/features/closure/`：`closureTypes`(235) `closureClassify`(85) `closureFlowGraph`(约 220) `renderClosure`(216)。
**消费者 import 路径零变更**（全部经 `registryClosure` 再导出）。

### 守卫与证据

- `closureAuditTruthContract`（24 例）：双向真值钉 / 幽灵为零 / produced 逐项证据 / 分类互斥穷尽 / 投影截断排序。
- `closureAuditMutation`（14 例）：5 处定向变异**每处必须翻转判定**（含 M5 窗口缺陷），并自证只读。
- `closureRenderOutputContract`（8 例）：渲染腿产出（含流向图挂载）。
- `closureFlowGraphContract`（7 例）：流向图恒等式 / 两形态 / 数据驱动 / 空态 / 端到端。
- `closureEvidenceAnchorContract`（7 例）：`definedAt` 行号正确性 + 反向自检。
- `closureAuditContract` 基线同步更新（**同步而非删除**）：i18n 棘轮 **42**（不是 45）、routes **44**。

### 已知遗留（如实登记，不在本轮 write_scope）

- ~~`tests/unit/skillHealthRoute.test.ts` 第 6 例在 HEAD 即失败~~ → **本轮已修**。
  根因是**夹具时间炸弹**（不是实现回归）：`analyzeSkillHealth` 的近期窗口是「最近 N 条
  **且**距 now ≤ 7 天」（`RECENT_MAX_AGE_MS`），原夹具写死 `2026-10-17`；当真实日期走到
  7 天后，窗口变空 ⇒ `recentSuccessRate === undefined` ⇒ 如实判 `insufficient`。
  两态已实测可分（同一夹具改到「1 小时前」立刻判 `degraded`）⇒ 改**夹具**为相对 now，
  **未放宽断言**（期望值本身是对的）。
- ~~`keyAnchor()` 用叶子名全文匹配 ⇒ `definedAt` 行号误报~~ → **本轮已修**。
  实测三例全错（`trace.statusDone` :79→**123**、`state.loading` :24→**60**、
  `gate.pending` :75→**235**）；改为**完整键路径 → 行号**索引（缩进栈还原 JSON 路径），
  302/302 叶子键全覆盖，未定位返回 `:0`（显式「未定位」，不猜行号）。
  另修一处 CRLF 陷阱：`.$` 不吃 `\r`，首版索引在此**零覆盖**（本仓工作区是 CRLF）。
  守卫：`closureEvidenceAnchorContract`（7 例，含「键移位后锚点必须跟随」的反向自检）。
- ~~**T4「可视化流动」（流向图）未落地**~~ → **本轮已交付**（见 ⑩）。首版提交时如实标记未完成；
  随后补做并以 `closureFlowGraphContract`（7 例）+ 渲染腿挂载断言收口。
- **MCP 面在插件内不可达**：15 个 MCP 工具完全依赖使用者手写 `mcpServers` 配置，
  插件侧零接线/零探测。建议下一轮在 `anic_status` / `anic_install` 输出里探测并提示未配置。
- 4/15 脚本**仅白名单可达**（`band-detector` / `fact-base-verify` / `multi-agent-gate` / `plan-sync-check`）：
  `consumed=16/16` 不应读成「16 个都有专线调用方」。
- **循环号与工作区目录号长期不同步**（cycle-42 曾校正过一次，属复发）：`.cycles/cycles/`
  只到 cycle-71，而 git 历史已有 cycle-73/74 产物；`init-cycle` 以 `max(目录号)+1` 计算，
  与 commit 语义不同源。本轮按设计册口径统一用 cycle-75 并清理了空壳 cycle-72，**根因未修**。

## v0.40.0 — 2026-10-22（cycle-41..71；**cycle-71 补录**——此前 CHANGELOG 停在 v0.38.0）

> **补录说明**：v0.39.0/v0.40.0 的版本号在 `package.json` 与 git commit 里早已生效
> （`2ada8b3` v0.39.0 / `3c70baa` v0.40.0），但 **CHANGELOG 未同步**——两代未记录。
> cycle-71 补录，并加**版本锚点守卫**（`tests/contract/versionAnchorContract.test.ts`）防再漂。

### cycle-71 本轮：阻断级 P0 修复 + 用户核心 UI 要求落地 + 三路研究

**① 阻断级 P0：H2 扫描死循环（非全局正则 `exec`）**
- **缺陷**：`classifyDestructiveLine` 对**非全局**正则调 `re.exec(line)` 循环到 `null`。非全局
  `exec` **忽略 `lastIndex`**，每次返回同一首个命中且 `lastIndex` 恒 0——零宽保护
  `if (m.index === re.lastIndex) re.lastIndex++` **永不触发**（`m.index` 是命中下标、`lastIndex` 是 0）→ **死循环**。
- **后果实测（两处）**：① vitest 跑完 121/122 文件后**永不打印汇总、进程不退出**（整条
  `pnpm run test` 挂死 >25min）；② **`checkH2` 同路径——任何含破坏性命令词形的 diff 会挂住宿主进程**。
- **修复**：模块级全局副本 + `String.prototype.matchAll`（按 species 克隆迭代、只读调用者
  `lastIndex`、天然有界，不依赖调用方推进）。
- **补全第二缺陷**：设计定义引用上下文含「**注释内**、文档块」，首版只做引号 → 本体 JSDoc
  说明行仍自触发熔断。补四类（散文行 `#`/`*`、字符串、`//` 注释、行内代码）+ URL scheme 漏报面防线。
- **T3**：`hitlAudit.ts` 290→226 行（扫描域拆出 `governance/destructiveScan.ts`，re-export 保 API 稳定）。
- 契约：`hitlAuditContract` 44 例（含**自免疫钉**：本体源码词形行全部降敏）。

**② 阻断级 P0：mcp-server 命令注入（安全）**
- `assets/skill/scripts/mcp-server.mjs` 旧用 `execSync` **模板串拼接** `projectDir` →
  路径含空格/引号/`&&`/`;` 即成命令注入。**独立复核确认真实可利用**（旧模板串在恶意路径下写出哨兵文件）。
- 修复：`spawnSync` **argv 形态** + `resolveProjectDir` 形状校验（NUL/显式空值响亮拒绝；
  顺带修掉「显式传空静默回落 cwd」的静默降级）+ 7 例回归含**反向自检**。

**③ P0：自举「缺前置被折叠成 0 分」（L4 收敛不可能的结构根因）**
- 两轮 `lastEvalScore:0`/`gateVerdict:FAIL`、`CONVERGED` 恒假的根因**不是解析器坏了**，
  而是 `eval-runner` 缺 `.cycles/config.yml` 时硬 `exit(1)`，插件记为 `evalScore 0`
  → 自举**无法区分「缺前置」与「真失败」**。
- 修复：`bootstrapPreflight.ts` 专用前置码 + 编排器拦截 + 网关 + **HTTP 412**；空工作区
  **不再产出误导性 0 分提案**（`rounds.length=0`，`tech-debt/` 不创建）。
- 伴生 **P0 取证面缺位**：`/anic/self/*` 三端点零 FlowTracker（状态文件有失败、流里零条）
  → `selfBootstrapFlow.ts` 唯一实现接入；**真机复核新增 flow-tracker 记录**。
- `scriptParsers` 三态（passed/failed/not-run+reason，薄包装零破坏，**fail-closed 不变**）；
  异步 rounds 补 `fixFlowId`/`verifyFlowId`（四 ID 互异断言）。

**④ P0：用户核心 UI 要求（真机 3080 验证）**
- **默认只展开最近一次已完成调用** → 10 分区 `defaultOpen` 收口为 **8 闭 / 2 开**
  （仅 `diagnostics`/`hitl` 为兜底观测面）；新增 `data-anic-fold-state` 锚点。
- **最近一次已完成调用全貌卡**（七段；⑤归属/⑥证据按 INV-27 **刻意留空**、⑦门禁裁决带
  `heuristic` 标注）；`role=region` **不含 `aria-live`**（APG：自动更新内容禁 live region）。
- **折叠记忆**（`foldPrefs`，`PREFS_KEY` 加 `folds` 段**不升 version**）——原 `open:true` 是
  「初值当受控值」；改受控后**内存先行 + storage best-effort**（隐私模式下只信 localStorage
  会让受控值反向）——**真机等 2 轮 4s tick 验证折叠不弹回**。
- 量化补全：P50/P95/max + 错误码直方图（新 `invocationQuant.ts`）+ skillHealth `lastInvoked`
  + techDebt `proposedAction`/年龄。

**⑤ DSH 规范文档校正（asar 一手取证）**
- **宿主基线错证**：本机实测 **0.2.1-rc.2**（`runtime/primary-runtime/runtime.json` 的
  `desktopVersion` + asar `dsh/package.json` 双证），非文档长期所写的 0.2.0-rc.2
  （该版本**从未安装**）→ 「0.2.0 系列已验证」改读作「**声明下限** + 0.2.1-rc.2 实测取证」。
- **B9 叙述作废**：0.2.1-rc.2 起 **`engines.dsh` 优先且单独决定**（asar `app-boot:281-285`
  逐字注释），无 engines 才回退 peer——双声明同范围成为正确姿势。
- **桌面端架构纠正（KB 漂移）**：非 `file://`+IPC，实为 **`dsh-app://` privileged scheme +
  `protocol.handle` 同源反向代理**（Origin 白名单 `dsh-app://app`，`main.js:8271`）
  → `/anic/*` 桌面端**完全可达**；引出「客户端必须相对路径 fetch」硬约束。
- 新增 **B12-B18** 破坏性变更类 + dsh-ops/dsh-plugin-dev-kb 吸收裁决（5 吸收 / 5 不吸收）。
- **新增 2 契约守卫**：`dshConformance` 双锚（engines.dsh ⇄ peer 逐字相等 + `-0` 上界 +
  无 `workspace:` + engines 必须对象）+ `clientSameOriginContract`（客户端零绝对 http(s) URL）。

**⑥ 文档册补齐（docs/agents 17 → 19 册，+2）**
- **《工具面参考.md》**（新建）：19 工具**零覆盖**的结构性缺口 + **册⇄源码双向契约**
  （`toolIdsContract` 10→14 用例：文档臆造/文档缺口都红）。
- **《自举与健康取证.md》**（新建）：三工件分工 / 解析器二值语义 / **谁进 flow-tracker 谁不进** /
  技能健康时间窗根因（cycle-57「修复从未被健康面承认」）/ **「能力就位 ≠ 真机收敛」** / 排障手册。
- **《API参考-自举与技能.md》纠错**：解析器描述旧写「正则形状契约」**与实现互斥**
  （实为按脚本真实输出行判定，evalScore 是**忠实二值**）→ 按真实契约重写。
- `.cycles/cycles/cycle-71/research/三路研究汇总裁决.md`：三路研究（asar / context7 / 生态实读）并入 + 证据边界声明。

**⑦ 工程与测试**
- **测试宿主解析显式化**：`findDshCmd` 原两个硬编码候选**均不存在**（两套 profile 的
  `@deepseek-ai/*` 是 **244 个 dangling symlink**）→ 显式解析序
  （`DSH_TEST_CLI` → 桌面 app CLI → PATH 兜底）+ **打印宿主版本**（消除「版本不可知」）。
- **测试塔**：vitest **128 文件 / 1627 用例**（本轮 +7 文件 +112 用例）；全量金字塔 ALL GREEN（30.3s）。
- **真机验证**（Chrome DevTools MCP）：折叠 8/2 实测 · 跨 2 轮 tick 稳定 · HITL 4/4 PASS ·
  API 5 端点 200 · ANIC 标签挂载 245 节点/378 边 · 控制台本插件零错误。
- **门禁**：G0-G3 全过（账本 hash `d65909c7` / `b7139da6`）。

**诚实边界**：**未宣称自举已收敛**（本轮修的是「收敛不可能」的根因，真实 `CONVERGED` 尚需
完整全绿一轮）；**白盒四元组未完整**（「流程流向/运行产物」两元仍缺——调用与 cycle/phase/门禁
**零 join key**）；**j0-probe 未跑**（`@playwright/test` 工具链不可达）改用 Chrome DevTools MCP
等价验证；E5 性能基线/覆盖率**未采样**（SKIP 如实标注）。

> v0.40.0 系列横跨 cycle-41..71（31 轮提交）。cycle-41 起的主线：invocations 默认展开语义 +
  聚合播报 + 九分区折叠壳 + 概览量化（cycle-41）；live 域时序三轮深化（cycle-60/63/64）；
  面板分区装配契约 + G-DOC-API / API 数据面形状三腿契约（cycle-66/67/69）；H2 词边界修复
  （cycle-68，挂账 20 轮终点）；场地复核点按期执行（cycle-70/65）；守卫族命名收口（cycle-58）；
  时间窗健康三件套（cycle-57）；测试体系审计（cycle-59）；响应式断点表契约（cycle-61）；
  E5 性能基线工件通道（cycle-62）。

## v0.39.0 — 2026-10-21（cycle-40；**cycle-71 补录**）

研究驱动深挖轮——迁移合法性矩阵 **5/5 收口**（`validateRecordShape` 记录类型白名单 +
`cycleRunner.advanceCycle` 哈希链 fail-closed 校验）+ E3/E8 根因归档修正（execSync ENOBUFS、
技能 v2.4.0 三态判定）+ 文档审计 P0×2/P1×8/P2×5/P3×6 全修（G-IND 颠倒 / inject 四元 /
62 端点闭合 / flows 域补录）+ KB 吸收 `toolsSlot`（`timeoutMs` / `isConcurrencySafe`）+
UI 研究 Top1/Top3（`usePanelFetch` 退避 + abort + 稳定 key）+ iterate 超时参数化 + Post-Verify 环 +
场地 journey 红→绿 + DiffPanel a11y + G0-G3 全过。技能 **v2.3.0→v2.4.0**。

## v0.38.0 — 2026-10-20

cycle-39：**研究驱动优化轮（1×P0 + 6×P1 修复 + journey 门禁落地 + 场地 3 实验）**——P0-DAG-PARSE 根除（stateMachine 解析器三形状实证失明）+ quick-validate 网关相对路径自动解析（flow #29）+ journey_coverage 门禁双侧实现（场地首跑抓 3 处真漂移）+ W-3 全档测试报告投影 + 19/19 presentCall 完备 + TerminalCallView 官方字段名 + skillRoute 行为测试 + 文档数字契约。技能 v2.2.0→**v2.3.0**。vitest 106→**109 文件 1294→1325 用例**。

### ① P0-DAG-PARSE：stateMachine 真实图形状解析（多年空转根除）
- **缺陷**：parseWorkflowGraph 只认纯文本边（`- from: X to: Y`）+ 大写 `Gate`——本仓 `.cycles/workflow-graph.yaml`、技能模板、测试场地**三处真实图**全是流式边（`- { from: X, to: Y, type: "..." }`）+ 小写 gate → 解析出 **0 边 0 Gate 节点**：advance 前驱检查恒过、gate 批准检查恒不触发，cycle 状态机（advance/close/checkStrict + 账本联动）全链空转——只有合成测试夹具「工作」。
- **修复**：边双形态（流式 + 旧文本兼容）+ type 大小写归一（gate/human-gate/phase/micro-step/trigger/play）+ 迁移合法性矩阵 3/5 条（doc06 §3.x / doc18 #8：#1 门匹配 record.gate===node.gate 不符拒绝 / #3 done 不可重复推进 / #4 前驱边——既有语义回归钉）；human-gate 节点同样受门约束（修复前只查大写 Gate）。
- **契约**：tests/contract/stateMachineGraphShape.test.ts 12 用例（真实图 15 边 4 门 5 human-gate/模板同形状/边 type 透传/旧形态兼容/矩阵逐条）。

### ② quick-validate 网关相对路径自动解析（flow #29 实证）
- 工具描述与 SKILL.md 教的 `args: ["assets/skill"]` 相对形态在 spawn cwd=scriptsDir 下解析成 `<scripts>/assets/skill` 幽灵路径必 404。修复：`resolveQuickValidateSkillDir`（skillInvoker.ts 纯函数）把相对 skill-dir 映射为目标工作区已装技能根的绝对路径（"assets/skill"→根 / "assets/skill/scripts"→根/scripts；未装回退内联根）。技能 v2.3.0 三锚点（SKILL.md MCP Tools/mcp-server/CHANGELOG）。

### ③ journey_coverage 门禁双侧实现（装饰性声明→真门禁）
- gate-check.mjs `checkJourneyCoverage` + `getYamlNestedBoolean`（技能侧）+ gateArtifacts.ts 同构移植 + gateEngine checkG2 接线（原生侧）——config journeys 声明的 test_files 必须存在且非空，否则 G2 FAIL；差分契约 flowDifferential +2 用例钉死双侧 detail 全等。
- chaos_coverage 声明删除（journeys 协议无 chaos 旅程定义——装饰性门禁声明是负债）。
- **实战验证**：dsh-codegraph-visualizer 场地首跑即抓 3 处旅程-测试映射漂移（J2/J12 引用不存在的 tests/e2e/large-repo.spec.ts、J9 引用已删除的 tests/unit/services.test.ts）——此前恒假绿。

### ④ W-3 全档：测试报告行投影进节点详情
- snapshotCore 提取最新 cycle test-report 的 §2 汇总（通过/失败/错误计数）+ 分层结果行（validate/vitest/smoke/trigger/typecheck/build）→ G2 事件节点携带 testReport；renderNodeDetail 渲染测试报告分区（失败/错误计数 >0 时红显 anic-fail 语义色，走设计令牌）。

### ⑤ 透明性与契约收角
- **19/19 工具 presentCall/presentResult 完备**（anic_gate_check/anic_bootstrap/anic_snapshot/anic_self_check/anic_hitl/anic_status 补齐；anic_status 拆分 toolsStatusGateway.ts 维持 T3）——调用时轨迹卡片无缺口。
- **TerminalCallView 字段名对齐官方**（summary→description，presentation.d.ts:85 契约——DSH 规范审计 P1）。
- 指针工具与 anic_status 返回 desktopNote（桌面端 dsh-app:// IPC 桥接语义标注——asa 实证 main.js forwardWebRequest）。
- skillRoute 4 路由行为测试补齐（全仓唯一零行为测试路由文件；6 用例含 bootstrapSync ok/failed 双形态）。

### ⑥ 文档数字契约 + 漂移修复（三路研究产出）
- README：19 工具清单（补 anic_skill_repair）/62 路由/cycle-39 形态节；readmeNumbers.test.ts 4 用例钉死（README 数字 == glob 计数——「以 README 为准」的指针链从此有守卫）。
- docs/anic 8 文件：README v1.15（补 20 号入地图）/03（inject 数组 +peerDeps 声明更新）/06（子 fiber 裁决指针注记）/07（engines.dsh 0.2.1 硬门语义 + 宿主基线 0.2.1-rc.2）/11（RingBuffer deferred 标注）/13（agents 扩展名 .json）/14（--project-dir 反模式示例修正）/15/16/17（时点声明制度）。
- 元数据：smoke 21 断言实数（头注释/run-tests）/doc10 evals 13 时点注。

### ⑦ 清理
- assets/skill/evals/trigger-eval.json 删除（cycle-16 的 20 条旧格式零消费方双真相源；manifest 65→64）。
- 测试体系审计处置：skillRoute 行为测试（P1#1）✅ / journey_coverage（P1#2）✅ / trigger-eval 清理（P2#3）✅ / J2 reverse 面板降级离线测试（P2#4→cycle-40）/ 元数据五处（P3#5）✅。

### ⑧ DSH 规范 asar 实证发现（文档同步）
- **engines.dsh 已是硬门**（0.2.1-rc.2 dsh-app-boot:279-298「own range decides alone, peerDependencies ignored」）——doc07/DSH多代兼容 的「纯声明」记载更新。
- **桌面端 dsh-app:// 自定义 scheme + IPC 转发**（非 file://，pathname 完整透传）——anic 路由桌面可达有机制保证；隐性依赖：桥删除 origin 头（CORS 前瞻放行建议登记）。
- 宿主实际 0.2.1-rc.2 + cordis 4.0.5（文档基线滞后一代，已标注）。
- 可吸收新能力登记 cycle-40：tools.guard()（熔断升宿主级）/isConcurrencySafe（只读工具并行）/timeoutMs（声明式超时）/defineTool 迁移评估。

### ⑨ 场地实验（doc20 §4）
- #2 cycle-103 收口 ✅（git commit 11 files + advance）/ #1 跨项目评估 ✅（E1-E8 逐维，抓到 E3/E8 vitest 弃用告警污染判定新缺陷）/ #3 差分门禁 ✅（双源 G0-G3 逐门全等）/ #4 auto-fix 推迟 cycle-40 / #5 CO-4 用户动作。

### 验证
- typecheck 0/0 · vitest **109 文件 1325 用例**全绿（基线 106/1294）· smoke 21/21 · validate 12/12 · trigger recall 100%/FPR 0% · build OK · J0 8/8 · 账本 113 条链完整 · G0-G3 --record 全 PASS（G2 首带 journey coverage verified）

## v0.37.0 — 2026-10-19

cycle-38：**研究驱动优化迭代轮（承 37 裁决 + 19 号文档生态吸收收口）**——doc19 §5 四项第三方吸收落地收口（factBaseAnchors 三态/表驱动自举/toolIds 幽灵校验/reviewLedger 时效性）+ 本轮五项能力迭代（V-1 ETag 条件请求/re-gate 复检环/跨项目调用人体工学/技能 v2.2.0/测试场地实验）+ W-3 白盒「为什么」层最小版。vitest 106 文件 **1278→1300+ 用例**。

### ① doc19 §5 生态吸收四项（上轮遗留工作树收口，均有测试钉）
- **factBaseVerify 三态重写**（`verified`/`missing`/`unscannable`——「核不了」不是「缺失」）+ 新建 factBaseAnchors.ts；riskScore 分母改 verified+missing（72% unscannable 噪声出清）。
- **自举状态机表驱动**：BOOTSTRAP_TRANSITIONS 9 条迁移表是 status 唯一权威（dsh-per 纪律）；中间态四相位真实落盘；15 张角色卡 toolsAllowlist 存在性校验（toolIds.ts 单一清单，幽灵 id 被拒）。
- **reviewLedger 结论时效性**：结论绑定 evidenceDigest（sha256 前 16 位内容指纹），响应新增 review.freshness/previous——「证据换了结论就 stale」。
- 三处一致性修复：fixLoop 原子写/bootstrapEngineIntegration 分母/reviewRoute ReviewAttribution 消费。

### ② V-1 ETag 条件请求（doc18 §3 #5 收口）
- 服务端：快照端点语义 ETag（**排除 generatedAt**——覆盖它则永 200）+ If-None-Match 命中 304 空体；数据真变指纹变（账本追加用例钉死）。
- 客户端（TanStack Query 轮询纪律吸收，context7 检索）：usePanelFetch 学 ETag 回带 If-None-Match；**304=数据未变不重放 apply**（结构性共享语义）；document 隐藏暂停轮询（refetchIntervalInBackground=false 缺省语义）。
- 测试：snapshotRoute 6 用例 + usePanelFetch 5 用例（jsdom act 驱动）。

### ③ 自举 re-gate 复检环（doc18 P1-6 深度收口）
- 审计发现「中间态已落盘但 re-gate 是空壳」——fix-done 后用修复前裁决结算=伪造复检。
- 修复：VERIFYING 相位真实重跑 gate-check（FlowTracker 留痕 verify-round）；复检 PASS 以新裁决结算，未过 fire verify-fail 回 GATE_CHECKING。步骤执行器拆分 bootstrapSteps.ts（T3 279→191 行）。

### ④ 跨项目调用人体工学（T-3805，真机 6 连失败实证收口）
- anic_skill 网关：args 首位合法项目绝对路径（非 quick-validate skill-dir 形态）→ 自动移作 workspace 并回显 workspaceRedirected；非法路径不吞（让脚本守卫报精确错误）。
- 技能 v2.1.0→**v2.2.0**：SKILL.md 新增「跨项目调用契约」节（三通道对照表）+ auto-cycle.md 复检语义节 + CHANGELOG；三锚点一致（quick-validate PASSED）。
- 本仓与测试场地副本同步修复（repair 差异重装，integrity 65/65 全绿）。

### ⑤ 测试场地实验（dsh-codegraph-visualizer，doc20 新建）
- 实验 A：anic_install 场地升级 v1.9.0→v2.2.0 真实工作区验证通过（upgraded:true + integrity 全绿）。
- 实验 B/C：跨项目 workflow-state status + gate-check --record + advance——**场地 cycle-103 收口**（四门全过，Test→Deploy）。
- CHAIN_BREAK 裁决：保留为 known-bad 检测夹具（H4/verify 需要真实断裂样本）。

### ⑥ W-3 白盒「为什么」层（最小版）
- snapshotCore 提取账本 detail → gate-event 节点携带 → 点击节点详情抽屉渲染「这一门为什么 PASS/FAIL」。

### ⑦ 文档体系
- docs/agents：API参考-数据面（ETag/304/W-3）、API参考-评审进化与治理（§1a 治理底座三模块）、API参考-自举与技能（跨项目重定向）、可观测性（§4a 数据面演进）、README 地图 +6 行。
- 新建 docs/agents/UI功能域与界面组件规划.md（14 分区矩阵 + 数据面演进 + 缺口排期）。
- docs/anic/18 处置表扩 cycle-38 列（#5/#7 已修复、#8 部分、新增 #15-17）；新建 docs/anic/20 测试场地实验报告。
- .cycles/config.yml 旅程扩 J2-J4（面板观测/跨项目调用/技能生命周期）。

## v0.36.0 — 2026-10-19

cycle-37：**研究驱动优化迭代轮**——三路深度研究（DSH 官方规范审计 / 生态技能对照 / docs-anic 文档审计）汇拢后落地：L4 自主性原生化架构决策（不全面原生化）、SKILL.md 目录描述 P1 修复、生态吸收三件、双端用户旅程真机验证（含宿主轨迹 26 个 anic_* 持久事件确证）。vitest 103→**104 文件 / 1236→1240 用例**。

### ① L4 自主性原生化核心裁决（docs/anic/18 号新建）
- **不全面原生化**：插件原生引擎（flows 状态机+模块引擎）与技能脚本正典双实现 + 差分契约防漂移（gate-check script/native/diff 三模式）是差异化资产；L4 瓶颈在任务级编排/能力对照测量/触发可靠性三缺位层而非流程原生化。
- 含 P0-P3 十四项缺口处置、六自记分卡（自评审 85%/自进化 65%/自举 90%/自迭代 75%/自优化 55%/全自主 75%）、增量路线图、negative space、每 5 cycle 复核纪律。

### ② DSH 规范审计结论（kb 镜像 commit 5badb150）
- 安装宿主 0.2.1-rc.2 在 engines 区间内；0.2.0-rc.2 五条破坏性变更全部天然不受影响（逐条证据核对）；**kb 无 0.3.x 升级指南——证据空白区**，0.3 发布时须重跑 j0+validate 回归。
- 四 inject 服务用法全部合规；**P1 发现：SKILL.md description 折叠后 789 > catalogDescriptionMaxLength 500（skills.md:233）**——触发词在尾部必被模型目录截断。
- 轨迹可见性闭环确证：anic_* 工具调用自动产生 tool/call+tool/result 持久会话事件；invocationFeed 接线与 events.md:107-109 逐字吻合。
- 桌面端 file://+IPC 架构风险记入 18 号文档风险登记（当前实测走 http 可达）。

### ③ P1 修复 + 契约守卫（+4 用例）
- SKILL.md 目录描述重写：789→**455 字符**，「Triggers:」触发词块前置（截断只损失尾部溢出语）。
- 新建 tests/contract/skillCatalogDescription.test.ts 4 用例：≤500 守卫/Triggers 前置/双语完整/whenToUse 完整。
- trigger-eval.mjs 头注释改口：评分面不含 SKILL.md（目录可见性守卫移交契约测试，各管一面）。

### ④ 生态吸收三件（anthropics/skills + skill-creator + superpowers 对照筛选）
- SKILL.md 新增「会话恢复协议」节（快速启动前：读 workflow-state.json → cycle 工件 → 只读当前阶段 reference）。
- references/auto-cycle.md 新增「任务级派遣编排」节（任务单元契约表+派遣协议四步+与微观循环关系）。
- assets/templates/task-list.md 新增 §8 任务级派遣记录表（G1 解析器 parseTaskRows 兼容——占位行首列含文字、末列非状态值不计入）。
- 不吸收清单及理由沉淀 18 号文档 negative space 节（ECC 巨型聚合/激进 TDD/SessionStart 注入等）。

### ⑤ 文档体系
- docs/anic/agents/orchestration.md 新建（补 doc13 §1.3 缺口：15 agent 卡三配方 A/B/C）。
- doc15 §3.1 逐脚本表刷新（v0.36.0 现状全 ✅）+ §3.2 历史记录。
- docs/anic/README v1.13→v1.14；仓根 README 数字全量校准（37 路由/104 文件/21 smoke/169 节点）。

### ⑥ 双端用户旅程验证（真机）
- **Web 端**（3080 测试宿主 + Chrome DevTools MCP）：j0 8 checks PASS；ANIC 标签与对话/轨迹/代码图谱共存；179 节点/228 边实时渲染；INV P1-P6 全 PASS；节点详情抽屉交互闭环（开→内容→关）；路由面 200+digest+no-store。截图+a11y 快照存档 verifications/。
- **桌面端**（65518 真实宿主）：插件 active；三路由 200；**宿主轨迹 26 个 anic_* tool/call 持久事件**（16/17 日两会话，多帧 zstd 逐帧解压取证，脚本存档 verifications/search-session-trace.mjs）——「LLM 调用插件工具出现在宿主轨迹」真机确证。

### ⑦ 验证
- typecheck host+client 双 exit=0；build exit=0（host-esm 368.33 kB）；npm pack dry-run 75 files/330.1 kB。
- 四层 ALL GREEN：validate @0.36.0 + vitest **104 文件 1240 用例** + smoke 21 check + trigger-eval 100%（24/24）/0%（0/14）。

## v0.35.0 — 2026-10-18

cycle-36：**零直测文件第三轮收口**——8 个遗留零直测文件审计后，真实缺口 5 文件行为级直测 26 用例（tests/unit/zeroCoverageFiles.test.ts）。vitest 102→103 文件 / 1210→1236 用例。src/ 零变更（纯测试轮）。

### ① 摸底结论（T-3601，审计修正遗留清单）
- skillInvokerAsync 已由 invokeSkillAsync.test.ts 覆盖（cycle-30）——遗留清单该项有误，撤。
- gateTypes 是纯类型文件——不可测，撤。
- truthAuditChecks 正路径已由 truthAudit.test.ts 覆盖（真插件目录）——本文件补负路径夹具。
- 真实缺口 5 文件：graphDataTable / workflowGraphData / gateCheckRunners / truthAuditChecks（负路径）/ flowsRoute / selfBootstrapRoute（合计 6 测试面，26 用例）。

### ② 新测试 tests/unit/zeroCoverageFiles.test.ts（26 用例）
- **graphDataTable（4）**：WCAG 1.1.1 等价数据表——anic-sr-only 视觉隐藏/table+caption+thead 原生语义/每节点一行四单元格（REJECT→fail 归一）/verdicts Map 覆盖优先于快照 result/与真实 WORKFLOW_SNAPSHOT 同源渲染 169 行。
- **workflowGraphData（2）**：嵌入快照契约——GENERATED 头注释+重新生成命令/counts 与数组长度自洽。
- **gateCheckRunners（5）**：CONVERGENCE_GATE_NAMES 与技能 GATE_NAMES 同表四门/门禁行+质量行解析+无总裁决行时逐门禁统计兜底/stderr config 缺失→fatal=CONFIG_MISSING/**ANIC_SKILL_DIR env 覆盖优先级**（候选 0 胜过工作区本地副本——首版「技能目录缺失」用例不可达的替代验证）/native 入账去重（同 result+detail 跳过+判决翻转入账+loadLedger 读回形状）。
- **truthAuditChecks 负路径（3）**：T1 空目录全 MISSING+score<100/T3 超 251 行文件 fail+modular compliance fail/T4 无注册路由 warn+routeContext.ts 白名单豁免。
- **flowsRoute（7）**：9 路由注册+disposer 回收/GET flows 5 描述子投影/status 无工作区 neverRun=5 不伪造/state bogus 404+合法 200/POST gate-check 无 ws 500+非法 gate 400/macro-phase 非法 target 400 带 validPhases+dryRun+script 400/hitl 非法 gate 400+auto-fix 无 ws 500。
- **selfBootstrapRoute（5）**：4 路由注册/status IDLE 初始态/evaluate 假脚本全绿 score=1+状态推进 EVALUATING/gate-check PASSED+GATE_CHECKING/iterate FAIL 路径写 tech-debt 提案（R-31 REVIEW_REQUIRED 不自改代码）。

### ③ 测试基建发现（重要，沉淀进文件头注释）
- **resolveSkillScriptsDir 回落链含 process.cwd() 候选**：本仓库装有 .dsh/skills（cycle-31 实弹安装），「技能目录缺失」路径在 cwd 环境下不可达——改为验证 ANIC_SKILL_DIR env 覆盖优先级（候选 0）。
- **selfBootstrapRoute 走 resolveWorkspaceRoots**：不钉 workspaceRegistry 时回落到真实 dsh-anic 工作区，会跑 60s 真实 eval-runner（首版实测 60s 超时的根因）——必须用 makeCtxWithWs 钉住临时工作区。
- **flowsRoute 的 listFlows 是模块级单例注册表**：不调 registerBuiltinFlows() 时 GET /anic/flows 返回 0 流程——测试须先注册（首个胜出语义，重复调用安全）。
- `'x\n'.repeat(251)` split 出 252 行（尾换行计空行）——精确 251 行要 `'x\n'.repeat(250)+'x'`。

### ④ 验证
- typecheck host+client 双 exit=0；build exit=0；lint 12 checks PASS。
- 四层 ALL GREEN：validate 12/12 @0.35.0 + vitest 103 文件 1236 用例 + smoke 21 check + trigger-eval 100%（24/24）/0%（0/14）。

## v0.34.0 — 2026-10-18

cycle-35：**触发评估语料扩容轮**——trigger-eval 数据集 20 → 38 条（19 pos 全工具覆盖 + 19 neg），契约钉 13 用例；顺带修两处 SDO 触发词盲区。评分面从「15 例抽检」升级为「24 正例 + 14 负例全工具矩阵」，recall 100% / FPR 0%。

### ① 数据集扩容（tests/fixtures/trigger-eval-dataset.json，20 → 38 条）
- **pos-\* 10 → 19**：每个 anic_\* 工具恰 1 条正例（新增 pos-11..19 覆盖 bootstrap/bootstrap_analyze/flows_gate_check/snapshot/skill/autonomy_downgrade/self_check/hitl/skill_repair）。
- **neg-\* 10 → 19**：5 条区分度对（shouldTriggerOtherTool）保持 + 14 条纯负例（shouldTriggerNone，新增 9 条词面相撞检验：团队周报 vs 项目状态/DB 存档 vs 归档循环/装机器环境 vs 安装技能/分支清理 vs 修复清理/backlog 规划 vs 迭代/清盘 vs 治理预算/算法复杂度分析 vs 评估等）。
- 评分口径沉淀进 `_meta.usage`：pos-\* 与 neg-\*(otherTool) 按正例计分（24），neg-\*(none) 命中任何工具即误触（14）。split 20 train / 18 test。
- 措辞微调 4 条新增负例去字面直撞（「评估一下」→「分析一下」等），rationale 记录原因——负例挑战语义而非字面。

### ② SDO 触发词两处增修（src/host/）
- `toolsSkillGateway.ts` anic_skill_repair Triggers + 「技能副本」（区分度：pos-19「装好的技能副本…对不上」原先与 anic_status 平分，靠注册序侥幸取胜）。
- `toolsEvolutionGateway.ts` anic_autonomy_downgrade Triggers + 「回退一档」（区分度：pos-16「从 L4 回退一档」原先被 anic_status 的「自主级」压制）。
- 修复纪律沿用 cycle-29：只动 Triggers: 段，Use when 语义段零变更。

### ③ 契约钉（tests/unit/triggerEvalContract.test.ts，13 用例）
- 结构不变量 5：38 条构成（19/5/14）/ 19 工具全覆盖对账 / split 20-18 / id 唯一 / cycle-16 原始条目与 cycle-29 修复措辞在位。
- 区分度对 5：四对词面相撞（含平分由稳定排序按注册序胜出的语义钉）+ 周报负例全工具零命中。
- Triggers 增补钉 2 + 全量离线重放 1（与 trigger-eval.mjs 同判定 24/24 + 0/14）。

### ④ 验证
- 四层全绿：validate 12/12 + vitest 102 文件 1210 用例（+1 文件 +13 用例）+ smoke 21 check + trigger-eval recall 100%（24/24）/ FPR 0%（0/14）。
- 触发词属 description 文本变更，无行为变更——工具执行路径零改动。

## v0.33.0 — 2026-10-18

cycle-34：**工具网关域直测**——27 零直测审计残留的 gateway/路由层收口，+37 用例（vitest 98→101 文件 / 1160→1197 用例）。零源码变更（纯测试增量轮；src/ 无 diff）。

### ① 指针/进化/自举网关（tests/unit/toolsGatewayDomain.test.ts，11 用例）
- `registerPointerTools`：三工具注册/disposer 计数；`anic_snapshot` workspace 编码进 URL + 缺省回退 getRoot() + validateWorkspace 拦截（不存在/路径穿越）；`anic_self_check`/`anic_hitl` 纯指针不校验的行为契约（错误工作区也返回 URL）。
- `registerEvolutionTools`：无 workspace/空工作区 refused（证据围栏零写入）+ configPath 回显 + presentCall edit 卡 + presentResult 官方/宽容双形状归一化。
- `registerBootstrapGatewayTools`：错误路径（no workspace/path traversal）+ presentCall/presentResult 接线。
- `registerAnicTools` 聚合契约：19 工具恰好一次注册 + 名字清单与市场草稿一致 + dispose 逐个调用各一次。

### ② flows/hitl/auto-fix 网关（tests/unit/toolsGatewayFlows.test.ts，16 用例）
- `anic_flows_gate_check`：gate 白名单外值拒绝 + validateWorkspace 先拦 + presentCall 缺省（gate=all/mode=script）+ presentResult 双形状。
- `anic_flows_advance`：非法 target 列出六相 + dryRun 只允许 native。
- `anic_flows_archive`：list 只读缺省（IDLE 不推状态机/inventory 双空数组）+ cycle/keep 类型守卫 + presentCall 三动作显示。
- `anic_flows_hitl`：gate H1-H4 白名单 + 空工作区 native 审计完整判定形状 + circuit→autonomy-fallback 提示行。
- `anic_flows_auto_fix`：无 config 前置错误（IDLE 零状态推进/error 响亮/exitCode 1）+ maxRetries 非整数回退缺省 + presentResult pattern 附加。

### ③ 技能生命周期对 + review 路由（tests/unit/skillLifecycleRoute.test.ts，10 用例）
- `anic_install`/`anic_skill_repair`（eco P0 生命周期对）：前置拒绝三态；全新工作区安装 integrity 全绿（inline 直比 65 文件）；篡改两文件后 repair/install 恢复链路贯通；presentCall 双 edit 卡。
- `reviewRoute`（唯一 register(method,path) 第二注册形态）：恰好一条 POST /anic/review；非 JSON→400 INVALID_JSON；缺字段→400 INVALID_REQUEST；卡不存在→404 AGENT_NOT_FOUND（cardId 回显）；probeCtx=null→Tier-1-heuristic 降级裁决 + providers 诊断字段 + X-ANIC-Review-Tier 头。

### 测试
- vitest 101 文件 1197 用例（+37），四层 ALL GREEN（validate 12/12 @0.33.0 + smoke + trigger 100%/0%）。
- typecheck host+client 双 exit=0；build exit=0；lint 12 checks PASS。

## v0.32.0 — 2026-10-18

cycle-33：**测试体系深挖第二轮**——27 个零直测源文件审计后补齐客户端数据层原语 + host JSON 提取器，+71 用例（vitest 93→98 文件 / 1089→1160 用例）。

### ① 渲染原语直测（tests/unit/clientPrimitives.test.ts，33 用例）
- `toneColor` 16 键 ToneName 封闭集合逐一断言（含 `var(--token, fallback)` 同源引用形态）。
- `DataRow`/`StatusDot`/脉冲三常量逐字契约（`@keyframes anic-fail-pulse`/`anic-live-dot`/`prefers-reduced-motion` 逃逸/`animation:none`）。
- `sectionIds` 实例序号递增（aria-controls 不静默错位）+ `sectionShell` 分区壳三分支 + 关闭形态。
- `governanceTargets`/`panelLiveTargets` 两 target 工厂：URL 接线（分页 limit 透传）/guard 语义/apply 遥测同步（`window.__ANIC_TAB_SPIKE__`）/onFail 三分类降级文案/onResponse 学头（encodeURIComponent 解码）。

### ② usePanelFetch 钩子生命周期（tests/unit/usePanelFetch.test.ts，9 用例，jsdom）
- 三分类降级：http(503)/malformed(guard 不过)/network(fetch reject 与 json() 抛错同面)。
- 取消语义：unmount 后迟到响应不 apply；暂停语义：pollMs<=0 只首拍；无 fetch 环境（smoke 沙盒形态）一次都不拉。
- 成功恢复 onRecover；getHeaders 引用安全；onResponse 原始响应通道。

### ③ host jsonExtract 三级提取链（tests/unit/jsonExtract.test.ts，13 用例）
- 钉住提取器边界：围栏内容非 JSON → 降级平衡扫描（不是直接 null）；首个平衡候选解析失败 → null（fail-fast 不贪第二个对象）；字符串字面量内花括号/转义引号/转义反斜杠不扰动深度；数组根整串可过但散文包裹不可提（扫描只找对象根）；截尾/无花括号/空串 → null。
- reviewEngine.test.ts 的四用例间接覆盖升级为提取器自身的完整边界规格。

### ④ fetchJson 数据面守卫 + useSelfInit 状态机（16 用例，jsdom）
- `fetchJsonGuarded` 三路收敛 null（非 2xx 不做 json 解析）；`isObjectLike` 宽松守卫语义注记（数组也过——与旧直接 cast 语义一致）；`isFlowStatus` 硬契约；`syncTelemetryCounts` 渲染=遥测同步跳。
- `useSelfInit` 四态反馈：409+`ANIC_ROUTE_SELF_INIT_ALREADY` 是「已初始化」成功语义（refuse-to-rerun 对按钮视角是目标已达成）；running 期间重入防抖。

### ⑤ 文档
- 测试指南.md L2 计数校准（98 文件/1160 用例实跑口径；unit 85/1024+contract 13/90 静态口径）+ cycle-33 覆盖域注记。

## v0.31.1 — 2026-10-18

cycle-32：**桌面端验证策略系统化轮**——P2 桌面端验证以「API 面 14/14 + token 边界穷尽」收口，桌面 webview UI 目验转用户动作项。

### ① 桌面宿主 API 面全分区验证（14/14 全 200）
- 面板消费的全部 14 端点（workflow-snapshot/step-trace/self-check/org-status/flows-status/cycle-list/cycle-state/hitl-audit/api/ledger×2/invocations/live/skill-health/skill-status/governance-budget）在桌面宿主 57200 带 `X-ANIC-Workspace` 头逐一验证通过（v0.30.0 host）。

### ② token 边界穷尽（UI 目验转用户动作项）
- GUI 面一切路径 401：token 只在宿主启动时打印给用户。穷尽通道：profiles 目录/`~/.dsh/logs`/Electron userData（logs/leveldb/Session Storage/Cookies/webview partitions）/Authorization 头三形态/浏览器进程命令行/8326 端口（LLM gateway 非 GUI）——全部不可得。
- 结论：桌面 webview UI 目验只能用户人手完成；agent 等价验证 = API 面（数据层）+ 测试宿主 UI（渲染层，同一 client bundle）。

### ③ 宿主生命周期时序发现（「侥幸正确」案例）
- 桌面宿主 17468 于 18:23:57 启动载 v0.30.0 bundle；其 skill/status 返回 installedVersion:null 是旧 readSkillVersion 正则行为——旧缺陷碰巧产出可接受结果，掩盖了 cycle-31 才修复的正则缺陷。18:49 dist 已含修复（验证新锚点在/旧正则无），宿主下次重启生效。
- 本地直测新代码：inline=2.1.0 / installed=2.1.0 双读正常。

### ④ 文档：DSH多代兼容与双端适配.md 新增 §6 桌面端验证策略
- §6.1 双宿主分工（测试宿主=每轮功能验证主场载最新 dist；桌面宿主=上一版本回归场，ESM import cache 进程级）；
- §6.2 可达面与 token 边界（14/14 实测 + token 穷尽清单）；
- §6.3 历史实测锚点（2026-10-16 12 工具 + 2026-10-18 14 端点）；原 §6/§7 顺延为 §7/§8，交叉引用同步。
- 版本 0.31.0→0.31.1（文档+验证轮，无源码行为变更）。

## v0.31.0 — 2026-10-18

cycle-31：**桌面宿主实弹验证轮**——等了 11 轮的 P2 桌面端窗口随宿主自然重启（57230→57200）打开；实弹 anic_* 工具链暴露并修复 1 个 P1 真缺陷 + 2 个传播缺陷。

### ① readSkillVersion 正则缺陷修复（P1——版本门控从未生效）
- 根因：`skillIntegrity.ts:60` 旧正则 `/version[:\s]+v?(\d+\.\d+\.\d+)/i` 要求字面量 "version" 前缀，但真实锚点是 SKILL.md「MCP Tools (vX.Y.Z)：」标题行——无此前缀，恒返回 null。
- 后果链：anic_status 的 skillIntegrity.installedVersion/inlineVersion 恒 null（误导性汇报）；skillInstallRoute 版本门控快路径从未生效（null===null 防御兜底落重装路径，行为侥幸正确但路径从未被测试）。
- 修复：锚点正则 `/MCP Tools \(v([0-9]+\.[0-9]+\.[0-9]+)\)/` + 注释说明。修复后实测：inline 2.1.0 vs 陈旧安装 2.0.0——真实差异首次可见。
- 回归钉：skillIntegrity.test.ts 新增 3 断言用例（真实锚点 2.1.0/无锚点 null/旧式字面量不再匹配防倒退）。

### ② 陈旧技能副本修复（真机 anic_install 实弹）
- 发现：dsh-anic 工作区 `.dsh/skills/ai-native-iteration-cycle` 停在 2.0.0——cycle-27 的 16 脚本迁移+lib/args.mjs 从未传播（cycle-19 后未重跑 install + 版本门控因 ① 恒 null）。
- 修复：新桌面宿主实弹 `anic_install` → installed:true + integrity{ok:true, reference:inline, checked:65, mismatches:[]}（65 文件全同步 2.1.0）。

### ③ quick-validate 位置参数冲突修复（工具面契约适配）
- 冲突：anic_skill 工具契约 `spawn(node,[script, workspace, ...args])`——workspace 恒第一位置参数；quick-validate 旧 spec `min:1 max:1` 只要 skill-dir。工具面调用必然超参被拒，或旧副本静默取 workspace 当 skill-dir（扫全工作区 35285 文件 59 假错）。
- 修复：spec 放宽 `min:1 max:2` + `skillDir=resolve(args._[args._.length-1])`（取最后位置参数——工具形态 [workspace, skill-dir] 与直接 CLI [skill-dir] 都正确）+ usage 注明工具形态。
- 工具描述同步：toolsSkillGateway anic_skill args 参数加 NOTICE（quick-validate 第一位置是 skill-dir 非 project dir，须传绝对路径）。
- 测试：cliArgsGuard 新增双形态贯通用例（两位置/单位置都 VALIDATION PASSED）。

### ④ 桌面宿主实弹验证（P2 桌面端窗口收口）
- 新宿主 57200（PID 17468）实弹全链：anic_self_check / anic_status（flows 17 条+health 六级+skillIntegrity 全响应）/ anic_skill gate-ledger --verify（83 条链完整）/ anic_skill org-status status（L2 协作模式）/ anic_install / anic_skill quick-validate（2.1.0 PASSED）。
- FlowTracker 如实记录全部 17 次调用（含调试期 4 次 FAILED）——失败也白盒跟踪，验证过程本身即证据。

### 验证
- 四层 ALL GREEN：validate 12/12 + vitest 93 文件 1089 用例（1087+2 新增）+ smoke 21 + trigger 100%/0%；typecheck exit=0；build exit=0。

## v0.30.0 — 2026-10-18

cycle-30：**测试体系深挖轮**（cycle-28 文档轮姊妹篇）——5 个 handler 级零覆盖路由补齐 26 个行为测试，vitest 1061→1087 用例；invokeSkillAsync 并行负载偶发竞态根治。

### ① 五路由 handler 级行为测试（此前仅有常量登记或 req 透传）
- `tests/unit/selfCheckRoute.test.ts`（7 用例）：runSelfChecks 六探针行为——无 .cycles 空转 vacuous ok + P3/P4 诚实部分绿；绿工作区全过（P1 digest 16hex/P3 source=canonical/P5 trace stable）；P2 结构化身份钉「wf: 前缀恒加」构造性保证；HTTP 面 404/200 形状。**教训**：registerSelfCheckRoute 返回单个 disposer 函数（非数组）。
- `tests/unit/stepTraceRoute.test.ts`（5 用例）：200 有 cycles（wf:build 可见）/404 无 cycles/500 EISDIR（workflow-graph.yaml 造成目录）。**教训**：sendJson 需要 res 桩有 writeHead/end 方法（直接对象桩会被静默跳过）。
- `tests/unit/selfInitRoute.test.ts`（7 用例）：405 POST only/403 开关关（ANIC_ROUTE_SELF_INIT_DISABLED）/404 无 root/409 已初始化（ANIC_ROUTE_SELF_INIT_ALREADY）+ 守卫顺序两钉（405 先于 403、403 先于 404）。
- `tests/unit/stackProbeRoute.test.ts`（3 用例）：404 无 root/200 Node 项目探测（node+configYaml+autonomy_level）。
- `tests/unit/dualBootstrapRoute.test.ts`（4 用例）：三路由 404/pluginDir 空 500（P0-DIR-ROOT 语义）/dual-status 双态（IDLE round 0 ↔ EVALUATED lastEvalScore 60）。**教训**：DualBootstrapState 真实形状是 {plugin: BootstrapState, skill: BootstrapState, crossProposals[]}——BootstrapState 含 status/round/maxRounds/lastEvalScore/lastGateVerdict/history: BootstrapHistoryEntry[]。

### ② invokeSkillAsync 偶发竞态根治（既有债务，本轮全量并行暴露）
- 症状：93 文件并行全量跑 5 次中 2 次 invokeSkillAsync.test.ts 1 FAIL；单独跑恒绿；单层 test:unit 3 连跑全绿。
- 根因：`setTimeout(() => ac.abort(), 300)` 在并行负载下（spawn 起进程耗数百 ms）会在「started」尚未输出前到达——kill 先于首条 stdout 是 abort 语义的正常形态，断言 `toContain('started')` 把「进程真的被启动过」与「300ms 内完成 spawn」两个命题绑在一起，负载下第二个命题不稳。
- 修复：abort 延时 300ms→800ms（只让断言目标在负载下稳定成立，被测语义零改动）；附注释说明设计动机。
- 验证：修复后全量四层连跑 6 次（3+3）全 ALL GREEN。

### ③ 覆盖缺口方法论沉淀
- 「req 透传（404 早退）」证明路由把 req 传给 getWorkspaceRoot，但不证明 handler 主体逻辑——两者是不同覆盖层；本轮补的是后者。
- 常量登记（ALL_ROUTES）只证明路由存在，不证明行为——三层覆盖（常量/透传/行为）自此齐全。

### 验证
- 四层 ALL GREEN：validate 12/12 + vitest 93 文件 1087 用例 + smoke 21 + trigger 100%/0%。
- typecheck exit=0 + build exit=0。

## v0.29.0 — 2026-10-18

cycle-29：**触发评估语料修复轮**——cycle-16 以来稳定复现的 3 个 trigger-eval MISS 全部修复，正例命中率 80%（12/15）→ **100%（15/15）**，负例误触率维持 0%。

### ① 三处 SDO 触发词修复（description-only，零行为变更）
- `anic_iterate`（tools.ts）：补「跑一轮完整的迭代 / 评估加门禁一起」——原触发词「跑一轮迭代」无法命中口语化变体「跑一轮完整的迭代」（词面不连续），评估+门禁组合语义此前落在 anic_evaluate。
- `anic_flows_gate_check`（toolsFlowsGateway.ts）：补「流程状态机 / 流转事件 / transition events」——原触发词「状态机门禁」与查询语「流程状态机的当前状态和流转事件」词面不连续（中间插了"的"），导致脚本名关键词 script 抢分误中 anic_skill。
- `anic_skill`（toolsSkillGateway.ts）：补「点名脚本带自定义参数 / 脚本跑一下」——org-status/quick-validate 等脚本名虽已在 description 中但英文 token 权重（2 分）不敌 anic_status 的 status 命中（中文 6 分）；中文触发短语补齐中文查询的正分。

### ② 修复方法论（供后续 description 演进复用）
- MISS 根因分型：**词面不连续**（trigger 短语被口语插入语打散——加变体短语）与 **跨语言权重失衡**（中文查询 vs 英文 token 得分不对等——补中文触发短语）。
- 修复纪律：只动 `Triggers:` 段，绝不改 `Use when` 语义段；每处修复后立即 `node scripts/trigger-eval.mjs` 复跑；全部负例（FPR 0%）复核确认新触发词不引入误触。
- 评估器不改：词面评分器是 description 纪律的守卫面，语料修复优先于评分器调参（防止「改考卷凑分数」）。

### 验证
- 四层 ALL GREEN：validate 12/12 + vitest 88 文件 1061 用例 + smoke 21/21 + trigger **15/15=100%**/FPR 0%。
- typecheck exit=0 / build exit=0 / quick-validate 3 anchors 2.1.0 不动。

## v0.28.0 — 2026-10-18

cycle-28：**文档代际校准轮**——v0.19→v0.27 九轮演进后 docs/agents 与 README 的数字/行号/描述漂移全量修正，文档回到「与代码可核对」状态。

### ① 架构总览.md 全面校准
- §2.1 路由表：六域→九分区（+data 域 invocationRoute/self 域 skillHealthRoute/flows 域），聚合位置行号全部按 `index.ts` 实测更新（:54/:64-69/:74-77/:84-93/:94/:98/:101-106/:112/:120-121/:125）；disposer 过滤 :127；snapshotRoute 形状权威锚点行号修正（SNAPSHOT_ROUTE:28/SnapshotCtx:34/resolveWorkspaceRoots:58/sendJson:120）。
- §2.2 runtime 表补 invocationFeed.ts(216)/scriptParsers.ts(125)；§2.3 evolution 补 autonomyActions/autoFix 三件套/breakerSignals/techDebtQueue/truthAuditTypes；§2.4 governance 7→9 文件（+hitlFix/hitlThreePhase）；§2.5 llm 补 5 文件；§2.6 顶层表补 cors/crossProjectHistory/skillInvokerAsync/skillRegistration/toolsAutoFixGateway/toolsBootstrapGateway/toolsEvolutionGateway/snapshotRoute/pluginRoot 9 文件+全行数。
- §3 特性表 17 处行数漂移修正（renderGraph 225→245、gateColors 183→200、renderInvocations 140→195、renderLedger 103→137 等）+补 governanceTargets/panelLiveTargets/i18n/panelTheme 组件行；§4 shared 表重写（palette.ts 145/tokens.ts 214/shellTheme.ts 69/panelCss.ts 92/fs-safe.ts 54/stepTrace.ts 222/flows.ts 140）；adapters 114→145；§5 速查表 WorkflowGraphPanel:65→:54。

### ② 设计令牌与主题.md 整篇重写
- 旧文整篇描述拆分前旧系统（tokens.ts 98 行/PALETTE 16 键 green500 档位/SEMANTIC 11 键/:root 注入/prefers-color-scheme 媒体查询/「40+ 十六进制仍在用、4 套硬编码调色板仍在、hex 禁令守卫不存在」）。
- 新文按现状：三文件体系（palette.ts 64 原语按角色命名 WCAG 反解 + tokens.ts SEMANTIC 42 键/SEMANTIC_DARK 22 键覆盖 + shellTheme.ts 宿主主题探测）；TOKEN_SCOPE 面板作用域绝不写 :root；暗色走 data-anic-theme 属性选择器非媒体查询；守卫面三份契约（clientRenderContract 颜色字面量禁令——src/client 实测 0 hex；contrastContract 11 用例 WCAG 逐项测量）；§6 落地程度改「已收敛」；§7 脉冲类迁至 components/statusDot.ts。

### ③ 其余文档修正
- DSH多代兼容 §7.1：「npx 分发未实施」→已实施（cycle-25 bin/anic-init.mjs）。
- API参考-自举与技能 §2.2：CLI 约定段补 lib/args.mjs parseCliArgs 三防线描述（16 脚本+白名单 15 的精确表述）。
- API参考.md+开发规范.md：方法检查断言 3 处→5 处 405（+skillInstallRoute:127/skillHealthRoute:43），行号全修正。
- 开发规范-守卫与约束.md locale 段：49 行/6 键→258 行/19 顶层键/220 扁平键；「t() 只有 9 处全在宿主、客户端硬编码中文」→宿主 8 处+客户端 29 处全量接入；补 JSON 重复键地雷（JSON.parse last-wins vs PowerShell ConvertFrom-Json FIRST-wins）教训。
- 测试指南.md：269 it()→实跑 1061 用例/88 文件（unit 75 文件 941 + contract 13 文件 90 源码静态计数，it.each 展开计入实跑）。
- README：L2 132→1061/88 文件；L4 smoke 19→21 断言（169 点 217 线）；snapshotRoute 8→13 用例。

### ④ 源码注释级修正（非行为变更）
- `src/host/routes/index.ts` 头注释「~45 行」→「130 行」。
- `src/host/skillInvoker.ts:167`「全部 15 个技能脚本」→「SKILL_SCRIPTS 白名单 15 个（mcp-server 不在白名单，cycle-27 后脚本总数 16）」。

### 验证
- `pnpm run lint` PASSED 12 checks（dsh-anic@0.27.0→v0.28.0）；文档数字全部经命令实测（Select-String/Get-ChildItem 计数），未引用记忆值。

## v0.27.0 — 2026-10-18

cycle-27：**统一 CLI 参数防护库轮**——cycle-26 范围界定的 15 脚本敞口全部收口。

### ① lib/args.mjs 共享参数解析库（技能新增第 65 文件）
- `parseCliArgs(argv, spec)`：spec 声明式描述旗标（`type: boolean|string|int|float` + `default`）与位置参数契约（`min/max/name`），统一三防线：`--help`/`-h` 短路（打印用法 exit 0）；未知旗标拒绝（报旗标名 + usage exit 1）；位置参数契约（恰好/范围/零容忍，越界报实收数与列表）。
- 值旗标缺参拒绝、int/float NaN 拒绝、kebab→camel 映射（`--max-retries`→`args.maxRetries`）、boolean 缺省恒 false。
- 落点 `assets/skill/scripts/lib/args.mjs`（lib/ 共享模块目录第 8 模块），90 行零外部依赖。

### ② 16 脚本全量迁移（手写 parseArgs 零残留）
- 16 个脚本全部删除手写 `function parseArgs` + 零参检查块，换 `parseCliArgs(process.argv, {script, usage, flags, positionals})` 声明式调用。
- 位置参数语义保持：13 脚本恰 1 个（project-dir）；org-status/workflow-state 恰 2 个（project-dir+command）；quick-validate 恰 1 个（skill-dir）；mcp-server 0 个。
- 收紧点（诚实列出）：mcp-server 原把多余位置参数静默推入 `args._` 不消费，现按契约拒绝。
- 冒烟：16 脚本 `--help` 全 exit 0、`--zzz` 全 exit 1；gate-ledger --verify 74 条 Valid；init-cycle . --cycle N 正常建删。

### ③ 技能版本三锚点 2.0.0 → 2.1.0（minor：健壮性+共享库，不破坏消费契约）
- SKILL.md L301 `MCP Tools (v2.1.0)：`；mcp-server.mjs `version: "2.1.0"`；assets/skill/CHANGELOG.md 顶部条目（含背景：cycle-25 事故、收紧点、文件数 64→65）。
- quick-validate 三锚点一致性 PASSED。

### ④ 测试（+41 用例）
- 新增 `tests/unit/cliArgsGuard.test.ts`：进程内契约 10 用例（captureReject helper 捕获 console.error+process.exit 拒绝路径；kebab→camel/默认值/未知旗标/值缺参/NaN/恰 1/零参/0..0/min..max/--help 哨兵）+ 子进程抽验 31 用例（15 脚本 × --help/--zzz 真实 exit code；auto-fix-loop --max-retries 2 位置参数拒绝先于旗标错误）。
- 同步四套件：npxInit（v2.1.0 ×2 + 65 文件）、skillIntegrity（65 ×7 处）、initWorkflowGuard（文案「只接受 1 个位置参数」）、README L35（65 文件）。

## v0.26.1 — 2026-10-18

cycle-26：**CLI 参数防护轮**——cycle-25 收口时发现的 `--help/` 目录事故根治。

### ① init-workflow.mjs 参数防护（P3 根治项）
- 事故：parseArgs 把未知旗标（`--help`/`--bogus`）当位置参数推入 `args._`，scaffoldProject 便在 CWD 下脚手架出 `--help/` 目录（cycle-25 提交清理时发现）。
- 修复三防线：未知旗标（`--*` 不在白名单）exit 1 并报旗标名；位置参数必须**恰好 1 个**（多给报数量与列表）；`--help`/`-h` 打印用法 exit 0（不再落入位置参数桶）。
- 产物：`assets/skill/scripts/init-workflow.mjs` 95→111 行；技能三锚点 2.0.0 不动（参数防护不算能力变更）。

### ② 测试（+7 用例）
- 新增 `tests/unit/initWorkflowGuard.test.ts`：--help exit 0/-h 等价/未知旗标拒绝/事故回归钉（--help 不再产生目录）/两位置参数拒绝/零参数用法/正常路径不回归。
- 教训：拒绝路径输出在 stderr（console.error）——execFileSync 捕获时要拼 stdout+stderr。

### ③ 范围界定（tech-debt 如实记录）
- 其余 15 个技能脚本的同型 parseArgs 未在本轮统一——宿主侧 invokeSkillScript 显式传 workspace（LLM 面不直接拼 CLI），风险敞口仅限手动 CLI 用户；统一参数防护库列入后续轮。

## v0.26.0 — 2026-10-18

cycle-25：**npx 技能-only 分发轮**——eco 研究报告最后一个 P1 分发缺口收口。dsh-anic 从「DSH 专属插件」升级为「跨 harness 技能 + DSH 增强插件」双层产品。

### ① npx 分发入口（P1 · skill-ecosystem.md:240）
- 新增 `bin/anic-init.mjs`（零依赖，仅 node: 内置模块）：`npx dsh-anic init <dir> [--name] [--framework claude|codex] [--dry-run]`——① `assets/skill/` 64 文件 → `<dir>/.dsh/skills/ai-native-iteration-cycle/`（与 `anic_install` 同构落点）② `.cycles/` 骨架（init-workflow.mjs，从已装副本执行——npx 缓存生命周期不可依赖）。
- 幂等语义：同版本已装跳过复制、异版本重装覆盖、`.cycles/` 已初始化跳过脚手架（既有文件不覆盖）。
- 版本锚点：`MCP Tools (vX.Y.Z)` 正则与技能侧 quick-validate 同锚——安装/跳过/重装三态汇报真实版本。
- `--dry-run` 零写盘（连目标目录都不创建）；`--help` 含 MCP server 注册指引。

### ② package.json 分发面
- `bin.anic-init` + `files` 白名单（dist/assets\/skill/bin/locale/icon/cordis.patch.yml/README/LICENSE）——npm 发布形态就绪（发布本身仍待用户建仓推送后执行）。

### ③ 测试（+6 用例，e2e 子进程手法）
- 新增 `tests/unit/npxInit.test.ts`：全新目录安装（64 文件精确计数 + CLAUDE.md --name 落盘）/幂等重跑/dry-run 零写盘/--framework codex 落 AGENTS.md/--help 含 MCP 指引/源与安装副本版本锚一致。

## v0.25.0 — 2026-10-18

cycle-24：**治理与审计补完轮**——ui-domain-plan 缺口清单最后两项 P3 一次收口：治理预算视图 + 账本分页。至此 2016 年研究轮（cycle-16）规划的七个 UI 缺口（P0 时间线 / P1 账本 / P1 HITL / P2 仪表带 / P2 turn 分组 / P3 技能健康 / P3 治理预算）全部落地。

### ① 治理预算视图（P3 · ui-domain-plan:135）
- 新增 `src/client/features/budget/renderBudget.ts`（128 行）：消费既有 `GET /anic/governance/budget`（零新增 host 面）——状态徽标三态（normal/warn/alert 语义色三通道）+ 预算余量条（`role=img` aria 整条播报；填充=totalBytes/alertBytes 封顶 100%；warn 阈值画绝对定位刻度线）+ 统计行（文件数/目录数）+ 大文件 Top 5 榜（>1MB，完整路径 title 悬停）。
- `humanBytes` 人性化（B/KB/MB/GB/TB，<10 一位小数否则取整；非有限/负数如实返回）。
- 纯函数渲染器范式与 ledger/hitl 同构：null → 整区不渲染，不伪造空态；largestFiles 空 → 榜区不渲染。
- 面板接线：4s 轮询档（治理证据簇同节奏），旅程排序在 HITL 队列后——「留了什么痕」之后呈现「这些痕占了多少空间」。

### ② 账本分页（P3 · ui-domain-plan 遗留）
- 服务端 `?limit&?offset` 早已支持（ledgerRoute.ts:44-47），本侧接线：`ledgerListUrl(limit)` 工厂 + `governanceTargets(setters, ledgerLimit)` 按翻页深度拉取。
- `renderLedger` 新增第三参 `actions: { hasMore, onShowMore }`：`entries.length < total` 时渲染「显示更多」按钮（`data-anic-ledger-more` 契约标记），点击抬 limit+24 并 bump reloadKey（语义=带新翻页深度的手动刷新）。无 actions / hasMore=false → 不渲染（与既有测试零破坏——第三参可选）。

### ③ 测试（+22 用例，全量 85 文件 1007 用例）
- 新增 `tests/unit/budgetSection.test.ts` 17 用例：渲染 7（null/锚点+徽标/余量条三契约/三态/统计行/大文件榜/空榜不渲染）+ isBudget 守卫 5 + humanBytes 5。
- `tests/unit/ledgerSection.test.ts` 追加 5 用例：ledgerListUrl 工厂 1 + 分页 footer 4（无 actions 不渲染/hasMore=false 不渲染/hasMore=true 按钮计数/渲染期不触发回调）。
- 教训复用：新测试文件 import 深度算错（`../../../src` 越出工程根被 G-IND 独立性守卫拦截）——tests/ 下到 src/ 统一 `../../src`。

## v0.24.0 — 2026-10-18

cycle-23：**分发正典化轮**——eco 研究报告 P1「DSH 插件市场正典化」收口：把 dsh-anic 从「本地 link 安装的事实形态」推进到「可被 DSH 市场生态收录的正典形态」（官方 bundle 安装三通道对照见 `docs/agents/DSH多代兼容与双端适配.md` §7）。

### ① 市场收录物料就绪
- **LICENSE**（MIT）：contributing.md 惯例要求，此前缺失。
- **screenshots.json** + `docs/screenshots/` 三张真机截图：`workflow-graph.png`（工作流图+实时调用流，1440x960）/ `ledger-hitl.png`（门禁账本+HITL 队列，1154x499）/ `autonomy-gauge.png`（自主级仪表带+技能健康区，1440x960）——Playwright 于 3080 测试宿主真面板拍摄，非设计稿。市场详情页 App Store 式轮播自动读取；截图更新只推本仓库。
- **README 顶部「安装」段**：`dsh plugin add github:<owner>/dsh-anic` / engines.dsh 与 peer 层说明 / 技能自动安装（SHA-256 清单）/ 19 工具 62 路由白盒面板一览。
- **投稿条目草稿** `docs/agents/marketplace-提交草稿.md`：`data/plugins/<owner>__dsh-anic.yml` 完整内容（category: workflow；中英描述数字已对照代码核实）+ 用户动作项清单（建 GitHub 仓 / 打 dsh-plugin topic / 提 PR——agent 无 remote 无凭据不能代做）。
- 描述数字核对纪律：**19 个 anic_ 工具 / 62 个 HTTP 路由**——contributing.md 明确「描述会被对照代码核实」，条目草稿内已警示增减工具/路由后必须同步。

### ② 研究固化
- awesome-dsh-plugin 收录规则（contributing.md 2026-10-18 快照）全文研读并固化到 `DSH多代兼容与双端适配.md` §7：收录硬性要求逐项对照、peer 范围显式预发布分支陷阱（本仓库 `>=0.2.0-rc.2 <0.4.0-0` 已是正确形态）、screenshots.json 惯例、一个 PR 最多 3 条、README 生成勿手编。
- npx 技能-only 分发（eco P1 第二项）评估：延后——先让市场正典路径落地，npx 形态需独立 bin 入口与发布链路，收益窗口在市场收录之后。

### ③ 桌面端生命周期事实（如实留档）
桌面宿主（57230，PID 2592 07:17 起）运行 v0.22.0 host bundle——承载当前会话不可重启；本版 host 侧变更（无）不影响该事实。桌面 webview 新面目验仍待宿主自然重启（cycle-12 D-1102 同款生命周期语义）。

## v0.23.0 — 2026-10-18

cycle-22：**官方契约对齐轮**——两项 dsh-kb-compliance 研究报告遗留 P2 一次收口：①其余域路由 `getWorkspaceRoot` 带 req 统一（cycle-21 只修了 native 域，其余 7 文件仍无参调用）②safeHandler 吞异常语义修正（与官方 isError 语义相反）+ presentResult 第二参签名偏差（0.3+ 宿主收紧传参形状即碎的多代风险点）。契约出处：`dsh-plugin-dev-kb/kb/site/reference/cookbook/adding-a-tool.md`。

### ① 其余域 7 文件 `getWorkspaceRoot(req)` 统一
- 全改 deps 接口签名 `(req?: unknown) => string | null` + handler 传 req：`cycleRoute.ts`（init/advance/close/state/list）、`ledgerRoute.ts`（ledger/append/verify）、`skillInstallRoute.ts`（install/status/repair——写侧，错工作区写 `.dsh/skills/` 代价最高）、`dualBootstrapRoute.ts`（dual-evaluate/dual-advance 写侧/dual-status）、`segmentedLedgerRoute.ts`（seg-ledger/append 写侧/verify/init）、`selfInitRoute.ts`（self/init 写侧）、`stackProbeRoute.ts`。
- 顺带清 `cycleRoute.ts`/`ledgerRoute.ts` 死导入 `resolveWorkspaceRoots`。至此**全部 13 个路由文件**的 handler 一律 `getWorkspaceRoot(req)`——写侧路由在多会话宿主上不再写到首条会话的工作区（X-ANIC-Workspace 头全域生效）。

### ② safeHandler isError 语义修正（官方契约：基础设施故障请抛异常）
- 官方契约：「抛出异常或返回无效值意味着 isError。基础设施故障请抛异常。成功的领域结果即使表示不理想的状态，也应写入规范值。」旧实现（`toolsSlot.ts`）把一切异常折叠成 `{ error: message }` 正常返回——模型与轨迹看到 `isError=false` 的「成功」，无法区分 infra 故障与领域失败。
- 新实现：`safeHandler` 不再吞异常——infra 异常沿 Promise 拒绝传播给注册表（注册表收敛 `isError=true`），领域失败仍走显式 `{ error }` 规范值。grep 验证全部 `tools*.ts` gateway 无 intentional throw，rethrow 安全；`not whitelisted` 等领域拒绝断言不受影响。

### ③ presentResult 第二参双形状归一化（多代防御）
- 官方签名 `presentResult(args, { content, isError, meta? })`（meta 由 `output.presentationMeta` 派生持久化在 `result.meta`）；宿主 0.2.0-rc.2 实测宽容直传原始 execute 返回值。`presentation.ts` 新增纯函数 `normalizeToolResult(result)`：官方形状（content 数组判定）从 meta 提取持久化事实（exitCode/stdout/stderr）+ content text 块兜底拼接；宽容形状原样返回。
- `terminalResult()` 入参先过归一化；5 个 gateway（skill/hitl/flows/evolution/autoFix）与 `tools.ts anic_evaluate` 的 presentResult 全部接线——0.3+ 宿主收紧传参形状时卡片不碎。
- 已知小偏差（未改，实测无害）：`presentCall` terminal 卡字段官方 `description` vs 本插件 `summary`——宿主 0.2.0-rc.2 渲染正常，文档化为第一排查点。

### 测试（+21 用例，全量 84 文件 985 用例 ALL GREEN）
- 新增 `tests/unit/toolContractCycle22.test.ts` 10 用例：safeHandler 3（infra 异常 rejects/领域失败规范值/exec signal 透传）+ normalizeToolResult 4（官方 meta 事实提取/content 兜底/isError 透传/宽容形状原样同引用）+ terminalResult 3（官方形状渲染/宽容形状回归锚点/纯函数幂等）。
- 新增 `tests/unit/routeWorkspaceCycle22.test.ts` 8 用例：7 文件各自路由注册 + req 透传 404 早退（POST readBody 异步 handler 必须 flush 微任务——教训固化）+ 写侧钉（X-ANIC-Workspace 头声明工作区优先于 fallback）。
- 四层全绿：validate 12/12 + vitest 84 文件 985 用例 + smoke 19/19 + trigger-eval 80%/FPR 0%。

## v0.22.0 — 2026-10-18

cycle-21：**band-history 双 schema 收敛轮**——cycle-20 真机验证发现的深层契约债务：`.cycles/band-history.json` 的真实生产形状是**代码质量带**（技能 `band-detector.mjs` 写入 `{timestamp,totalScore,avgScore,fileCount,overBudgetCount}`），而插件 `BandEntry{cycle,score,timestamp,band}` 是**自主带**形状。两代 schema 盲解析导致：读侧 `map(e=>e.score)` 产出 `[null,null]`（仪表带火花线拿不到数据）；写侧 `runBandDetection` 会错编 cycle、并把混合 entry 覆写回文件；`classifyBand` 0.7/0.5 阈值对 avgScore（复杂度分量纲）套用会误报 alarm。

### 新域模块 `src/host/evolution/bandHistory.ts`（T3 一域一文件拆分）
- **读侧归一化**：`loadBandHistory` 只返回自主带形状 entry（`isAutonomyEntry` 形状判定 cycle+band 字段）；`loadHistoryScores` 量纲感知三态——自主带存在 → 只用 score（阈值语义正确）；纯质量带 → avgScore 兜底 + `source:'quality'` 标记（趋势/WE 形状可看，调用方不得用它判 band）；损坏/非数组/空 → `source:'none'` 不伪造。`loadRawHistory` fail-safe（损坏 JSON → 空数组）。
- **写侧收敛（`runBandDetection`）**：追加时保留全量原始数组（过滤覆写会摧毁技能仍在消费的质量带历史）；cycle 编号与 trend/WE 统计只取自主带子序列（质量带 entry 无 score 字段，盲 map 产出 undefined 让趋势静默错算 stable）。
- `orgStatus.ts` 接线：`band.current` 只对自主带分数做阈值分类，质量带/空历史 → `'normal'` 不误报；`trend`/`weViolations`/`recent`（火花线）消费归一化分数序列。
- `breakerSignals.ts` CB5 量纲注释：质量带 entry 无 band 字段 → `every()` 对 undefined 判等 false → 不触发自主性熔断（行为本来正确，语义现在写明——复杂度超标由 band-detector 脚本 exit code 治理，不走 CB5）。

### 附带修复：nativeRoute 写侧路由工作区错位（真机发现 → 修复 → 真机复验）
- **发现**：测试宿主多会话场景下，带 `X-ANIC-Workspace` 头调 `band-detect`——org-status（带 req）读对工作区，但 band-detect（不带 req）把自主带 entry 写进了 registry 首条会话的 codegraph 工作区（`getWorkspaceRoot()` 无参调用走 registry 首条兜底）。写侧路由忽略头 = 跨工作区数据写错位。
- **修复**：nativeRoute 7 条路由全部 `(req,res) + deps.getWorkspaceRoot(req)`——hitl-audit/band-detect/fact-base/plan-sync/multi-agent-gate/fix-loop 原来 `_req` 或不带参，现与 org-status 统一（头注释写明缘由）。
- **回归钉**：新增 `tests/unit/nativeRouteWorkspace.test.ts` 3 用例——7 路由集合回归 + 每路由把 handler 收到的 req 原样传给 getWorkspaceRoot（身份断言 toBe）+ band-detect 写侧落盘在解析器选定的工作区（双工作区夹具：claimed 追加保留 2 质量+1 自主、default 零写入）。
- **真机复验**：重建后重启测试宿主，`band-detect?score=0.82` 带 dsh-anic 头 → dsh-anic/.cycles/band-history.json 41→42（1 自主 entry），codegraph 2/0 未被写；org-status 带头返回 band.current=normal/12 点 recent/L2-L2。误写入 codegraph 的 1 条 entry 已清理（该文件恢复 2 条纯质量带）；验证用合成 entry 亦从 dsh-anic 清除（自主带历史只留真实评估）。

### 测试
- 新增 `tests/unit/bandHistorySchema.test.ts` 15 用例：读侧三态（纯质量带/纯自主带/混合 autonomy 优先/损坏 none/非有限 score 剔除）+ 写侧追加保留（质量带历史不摧毁/cycle 基于自主带子序列编号/纯自主带续编与旧行一致）+ orgStatus 集成（质量带 current=normal 不误报 alarm 回归/质量带趋势 degrading 真信号/自主带阈值分类生效）。
- 新增 `tests/unit/nativeRouteWorkspace.test.ts` 3 用例（见上「附带修复」）。
- 清理 `nativeRoute.ts` 死导入 `loadBandHistory`。

## v0.21.0 — 2026-10-18

cycle-20：**自主性与健康白盒轮**——ui-domain-plan 研究报告三缺口一次收口：P2 自主级仪表带 + P2 invocations turn/step 折叠分组 + P3 技能健康面板。全部属「AI 自主权/技能健康动态白盒」主线。

### P2：自主级仪表带（`features/autonomy/renderAutonomyGauge.ts`）
- org 全景的"一眼可读"形态：L1-L4 刻度条 + 当前档实底粗字 + 配置档虚线描边双指针（降级分歧一眼可辨）+ 熔断徽标（✓/⚠ 字形双通道）+ 性能带芯片 + 信任模型建议档 + 分数火花线（SVG polyline，最近 12 点）。
- 数据面零新端点：消费既有 org-status 轮询；`orgStatus.ts` band 加 `recent: number[]`（slice(-12) 分数序列）。
- 刻度条整体 role=img + aria-label 全文播报（AT 单次播报非碎片）。

### P2：invocations turn/step 折叠分组（`renderInvocations.ts`）
- 有 turn 元数据 → 按 turn 分组折叠（原生 details/summary 无 JS 状态）；turn 降序、最新组默认展开；无 turn 条目归「未分组」殿后不丢弃。
- 全部条目无 turn → 平铺模式与改造前逐字节同构（零回归面：旧宿主/旧 feed 不受影响）。
- 单行渲染抽为 `invocationRow` 局部函数（分组/平铺共用，data-anic-* 契约标记不变）。

### P3：技能健康面板（`features/skillhealth/` + `skillHealthRoute.ts`）
- 新 HTTP 端点 `GET /anic/skill/health`：FlowTracker 调用历史 → `analyzeSkillHealth` 纯函数 → SkillHealthReport。与 `anic_status` 工具（LLM 面）同一份分析——阈值单一事实源 `continuousLearning.ts`，两个消费面。
- 面板渲染：六级等级字形+色双通道（✓/✕/⏱/⌛/○/·）、成功率微条形、超时率徽标、建议列表 severity 着色。空历史如实引导（totalInvocations=0 → 200 空态，不是 500）。
- 路由独立成域（不塞 skillInstallRoute：安装生命周期≠运行健康观测）；getWorkspaceRoot 带 req（P2 桌面多会话契约）。

### 附带修复
- **火花线 null 防御（真机发现）**：宿主 band-history.json 是代码质量带历史（entry 无 `score` 字段），`recent=[null,null]` 时火花线逐点过滤非有限值，有效点 <2 不画线（不伪造平线）。
- **locale 双 flows 键地雷永久拆除**：zh.json 历史存在文本级两个 `flows` 段（JSON 解析 last-wins 掩盖，PowerShell ConvertFrom-Json first-wins 会静默降级 25 键→11 键）。本轮 JSON 重写后单段 24 键，运行时语义与 HEAD 逐键一致（node last-wins 复核）。
- API参考.md 端点索引 60→62（追认 cycle-19 的 repair + 本轮 health——计数纪律注记再次印证，本表同步已进任务清单）。

### 测试
- 新增 `autonomyGauge.test.ts`（8+1 真机防御）/`skillHealthPanel.test.ts`（8）/`skillHealthRoute.test.ts`（6）；`invocationsRender.test.ts` 追加分组用例 3 个（11 用例）；`snapshotRoute.test.ts` ALL_ROUTES 加 health（62 条对齐源码字面量计数）。


cycle-19：**分发完整性轮**——eco 研究报告最后一个 P0 收口：安装清单 + sha256 完整性校验 + doctor/repair（对标 ECC doctor/repair）。`autoInstallSkill` 从「盲拷贝 64 文件」升级为「安装即建锚」，把「已安装副本 vs assets/skill 内联副本」的字节对比从评估期提前到安装期。

### P0：安装清单 + 完整性校验 + doctor/repair

- **`src/host/skillIntegrity.ts`**（新域模块）：`buildSkillManifest`（path+size+sha256+版本锚点，POSIX 相对路径跨平台稳定）；`verifySkillInstall`（doctor 语义——inline 权威直比优先，manifest 兜底，双参考系缺失时 ok=false 不静默放行）；`repairSkillInstall`（repair 语义——只重装差异文件，extras 只报告不删除：用户/其他工具放入的文件不属本插件删除权限）；`skillIntegritySummary`（anic_status 消费面）。清单文件 `.anic-manifest.json` 是插件私有元数据（隐藏文件，自身被排除在清单外）。
- **`skillInvoker.ts`**：`autoInstallSkill` 安装后写清单并返回 manifest 摘要；新增 `inlineSkillRoot()` 真内联解析（单一事实源）。**顺带修复**：`skillInstallRoute` 此前借 `resolveSkillScriptsDir(process.cwd())` 间接取内联目录——cwd 邻近存在外部副本时会解析到非内联目录（潜在错参比）。
- **路由**：`GET /anic/skill/status` 增 `integrity` 字段（doctor 并入 status，不另设端点避免动词通胀）；新增 `POST /anic/skill/repair`。
- **工具**：`anic_install` 返回 `integrity`（安装后立即校验，漂移当场暴露）；新增 `anic_skill_repair` 工具（SDO 触发词：修复技能/repair skill/技能损坏/完整性）；`anic_status` 返回 `skillIntegrity` 摘要。
- **测试**：`tests/unit/skillIntegrity.test.ts` 15 用例——真 inline（64 文件）× 真 tmp 安装目录全链：清单构建/往返/损坏降级 → 安装即建锚 → 三种篡改（hash 等长替换/size 截断/missing 删除）逐一检出 → repair 只重装差异 → extras 权限边界 → summary 消费面。

### 其他

- truthAudit T3 守卫两次拦截 `tools.ts` 超长（251/252 行），修剪至 249 行（T3 结构守卫有效性实证）。
- snapshotRoute 契约测试 ALL_ROUTES 增 `/anic/skill/repair`。

## v0.19.0 — 2026-10-18

cycle-18：**治理证据白盒轮**——B2 双分区（账本事件流 + HITL 审计队列）落地，`flow.approvals` 开关 15 轮来首次接线真实 UI（声明与实现断层收口）。桌面宿主重启后全链补验（遗留 #1 收口）：junction 双端 ✓ + self-check 6/6 + anic_* 工具实时响应 + J0 8/8（新测试宿主）。零新增 host 路由（纯消费既有数据面）。

### B2 账本事件流 + HITL 审计队列（P1 UI 缺口）

- **`features/ledger/renderLedger.ts`**：消费 `GET /anic/api/ledger?limit=12` + `GET /anic/api/ledger/verify`——最近 12 条门禁裁决（PASS 绿/FAIL 红语义色、门名、短时间戳、8 位短哈希 + title 悬停完整 64 位、首条 genesis 如实标注、detail 摘要行）+ 链完整性徽章（ok/broken/unknown 三态，断链显示断点序号）。
- **`features/hitl/renderHitl.ts`**：消费 `GET /anic/hitl-audit`——H1-H4 四检查（域标签 i18n：敏感数据保护/回滚安全/门禁绿态/账本证据一致性）+ 逐项徽章（circuit 优先于 passed——熔断是「等待人工」琥珀语义，与 FAIL 红严格区分）+ 总评行 + **只读边界常驻提示**（H4 账本冲突是人工专属裁决，插件不提供一键改写；修复走技能 CLI 三段流程——degradation 契约落地）。
- **`flow.approvals` 门控接线**：关闭形态 = 分区隐藏 + 如实说明行（INV-30）；真机实测关闭→显示「队列降级为只读展示，修复动作请改走技能 CLI」，账本分区不受影响。
- 旅程排序：流程状态机 → 账本事件流 → HITL 队列（治理证据簇相邻呈现：「状态机走到哪」与「裁决留了什么痕、谁在等人工」）。
- locale：`ledger.*`/`hitl.*` 两段 20 键（zh+en）。

### 桌面端遗留收口（cycle-16 遗留 #1）

- 宿主 7:17 自然重启后：desktop/web profile junction 均指向本工程验证 ✓；桌面宿主（57230）self-check 6/6（快照确定性 86 节点/15 卡片/trace 复现）✓；anic_* 工具实时响应 ✓。
- B2 客户端分区在 web 测试宿主真机验证（同一 dist：12 条账本 + 链完整徽章 + H1-H4 徽章 [pass,pass,circuit,pass] + 熔断琥珀语义）；桌面宿主 host 路由同版本已验，webview 下次重载即呈现（结构性约束如实留档）。

### 其他

- `docs/agents/架构总览.md` 特性模块表补齐至 20 模块（cycle-16 的 cycles/flows/live/components/stepTrace 更新 + 本轮 ledger/hitl）；数据热更新描述同步 usePanelFetch 架构。
- 测试 74→76 文件 888→942 用例（ledgerSection 10 + hitlSection 10，renderToStaticMarkup 真渲染纪律）。

## v0.18.0 — 2026-10-18

cycle-16：**深度研究驱动的全量收口轮**——4 份研究报告（docs 审计 / DSH kb 合规 / 技能生态 / UI 功能域）→ 23 任务：P0-P3 问题全清 + 动态白盒闭环真机验证。测试 71→74 文件 863→888 用例 + trigger-eval 第 4 测试层（新增，recall 80%/FPR 0%）。真机验证：J0 8/8 + DevTools 用户旅程 12 项 + **DSH 模型真调 anic 工具双通道可见**（实时调用流 + 宿主轨迹页）。

### P0 真机暴露与部署修复

- **P0-CYCLE-LIST**：cycleRunner.listCycles 只扫 `.cycles` 根，而正典布局是 `.cycles/cycles/`（gateEngine:55/orgStatus:33/macroPhaseEngine:82 全是双跳）→ `cycle/list` 路由在**任何真实工作区永远空列表**（cycle/init 同病写错位置）。B1 时间线是第一个消费者才暴露——65 cycle 数据一根时间线全数复活（真机实测）。双布局兼容 + initCycle 对齐正典 + runtime.test 2 回归钉。
- **P1 部署阻断**：双端 profile 的 dsh-anic junction 均指向已不存在的旧路径（独立化迁移后未重装）——当前安装态两端都加载不了插件。双端 pnpm install 修复，junction 指向新工程验证。
- **semver 上界泄漏**：`<0.4.0` 在 includePrerelease 下放行 `0.4.0-rc.*`（实测）；上界改 `<0.4.0-0` 全拦（engines.dsh + peer 双声明；下限 >=0.2.0-rc.2 保持精确——kb 报告确认 0.2.1-rc.2 已实装 engines 门）。

### P1 工具执行契约对齐（kb 合规审计）

- **P1-EXEC-SIGNAL**：全部工具 execute 丢弃第二参 exec（不遵守官方 adding-a-tool「遵守 exec.signal」）→ 新 `skillInvokerAsync.ts`（async spawn + signal 三路终止 + aborted 字段区分取消/超时）+ `ToolExecContext` 契约（toolsSlot.ts）+ 6 个长时工具接线（anic_evaluate/iterate/gate_check/bootstrap + anic_skill 网关 + bootstrap_cycle）。用户取消即 kill 子进程，60-120s 脚本不再失控跑满。
- **P1-EVENT-LOOP**：spawnSync 同步阻塞宿主事件循环（脚本冻结所有会话+UI）→ 同上异步化 + `runSelfBootstrapCycleAsync`（轮边界协作取消，已完成轮次状态/账本/flow 记录如实保留绝不回滚）。invokeSkillAsync.test.ts 6 用例钉死（含事件循环不阻塞探针）。
- **P2 isAnicInvocation**：skill 参数子串匹配 → JSON 解析精确 name 匹配（他人 prompt 提到技能名不误命中；解析失败回退子串，事件不丢——误报优先于漏报）。

### 缺口闭环（G-C3/G-C5/G-T5）

- **G-C3 tech-debt 消费链**（半闭环→闭环）：`techDebtQueue.ts` + `GET /anic/api/tech-debt/list`（open/resolved/skipped 三分流；fix-loop 数组展开、自由形态如实跳过）+ `POST /anic/api/tech-debt/consume`（记账不执行修复——R-31 红线不破；consumedAt/consumedBy 审计字段；幂等；原文件形态保持：数组写回数组）。
- **G-C5 跨项目→自举回写**：`crossProjectHistory.ts`——/anic/evaluate、/anic/iterate 摘要写插件自身 self-bootstrap.json 的 crossProjectHistory 段（与 history 并列**不混入**——跨项目调用不是自举轮次，混入会污染 CONVERGED 判定；滚动 50 条；失败响亮降级 bootstrapSync:'failed' 不阻断主结果）。
- **G-T5 产出者标注**：TraceStep.producedBy——结构化前缀映射表（wf:micro-eval→eval-runner 等 10 条），不可判定 null 诚实留空（INV-21 同款纪律不猜）；客户端「产出:」行内渲染 + tooltip（真机 step-trace 实测）。

### 生态吸收（skill集合.md 35 项研究 → 落地）

- **A1 SDO 描述纪律**：18 个 anic_* 工具 description + SKILL.md frontmatter 从「工作流总结型」（superpowers 实证反模式：agent 抄 description 捷径不读正文）重写为「Use when + 症状 + 双语触发词」。SKILL.md 789 字符 ≤1024（Agent Skills 规范合规）。
- **A3 trigger-eval 闭环**：`scripts/trigger-eval.mjs` 确定性代理评分器（description 触发词面 × 20 条查询数据集，12train/8test 60-40 分离、4 区分度对）挂入 run-tests 第 4 层——每次 description 改动可复跑抓回归。数据集稳定副本 tests/fixtures/trigger-eval-dataset.json。已知 3 MISS 为代理评分器词面区分度极限，真模型采样是后续完全体。

### UI 功能域（ui-planner 全量实施）

- **B1 Cycle 时间线**（P0 缺口）：features/cycles/renderCyclesTimeline——每 cycle 一格、当前 ▶ 高亮、历史格不加裁决（诚实边界：state 端点是全局单份状态机，不伪造历史 PASS/FAIL）；4s 轮询；真机「Cycle 时间线（65 轮）· 最新 cycle-99 · 下一轮 cycle-100」实渲染。
- **B5 a11y 高危**：PREFS_PANEL_ID 固定串多实例碰撞 → 基础名+实例序号（useId 因 offline-smoke stub React 只提供 4 hooks 不可用，模块计数+useRef 惰性初始化等价实现——首渲染同步求值）；节点详情抽屉关闭按钮（复活死键 panel.detailClose）+ Esc + autoFocus + 关闭后焦点还原图区。
- **B4 组件整合**：components/ 五件（sectionShell 64/statusDot 69/dataRow 79/usePanelFetch 88/sectionIds 35）——7 处分区壳、2 份脉冲 keyframes、5 处语义色三元、双套轮询（useInvocations 2s/usePolledSection 4s）全部收敛为 usePanelFetch；usePolledSection 删除。主面板 249→239 行。
- **B6 i18n**：flows labelKey（FLOWS 表加 labelKey 字段 + prefsDrawer/renderFlows 两条渲染路径统一走 t()）+ renderDiagnostics PASS/FAIL 字面量 → 现成 diag.pass/fail 键 + 11 死键清理（prefs 分组抽屉组，双侧同步）。

### 文档债务清偿（P1-1/P1-2 全收口）

- CHANGELOG 补 v0.12.0-v0.17.0 六条（git show 逐提交核实版本号/日期，内容从各 cycle 交付清单转录）。
- docs/agents/API参考.md 端点总索引 47→60（与源码 pwsh 去重实测 BIDIRECTIONAL MATCH）+ 四分册补全（flows 域 9 端点/invocations/autonomy-downgrade/tech-debt list+consume）+ fix-loop 过时描述修正（旧文「只查文件存在」vs 现源码 verifyLedger 哈希链校验）。
- README 18 工具对齐 + docs/anic/04 补 §8b M11-M15 对照表与 §8c R3 阶段 1-5 完整表 + docs/anic README 地图补 17 号 + 16 时点快照声明 + 17 双 §8 编号修复 + 质量属性文档动态措辞 + docs/agents/README 登记四份 cycle-16 研究报告索引。

### 结构守卫

- 250 行三连拆：skillInvoker(272→163+91 skillInvokerAsync) / toolsSkillGateway(254→154+104 toolsBootstrapGateway) / WorkflowGraphPanel(249→239)。truthAudit T3 全绿。

### 验证

- typecheck exit 0；**run-tests ALL GREEN（validate 12/12 · vitest 74 文件 888 用例 · smoke 21/21 · trigger-eval PASS）**。
- 真机网页端（3080）：J0 8/8；DevTools 用户旅程 12 项：ANIC 面板 179 节点/Cycle 时间线 65 轮/producedBy 标注/org 全景（账本 84 条 ✓ 信任分 G2 95% → L4）/5 流程状态机卡/**DSH 模型真调 anic_status(21ms)+anic_snapshot(6ms)——实时调用流 2 条即时捕获 + 宿主轨迹页完整记录**（动态白盒双通道闭环，「轨迹要有插件调用」核心要求验证）。
- 桌面端：junction 修复+dist 构建+lock 刷新；宿主承载当前会话不可重启（与 cycle-15 P2-4 同款结构约束，下次自然重启生效后补 J0）。

## v0.17.0 — 2026-10-17

cycle-15：**P0-DIR-ROOT 布局根解析统一**（pluginRoot 标记驱动向上查找）+ **两枚潜伏缺陷根除**（band-detector 越界变量 / eval-runner fail-open）+ E1/E2 自举诚实化。测试 71 文件 863/863 全绿。真实宿主复验：truth-audit overallScore 17→**100**（修复前审计的是仓库父目录）、dual-evaluate 双向真实数据、J0 8/8。

### P0-DIR-ROOT：truthAudit/dualBootstrap 双布局从未正确工作（cycle-15 发现并修复）

- **根因**：truthAuditRoute 的 `resolve(file,'../../../')` 在 dist 单文件布局下解析到**仓库父目录** `D:\Projects\TraeProjects\`（T1 42 findings 全 MISSING、T2 version `vunknown`、agent card 0、overallScore≈17）；源码布局下也错（落到 `src/`）。同病：routes/index.ts 双向自举 `new URL('../../../')`。旧测试只断言路由注册，故恒绿。
- **修复**：新建 `src/host/pluginRoot.ts` 标记驱动向上查找（package.json name=dsh-anic，MAX_WALK_UP=10，损坏 package.json 容错）；truthAuditRoute/dualBootstrapRoute/routes/index/agents/skillRegistration 四处调用点统一；根未解析时双路由显式 500（`ANIC_PLUGIN_ROOT_UNRESOLVED`），绝不静默审计错误目录。
- **回归钉死**：pluginRoot.test.ts 9 用例（dist/src 双布局 + junction + 深嵌套 + 损坏 pkg 容错 + 无标记 + name 不匹配）+ truthAuditRouteBehavior.test.ts 2 用例行为级（修复前必红：T2 version=真实版本、15 cards）。

### D-1415：两枚同型漏网（收口期发现）

- **band-detector.mjs:141 越界变量**：规则 2 的 push 引用规则 1 循环的 `v` → ReferenceError，仅规则 2 真触发时崩（历史快照统计量漂移使其「时好时坏」）。修复：`value: dataPoints[i]`，3 跑全确定性。
- **eval-runner checkComplexity `|| true` fail-open**（D-1404 漏网同型）：band-detector 非零退出（真发现 WE 违例——最需报警时）在 cmd.exe 无 `true` → execSync 抛 → SKIP。修复：execFileSync 直跑非零取 stdout，WE 信号归类 pass+advisory。

### E1/E2 自举诚实化

intent.md 真实意图（替换 init-workflow 模板桩）+ spec.md（docs/anic 八文档索引 + 六面符合判定基准）+ plan.md（12 里程碑索引 + 活跃工作项 + 风险登记）。自举评估 **15 PASS + 1 结构性 SKIP（E5）**——历史最佳。

### 验证

- typecheck exit 0；run-tests ALL GREEN（71 文件 863 用例）；build 成功。
- 真实宿主（3080）：truth-audit **T1-T4 全 100 failCount=0**；dual-evaluate plugin=73（srcFiles=125 testFiles=73 truthAudit=99）/ skill=100；J0 8/8；flows/status 200；Chrome DevTools 面板三断言。
- 桌面宿主 v0.17.0 复验移交下轮（19387 旧进程承载会话，待自然重启）。

## v0.16.0 — 2026-10-17

cycle-14：**自举评估链主平台复活**（D-1401~D-1408）+ **供应链审计修复**（critical×2 + high×1 清零）+ **首次真实环检测自证**。测试 69 文件 852/852 全绿；自举审计 16 维度 14 PASS + 2 SKIP（历史最佳）。

### 自举评估链 Windows 主平台复活（D-1401~D-1406）

eval-runner 质量门在 Windows（DSH 宿主主平台）系统性失明，全部根治：

- **D-1401**：`.cycles/config.yml` 四命令指向 `../node_modules/...`（cycle-1 时代父级布局假设）→ typecheck/test/coverage/e2e 统一改本仓 wrapper 脚本。
- **D-1403/1404**：scanSourceLines 纯 Node 行扫描替换 `grep|wc` shell-ism（恒 SKIP → 真实裁决）；locale/.ts 生态适配。
- **D-1405**：秘钥扫描 138 命中全假阳性（design-token 惯用形态误伤）→ 两段式精筛（pre 粗筛 + 紧邻赋值精筛）。
- **D-1406**：依赖审计 npm audit 无 true 命令恒 SKIP → pnpm audit 回退链（npmmirror 无 bulk 端点 → registry.npmjs.org）。
- **D-1408**：环检测 madge 恒 SKIP 且真环被 `|| true` 吞掉（fail-open）→ importGraph.mjs 纯 Node 相对 import 图 + DFS 三色环检测（零外部依赖）。

### 供应链修复 + 真实环检测自证

- pnpm-workspace.yaml 重写（pnpm 11 不读 package.json pnpm 字段）：tinypool critical×2 + valibot high（全 dev 链）经 overrides 清零，824 包污染锁 → 239 包。
- **自证闭环**：修复后首次真实环检测在自家仓抓到 truthAudit↔truthAuditChecks 真环（type 回边），类型下沉 truthAuditTypes.ts 断环复验 PASS。

### 验证

- typecheck exit 0；run-tests ALL GREEN（69 文件 852 用例）。
- pnpm audit {critical:0, high:0}；G-IND 守卫持续绿（auto-install-peers=false 后 node_modules 无 @deepseek-ai/*）。
- gate-check --record All gates PASSED（G0-G3）；Q4/Q5/Q6/Q7 首次真实裁决全绿。

## v0.15.0 — 2026-10-17

cycle-13：**D-1103 auto-fix 报告双格式解析**（正典管道表 vs 旧键值两套互不相交解析器）+ **F-T1/F-T2 抖动加固**。测试 69 文件 849/849 全绿。

### D-1103：auto-fix 报告计数通道假绿（fail-open 家族）

- **缺陷**：auto-fix 报告计数只认旧键值「失败：N」，而正典模板与 G2 门禁规定的是 §2 汇总管道表「| 失败 | N |」——两套正典解析器互不相交，正典报告被读成 0（fail-open 假绿）。
- **修复（双侧同步）**：技能脚本 auto-fix-loop.mjs（v1.8.5-fork）与原生引擎（autoFixAnalyze.parseReportContent）均支持管道表优先 + 键值回退；引擎侧重复解析器消重为单一源。
- **实证**：差分第 4 场景红→绿（命令过 + 正典报告 3 失败 → 双侧 circuit/exit 2/repeating）；真实宿主（3080）script 模式端到端 409 circuit。

### F-T1/F-T2 抖动加固

- **F-T1**：atomicWriteFileSync rename 瞬时错误（EPERM/EACCES/ENOTEMPTY/EEXIST）1/5/25ms 同步退避重试；非瞬时立即抛。
- **F-T2**：macroPhaseDifferential 等 6 个测试文件补 afterEach/afterAll rmSync（原先每轮泄漏 ~20 个 anic-macro-diff-* 等临时目录）。

### 验证

- typecheck exit 0；run-tests ALL GREEN（69 文件 849 用例）；build 成功。
- fsSafe.test.ts 新增 6 用例（rename-over-existing 60 次连续覆盖 / 无 .tmp 残留）。

## v0.14.0 — 2026-10-17

cycle-12：**终态重入四流程修复**（D-1101）+ **桌面端宿主实证**（D-1102）。测试 67 文件 837/837 全绿。

### D-1101：task 型流程终态后不可重新入轮

- gate-check（PASSED/FAILED→RUNNING）、archive（DONE→RUNNING）、hitl（PASSED/FAILED→RUNNING）三流程补 run 边——下一 cycle 的同名流程是**新的一跑**，不是同一跑的恢复；macro-phase 经正典比对排除（maintain 是末相无 reset 语义，phase 型流程无重入）。
- flowTerminalReentry.test.ts 四层 9 用例：描述子齐全性 / 机器层放行 / 集成层二轮 / 排除钉。

### D-1102：桌面端宿主实证

plugin_manager list_plugins fiberPhase active；anic_snapshot/anic_status 工具真实执行（FlowTracker 历史返回）；org-status/workflow-snapshot 路由 200；plugin_manager 禁用→启用往返无 duplicate-route（R12 HMR 安全性真机实证）。限制项：桌面宿主 10-17 07:50 启动早于当日构建，v0.13.0+ 新面需宿主自然重启生效。

### 验证

- typecheck exit 0；run-tests ALL GREEN（67 文件 837 用例）；桌面端真机五项验证记录见 cycle-12 交付清单。

## v0.13.0 — 2026-10-17

cycle-11：**auto-fix 自动修复循环流程**（R3 阶段 5，第 5 个专属流程状态机）+ **H3 per-gate-latest 双侧修复**。测试 68 文件 813 用例（素材：cycle-11 交付清单；用例总数见该轮 test-report）。真实宿主：flows/auto-fix.json 19 条事件投影完整轨迹 + 真机恒败场景 incident 落盘。

### R3 阶段 5：auto-fix 流程（第 5 流程状态机）

- **autoFixAnalyze.ts**（纯函数层）：报告计数解析 / 失败识别 / repeating-cascading-transient 三模式（技能 mjs:57-140 逐字）。
- **autoFixEngine.ts**（IO+编排）：test→失败识别→retest→判定主循环 + onProgress 逐轮回调。
- **autoFixReport.ts**：落盘三件（审计行 / incident / 修复报告，技能 mjs:142-200 逐字）。
- **autoFixFlow.ts**：IDLE→RUNNING→ITERATING↺→CONVERGED/CIRCUIT；ITERATING 自环轨迹进投影 history（迭代过程可回放）；终态重入边；**第 17 工具 anic_flows_auto_fix** + 路由 POST /anic/flows/auto-fix/run（pass 200 / circuit 409 / 前置错误 400）。
- **差分孪生契约** autoFixDifferential 3 用例（native vs script 逐字段对账）。
- **面板轮询修复**（usePolledSection.ts）：org/flows 分区从静态单拉改 4s 轮询——POST 后 6s 内卡片 CIRCUIT→CONVERGED 实时更新。

### 双 fork 修复（上游技能缺陷，双侧同步）

- **H3 per-gate-latest**：gate-check 去重 × 末 4 条窗口互斥——cycle-10 发现的结构性误熔断（同门多次 PASS 记录互相吞掉），hitl-audit.mjs 与 hitlAudit.ts 双侧同步修。
- **auto-fix-loop readdirSync 未 import**：test-reports 目录存在时 ReferenceError，真机复现修复。

### 验证

- typecheck exit 0；run-tests 全绿；build 成功。
- 真实宿主（验证场）：.cycles/flows/auto-fix.json 19 条事件投影（终态重入 + 恢复路径完整轨迹）；incident ×2（真机恒败场景）；审计行落盘。

## v0.12.0 — 2026-10-17

cycle-10：**HITL 三段修复流程**（R3 阶段 4 后半，第 4 个专属流程状态机）+ 双存量缺陷修复。测试 62 文件 786 用例。真实宿主双模式实证：409 circuit / H3 真实熔断 / BLOCKED→RUNNING 重试恢复边现场触发 / J0 8/8。

### R3 阶段 4 后半：HITL 三段修复流程

- **hitlFix.ts**（177 行）：H1-H4 修复器纯函数逐字对齐技能 hitl-audit.mjs:190-284（H1 .gitignore 模式族追加 / H2 git init 基线或拒绝 / H3 指向 gate-check 或建审计日志 / H4 append-only 永拒——改历史毁哈希链）+ writeHitlIncident（诚实化：不声称 L4→L3）。
- **hitlThreePhase.ts**：Phase0 全审计落审计行 → 无熔断二元判定 → Phase1 仅熔断门修复 → Phase2 全修复成功才重审；fix 失败不重审不落 incident。
- **hitlFlow.ts**（第 4 流程状态机）：IDLE→RUNNING→PASSED/FAILED/BLOCKED + BLOCKED→RUNNING 重试恢复边；投影 flows/hitl.json；**第 16 工具 anic_flows_hitl** + 路由 POST /anic/flows/hitl/run（状态码语义 pass→200 / fail→422 / circuit→409——exit 2 = 需要人类介入）。
- **差分孪生契约** hitlDifferential 4 用例（native vs script 孪生夹具逐字段对账）。

### 存量 P1 连带修复

- `latestCycleDir` 绝对路径 bug（join 碎路径恒 false——H3 审计日志检查自 cycle-5 起从未工作过）。
- J0-2 遥测陈旧（syncTelemetryCounts：live 到达后遥测如实反映渲染面，「渲染=遥测」强不变量）。

### 验证

- typecheck exit 0；run-tests ALL GREEN（62 文件 786 用例）。
- 真实宿主（3080）：native/script 双模式裁决一致（409 circuit / exit 2 / suggestedNextStep=autonomy-fallback / 审计行 4 条落盘）；面板 HITL 卡片实时态；J0-2 circles=50=遥测 nodes=50。

## v0.11.0 — 2026-10-17

R3 路线图阶段 4 前半：**multiAgentTier2 LLM 评审通道**（15 角色真模型评审）+ **流程状态机面板可视化**（flows 分区第 10 开关）+ **Tier-2 真机排障三连环**（桩宿主假绿系列第三批）。测试 713→744 用例（55→58 文件）。真实宿主验证：Tier-2 15 角色全走真 LLM 通道（deepseek-official/deepseek-flash，MISSING_CREDENTIAL 诚实终态）、flows/status 一站式、DevTools 面板三分区实渲染、J0 8/8。

### Tier-2 真机排障三连环（cycle-9 发现并修复）

桩宿主全绿但真机 `/anic/multi-agent-gate` 三连报错——三根因全是「桩契约 ≠ 宿主真实协议」：

1. **「LLM 返回不符合闭合 JSON 协议」**：validateReviewJson 只接受整串严格 JSON.parse；真机响应常含 ```json 围栏或散文前缀。新文件 `src/host/llm/jsonExtract.ts`：extractJsonCandidate（整串→围栏块→花括号平衡扫描跳过字符串字面量）。**闭合 schema 校验不放松**——提取 ≠ 放行。
2. **「（空响应）」**：旧 LlmChunk 契约 `{error:{code,message}}` 在真实宿主不存在。权威类型（dsh-llm types.d.ts:141-146）：流式 chunk 正文是 `type:'text-delta'` 的 `text`（**reasoning-delta 的 text 不是正文**）；错误终点是 `{type:'finish', reason:{kind:'error'|'aborted', failure:{code,message}}}`。reviewTransport 正文收集条件与错误分派全部重写。
3. **「content.some is not a function」**：`messages[].content` 必须是 `ContentBlock[]`（`{type:'text',text}` 数组）非纯字符串（dsh-llm index.js:594 扫 image 块）；系统提示走 `GenerateOptions.systemPrompt` 专用槽位（adapters 映射到 provider system slot）。

### provider/model 诚实解析（新 src/host/llm/providerResolve.ts）

真实宿主 22 条 LLM 路由**全为有名 id，无 'default'**——字面 default 解析必失败。pickProvider（显式指定 > 注册表首条 > 字面 default）+ resolveModel（显式 > 目录首条 > default，**由宿主给诚实错误，ANIC 不猜**）。reviewRoute 响应新增 providers[] 诊断字段（Tier-2 判定依据可见——动态白盒）。

### R3 阶段 4 前半：multiAgentTier2.ts LLM 评审通道

- runAllGatesWithLlm：probe 模式探测 → 零证据门跳过 LLM → 逐门逐角色 runLlmReview → 证据接地纪律（INV-23 幻觉引用过滤 + approve 降 doubt）→ TIER2_CONFIDENCE 映射 → 授权带越界不烧配额 → 单角色失败独立降级（不拖垮整轮）。
- LlmRuntime 契约升级：listProviders 返回 `Array<{id,name?}>` + 可选 `listModels?(provider)→Promise<Array<{id?}>>`（LlmProviderInfo/LlmModelInfo 宿主同形）。

### 流程状态机面板可视化（动态白盒）

- `renderFlows.ts`：三流程行（label + 引擎 + 技能回退 + 当前态 + 最近转移 + 计数汇总）；「从未运行」诚实空态（projection=null 不伪造 IDLE）；data-anic-flows-wrap / data-anic-flow 钩子。
- orgStatus band.weViolations 接线（WeViolation.rule 是 **number 1-8** 非字符串——renderOrgStatus 类型修正）；无违例时不渲染违例分区（诚实空态）。
- `GET /anic/flows/status` 一站式路由；flow.flowsView 第 10 开关；fetchJson.ts 形状守卫（T3 拆分 WorkflowGraphPanel 257→245 行）。

### 验证

- typecheck exit 0；**run-tests ALL GREEN（58 文件 744 用例）**；smoke 全绿；validate 12/12；build 成功。
- 新增测试文件：renderFlows.test.ts（6）/ orgWeViolations.test.ts（5）/ multiAgentTier2.test.ts（8，listProviders 桩改对象形）；reviewEngine.test.ts 扩展 pickProvider（3）+ resolveModel（3）+ validateReviewJson 提取族（散文前缀/围栏/字符串字面量花括号/提取≠放行/不完整左括号）；reviewTransport.test.ts 重写为真实协议形态（errChunk helper + reason.failure 终点 + reasoning-delta 不误收正文，17 用例）。
- 真实宿主（dsh 0.2.0-rc.2 web 3080）：Tier-2 15 角色全走真 LLM 通道（provider=deepseek-official model=deepseek-flash——listModels 目录首条真实解析），终态 error[MISSING_CREDENTIAL]（无头测试宿主无凭据的诚实结果，链路全通）；flows/status 3 流程（gate-check FAILED / macro-phase 从未运行 / archive BLOCKED 6 转移）；org band normal/stable/weViolations=[]；DevTools 面板 flows/invocations/org 三分区实渲染断言；J0 8/8 PASS。
- 桌面端：junction 指向新 dist（含 flows 路由）已确认；宿主进程持旧内存 bundle——承载当前会话不宜重启，P2 债务移交下轮。

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
