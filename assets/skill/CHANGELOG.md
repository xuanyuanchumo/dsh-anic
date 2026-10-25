# Changelog — ai-native-iteration-cycle

## 2.6.1 — 账本循环身份 + 账本形状归一（cycle-79）

### 修复
- **账本循环身份**（gate-check `--record`）：G1/G2/G3 的 detail 追加 `§cycle-N`。此前去重键 `(result, detail)`
  不含循环身份 ⇒ 跨循环同结论被静默去重（实测 cycle-78 的 G2/G3 仍是 cycle-77 记录，本循环无审计条目）。
  宿主 `gateEngine` 同语义（逐字全等）。
- **账本形状归一**（`lib/ledger.mjs` `readLedger`）：包裹 / 裸数组 / 缺失 / 坏 JSON / 形状不认识五态；
  裸数组不再被误当「0 条 + Valid: YES」（旧实现把 `Array.prototype.entries` 函数当 entries），
  `appendEntry` 不可读时**拒绝写入**（防覆盖历史），`gate-ledger --list/--verify` 明确 `[SKIP] ledger unavailable — 原因`。

### 兼容性
- 无 `--record` 时打印文本不变；合法包裹账本 hash 链校验语义不变；`.` 与 `.dsh` 副本需 repair 同步。

## 2.6.0 — band-detector 告警≠执行失败（cycle-78 WS-B 可观测性诚实化）

### 修复（feat）

- **语义分层**：`band-detector.mjs` 原先在 `WARNING` / Western Electric 违例时也
  `exit 1`（实测 3674 分 / 10 热点 / 65 条 WE 违规 → exit 1）。后果是 **FlowTracker 把
  「报告送达且有告警」记成 FAILED**（本机 flowStats `band-detector 1/1 failed`），
  `analyzeSkillHealth` 据此长期输出 degraded 建议——健康面被噪声淹没。而 WE 规则 7/8
  在近常数过程（σ≈0.16）上必然常亮：**报告内容不该等于执行成败**。
  - **默认（报告模式）**：成功产出报告即 `exit 0`；热点/超预算/WE 违例保留为报告数据
    （文本面原样保留：`OVER_BUDGET`、`WARNING`、`N Western Electric rule violation(s)`
    仍可被 eval-runner / MCP 解析），新增 `Mode: … | alarms: …` 汇总行。
  - **`--strict`（门禁模式）**：`OVER_BUDGET` 或 `WARNING`（hotspots>5）或任意 WE 违例
    → `exit 1`（stderr 点名告警清单），供 CI/硬门使用。
  - **执行失败**仍非零退出并点名原因：项目目录不存在、`.cycles/config.yml` 缺失、
    `.cycles/band-history.json` 损坏或非数组（原先静默 `return []` = 统计基线被悄悄
    清空、WE 规则永不触发）；顶层 `try/catch` 兜住内部抛错。
- 文档同步：`references/scripts-reference.md`（band-detector 小节：`--strict` 参数、
  输出 `Mode` 行、两模式退出码表）、`SKILL.md`（L4 链「复杂度漂移」行）。
- 测试：`tests/contract/bandDetectorSemantics.test.ts`（真跑 spawnSync：默认 0 / strict 1 /
  执行失败非零 + stderr 点名 + 反向自检 + 版本四锚）。

## 2.5.2 — E5 性能基线工件通道（cycle-62 T-6201）

### 修复（feat）

- **E5「性能基线」维自 v1.0 起永远 SKIP**：`eval-runner.mjs` 硬编码
  `skipped('Performance baseline requires a baseline artifact (manual check, none attached)')`
  ——iteration-5 修「无证据记 PASS」时把证据路径焊死为「永远没有」，矫枉过正。
- **升级为工件通道**：项目侧 `.cycles/performance-baseline.md` 在位且含「基线」「阈值」
  关键词 → E5 PASS（带表行计数详情）；缺失/空占位 → 维持 SKIP。三态纪律不变：
  无工件 = 无证据（不是 FAIL——没声明基线不是错误）。
- **判定形状与 checkDeliveryChecklist 同构**（existsSync → 内容关键词），关键词防空文件占位。
- **E5 不跑性能测量本身**——测量由 test_cmd 全量跑时自然发生，工件承载基线事实
  （时间戳+命令+阈值+实测值四要素），避免 eval-runner 嵌套跑测试的递归时序问题。
- 测试：`tests/contract/evalRunnerBaseline.test.ts` 5 用例（工件在位 PASS 带详情/
  缺失 SKIP 指引路径/空占位 SKIP 防绕过/总结行三态如实两态对照/退出码语义）。

## 2.5.1 — 旧号重跑语义备注（cycle-49 T-4902）

### 说明（patch）

- **重跑旧号（`--cycle N` 低于当前号）的表面行为备注**：防回拉守卫保持状态机不动、
  已存在文件不覆写（模板拷贝守卫 `existsSync(dst)` 跳过）、git 内容零变更（cycle-47
  场地实验三重验证：status/diff/log）。文件系统层面目录 mtime 可能刷新——这是
  mkdirSync(recursive) 在部分 Windows 文件系统实现上的一次性元数据副作用，**不涉及
  任何内容变更**（cycle-49 重演不复现，归因为实验窗口内未记录的瞬时动作）。使用方
  以 git 为内容真值源即可，mtime 不构成契约。

## 2.5.0 — init-cycle ↔ workflow-state 联动（cycle-43 T-4302）

### 行为变更（minor）

- **init-cycle 建目录后同步推进状态机**：此前 init-cycle.mjs 只 scaffold 目录+拷模板，
  不写 `.cycles/workflow-state.json`；而 workflow-state.mjs 的 initState 仅在状态文件
  不存在时才重建。两脚本各管半边 → `currentCycle` 漂移（本仓实际受害：cycle-27..41
  期间状态机停在 cycle-26）。修复：scaffoldCycle 尾部调用 syncWorkflowState——
  loadState（损坏 JSON 走重建）→ currentCycle 仅当新号 > 旧号才前移（数值序兜底
  防旧号回拉）→ atomicWriteFileSync 原子写。同号幂等（状态文件字节不动）。
- **新增联动契约测试**：tests/unit/initCycleStateSync.test.ts 7 用例（前移/幂等/
  防回拉/损坏重建/全新形状/标准键集/写盘存在性），对安装副本黑盒驱动。

## 2.4.0 — eval-runner 大输出判定器根修（cycle-40 场地实验 #1）

### 行为变更（minor）

- **ENOBUFS 不再误判为测试失败**：`runTestCommand`/`runLintCommand`/`runBuildCommand`
  的 `execSync` maxBuffer 提升到 8-16MB，并在 catch 里识别 `ENOBUFS`——
  缓冲区溢出 = 判定器看不见完整输出 = 没有证据，按三态纪律记 **SKIP**
  （「无法评估」）而非 FAIL。旧版在大工作区（如 dsh-codegraph-visualizer
  5390 用例、stderr >1MB）上 throw ENOBUFS 后把 e.stderr 首行（恰是 vitest
  DEPRECATED 弃用告警）当失败详情——E3/E8 误报 FAIL 的真根因即此
  （cycle-39 实验报告的归因「弃用告警污染判定」修正为「缓冲区溢出」）。
- **失败详情截断 2000 字符**：catch 分支的 stderr 详情不再全量入报告
  （大输出下报告文件本身也会膨胀）。

## 2.3.0 — quick-validate 网关相对路径自动解析（cycle-39）

### 行为变更（minor）

- **网关相对 skill-dir 自动解析（SKILL.md 跨项目调用契约节）**：`quick-validate`
  从 dsh-anic 插件网关调用时，相对形态 `args: ["assets/skill"]` 此前被 spawn
  cwd（=技能 scripts 目录）解析成 `<scripts>/assets/skill` 幽灵路径而必 404
  （真机 flow #29 实证）。dsh-anic v0.38+ 的网关现在把相对 skill-dir 解析为
  **目标工作区已装副本**的绝对路径再传——文档教的形态从「必失败」变为「可用」。
  直接 CLI 调用不受影响（相对路径语义按进程 cwd 不变）。

## 2.2.0 — 跨项目调用契约与 L4 编排补强（cycle-38）

### 行为变更（minor）

- **新增「跨项目调用契约」节（SKILL.md）**：从插件网关（dsh-anic anic_skill / MCP
  mcp-server）调用本技能时，目标项目目录走**专门的 workspace 参数**（MCP
  `--project-dir` / 网关 `workspace`），**绝不能**把它放进 `args` 数组——网关会把
  workspace 作为第一个位置参数前置，args 再带目录会让脚本收到 2 个位置参数被数量
  守卫拒绝（真机 6 连失败实证）。唯一例外：`quick-validate` 的第一个位置参数本来就是
  SKILL DIR（`assets/skill` 相对形态）。
- **插件网关侧配套（dsh-anic 侧同步）**：`anic_skill` 网关对 args 首位是合法项目
  绝对路径的形态自动重定向到 workspace 参数并在响应中回显 `workspaceRedirected`。
- **任务级派遣编排**（2.1.x 文档补强收口）：auto-cycle.md 的派遣协议表更新——
  派遣记录表落任务清单.md，含 subagent 命名可见（R12）与有界报告要求。
- **自举复检环语义**（auto-cycle.md）：fix 后 VERIFYING 相位**必须真实重跑
  gate-check**（re-gate），复检通过才以新裁决结算——「跑过复检」与「复检通过」
  是两件事，用修复前的裁决结算是伪造复检。

## 2.1.0 — 统一 CLI 参数防护（cycle-27）

### 行为变更（minor）

- **新增共享库 `scripts/lib/args.mjs`（`parseCliArgs`）**：16 个脚本（15 白名单 + mcp-server）
  统一参数形状防护，替代各自手写的 `parseArgs`。三防线：
  ① `--help`/`-h` 短路打印用法 exit 0；② 未知旗标 exit 1 报旗标名；
  ③ 位置参数数量契约（min/max，越界报实收数量与清单）。
  附带：值旗标缺参拒绝、int/float 解析 NaN 拒绝、kebab 旗标名自动映射 camelCase
  （`--max-retries` → `args.maxRetries`、`--test-cmd` → `args.testCmd`）。
- **行为收紧点（诚实列出）**：mcp-server 原先把多余位置参数静默忽略，现拒绝 exit 1
  （此前唯一「容错」点，属静默吞错——统一后全部脚本 fail-fast）；其余脚本零参/多参
  行为与原 usage 分支一致，仅输出格式统一为 `[script] 消息 + usage` 两行。
- **背景**：cycle-25 事故（`--help` 被当位置参数，init-workflow 在 CWD 脚手架出
  `--help/` 目录）——cycle-26 单点根治 init-workflow，本轮全量收敛。
- 技能文件数 64 → 65（新增 `scripts/lib/args.mjs`）。

## 2.0.0 — 分发完整性：安装清单 + sha256 校验 + doctor/repair（cycle-19）

### 行为变更（major）

- **插件侧新增安装清单**：`dsh-anic` 插件在技能安装（`anic_install` / `POST /anic/skill/install`）时
  写入 `.anic-manifest.json`（path+size+sha256+版本锚点）到已安装目录——技能文件本体零变化，
  但**安装目录会多出一个插件私有清单文件**。技能自身脚本不读不写该文件。
- **完整性契约**：`GET /anic/skill/status` 新增 `integrity` 字段（doctor 语义：inline 直比优先、
  manifest 兜底）；新增 `POST /anic/skill/repair`（只重装差异文件，extras 只报告不删除）；
  `anic_status` 工具返回 `skillIntegrity` 摘要。宿主大模型可用这些面回答「技能是否损坏/漂移」。
- 版本 1.9.0 → 2.0.0（三锚点：本文件 / SKILL.md MCP Tools / scripts/mcp-server.mjs）。

## 1.9.0 — 门禁完整性：三态裁决 + 漂移守卫（iteration-5）

### 裁决完整性（行为变更）

- `eval-runner.mjs`：**引入三态裁决 PASS / FAIL / SKIP**。原先"无法评估"（缺主题 / 缺证据 /
  手工项）一律返回 `{ pass: true, detail: '…(skipped)' }`——评估器对**没评估过**的东西记 PASS，
  这正是 fail-open 的入口（屏幕上"没评估"和"评估通过"长得一模一样）。现在统一走
  `skipped()` → `{ pass: false, skipped: true }`；`combine()` 在合取里**传播** SKIP
  （任一 FAIL ⇒ FAIL；无 FAIL 但有 SKIP ⇒ SKIP），不再被外层吞掉；报告行写 `SKIP`；
  退出码只由 FAIL 决定（SKIP 不阻塞运行，否则文档型项目永远跑不完）但**响亮列出**。
- `eval-runner.mjs` 附带三处：`.env` 存在而项目无 `.gitignore` 时 E6 不再静默跳过；
  手工项（无基线工件）不得记 PASS；继承既有报告行时保留三态（否则 SKIP 在下次部分
  运行时被读成 FAIL）。
- `gate-check.mjs checkQualityGate`：**行缺失 / SKIP 不再等于通过**。原先正则只拦 `FAIL`，
  报告缺 Q1/Q5 行（match=null）或写 SKIP 都静默通过——质量门禁**无证据即可关门**。
  现在报 `not evaluated — gate cannot close without evidence`（判 FAIL）。
- `gate-check.mjs checkG0`：存在性 → 完整性（空报告、只有标题的报告不再算"已评估"）。
- `gate-check.mjs checkG2`：报告格式本身是契约（见 `assets/templates/test-report.md` §2
  汇总表），缺表格不再按"0 失败"判 PASS。

### 漂移守卫（新增，错误级）

- `quick-validate.mjs` 新增四类机器守卫。四轮进化里这些漂移每轮都要人工 grep 重扫，
  而且每轮都能扫出新的一层（人读文档 → agent prompt → 机器 schema/hook）：
  1. **版本一致性**：`SKILL.md` 的 `MCP Tools (vX)`、`mcp-server.mjs` 的 Server version、
     `CHANGELOG.md` 顶层条目三处必须一致；锚点找不齐即报错（守卫必须能失败，否则会随
     被守卫物一起消失）。
  2. **配置入口唯一**：脚本代码内不得出现 `.cycles/cycle-config.yml`（唯一豁免
     `lib/config.mjs` 兼容层）；样例字面量按字符串拼接构造，守卫不匹配自身源码。
  3. **原子写**：`lib/fs-safe.mjs` 之外不得直接调用 `writeFileSync(`；另报"死 import"警告。
  4. **词表漂移**：B 族旧维度名只在**与维度编号绑定**的上下文中判罚（同行含 `E1-E8`/`Q1-Q8`
     或 `name:` 绑定）——过宽的规则会把"技术债务"这类正常概念误判成漂移，那正是
     "守卫变成噪音、然后被忽略"的路径。豁免 `references/evaluation.md`（弃用声明本身
     必须提到旧名）与 `CHANGELOG.md`（历史）。

### 词表漂移清零（23 处）

守卫首次运行即抓出 23 处真实残留，全部修正：`assets/templates/eval-report.md`（E1-E8 表）、
`references/project-config.md`（evaluation 段 8 项）、`references/playbook.md`（5 行评估步骤）、
`references/state-transition.md`（G0/G2/G3/H4 的 Q 名）、`references/troubleshooting.md`
（示例改为 E1 意图对齐 / E3 测试覆盖）。

## 1.8.3 — 剩余脚本收口：账本不可变 + 反模式全清（iteration-4）

### 账本完整性（行为变更，P0）

- `archive-cycle.mjs`：**归档不再删改账本条目**。原先按 detail 是否含 `cycle-N` 过滤 entries
  并整文件重写——被删条目之后每条 entry 的 previousHash 都指向已删除条目，下一次
  verifyLedger 必报 CHAIN_BREAK（归档动作本身毁掉整条链）。改为只移动目录，
  账本永不触碰（INV-9：归档不改账本链，docs/anic/05 §4.3 / 08 §3.5）。
- `hitl-audit.mjs` attemptH4Fix：**不再原地改写 entry.detail**。entry 的 hash 覆盖 detail
  字段，改写即 HASH_MISMATCH（"修复"自毁链）。缺失证据必须以新条目补充
  （重跑 `gate-check --record` 或 `gate-ledger append`），历史记录不可变。

### 反模式全清（S-6 字典序/非原子写家族的最后一轮）

- 字典序收敛：`auto-fix-loop.mjs` / `hitl-audit.mjs` / `archive-cycle.mjs`（列表形态 ×2）/
  `workflow-state.mjs` / `org-status.mjs`（连续失败统计 ×1 + 评审摘要 ×1）→ `lib/cycle.mjs`
  新增 `listCycleDirNames()`（数值序列表）。fact-base-verify / plan-sync-check 的
  全目录遍历与顺序无关，不改。
- 原子写收尾：auto-fix-loop（审计日志 ×2/事故/报告）、hitl-audit（审计日志 ×2/事故/
  gitignore/审计表头）、workflow-state（saveState）、org-status（agent 配置/CB3 gitignore）、
  init-workflow（模板/补丁名/仓库记忆 ×3）、init-cycle（模板 ×1）→ `lib/fs-safe.mjs`。
- 配置单入口补齐：auto-fix-loop / hitl-audit 的本地 loadConfig → `lib/config.mjs`
  （缺配置响亮告知；auto-fix-loop 允许 `--test-cmd` 兜底继续）。
- **新增 `lib/tasks.mjs`**：P0-P3 任务表行解析唯一实现。`archive-cycle isCycleComplete`
  原先用整文件 `includes('待办')`（与 G1 修复前同一模板自陷家族），现与 gate-check G1
  共用同一解析器——消灭"G1 说完成、归档说没完成"的分叉。

## 1.8.2 — MCP 面 / hooks 面 / 引用面收口

### 脚本与 hooks（行为变更）

- `scripts/mcp-server.mjs`：`gate_check` 工具补 `record` 输入属性并转发 `--record`
  （**v1.8.0 的记账能力此前经 MCP 不可达**——按 SKILL.md L4 链走 MCP 的 agent 会漏记 FAIL，CB2 熔断失明）。
- `assets/hooks/production-gate.sh` 三处：
  1. `set -e` 下裸 `node gate-check` 失败即终止，`GATE_RESULT=$?` 与定制 FAIL 提示是死代码 → `|| GATE_RESULT=$?` 显式捕获；
  2. `sort` 字典序选最新循环（cycle-10 与 cycle-9 并存时选错）→ `sort -V`（与 gate-check 字典序缺陷同族）；
  3. 交付清单名 `交付检查清单.md` 是第三种拼法（init-cycle 与 multi-agent-gate 均用 `交付清单.md`）→ 对齐 `交付清单.md`。

### 文档与评测（无行为变更）

- `references/evaluation.md`：eval-runner 输出路径/文件名修正（`.cycles/cycles/cycle-{N}/项目评估报告.md`；
  旧文档的 `.cycles/cycle-{N}/eval-results.md` 两处都错）。
- `references/gates.md`：门禁流转一节补 `--record` 自动登记语义（FAIL 也记，CB2 依赖）。
- `README.md` 快速启动第 5 步补 `--record`。
- `evals/trigger-eval.json`：第 7 条查询的"E3 技术债务"改"E7 文档同步"（旧 B 族词表残留）。

## 1.8.1 — 评测面与引用文档收口（无脚本行为变更）

### 文档

- `references/scripts-reference.md`：gate-check 参数表补 `--record`（去重 + FAIL 也记 + CB2 依赖说明）。
- `references/auto-cycle.md` Phase 5：门禁行改 `--gate all --quality --record`；"全部通过 → 记录到 gate-ledger"
  更正为"门禁记录已在 --record 时写入账本"（原描述与 1.8.0 的自动记账机制矛盾——按旧文档走会漏记 FAIL）。
- `references/state-transition.md` 常用命令表：gate-check 行补 `--record`。

### 评测

- `evals/evals.json` 7 → **10 条**：新增 id8（G1 任务表行解析 + `--record` 去重，对应契约场景 G1/R1）、
  id9（纯中文 intent 通过意图门，对应 W1）、id10（空账本 verify 显式注记，对应 V1）——
  技能自带评测面自此与 15 场景契约套件对齐。

## 1.8.0 — 结构进化 iteration-2（修 N-1/N-2/N-3/N-4/N-5/N-6/N-7/N-8a/N-9/N-11）

> 进化依据：端到端 A/B 评测（`docs/anic/10-技能进化记录.md` §4）暴露的 10 处发现中，
> 取高价值且低风险的 8 项修复；关键词计数评审的语义局限（N-10）按设计保留到插件层解决。

### 修复

- **N-1 G1 模板自陷**：`gate-check` 的 G1 原对 `任务清单.md` 整文件 `includes('待办')||includes('进行中')`
  ——模板自带的状态约定图例（"待办 → 进行中 → 完成"）永远触发 FAIL，必须手删图例才能过门。
  现解析 P0-P3 任务表行（首列非空且末列为状态值的行）：无任务行报
  `No task entries found`，有行则按未完成数判定 `N of M tasks not completed` / `All N tasks completed`。
  模板图例不再参与判定（`assets/templates/task-list.md` §7 同步改写）。
- **N-2 门禁结果不入账本**：`gate-check` 新增 `--record`——每次判定结果经 `lib/ledger.appendEntry`
  写入账本（带去重：同门最新一条 result+detail 相同则跳过并提示 `unchanged, not re-recorded`，
  防重复运行污染链；FAIL 也记录，`org-status` CB2 熔断依赖 FAIL 记录）。
  SKILL.md L4 链同步改为 `gate-check.mjs --gate all --quality --record`。
- **N-3 中文词数低估**：`multi-agent-gate` 的 `countWords` 原按 `\s+` 切词，纯中文意图文档按空格切
  只得 1-3 个"词"，永远过不了 50 词门槛。现中文按字计数（CJK 区段），非中文按词计数。
- **N-4 快速启动缺步骤**：SKILL.md 快速启动补第 7 步 `init-cycle.mjs`（此前漏写，
  直跑 `eval-runner` 必报 No cycle directory）。
- **N-5 troubleshooting 路径错误**：`.cycles/cycle-{N}/` → `.cycles/cycles/cycle-{N}/`（3 处），
  G1 症状段按新判定重写。
- **N-6 `--name` 不落盘**：`init-workflow --name <n>` 现写回 `config.yml` 的 `project.name`。
- **N-7 模板清单漂移**：`scripts-reference.md` 的 init-cycle 模板 5 → 7 个
  （补 交付清单.md、非功能验证报告.md）。
- **N-8a 评估报告覆盖**：`eval-runner` 部分维度运行（`--dimensions`/`--quality`）时不再整文件覆盖
  既有报告，未运行维度从既有报告行继承（输出 `merged: N dimension(s) inherited`）。
- **N-9 空账本误导**：`gate-ledger --verify` 空账本时在 `Valid: YES` 后加注记
  `ledger is empty — no gate results recorded yet. "Valid" only means no tampering.`
  （"没被篡改"不再冒充"跑过门禁"；N-8b 空账本放行问题由 N-2 的 --record 从源头补记录）。
- **N-11 计数歧义**：`multi-agent-gate` Result 行 `PASS (3/2)` →
  `PASS (3/3 agents, threshold 2)`。

### 测试

- 契约套件 11 → 15 场景（新增 G1/W1/R1/V1），新旧两版各 15/15 通过：
  新版全部按新契约，旧版复现全部缺陷（含旧版 `--gate bogus` → NaN 信任分 + exit 0）。

## 1.7.0 — 结构进化 iteration-1（修 S-1/S-2/S-5/S-6/S-7/S-10/S-11）

> 进化依据：`docs/anic/09-结构优化与逻辑重构设计.md`（结构缺陷 S-1..S-11 取证）。
> 本轮不新增功能，只消灭结构性缺陷；所有 CLI 输出格式保持向后兼容。

### 新增：共享库 `scripts/lib/`（词表与机制单一来源）

- `lib/config.mjs` — 唯一配置入口 `loadProjectConfig`：canonical `.cycles/config.yml`，
  旧名 `.cycles/cycle-config.yml` 兼容读取但打印弃用告警；缺文件响亮失败（错误提示指向正确文件）；
  `getYamlString`/`getYamlInt` 引号容错 + 行尾注释剥离；`getAutonomyLevel` 引号容错。
- `lib/dimensions.mjs` — E1-E8/Q1-Q8 16 维注册表（id→名称唯一来源）+ `resolveDimensions`
  （未知维度抛 `UNKNOWN_DIMENSION` 并列出合法值）。
- `lib/ledger.mjs` — 账本 load/save/appendEntry/verifyLedger 唯一实现；
  `saveLedger` 原子写（temp+rename）；entry 六字段键序不变（既有账本哈希链完全兼容）。
- `lib/cycle.mjs` — `getLatestCycleDir` 数值序取最新 cycle（修 `cycle-9` > `cycle-10` 字典序缺陷）。
- `lib/fs-safe.mjs` — `atomicWriteFileSync`。

### 修复

- **S-1 配置发现路径漂移**：`init-workflow` 只创建 `.cycles/config.yml`，而 `eval-runner` /
  `gate-check` / `band-detector` 原先读的是从不存在的 `.cycles/cycle-config.yml`
  （缺文件时 eval-runner 静默返回空 → 测试维度恒 FAIL、
  lint/build 维度恒 PASS；gate-check exit 1 且错误提示自相矛盾）。现统一走 `lib/config.mjs`。
- **S-5 信任分伪造验证**：`multi-agent-gate` release 门 gatekeeper 原以 `existsSync(ledger.json)` 冒充
  "ledger verified"（篡改/断链账本照样放行）。现调用真 `verifyLedger` 链校验，detail 记录
  `ledger chain verified (N entries)` / `ledger-chain-broken(HASH_MISMATCH,…)`，agent 结果带
  `source: deterministic-chain-verify`。
- **S-6 非原子写**：账本/报告/状态写入全部改 `atomicWriteFileSync`（崩溃不再留下半截 JSON）。
- **S-7 自主降级正则改写**：`org-status auto-fallback` 原以 `content.replace(/autonomy_level:\s*L4/…)`
  改写配置——引号写法 `autonomy_level: "L4"` 时正则不匹配 → 配置保持 L4 但日志/事故记录称"已降级"；
  且降级成功与否与记录解耦。现走 `applyAutonomyDowngrade`：引号容错匹配 → 原子写 → **回读再解析**
  （Post-Verify），事故记录按回读事实写；写不生效时记录 `HUMAN INTERVENTION REQUIRED IMMEDIATELY`。
- **S-11 未知标识符静默丢弃**：`eval-runner --dimensions E9` 原静默过滤（空集 → exit 0）；
  `gate-ledger --gate G9` 原把任意字符串写进哈希链；`multi-agent-gate --gate bogus` 原打印错误后
  `continue` → 空结果 → NaN 信任分 + exit 0。现全部 exit 1 并列出合法值。
- **S-8 正则即接口（部分）**：build/test/lint/complexity_budget/autonomy_level 解析统一收敛到
  `lib/config.mjs`（各脚本不再各写一份正则）。
- **字典序缺陷**：`eval-runner` / `gate-check`（G0/G1/G2/质量门）/ `multi-agent-gate` 取最新 cycle
  统一走 `lib/cycle.mjs` 数值序。

### 文档对齐（S-2 / S-10）

- `references/evaluation.md`：E 维词表对齐声明（注册表 A 族名称唯一有效，B 族旧称废弃）；
  报告示例表改用注册表名称。
- `references/quality-review.md`：Q→E 映射表改用注册表名称。
- `assets/config/config.example.yml`：evaluation 段名称与注册表对齐。
- `SKILL.md`：L4 操作链补入 `band-detector.mjs`（S-10：原先不在自动化链上）；
  新增"结构契约"节；版本 v1.5.0 → v1.7.0（与 mcp-server 1.6.0 漂移一并收口）。

### 行为变更（有意，响亮失败原则）

- 缺 `lint_cmd` / `build_cmd`：由 `{pass:true, '(skipped)'}` 改为 **FAIL**（无法评估不得记 PASS）。
- 未知维度 / 未知门 / 缺失配置：由静默降级或伪通过改为 **exit 1 + 合法值清单**。
- 既有 `.cycles/` 数据零迁移：账本哈希算法、entry 字段、CLI 输出格式均不变；
  旧账本若有 genesis 断链（首条 previousHash 非空），行为与旧版一致。

## 1.6.0 — MCP Server 版本号（未同步 SKILL.md）

- mcp-server.mjs 版本号 1.5.0 → 1.6.0（当时未同步 SKILL.md，属版本漂移来源之一）。

## 1.5.0 — 初始发布基线

- 16 脚本 + MCP Server + 15 references + 模板/钩子资产。
