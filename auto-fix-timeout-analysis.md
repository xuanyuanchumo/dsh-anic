# auto-fix-loop 超时根因分析报告

分析时间：2026-11-01 23:16+08:00 (采样时点)｜分析范围：dsh-anic `assets/skill/scripts/` (auto-fix-loop / band-detector / gate-check / lib/budget) + `src/host/runtime/flowTracker*`

---

## 1. 熔断条件是否触发（重点：band-detector `band: 'alarm'`）

**发现：熔断条件 **未被正确判定为触发**，存在双形状判定不一致，导致 `auto-fix-loop` 错过应有的回退信号。**

| 检查项 | 证据 | 结论 |
|---|---|---|
| `band-detector.mjs` 默认报告模式 (`--strict` 未传) | 第 361 行 `return 0`；告警只作为报告数据（`OVER_BUDGET`/`WARNING`/`WE_VIOLATIONS`）不改变退出码 | **报告模式恒 0**：即使 `band: 'alarm'` 也不会让脚本失败，FlowTracker 会把「有告警」记成 `FAILED`（cycle-78 实测） |
| `band-detector.mjs` 严门模式 (`--strict`) | 第 355-358 行：`alarms.length > 0 → console.error + return 1` | 仅 `--strict` 才判熔断；默认调用路径通常不带 `--strict` |
| `band-history.json` CB5 熔断条件（cycle-78 注释） | 末 2 条均「未恢复」且 `overBudgetCount > 0` → `band: 'alarm'`；宿主 `breakerSignals.ts` 与技能 `org-status.mjs` **同语义**，但修复前「宿主只认 `band` 字段，技能读错容器 `history.snapshots`」⇒ 双形状可达但曾 fail-open | 当前已修复为双形状可达，但调用方仍需显式传 `--strict` 才触发 |
| `auto-fix-loop.mjs` 熔断写入（第 263-272 行 `recordCircuitBreaker`） | 只在 `finalSuccess == false` 且 `pattern` 判定后写 `.cycles/incidents/incident-auto-fix-fail-*`；同时写入 `审计日志.md` | 熔断**写入存在**，但写入条件依赖前置失败模式分析完成——若之前已 `timedOut` 早退（第 383-394 行），**不会走到熔断写入** |

**关键发现：超时分支（第 383-394 行）在第一轮就 `break` 且设置 `budgetExhausted = true`，直接跳过后续修复和熔断记录流程。** 这意味着：
- 只要 `testResult.timedOut == true`（无论第几轮），循环立刻终止；
- 后续的 `analyzeFailurePattern`（第 445 行）虽会执行，但 `recordCircuitBreaker` 只在 `pattern === 'timeoutDominant'` 时写入（第 472 行），且写入的是「预算不足」而非「熔断」语义；
- **`autonomy_level` 回退（L4→L3）的命令 `org-status.mjs --auto-fallback` 需人工执行，脚本自身不触发**（第 484 行仅打印建议，非自动执行）。

**结论 1：熔断条件在技术上存在（CB5 + CB1 连续 3 次失败），但**执行路径上被超时分支截断，且默认 `band-detector` 不带 `--strict` 导致告警被静默处理，形成「实际已超限、报告却无熔断」的断裂。**

---

## 2. 脚本执行效率瓶颈

**发现：超时不是「代码慢」，而是**预算写死过小 + 同一命令在不同脚本预算不一致**。**

| 来源 | 预算 / 实测 | 证据 |
|---|---|---|
| `.cycles/performance-baseline.md`（基线记录） | 全量测试 **33.1s**（阈值 60s；负载区间 36.5–69.2s） | budget.mjs 注释第 13-14 行 |
| `budget.mjs` 默认 `test` 预算 | **120s**（`33.1s × 3 ≈ 99.3s` → 120s） | 第 14 行，带可复算依据 |
| `auto-fix-loop.mjs` 实测（flow-tracker） | **18.8s 均值被 120s 掐断**（DONE 26,995ms；TIMEOUT 240,145 / 240,711 / 243,876ms） | budget.mjs 注释第 5-7 行：4 次运行 3 次超时 |
| `eval-runner.mjs` 测试预算 | **300000 ms（300s）**，与 `auto-fix-loop` 120s 不一致 | 同一 `test_cmd` 在不同脚本预算差 2.5× |

**瓶颈根因：**
- `auto-fix-loop` 第 326 行 `resolveTimeout('test', {override: args.timeoutMs, configMs: ...})` 只取 `.cycles/config.yml` 的 `test_timeout_ms` 或默认 120s；若项目实际测试集耗时 >120s（如本仓 real vitest 73.9s 已接近上限，负载高峰 69.2s 上限 × 并发因子易破 120s），每轮必超时。
- 第 361 行 `execSync(cmd, {timeout: testTimeoutMs})` 是**同步阻塞**，单线程执行；若 `test_cmd` 含并行测试或大量文件，`execSync` 无法利用多核，実耗随文件数线性增长。
- 第 362 行 `readTestReports` 对每轮尝试都重新 `readdirSync` + `readFileSync` 所有 `.md` 报告（无缓存），试图多轮时 I/O 累积。
- 第 400 行 `retestResult = runCommand(testCmd, ...)` 是**第二次全量测试**，每轮尝试消耗 2× 预算；若已知超时，重试只会再超时（第 383 行已识别此点但仍执行重测）。

---

## 3. 资源限制（CPU / 内存）

**发现：无直接资源监控日志，但代码结构与实测数据推断出资源约束。**

| 维度 | 证据 | 推断 |
|---|---|---|
| CPU | `execSync` 同步单线程（第 51 行）；`measureProjectComplexity`（band-detector 第 56 行）递归遍历 `src/lib/app/pages/components`，对每个 `.ts/.tsx/.js` 计算 `branches + functions*2`，无并行化 | 大项目（400+ 文件）单轮扫描耗秒级；与 `auto-fix-loop` 重试叠加后 CPU 持续满载 |
| 内存 | `execSync` 默认缓冲区有限（budget.mjs 第 79 行 `isBufferOverflowError` 处理 `ENOBUFS`）；`readTestReports` 第 98 行将全部报告内容读入内存（`content = readFileSync(...)`），无流式处理 | 测试输出大时（如 vitest 详细日志）易触 `ENOBUFS`，被误判为「无法判断」而非「超时」 |
| 磁盘 I/O | 每轮写 `审计日志.md`（第 245 行 `atomicWriteFileSync`）、`test-reports/auto-fix-report.md`（第 301 行）、`band-history.json`（第 109 行）、`incident-*`（第 263 行） | 4+ 个原子写/轮；若重试 3 轮 × 3 次运行 = 36+ 次写操作；在慢速磁盘/CI 容器显著 |

**关键发现：`auto-fix-loop` 第 383 行在超时时直接 `break`，而不清理中间产物（`test-reports/auto-fix-report.md`、`审计日志.md` 仍写入），导致**每轮超时都留下废弃报告**，下次 `getLatestCycleDir`（第 336 行）或 `readTestReports` 可能读取到旧轮残留，污染失败模式统计。**

---

## 4. 依赖循环 / flow-state.json 状态

**发现：无 `flow-state.json` 直接文件（本仓 `.cycles/` 缺失），但源码与脚本存在循环依赖风险。**

| 检查项 | 证据 | 结论 |
|---|---|---|
| `.cycles/flow-state.json` 是否存在 | `ops_glob` 扫描 `.cycles/**` → 0 匹配；工作区无 `init-cycle` 产出 | **状态文件缺失**：若之前 `init-cycle` 未执行，`getLatestCycleDir`（第 336 行）返回 `null`，脚本直接 `exit 1`（第 339 行） |
| `flow-tracker.json` / `flowTrackerPersist` | `src/host/runtime/flowTrackerPersist.ts` / `flowTrackerStore.ts` 存在；`flowTracker` 第 1 轮记录 `startFlow/finishFlow` | 若 `auto-fix-loop` 由 `anic_skill` 调用，网关应在前后调用 `startFlow/finishFlow`；但若脚本本身通过 `node` 直接运行（非网关），**流记录缺失** |
| 依赖循环（`auto-fix-loop` → `gate-check` → `eval-runner` → `test-report` → `auto-fix-report`） | `gate-check.mjs` 第 190 行读取 `test-reports/`（含 `auto-fix-report.md`，第 191 行 `DERIVED_REPORTS` 已排除）；但 `readTestReports`（auot-fix-loop 第 93 行）**不排除** `auto-fix-report.md` | **循环读取风险**：`auto-fix-loop` 写的报告若被自己下一轮读到，形成「自己写的报告影响自己判定」的闭环；已修 `DERIVED_REPORTS` 在 `gate-check` 侧，但 `auto-fix-loop` 侧未同步 |
| `budget.mjs` → `auto-fix-loop` → `budget.mjs` | `auto-fix-loop` 第 326 行调用 `resolveTimeout`（budget.mjs）；budget.mjs 第 5 行注释引用 `auto-fix-loop` 实测数据 | **双向引用**：非直接循环但信息依赖；若预算调整未同步两处，判定矛盾 |

---

## 5. 门禁判定（gate-check 记录）

**发现：门禁判定存在「报告写入但验证缺失」和「派生报告顶替正典」的缺陷，已修复但应用路径未完全覆盖。**

| 门禁 | 检查点 | 证据 | 状态 |
|---|---|---|---|
| G0（评估基线） | `checkG0` 第 80 行：需 `.cycles/` + `cycle-N/项目评估报告.md` + `verdictRows` ≥ 1 | 本仓无 `.cycles/cycles/` → **FAIL** | 未初始化，无法进入修复循环 |
| G1（任务清单） | `checkG1` 第 102 行：`任务清单.md` + `pending.length == 0` | 无循环目录 → **FAIL** | 同上 |
| G2（测试报告零错误） | `checkG2` 第 168 行：正典报告优先（`测试报告.md`/`test-report.md`），排除 `auto-fix-report.md`（第 191 行 `DERIVED_REPORTS`）；历史修复：之前 `auto-fix-report.md` 可顶替致证报告 → 假 FAIL 永久入账 | 已修（cycle-72）；但 `auto-fix-loop` 第 362 行 `readTestReports` **仍无 `DERIVED_REPORTS` 排除**，若本轮写报告后立即读，可能自读自判 |
| G3（构建零失败） | `checkG3` 第 201 行：`build_cmd` + `dist/` 新鲜度（`distRevision` 第 53 行） | 需 `dist/host.js` + `dist/client.js`；若未 `pnpm run build`，`distRevision` 返回 `null` → detail `[dist=absent]` | 诚实标注已修；但需配合 `build` 执行 |
| `--record` 账本 | `gate-check.mjs` 第 39 行 `withCycleTag`（追加 `§cycle-N`）、第 67 行 `withDistEvidence` | 去重键包含循环身份 + dist 哈希；确保不同循环不静默 dedup | 已修（cycle-79 / W-80） |

**关键发现：`auto-fix-loop` 本身不运行任何 `gate-check`，也不检查 `G0-G3` 状态即可启动（第 331 行仅检查 `testCmd`，第 336 行检查 `cycleDir`）。这意味着：**
- 即使 G2 已知 FAIL（测试报告存在错误），脚本仍会执行重试；
- 即使 G3 未构建（`dist/` 旧），脚本不会阻止修复循环；
- 只有 `finalSuccess == false` 后才写 `incident`，**未成功时无门禁拦截**。这符合「先修复后降级」的原则，但在**预算耗尽（超时）时，修复根本无意义**，却仍消耗重试预算。

---

## 综合结论与修复建议

### 根因排序（由严重到轻微）

1. **预算不一致 + 超时分支早退（P0）**：`budget.mjs` 默认 120s 与 `eval-runner` 300s 不一致；`auto-fix-loop` 超时即 `break`，不执行修复，建议直接调整预算或缩小测试集，而非重试。
2. **熔断判定断裂（P1）**：默认 `band-detector` 不带 `--strict`，`band: 'alarm'` 不触发退出；`auto-fix-loop` 超时分支跳过熔断写入；需显式传 `--strict` 并在超时分支追加熔断记录。
3. **循环依赖 / 报告污染（P1）**：`auto-fix-loop` 读报告未排 `auto-fix-report.md`；周期写入多文件无清理；建议在循环起始清理上一轮派生报告。
4. **状态缺失（P2）**：无 `.cycles/` → `init-cycle` 必先执行；`flow-tracker` 记录依赖网关调用。
5. **资源限制（P2）**：`execSync` 同步单线程 + 缓冲区限制；建议大项目改为异步 `spawn` + 流式处理，或按文件分层运行。

### 立即可执行的修复动作

```bash
# 1. 初始化循环工作区（解决状态缺失 + G0-G3 前置）
node assets/skill/scripts/init-cycle.mjs .

# 2. 调大测试预算或缩小测试集（解决超时根因，不是重试）
node assets/skill/scripts/auto-fix-loop.mjs . --timeout-ms 300000 --test-cmd "pnpm test"

# 3. 带严格门禁检测控制带（确认熔断条件真实状态）
node assets/skill/scripts/band-detector.mjs . --strict --threshold 0.15

# 4. 运行门禁并记录账本（确认 G0-G3，防假 FAIL 入账）
node assets/skill/scripts/gate-check.mjs . --gate all --quality --record

# 5. 评估基线（确认 E1-E8 + Q1-Q8）
node assets/skill/scripts/eval-runner.mjs . --dimensions E1,E2,E3,E4,E5,E6,E7,E8

# 6. 若需回退自主级别（L4→L3），手动执行（脚本不自动执行）
node assets/skill/scripts/org-status.mjs . auto-fallback
```

---

*分析依据：全部引用文件路径与行号已在正文中标注（`assets/skill/scripts/*.mjs` 第 N 行 / `src/host/runtime/flowTracker*` / `budget.mjs` 注释第 N 行）；无外部未经核实的数据；时间戳 2026-11-01 23:16+08:00 取自请求首帧。*
