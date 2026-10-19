# dsh-anic API 参考 · 自举与技能

> 本册覆盖 **self 域**（自举 evaluate / gate-check / iterate / status、技能 skill、安装 install）与 **dual 域**（双自举 evaluate / advance / status），共 13 个端点，另附 `truth-audit`（合计 14）。
>
> 公共约定见 [API参考.md](API参考.md)。读取本文件的时机：调用或修改自举循环、技能脚本网关、技能安装端点时。

## 1. self 域 · 自举循环

`src/host/routes/selfBootstrapRoute.ts`（204 行，最长的路由文件）。注册签名 `registerSelfBootstrapRoutes(ctx: SnapshotCtx, send: SendFn): Array<(() => void) | null>`。

**本域与其他域的三个关键差异**：

1. **用 `resolveWorkspaceRoots(ctx)`（含 `process.cwd()` 回退）**，无工作区返回 **500** `{ error: 'no workspace' }`（不是 404）。
2. **依赖已安装的 skill 脚本**：`resolveSkillScriptsDir(roots)` 为 null 时返回 404 `{ error: 'skill scripts not found' }`。这是与 native 域的本质差异 —— native 域用原生 TS 实现，不需要脚本。
3. **本域会真正执行子进程**（`invokeSkillScript`，超时 60000ms）。

**两个解析辅助函数的正则形状是契约**：

```ts
parseEvalScore(stdout)   // /(?:Overall\s+)?score[:\s]+([0-9.]+)/i
parseGateVerdict(stdout) // /(?:Overall|GATE|Verdict)[:\s]+(PASS|FAIL|doubt|SKIP)/i  → 无匹配则 'unknown'
```

`getLatestCycleDir(cyclesDir)` 扫 `<cyclesDir>/cycles` 下匹配 `/^cycle-\d+$/` 的目录，降序取第一个。

### 1.1 POST `/anic/self/evaluate`（`selfBootstrapRoute.ts:62`）

**执行**：`invokeSkillScript(scriptsDir, 'eval-runner', [], roots, 60000)`

**副作用**：持久化 `status: 'EVALUATING'` 与 `lastEvalScore`。

**响应 200**：`{ exitCode, score, stdout, stderr, timedOut, durationMs }` —— `stdout` 截断到 **4000** 字符，`stderr` 截断到 **2000** 字符。

### 1.2 POST `/anic/self/gate-check`（`selfBootstrapRoute.ts:92`）

**执行**：`invokeSkillScript(scriptsDir, 'gate-check', ['--gate', 'all', '--quality', '--record'], roots, 60000)`

**副作用**：持久化 `status: 'GATE_CHECKING'` 与 `lastGateVerdict`。

**响应 200**：`{ exitCode, verdict, stdout, stderr, timedOut }`（同样 4000 / 2000 截断）。

**`--record` 意味着本端点会写账本** —— 它不是只读的。

### 1.3 POST `/anic/self/iterate`（`selfBootstrapRoute.ts:124`）

**Body**：`{ maxRounds?: number }`，默认 **3**。

**状态重置**：若当前 status 是 `CONVERGED` 或 `EXHAUSTED`，先用 `initialBootstrapState(maxRounds)` 重置。

**循环**：EVALUATING → GATE_CHECKING → FIXING。verdict 既非 `PASS` 也非 `approve` 时，**只写提案不写代码**：

```
<cyclesDir>/tech-debt/self-bootstrap-round-{round+1}.json
{ action: 'REVIEW_REQUIRED — no auto code modification (R-31)' }
```

**R-31 是本端点最重要的约束**：自举循环**绝不自动修改代码**，只产出待评审的提案 JSON。改动前必须保留这一性质 —— 自动改代码会让整个 R-31 安全边界失效。

随后 `advanceBootstrap(state, evalScore, gateVerdict, fixApplied)`。

**响应 200**：`{ status, round, maxRounds, evalScore, gateVerdict, fixApplied, techDebtProposals, converged, exhausted }`。

### 1.4 GET `/anic/self/status`（`selfBootstrapRoute.ts:196`）

**响应 200**：`loadBootstrapState(cyclesDir)` 的**原始对象，无信封**。因此响应形状随 `BootstrapState` 演进而变，消费方不应假设固定字段。

---

## 2. skill 域

`src/host/routes/skillRoute.ts`。注册签名 `registerSkillRoutes(ctx: SnapshotCtx, send: SendFn): Array<(() => void) | null>`。

### 2.1 GET `/anic/skill/list`（`skillRoute.ts:35`）

**响应 200**：`{ scripts: listSkillScripts() }` —— 可用脚本名列表。

### 2.2 POST `/anic/skill/invoke`（`skillRoute.ts:40`）

**Body**：`{ script: string; args?: string[]; workspace?: string; timeout?: number }`

**timeout 夹取**：`Math.min(body.timeout, 120000)`，默认 `30000`。

| 码 | 条件 | 体 |
| --- | --- | --- |
| 400 | `!script \|\| !isAllowedScript(script)` | `` { error: `Unknown script: ${script}. Allowed: ${listSkillScripts().join(', ')}` } `` |
| 400 | `validateWorkspace(workspace)` 失败 | `{ error: wsCheck.error }` |
| 404 | 无 scripts 目录 | `{ error: 'skill scripts not found in workspace' }` |
| 200 | 正常 | `{ script, exitCode, stdout, stderr, timedOut, durationMs }` |

**`stdout` 截断到 8000、`stderr` 到 4000**（比 self 域宽 —— 这是通用网关，输出可能很长）。

**白名单是运行时取自 `listSkillScripts()` 的单一事实源**，由 `tests/unit/skillToolNative.test.ts` 钉死「白名单 ⇄ 内联底座集合恰好相等」。

**CLI 位置参数约定（最易踩的坑）**：`invokeSkillScript` 把**项目目录作为第一个位置参数**（`node <script> <workspace> ...args`）。**绝不能传 `--project-dir` 旗标** —— 脚本只认 `args._[0]`。`tests/unit/skillReplaceE2E.test.ts` 钉死此约定。

**quick-validate 例外（cycle-31 修复）**：它是唯一「第一位置参数是 skill-dir 而非 project dir」的脚本。经 `anic_skill` 工具调用时 spawn 形如 `node quick-validate.mjs <workspace> <skill-dir>`，脚本取**最后一个**位置参数为 skill-dir（两种形态都正确）；工具面须传**绝对路径**（安装后脚本 cwd 在已装副本 scripts/ 下，相对路径会解析错）。

**跨项目调用人体工学（cycle-38 T-3805，工具面 `anic_skill`）**：调用方把目标项目绝对路径误放进 `args`（如 `args: ["D:\\...\\project", "status"]`）曾是真机 6 连失败的形态。现在 `anic_skill` 工具网关（`toolsSkillGateway.ts`）对此自动收口：`args` 首位匹配盘符/正反斜杠开头的绝对路径、且 `validateWorkspace` 通过、且非 quick-validate 的 skill-dir 形态时——把它移作 workspace 参数、从 args 剥离，并在响应回显 `workspaceRedirected` + `note` 两字段（不静默：调用方看得见发生了什么）。FlowTracker 记账与技能脚本目录解析都按重定向后的工作区。非法路径（不存在/非目录）不吞不重定向，让脚本数量守卫报更精确的错误。HTTP 面 `/anic/skill/invoke` 不做此重定向（两通道行为差异是有意的：工具面服务大模型调用，HTTP 面服务程序调用——程序应当传对）。

**参数防护（cycle-27 起）**：技能脚本 16 个，全部经 `assets/skill/scripts/lib/args.mjs` 的 `parseCliArgs(argv, spec)` 统一解析——三防线：`--help/-h` 打印用法并退出 0；未知旗标（`--*` 不在 spec 白名单）exit 1 并报旗标名；位置参数数量契约（`min/max`，越界报实收数与清单）。值旗标缺参 / int/float NaN 同样拒绝；kebab 旗标自动映射 camelCase（`--max-retries` → `args.maxRetries`）。注意：`SKILL_SCRIPTS` 宿主白名单是 15 项（不含 `mcp-server.mjs`），脚本文件 16 个 + `lib/args.mjs` 共享库 = 技能 65 文件。

### 2.3 POST `/anic/evaluate`（`skillRoute.ts:78`）

**Body**：`{ workspace?: string; dimensions?: string }`

**执行**：`invokeSkillScript(scriptsDir, 'eval-runner', dimensions ? ['--dimensions', dimensions] : [], workspace, 60000)`

**响应 200**：`{ workspace, exitCode, stdout (8000), stderr (4000), timedOut, durationMs }`。

**与 `/anic/self/evaluate` 的区别**：本端点是**无状态**的（不写 bootstrap state），且可指定 dimensions、可指定 workspace。`/anic/self/evaluate` 是自举循环的一环，会持久化状态。

### 2.4 POST `/anic/iterate`（`skillRoute.ts:103`）

**Body**：`{ workspace?: string }`

**执行**：先跑 eval-runner，再跑 gate-check。

**响应 200**：

```ts
{ workspace,
  eval: { exitCode, stdout, timedOut },
  gate: { exitCode, stdout, timedOut } }
```

**注意截断更窄（4000）**且 `stderr` / `durationMs` **不在响应里** —— 与 `/anic/self/iterate` 的形状完全不同（后者返回 `techDebtProposals` / `converged` / `exhausted`）。两个 `iterate` 端点语义不同，不可互换。

---

## 3. 技能安装

`src/host/routes/skillInstallRoute.ts` + `src/host/skillIntegrity.ts`（cycle-19 起：安装即建锚——清单 + sha256 完整性校验 + doctor/repair）。

```ts
export const SKILL_INSTALL_ROUTE = '/anic/skill/install';   // skillInstallRoute.ts
export const SKILL_STATUS_ROUTE  = '/anic/skill/status';    // skillInstallRoute.ts
export const SKILL_REPAIR_ROUTE  = '/anic/skill/repair';    // skillInstallRoute.ts（v0.20.0 新增）
```

辅助函数：

- `readSkillVersion(dir)`（`skillIntegrity.ts`）：读 `join(dir, 'SKILL.md')`，匹配 `/version[:\s]+v?([0-9]+\.[0-9]+\.[0-9]+)/i`。
- `inlineSkillRoot()`（`skillInvoker.ts`）：真内联解析（`inlineSkillScriptsDir()` 向上找 `assets/skill/scripts` 带 `init-workflow.mjs` 哨兵），**绝不落入外部副本**——取代旧的 `getInlineSkillDir()`（借 `resolveSkillScriptsDir(process.cwd())`，cwd 邻近有外部副本时会解析错，v0.20.0 修复）。
- **完整性域**（`skillIntegrity.ts`）：`buildSkillManifest(dir)`（path+size+sha256+版本锚点）；`verifySkillInstall(installedDir, inlineDir?)`（doctor——inline 权威直比优先，manifest 兜底，双缺时 `ok:false` 不静默放行）；`repairSkillInstall`（只重装差异文件，extras 只报告不删除）；`skillIntegritySummary`（anic_status 消费面）。
- 安装清单 `.anic-manifest.json` 落在已安装目录根部，是插件私有元数据（隐藏文件，自身被排除在清单外，技能脚本不读不写）。

### 3.1 POST `/anic/skill/install`（`skillInstallRoute.ts:47`）

| 码 | 条件 | 体 |
| --- | --- | --- |
| 405 | 方法非 POST | `{ error: 'POST only' }` |
| 404 | 无工作区 | `{ error: { code: 'ANIC_ROUTE_NO_WORKSPACE', message: 'no workspace resolvable' } }` |
| 200 | 已安装且两侧版本都非 null 且相等 | `{ alreadyInstalled: true, version: installedVersion, path: …, integrity }` |
| 500 | `autoInstallSkill(root)` 未成功 | `{ error: { code: 'ANIC_ROUTE_SKILL_INSTALL_FAILED', message: result.error ?? 'unknown error' } }` |
| 200 | 安装成功 | `{ installed: true, version: inlineVersion, path: result.path, upgraded: alreadyInstalled, integrity }` |

**`upgraded` 的含义**：`alreadyInstalled` 为 true 但版本不等时走这条分支，因此 `upgraded: true` 表示「覆盖了一个旧版本」。

**安装目录固定**：`<root>/.dsh/skills/ai-native-iteration-cycle`。安装成功即写清单（安装即建锚），响应体 `integrity` 为安装后立即校验结果（`reference:'inline'`）。

### 3.2 GET `/anic/skill/status`（`skillInstallRoute.ts:84`）

| 码 | 条件 |
| --- | --- |
| 405 | 方法非 GET → `{ error: 'GET only' }` |
| 404 | 无工作区 → `{ error: { code: 'ANIC_ROUTE_NO_WORKSPACE', ... } }` |
| 200 | `{ installed, installedVersion, scriptsResolved, scriptsSource, inlineAvailable, inlineVersion, integrity }` |

**这是判断「技能是否可用」的唯一端点** —— `scriptsResolved` / `inlineAvailable` 两个布尔分别对应「工作区已装」与「插件内联底座可用」。`scriptsSource` 是解析出的脚本目录路径。**doctor 语义并入此端点**（不另设端点避免动词通胀）：`integrity` = `verifySkillInstall(installedDir, inlineDir)` 结果——`{ ok, reference: 'inline'|'manifest'|'none', checked, mismatches: [{path, kind: 'missing'|'size'|'hash'}], extras, manifestVersion }`；`reference:'inline'` 表示与插件内联副本逐文件权威直比，`'manifest'` 表示 inline 不可用时按安装清单兜底（独立分发场景）。未安装时 `integrity: null`。

### 3.3 POST `/anic/skill/repair`（`skillInstallRoute.ts`，v0.20.0 新增）

| 码 | 条件 | 体 |
| --- | --- | --- |
| 405 | 方法非 POST | `{ error: 'POST only' }` |
| 404 | 无工作区 / 技能未安装 | `{ error: { code: 'ANIC_ROUTE_NO_WORKSPACE' / 'ANIC_ROUTE_SKILL_NOT_INSTALLED' } }` |
| 200 | 修复完成 | `{ repaired: string[], verify }` |

repair 语义：verify 找出 mismatches → 逐个从 inline 源重装（源缺失则跳过）→ 重写清单 → 复验（返回的 `verify` 是修复后结果，`ok:true` 表示收敛）。**extras（安装目录多出的文件）只报告不删除**——用户或其他工具放入的文件不属本插件删除权限边界。inline 不可用时 repair 不动作。

### 3.4 GET `/anic/skill/health`（`skillHealthRoute.ts`，v0.21.0 新增）

| 码 | 条件 | 体 |
| --- | --- | --- |
| 405 | 方法非 GET | `{ error: 'GET only' }` |
| 404 | 无工作区 | `{ error: { code: 'ANIC_ROUTE_NO_WORKSPACE', ... } }` |
| 200 | 健康报告 | `SkillHealthReport` |

技能健康观测面（ui-domain-plan P3 收口）：FlowTracker（`.cycles/flow-tracker.json` 技能调用历史）→ `analyzeSkillHealth` 纯函数 → `{ scripts: [{script, level, total, successRate, timeoutRate, avgDurationMs, lastInvoked}], suggestions: [{id, severity, script, description, action}], overallSuccessRate, totalInvocations, generatedAt }`。与 `anic_status` 工具返回的 `health`/`healthSummary` 是**同一份分析**（阈值单一事实源 `continuousLearning.ts`），本端点把 HTTP 面板接进来。

语义要点：`level` 六级 `healthy|degraded|slow|expensive|insufficient|unused`（判定链 insufficient → slow → degraded → expensive → healthy，先具体后一般）；无 `.cycles`/无 tracker → 200 空态 `totalInvocations: 0`（「没有调用历史」是合法观测结果，不是 500）。工作区解析带 `X-ANIC-Workspace` 请求头（P2 桌面多会话契约）。

---

## 4. dual 域 · 双自举

`src/host/routes/dualBootstrapRoute.ts`。

```ts
registerDualBootstrapRoute(deps: RouteDeps): Array<(() => void) | null>   // :29
// RouteDeps = { ctx, send, getWorkspaceRoot, pluginDir }
```

本地 `reg(method, path, handler)` 的 `method` **被显式丢弃**（`void method;`，`dualBootstrapRoute.ts:37`）—— 宿主只拿到 path，因此**三个端点都没有方法检查**。

三个端点无工作区时统一返回 404：

```ts
{ error: { code: 'ANIC_ROUTE_NO_WORKSPACE', message: 'no workspace' } }
```

**dual 的语义**：同时评估「插件自身」与「技能/工作区」，然后选择较弱的一侧推进 —— 这样自举循环不会只优化一边。

### 4.1 POST `/anic/self/dual-evaluate`（`dualBootstrapRoute.ts:40`）

**响应 200**：`{ plugin: evaluatePluginSelf(pluginDir), skill: evaluateSkillSelf(cyclesDir) }`。

### 4.2 POST `/anic/self/dual-advance`（`dualBootstrapRoute.ts:50`）

**目标选择**：

```ts
const target = pluginEval.score <= skillEval.score ? 'plugin' : 'skill';
```

**门禁判定**（阈值是契约）：

```ts
const gateVerdict = evalScore >= 70 ? 'PASS' : evalScore >= 40 ? 'doubt' : 'FAIL';
```

**响应 200**：`{ newState, evaluated, evalScore, gateVerdict }`。

### 4.3 GET `/anic/self/dual-status`（`dualBootstrapRoute.ts:65`）

**响应 200**：`DualBootstrapState` 对象（无信封）。

---

## 5. GET `/anic/api/truth-audit`

`src/host/routes/truthAuditRoute.ts`（27 行，最短的路由文件）。

```ts
const PLUGIN_DIR = resolve(fileURLToPath(import.meta.url), '../../../');   // :10
```

**响应 200**：`runTruthAudit(PLUGIN_DIR)` 的完整结果 —— 四维 `T1_truthfulness` / `T2_accuracy` / `T3_structure` / `T4_logic`，每维含 `passed` / `score` / `findings[]`，顶层含 `totalFindings` / `overallScore` / `allPassed`。

**本端点无工作区检查** —— 它审计的是**插件自身**（`PLUGIN_DIR` 由 `import.meta.url` 推出），与工作区无关。因此**永不返回 404**。

同一个 `runTruthAudit` 也被 `tests/unit/truthAudit.test.ts` 调用，因此本端点的响应形状与 T3 守卫是同一份数据。

---

## 相关文档

- 公共约定与端点总索引 → [API参考.md](API参考.md)
- 数据面 → [API参考-数据面.md](API参考-数据面.md)
- 周期面 → [API参考-周期面.md](API参考-周期面.md)
- 评审 / 进化 / 治理 / 原生脚本面 → [API参考-评审进化与治理.md](API参考-评审进化与治理.md)
- 测试分层（含 T3 与 skillToolNative 守卫） → [测试指南.md](测试指南.md)
