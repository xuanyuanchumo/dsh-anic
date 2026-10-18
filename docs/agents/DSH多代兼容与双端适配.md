# DSH 多代兼容与双端适配

> 本文档是 dsh-anic 对 DSH 宿主多版本兼容与「网页端 / 桌面端」双端适配的权威开发规范。
> 全部结论基于源码取证（dsh 0.2.0-rc.2 / cordis 4.0.4 本机实测 + dsh-plugin-dev-kb 1.4.0），
> 每条带 `文件:行号` 出处；未验证项显式标注，不虚构。

## 1. 兼容性门的真实现（不要看文档，看源码）

DSH 宿主对插件版本兼容性的真实判定在 `@deepseek-ai/dsh-app-boot/lib/index.js:286-313` `evaluatePluginCompatibility`：

- `:289` 插件**无 `peerDependencies`** → 直接返回 undefined，**永不报错**；
- `:294` 只检查 peerDependencies 中 **`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-` 前缀**的条目（cordis 不在白名单）；
- `:300` `semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`；
- `:271` `getDshRuntimeVersion()` 读 **app-boot 包自身的 version**（本机 = 0.2.0-rc.2）；
- `:930-931` **bundle 不兼容 → throw**（组装失败）；`:2079-2080` 插件行不兼容 → 仅 warning。

`engines.dsh` 字段**不被任何代码读取**（`dsh-package-manifest/lib/types/types.d.ts:55-64` 逐字注释：
"Runtime requirements; DSH compatibility is declarative until a reader enforces it."）。

### 1.1 dsh-anic 的下限声明（已落地）

`package.json` 同时声明两层：

```json
"engines": { "node": ">=22.19", "dsh": ">=0.2.0-rc.2 <0.4.0" },
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.1",
  "@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.4.0"
},
"peerDependenciesMeta": { "@deepseek-ai/dsh": { "optional": true } }
```

- **生效层**是 peerDependencies（兼容性门只读它）；`optional: true` 只影响 npm 安装期对等解析，不影响宿主门（门只读键值，忽略 meta）。
- **为什么写 `>=0.2.0-rc.2` 而不是 `>=0.2.0`**：semver 的 `includePrerelease` 不会让 `>=0.2.0` 接受 `0.2.0-rc.2`（预发布号被排除在非预发布范围外）。实测（宿主自带 semver）：
  - `0.2.0-rc.2` vs `>=0.2.0` → **false**（会把当前 rc 宿主判为不兼容 → bundle throw → 双端崩）
  - `0.2.0-rc.2` vs `>=0.2.0-rc.2 <0.4.0` → **true**；`0.2.0`/`0.2.1`/`0.3.x` → true；`0.4.0` → false（上界拦住）；`0.1.7-rc.2` → false（下限拦住）
- 语义即「下限 = **dsh 0.2.0 系列起点**（含其预发布），上界 0.4.0（未验证的破坏性变更代际）」。
- 守卫测试：`tests/contract/dshConformance.test.ts` 断言 peerDependencies 含 `@deepseek-ai/dsh` 且范围形状正确。

## 2. 多代适配器策略：能力探测，不读版本号

**宿主 `ctx` 上无版本服务**（grep `super(ctx,"version"|"runtime")` 零命中；`getDshRuntimeVersion()` 只在 app-boot 内部）。
因此跨版本兼容**只能靠能力探测**，统一经非严格 `ctx.get(key, false)`（绝不用 `ctx.<name>` —— postmortem 0001 根因 #2：未在静态 inject 声明的服务用属性访问会抛 `cannot get property "x" without inject`）：

| # | 探测点 | 方式 | 回退行为 |
|---|---|---|---|
| D1 | `ctx.skills.register` | `ctx.get('skills', false)?.register` 为函数才注册 | log.info 跳过，插件主体继续 |
| D2 | `ctx.tools.register` | `ctx.get('tools', false)` | 工具域整体跳过 |
| D3 | Tool 字段名 | 静态统一 0.2.0 形态：`parameters`/`execute`（非 `inputSchema`/`handler`） | 无双写（旧形态在 0.2.0 直接失败） |
| D4 | `output.render` 契约 | 始终返回 ContentBlock[]（`[{type:'text',text}]`） | 裸字符串会在请求组装期崩（`dsh-llm/lib/index.js:594` `content.some is not a function`） |
| D5 | `webServer.register` 路由形状 | 单对象 `{kind:'exact'|'prefix', path, handler}`（0.2.0 形态） | 路由整体跳过 |
| D6 | 客户端平台 | 静态 `dsh.client.platform: 'web'`（两端都加载 Web 资源） | 无 |
| D7 | 宿主版本 | **不可运行时读取** → 全部走 D1-D5 探测 | — |
| D8 | `dsh.bundle.patch` 形状 | 保持单字符串（string | string[] 均合法） | 无 |

### 2.1 静态 inject 的架构张力（已知取舍）

`src/index.ts` 静态 `inject = ['tools','webServer','sessions','skills']`。cordis 语义下，inject 任一服务无人提供 → fiber 停 **PENDING 且不输出任何内容**（官方教程逐字：「这不是错误」）。因此「宿主无 skills 时内部跳过」的多代防御**在静态 inject 下永远走不到**。

- 动态 `ctx.inject(['skills'], cb)` 在本机 cordis 4.0.4 实测**嵌套纤维从不激活**（`src/host/skillRegistration.ts` 尾注记：cycle-97 实测）；
- 官方消费方（如 dsh-skill-badge）全部用静态 `const inject = ["skills"]`；
- **当前取舍**：保持静态 inject（与官方生态一致、双端都有这四服务）；`pick()` 探测作为纵深防御保留（若未来服务拆分/改名）。

## 3. 双端差异（网页端 vs 桌面端，实测）

| 维度 | 网页端（`dsh` CLI / start-dsh-test.mjs） | 桌面端（DeepSeek Harness Electron） |
|---|---|---|
| 宿主进程 | `node` 直启 | `dsh-desktop-host`（Electron main 内嵌 node） |
| GUI 端口 | 单端口（如 3080）同时服务 GUI 与插件路由 | **同**：GUI 与插件路由同在 19387（另有 8326 为带鉴权内部服务） |
| 插件路由鉴权 | GUI 需 token；插件 `webServer.register` 路由**不经 GUI 鉴权层**（直接 200） | 同左（实测 `/anic/org-status` 等无 token 返回 200） |
| 客户端壳 | `@deepseek-ai/dsh-web-app`（0.2.x） | `@linxin666/dsh-web-all`（0.4.4）——**两端都经 `dsh.client.platform:'web'` + `exports['./client']` 加载客户端 bundle**（桌面端 ANIC 标签已实测可见） |
| 工作区解析 | 单工作区：`resolveWorkspaceRoots` → sessions 首条 cwd（正确） | **多会话宿主**：解析到 sessions 列表**第一条**的 cwd（实测解析到 `D:\Projects\TraeProjects\Studying`，与当前会话工作区无关）→ 已知 P2 限制（见 §5） |
| 插件热更新 | restart 即重新加载 dist | **运行中宿主持有旧 bundle**（进程启动时加载，dist 重建后需重启桌面应用才生效） |

### 3.1 桌面端实测记录（2026-10-16）

- 桌面 profile `C:\Users\86156\.dsh\profiles\desktop`：junction 安装 + bundles 含 `dsh-anic` ✓
- 宿主侧：12 个 `anic_*` 工具全部注册（桌面会话内直接可枚举）✓
- 路由：`/anic/org-status`、`/anic/api/self-check`、`/anic/api/invocations/live`、`/anic/api/ledger/verify` 全部 200；`/anic/api/workflow-snapshot` 404（解析出的工作区无 `.cycles`，错误体明确告知工作区路径——诚实失败）✓
- 客户端：对话视图顶部「ANIC」标签与官方标签并列（用户实测确认）✓
- **陈旧 bundle 发现**：桌面宿主 13:29 启动，持有 cycle-98 期中间产物；其上复现的三处旧缺陷（CORS `*`、orgStatus currentBand 硬编码 L2、工具 `content.some is not a function`）均已在当前 dist 修复并在网页端 3080 验证通过；**桌面宿主重启后自动生效**。

## 4. 0.1.7 → 0.2.0 破坏性变更（B1-B6）与防御

出处：`dsh-plugin-dev-kb/kb/extra/upgrade-guide/{v0.2.0-rc.2, v0.1.7-rc.2}`。

| # | 变更 | dsh-anic 受影响 | 防御 |
|---|---|---|---|
| B1 | 不再发布 `@deepseek-ai/dsh-invariants` | 无（未引用） | 不依赖 |
| B2 | 子路径不读 package.json | 无（`exports` 齐全） | locale/icon 走 `./locale/*.json` 导出 |
| B3/B5 | schedule bundle 退役/改可选 | 无 | 不 patch `time-context` |
| B4 | `SignInErrorCode` 增 `no-response` | 无（不涉登录） | — |
| B6 | transcript 保存值 `normal` 显示 `detailed` | 无（不依赖该缺省） | — |

已知陷阱对照（R1-R20 摘要）：无 default export（unwrapExports 会丢 inject/name）✓；只用 `ctx.get(name,false)` ✓；`output.render` 返回 ContentBlock[] ✓（修复已验证）；`meta` 纯 JSON ✓；子进程超时与退出码分列 ✓。

## 5. 已知限制与未验证项（诚实清单）

1. **P2 · 桌面多会话工作区解析（cycle-20/21/22 已收口）**：`resolveWorkspaceRoots`（`src/host/snapshotRoute.ts`）claimed 头 `X-ANIC-Workspace` → knownRoots → `.cycles` 存在采信 → registry → sessions 首条 → cwd。客户端面板从首个成功快照响应学得工作区根并回带头（`src/client/WorkflowGraphPanel.ts:79-86`）；服务端 **cycle-21 修 native 域 7 路由、cycle-22 全域统一**——所有路由文件（cycle/ledger/skillInstall/dualBootstrap/segmentedLedger/selfInit/stackProbe/flows/governance/selfCheck/skillHealth/native/snapshot）handler 一律 `getWorkspaceRoot(req)`，写侧路由（install/repair/advance/append/init/band-detect 等）在多会话宿主上不再写到首条会话的工作区。
2. **未验证**：`ctx.slots` 服务本体在 Host 包内的精确形状（客户端按官方 `ctx.slots.inject` 形态使用，双端实测可用）；0.3.x/0.4.x 真实 API 差异（无安装版可比对，靠 §2 能力探测覆盖）。
3. **运行中桌面宿主的 bundle 陈旧性**：属宿主生命周期语义（进程启动时加载），非本插件缺陷；文档化即可。

## 6. 工具展示层官方契约对齐（cycle-22）

出处：`dsh-plugin-dev-kb/kb/site/reference/cookbook/adding-a-tool.md`（execute() 约定的规则 + 工具在 UI 中的渲染方式）。

### 6.1 safeHandler 的 isError 语义修正

官方契约：**「抛出异常或返回无效值意味着 isError。基础设施故障请抛异常。成功的领域结果即使表示不理想的状态，也应写入规范值。」**

| 语义 | 旧实现（≤v0.22.0） | 新实现（cycle-22） |
|---|---|---|
| infra 故障（子进程 spawn 失败、文件系统异常等） | 被折叠为 `{ error: message }` 正常返回——模型/轨迹看到 `isError=false` 的「成功」 | 异常沿 Promise 拒绝传播给注册表 → 注册表收敛 `isError=true` |
| 领域失败（脚本非白名单、validateWorkspace 拒绝、eval exit!=0） | 显式 `{ error }` 规范值 | 不变——规范值 + Native 渲染器解释状态（官方推荐形态） |

grep 验证全部 `tools*.ts` gateway 无 intentional throw（所有抛出的异常确为 infra），rethrow 安全；`skillToolNative.test.ts` 的 `not whitelisted` 领域拒绝断言不受影响。

### 6.2 presentResult 第二参双形状归一化

官方签名：`presentResult(args, { content, isError, meta? })`——`content` 是模型可见内容块数组，`meta` 由 `output.presentationMeta(args, value)` 派生持久化在 `result.meta`，回放时重现。宿主 0.2.0-rc.2 实测宽容直传原始 execute 返回值（`{ exitCode, stdout, stderr }`）。

`src/host/presentation.ts` 新增 `normalizeToolResult(result)`（纯函数）：

- **官方形状判定**：`result.content` 是数组 → 从 `meta` 提取持久化事实（`exitCode/stdout/stderr`），`isError` 透传；`meta` 无输出时从 content text 块拼接兜底（结果文本不丢）；
- **宽容形状**：原样返回（宿主直传）。

`terminalResult()` 入参先过归一化；5 个 gateway（skill/hitl/flows/evolution/autoFix）与 `tools.ts anic_evaluate` 的 presentResult 全部接线。**收益**：0.3+ 宿主收紧传参形状时卡片不碎（多代防御）。

### 6.3 已知小偏差（未改，实测无害）

`presentCall` terminal 卡片字段官方为 `description`，dsh-anic 用 `summary`（`toolsSlot.ts TerminalCallView`）。宿主 0.2.0-rc.2 实测渲染正常——若未来版本卡片描述缺失，此处为第一排查点。

## 7. 分发正典化：DSH 市场收录（cycle-23）

> 出处：awesome-dsh-plugin/awesome-dsh-plugin `contributing.md`（2026-10-18 快照，web_fetch raw）+ dshmarket 1.66.35 README.zh.md + dsh-plugin-dev-kb `site/develop/basic/publish.md`。

### 7.1 DSH 插件分发三通道

| 通道 | 机制 | dsh-anic 状态 |
|---|---|---|
| **官方 bundle 安装** | `dsh plugin --profile <name> add <pkg>`（pnpm 转发；git 源码安装走 `prepare` 构建脚本 + `allowBuilds` 授权；npm/tarball 免授权） | manifest 已就绪（`dsh.bundle.patch` ✓ / peer 显式预发布分支 ✓ / `engines.dsh` 声明层 ✓） |
| **市场可视安装** | dshmarket 插件读精选目录 awesome-dsh-plugin（`data/plugins/<owner>__<repo>.yml`）一键装 | 条目草稿 `docs/agents/marketplace-提交草稿.md`（待用户建 GitHub 仓后提 PR） |
| **技能 CLI 分发** | `npx` 形态（eco 报告 P1，技能-only 路径） | 未实施——评估为后续轮 |

### 7.2 收录硬性要求（对照本仓库逐项）

- `dsh.bundle` manifest ✓（只声明 `dsh.client` 会被 CI 拒——最常见的被拒形态）；
- 真实可用代码 ✓；仓库满 1 天（CI 自动查）✓；活跃维护 ✓；
- 仓库打 `dsh-plugin` topic（**用户动作项**，本仓库尚无 git remote）；
- 描述必须与代码核实一致：**19 个 anic_ 工具 / 62 个 HTTP 路由**——工具或路由增减后必须同步条目与 README（条目草稿内已警示）；
- peer 范围写显式预发布分支（`>=0.2.0-rc.2 <0.4.0-0`，§1.1 已是正确形态；contributing.md 的 semver 陷阱示例与本仓库实践一致）。

### 7.3 screenshots.json 惯例（已落地）

仓库根 `screenshots.json` 声明 1-8 张相对路径图（不得以 `/` 开头、不得含 `..`、第三方图床拒绝）→ 市场详情页 App Store 式轮播。本仓库三张真机截图（`docs/screenshots/`，Playwright 于 3080 测试宿主拍摄）：`workflow-graph.png`（工作流图+实时调用流顶部）、`ledger-hitl.png`（门禁账本+HITL 队列）、`autonomy-gauge.png`（自主级仪表带+技能健康区）。截图更新只推本仓库，无需再动市场条目。
