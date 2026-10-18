# dsh-anic CHANGELOG

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
