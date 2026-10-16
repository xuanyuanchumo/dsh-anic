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

1. **P2 · 桌面多会话工作区解析**：`resolveWorkspaceRoots`（`src/host/snapshotRoute.ts:50-66`）取 sessions 首条 cwd。桌面端多会话时面板绑定到首个会话的工作区。**建议修复方向**：客户端携带自身工作区上下文（如 `X-ANIC-Workspace` 头或查询参数），服务端优先采信。
2. **未验证**：`ctx.slots` 服务本体在 Host 包内的精确形状（客户端按官方 `ctx.slots.inject` 形态使用，双端实测可用）；0.3.x/0.4.x 真实 API 差异（无安装版可比对，靠 §2 能力探测覆盖）。
3. **运行中桌面宿主的 bundle 陈旧性**：属宿主生命周期语义（进程启动时加载），非本插件缺陷；文档化即可。
