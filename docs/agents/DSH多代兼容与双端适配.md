# DSH 多代兼容与双端适配

> 本文档是 dsh-anic 对 DSH 宿主多版本兼容与「网页端 / 桌面端」双端适配的权威开发规范。
> **版本基线（cycle-71 校正）**：本机实测宿主 = **dsh 0.2.1-rc.2**（`resources/runtime/primary-runtime/runtime.json` 的 `desktopVersion`，asar `dsh/package.json` 同值）+ **cordis 4.0.5**（asar 依赖表）；KB 镜像 = dsh-plugin-dev-kb 1.5.2。此前本册与 `docs/anic/07` 写"实测基线 0.2.0-rc.2"**与事实不符**——0.2.0-rc.2 是本仓声明的**下限**，本机从未安装该版本（两套 profile 均 0.2.1-rc.2），故"0.2.0 系列已验证"应读作"0.2.0 系列声明下限 + 0.2.1-rc.2 实测取证"。
> 全部结论基于源码取证，每条带 `文件:行号` 出处；未验证项显式标注，不虚构。

## 1. 兼容性门的真实现（不要看文档，看源码）

DSH 宿主对插件版本兼容性的真实判定在 `@deepseek-ai/dsh-app-boot/lib/index.js:311-333` `evaluatePluginCompatibility`：

- `:281-285` **插件有 `engines.dsh` → 由它单独决定，`peerDependencies` 被完全忽略**（原文注释 `:301-304`："An own `engines.dsh` range decides alone and peerDependencies are ignored"）；
- `:286-291` 只有在**无 `engines.dsh`** 时才回退读 peerDependencies，且只检查 **`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-` 前缀**的条目（cordis 不在白名单）；
- `:292-296` `workspace:^/~/*` 仅能在 **peerDependencies** 里解析为当前 runtime；出现在 `engines.dsh` 里一律视为**未满足**；
- `:276-277` `semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`；空串即 false；
- `:271-275` `getDshRuntimeVersion()` 读 **app-boot 包自身的 version**（本机 = **0.2.1-rc.2**）；
- `:281-284` `engines` 非对象 → 直接判不兼容；拒绝记录字段名为 **`requirements`**（0.2.1-alpha.3 起由 `peers` 改名）——消费方读拒绝记录时勿用旧名。

**旧结论作废（cycle-45 遗留的中间态）**：下段曾写"`engines.dsh` 不被任何代码读取"，那是 0.2.1-alpha.3 **之前**的形态；0.2.1-rc.2 起 engines.dsh **优先且单独决定**。0.2.1-alpha.3 的官方升级指南与此 asar 实测一致。该变更属 **B9 改写**（见 `docs/anic/07`）。

### 1.1 dsh-anic 的下限声明（已落地）

`package.json` 同时声明两层：

```json
"engines": { "node": ">=22.19", "dsh": ">=0.2.0-rc.2 <0.4.0-0" },
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.1",
  "@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.4.0-0"
},
"peerDependenciesMeta": { "@deepseek-ai/dsh": { "optional": true } }
```

（cycle-40 勘误：上方引用块旧版省略上界预发布排除号 `-0`——`package.json:25/:29` 逐字是 `<0.4.0-0`；语义近似（两者都拦 0.4.0 系全部版本），但 `-0` 形态额外显式排除 0.4.0 的预发布。以下判定行同理按 `<0.4.0-0` 口径理解。）

- **生效层是 `engines.dsh`**（0.2.1-rc.2 起它优先且单独决定；peerDependencies 同值是**纵深防御** + npm 安装期对等解析约束）；`optional: true` 只影响 npm 安装期，不影响宿主门（门只读键值，忽略 meta）。
- **`cordis` 的 peer `^4.0.1` 实际永不被宿主判定**（engines.dsh 短路；且 cordis 不在 peer 白名单内）。实现捆绑 cordis **4.0.5**——若要真守 cordis 兼容需运行时探测形状，当前不必。
- **双锚同步纪律**：两处范围**必须同步演化**（改一处不改另一处=静默漂移）；`engines.dsh` **不得出现 `workspace:`**（出现即判不兼容）、`engines` 必须是对象。守卫已双锚化：`tests/contract/dshConformance.test.ts` 同时断言 engines.dsh 与 peerDependencies（cycle-71 扩）。
- **为什么写 `>=0.2.0-rc.2` 而不是 `>=0.2.0`**：semver 的 `includePrerelease` 不会让 `>=0.2.0` 接受 `0.2.0-rc.2`（预发布号被排除在非预发布范围外）。实测（宿主自带 semver）：
  - `0.2.0-rc.2` vs `>=0.2.0` → **false**（会把当前 rc 宿主判为不兼容 → bundle throw → 双端崩）
  - `0.2.0-rc.2` vs `>=0.2.0-rc.2 <0.4.0` → **true**；`0.2.0`/`0.2.1`/`0.3.x` → true；`0.4.0` → false（上界拦住）；`0.1.7-rc.2` → false（下限拦住）
- 语义即「下限 = **dsh 0.2.0 系列起点**（含其预发布），上界 0.4.0（**未验证的破坏性变更代际**——0.3.x/0.4.x 在 npm registry 上**不存在**：`@deepseek-ai/dsh` dist-tags `latest=0.2.1-rc.2`，`0.3.0-rc.2`/`0.4.0-rc.1` 均 404；旁证：dsh-ops `lib/compat/alias.js:1-2` 注释称工具改名发生在 "0.4.0"，说明上游有 0.4 代际规划但未发布）」。
- 守卫测试：`tests/contract/dshConformance.test.ts` 断言 engines.dsh + peerDependencies 双锚与范围形状。

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
| 宿主进程 | `node` 直启 | `dsh-desktop-host`（Electron main 内嵌 node，asar `lib/main.js:3793-3811` spawn） |
| GUI origin | `http://127.0.0.1:<port>`（webserver `getOrigin()`） | **`dsh-app://app`**（自定义 privileged scheme，`lib/main.js:7009` 定义 + `:11880-11890` 注册） |
| **插件路由如何到达** | 直连 Host webserver | **经 `protocol.handle` 反向代理**：非静态路径一律 `forwardWebRequest(request, hostUrl, hostCookie)`（`lib/main.js:12411-12412`）→ 同一 Host webserver → 插件 handler。代理注入 Host 认证 cookie、剥离 host/origin/cookie，并**白名单 Origin**（`:8271` 逐字 `if (origin !== null && origin !== "dsh-app://app") return 403`） |
| 插件路由鉴权 | GUI 需 token；插件 `webServer.register` 路由**不经 GUI 鉴权层**（直接 200） | 同左——且桌面代理已代持认证 cookie，面板同源 fetch 无需 token（实测 `/anic/org-status` 等无 token 返回 200） |
| **客户端 fetch 硬约束** | — | **必须同源相对路径**（代理按 `Origin: dsh-app://app` 白名单放行；绝对 `http(s)://` URL 会被 403 或跨源拒绝）。本仓已是相对路径（`components/fetchJson.ts`、`components/usePanelFetch.ts`、`features/selfinit/useSelfInit.ts`；`grep http(s):// src/client` 零命中）→ 合规；契约守卫见 `tests/contract/clientSameOriginContract.test.ts` |
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

### 4a. cycle-45（T-4501）KB 全量对照结论（kb 快照 2026-10-21，commit 687f282）

**KB 无任何 v0.3.x/v0.4.x 条目**（全库 grep 零命中；upgrade-guide 最高到 v0.2.1-alpha.4 account-notification-fields）——上游 docs 尚未发布 0.3/0.4 升级指南，本文 D1-D8 能力探测矩阵仍是唯一防线（j0-probe 实测宿主为准）。v0.2.1-alpha 系新增已核对项：

| 变更 | 内容 | dsh-anic 影响 |
|---|---|---|
| v0.2.1-alpha.3 plugin-engines-dsh | 兼容判定 engines.dsh 优先；`workspace:` 出现在其中=不兼容；engines 非对象直接拒绝 | §1.1 已补同步演化警示 |
| v0.2.1-alpha.1 tool-presentation-mode | tools mode 只认 native\|ptc，both 拒绝 | 无（未用 presentAs/mode） |
| v0.2.1-alpha.1 working-directory | presentationMeta 在嵌套 PTC 调用中也运行，须纯函数，异常致 ToolOutputError | 无（本仓 presentationMeta 仅类型声明未实用；presentCall/presentResult 已是纯函数） |
| v0.2.1-alpha.4 account-notification-fields | 账号通知字段 | 无（不涉账号通知） |

### 4b. cycle-71 asar 一手取证补充（B12-B18 新类 + 两处文档漂移纠正）

**方法**：只读 asar 条目字节（`D:\DSH\DeepSeek Harness\resources\app.asar`）+ `cordis_inspect_query` 服务/事件目录实测 + npm registry 在线核验。**asar 一手证据 > 在线实测 > KB 文档镜像**（本次发现 KB 两处与实装冲突，见下）。

| 编号 | 新类 | 内容与证据 | dsh-anic 命中 |
|---|---|---|---|
| B12 | 工具呈现模式枚举收紧 | `mode` 只认 `native\|ptc`，`both` 拒绝；`DSH_TOOLS_MODE=both` 报错；`presentAs` 仅 scoped ctx 且同 scope 重复声明抛（asar `dsh-tools/lib/index.js:2911-2926`） | 否（未用 presentAs/mode） |
| B13 | 兼容拒绝记录字段改名 + engines 优先 | 兼容判定 `engines.dsh` 优先；`IncompatiblePlugin`/`PluginCompatibility` 的 **`peers` → `requirements`**（键为 `engines.dsh` 或 peer 包名） | 否（不读该记录）——但 §1 叙述已随之改写 |
| B14 | profile 服务键改名 + 监听地址收紧 | `webRuntime` 服务与 `web-runtime` bundle 行退役 → **`webStartup`**；`ctx.webRuntime.trustedHosts` 求值失败会让必需 Connection 行 pending；**通配监听地址加载期拒绝**（asar `dsh-host-webserver/lib/index.js:252-256`；服务目录实测 `webStartup`/`webRuntime` 均**不在** host 目录） | 否（未 inject webRuntime） |
| B15 | 服务键「在场」≠「可属性访问」 | 未被自己 `inject` 声明的服务做**属性访问会抛**（本仓 `routes/index.ts` 曾记录 4 路由恒 400 空体的 postmortem）；`ctx.get(name, strict=true)` 只返回提供方 fiber **当前 active** 的实现 | **命中过（已修）**——全仓统一 `ctx.get(key, false)` |
| B16 | 客户端动态包的 inject/环硬约束 | (a) 动态包 `ctx.<service>` 访问被 `fiber.inject` 门控，未声明即拒绝并 park（asar `dsh-cordis-client-runner/lib/client.js:323-332`）；(b) `dsh.client.external` 自请求或依赖图成环 → 组合期 throw（`dsh-client-modules/lib/index.js:422-444`）；(c) 缺 `exports["./client"]` 且声明 `dsh.client` → throw（`:738`） | 否（未声明 `external`；`./client` 存在） |
| B17 | 会话事件词汇白名单 + `ignorable` 兼容机制 | 未知 type 的**持久化**会话事件在无 `ignorable:true` 标记时被读取路径拒绝（`dsh-session/lib/types/known-event-types.js:1-22`）；`Session.append()` **无法**设置该标记 → 插件绝不能 append 自定义 type | 否（不写 session log；`ctx.emit`/`session.append` grep 零命中） |
| B18 | 客户端 release 一致性门 | Host/page release 不等则页面**拒绝应用**图与 rebuilt 帧，仅刷新可换（`dsh-client-modules`） | 否——但解释 §3 表格「运行中桌面宿主持旧 bundle 必须重启」的机制来源 |

**轨迹可见性官方契约（补证 §D，双向证据）**：

- `tool/call` / `tool/result` 是**持久化会话事件类型**（由 agent loop `session.append`，asar `dsh-agent-loop/lib/index.js:681-706`），**不是同名 Cordis 事件**——观察它们须监听 `session/event` 并检查 `event.type`。官方 `site/develop/framework/events.md:109` 逐字同述。
- 另有一个**同名 Cordis 事件 `tools/result`**（emit，`(exec, result)`）——本仓实时流双通道订阅正是 `session/event`（起始相位）+ `tools/result`（结束相位），**合规**。
- **遗漏 1（官方语义，非本插件缺陷）**：插件 HTTP 路由调用**不进会话轨迹**（事件词汇表无 HTTP 事件；`dsh-host-webserver` grep `session.append` 零命中）→ 面板触发或 curl 触发的 `/anic/*` 写侧动作不留轨迹。必须显式记录，勿误以为「所有调用都可见」。
- **遗漏 2（P2，待收口）**：PTC 模式下调用走 `tool/ptc-dispatch` / `tool/ptc-dispatch-start`（词汇表 `known-event-types.js:75-77`），而本仓 feed 只认 `tool/call` → 若 `tools mode=ptc`，实时调用流**会漏记**。修复落点 `src/host/runtime/invocationFeed.ts`。

**KB 文档漂移（两处，以 asar 为准）**：

1. **桌面端架构**：KB `site/reference/subsystems/web-server.md:9` 称 Electron 走 `file://`+IPC「不使用本服务器」——实际是 `dsh-app://` privileged scheme + `protocol.handle` 同源反向代理到同一 Host webserver（asar `lib/main.js:7009 / :11880-11890 / :12406-12415 / :8271-8290`）。插件路由**完全可达**，见 §3 表格。
2. **`ctx.inject(deps, cb)` 语义**：官方语义是 `ctx.plugin({inject, apply:cb})` 的简写，**服务变化时卸载并重跑**（KB `site/reference/cordis-api/registry.md:13-38`）。本仓此前把它当「官方语义不可用」——实为 **0.2.x 本机实测「回调未触发」（根因未定位）**，非规范结论。升级到新型号后须重测该路径并记录日志/命名空间证据。

**`__ModuleLoader__.load` 契约（一手取文）**：气泡在 `dsh-client-modules/lib/index.js:460-480`（`bootInjections` 生成 inline queue 脚本），注册形状 = `{ id, factory }`；`factory(require)` 是 **lazy CJS 物化点**（bundle 执行只注册 factory，模块副作用含 CSS 注入在物化时运行，有 `loadCache` 记忆化，循环 require 抛）；`id` 身份 = **包名**（`<pkg>/client` 与裸 `<pkg>` 归一，`:96-100`）。本仓 `scripts/wrap-client-bundle.mjs` 实现与官方 `load({id,factory})` 形状匹配（`id` 由第三个 CLI 参数注入）。**与 cordis 的关系**：`__ModuleLoader__` 只负责「插件代码如何到达浏览器」，到达后由 cordis client runner 建 fiber、按 `inject` 门控服务访问、按 `ctx.effect` 清理——是**接力关系，不是同一契约**。

### 4c. dsh-ops / dsh-plugin-dev-kb 可借鉴设计（cycle-71 首轮实读外仓）

> 实测对象：`.dsh/profiles/desktop/node_modules/dsh-ops`（**0.4.1**）+ KB 镜像 `dsh-plugin-dev-kb@1.5.2`（commit `687f282`）。**纠正前档**：`docs/anic/07`/§4a 记「KB 全库零提及 dsh-ops」，本次复核**仍为零**（kb 全文 grep 零命中）——上条结论有效；本节是首轮实读外仓源码的增量。

**建议吸收（按 ROI）**：

| # | 机制 | 对方落点 | 本仓落点 |
|---|---|---|---|
| 1 | **跨代工具改名静默迁移层**：`RENAMED_TOOLS`（7 条，如 `read_many→read_files`）+ `migrateRawName`/`migrateRawNames`（去重） | `dsh-ops/lib/compat/alias.js:1-18` | `src/host/toolIds.ts` 旁增设别名归一——未来 `anic_*` 改名不破坏旧客户端与旧工件 |
| 2 | **组件化 patch 行**：单一 `cordis.patch.yml` 内 7 个稳定 id，每行独立 `disabled` + `config`，consumer 可整行覆盖 | `dsh-ops/cordis.patch.yml:1-42` | 把 `anic_*` 工具与路由按域拆成可停用组件行（配置显式化/降级路径的「显式」形态） |
| 3 | **无宿主包依赖的窄化探测 + provider 化注册**：`ctx.get('tools')?.schemas(agent)`（try/catch 包裹）+ `registerNativeProvider(ctx, defs, tool => ctx.tools.register(tool))` 懒绑定，不 import 宿主类型 | `dsh-ops/lib/index.js:35-43,50-70` | `src/host/toolsSlot.ts` 的手写窄化接口可升级为「provider 注册器」（一处收口探测/降级/诊断三角色） |
| 4 | **release/尺寸静态门禁三件套**：`validate-manifest.mjs` + `check-file-size.mjs` + `check-release.mjs` + `verify:release` 组合串 | `dsh-ops/package.json:107-116` | `scripts/validate-dsh.mjs` 已有 2/3，可补「发布前一次跑」 |
| 5 | **工件逆向分析文档留档**（中英双语 5 篇 asar 拆解） | `dsh-ops/docs/` | 本次 asar 取证正落成 §4b（抑制文档漂移复发） |

**明确不吸收（附理由）**：

| 候选 | 理由 |
|---|---|
| 多入口 `exports` 矩阵（`./shell ./file ./ptc ./panel ./tui`…） | 每个子路径 exports 都是一条**跨版本契约边**（B6 类）；本仓单包已是最小面，扩面只增脆弱性 |
| `hide-official` 组件（替换/隐藏官方工具） | 与「不改写共享工具注册表」纪律冲突；会与他插件的 `tools.restrict` 形成不可预测交叠 |
| native Rust worker + koffi/PTY 二进制矩阵 | 与「多代兼容 + 纯 JS + 零运行时依赖」三条资产正面冲突（`docs/anic/18 §5` negative space 已裁决不做） |
| `dsh-plugin.json` 引用**远程** schema URL | 引入外部供应链/网络面与可变性；若要吸收必须把 schema **本地冻结** + sha 校验 |
| `panel` 组件（跨会话抓取 stdout，默认 disabled） | 与本仓「轨迹可见性经官方事件通道 + 工件投影」纪律冲突；对方自己也默认关闭，说明非基座能力 |

**工具/技能注册官方契约 vs 本仓实现（P1/P2 研究结论，已等价）**：

- `defineTool`（@deepseek-ai/dsh-tools）是官方推荐的第一方工具形态（DSL 校验+类型收窄）；**raw JSON-Schema ToolDefinition 同被 ctx.tools.register 直接接受**（MCP 路线）——dsh-anic 走 raw 路线，官方认可，**不迁移**（免增运行时依赖，DSL 收益有限）。字段名铁律逐项核对：`parameters` ✓（`src/host/toolsSlot.ts:86-97`）、`execute(args, exec)` 双参 ✓（:105）、`output:{schema,render}` ✓（:107）、render 返回 ContentBlock[] ✓（:59-62）、presentCall/presentResult 纯函数可回放 ✓（:109-111）、timeoutMs 宿主专用不模型可见 ✓（:120）。
- `ctx.skills.register` 官方形状（SkillRegistration = Omit<SkillDefinition,'invocation'|'provider'>，必填 name/description/source/content）——本仓 `src/host/skillRegistration.ts:113-121` 逐字段吻合（source:'runtime'/resourceBase:{kind:'directory'}）；同层重名 runtime 首胜+warn+no-op disposer 语义已复刻（`src/host/flows/registry.ts:5`）；disposer 经 `c.effect` 承接（`src/index.ts:38`）。
- presentationMeta 是 output 上的纯投影（args,value)→JsonValue，持久化到 tool/result 供 presentResult 回放——本仓卡片回放走 result.meta→presentResult（`src/host/tools.ts:74` 等），符合官方「UI 状态经持久化 meta 回放」路线，**无需动作**；仅当卡片需要调用期事实（非结果期）再补。
- dsh-ops（T-Auto）：KB 全库零提及，无吸收点；工具组织/路由/会话以 KB 官方为准（tools.md 宿主+per-scope 分层注册表、skills.md 同形态、api-gateway.md Remote 方法声明）。
- KB 镜像位置：`C:\Users\86156\.dsh\profiles\desktop\node_modules\dsh-plugin-dev-kb\kb\`（asar 归档内路径不可直接浏览）。

## 5. 已知限制与未验证项（诚实清单）

1. **P2 · 桌面多会话工作区解析（cycle-20/21/22 已收口）**：`resolveWorkspaceRoots`（`src/host/snapshotRoute.ts`）claimed 头 `X-ANIC-Workspace` → knownRoots → `.cycles` 存在采信 → registry → sessions 首条 → cwd。客户端面板从首个成功快照响应学得工作区根并回带头（`src/client/WorkflowGraphPanel.ts:79-86`）；服务端 **cycle-21 修 native 域 7 路由、cycle-22 全域统一**——所有路由文件（cycle/ledger/skillInstall/dualBootstrap/segmentedLedger/selfInit/stackProbe/flows/governance/selfCheck/skillHealth/native/snapshot）handler 一律 `getWorkspaceRoot(req)`，写侧路由（install/repair/advance/append/init/band-detect 等）在多会话宿主上不再写到首条会话的工作区。
2. **未验证**：`ctx.slots` 服务本体在 Host 包内的精确形状（客户端按官方 `ctx.slots.inject` 形态使用，双端实测可用）；0.3.x/0.4.x 真实 API 差异（无安装版可比对，靠 §2 能力探测覆盖）。
3. **运行中桌面宿主的 bundle 陈旧性**：属宿主生命周期语义（进程启动时加载），非本插件缺陷；文档化即可。cycle-32 系统化此结论（见 §6）。

## 6. 桌面端验证策略（cycle-32 系统化）

### 6.1 双宿主分工

| 宿主 | 用途 | 生命周期 |
|---|---|---|
| 测试宿主（`scripts/start-dsh-test.mjs start`，3080） | **每轮功能验证的主场**——启动即载最新 `dist/`，token 可从 stdout 拿，Playwright/Chrome DevTools 可自动化 | 每轮启停，无状态 |
| 桌面宿主（用户日常宿主，如 57200） | **上一版本回归场**——进程启动时载当时的 `dist/`，ESM import cache 进程级，build 后不重启则滞后一轮 | 长期存活，承载用户会话，agent 不可主动重启 |

**推论**：开发期「build 后桌面宿主表现旧行为」不是缺陷而是时序。等真实用户 `npm install` 升级也会重启宿主——发布语义一致。

### 6.2 桌面端可达面与 token 边界（2026-10-18 实测）

- **API 面（免 token，全通）**：面板消费的全部 14 端点（workflow-snapshot/step-trace/self-check/org-status/flows-status/cycle-list/cycle-state/hitl-audit/api/ledger×2/invocations/live/skill-health/skill-status/governance-budget）在桌面宿主 57200 带 `X-ANIC-Workspace` 头逐一验证 **14/14 全 200**（v0.30.0 host）。注意快照路由是 `/anic/api/workflow-snapshot`（无裸 `/anic/snapshot`）。
- **GUI 面（token 墙）**：一切页面路径 401 `dsh web authentication required`——token 只在宿主启动时打印给用户。穷尽过的通道（全部不可得）：profiles 目录无 token 文件、`~/.dsh/logs` 无当次启动日志、Electron userData（logs/Local Storage leveldb/Session Storage/Cookies/webview Partitions）无 token 键、Authorization 头三形态全 401、浏览器进程命令行无 URL（用户经桌面内部 webview `dsh-app://` scheme 访问）、8326 端口是 LLM gateway 非 GUI。
- **结论**：桌面 webview **UI 目验**只能由用户人手完成（打开桌面窗口会话页 ANIC 标签）；agent 的等价验证 = API 面 14/14（数据层）+ 测试宿主 UI 验证（渲染层，同一份 client bundle）。此项列为用户动作项。

### 6.3 桌面端历史实测锚点

- 2026-10-16（cycle-13 期）：12 工具注册/4 路由 200/ANIC 标签并列——§3.1 记录。
- 2026-10-18（cycle-32）：14/14 面板端点全通；宿主 17468 于 18:23:57 启动载 v0.30.0 bundle，其 `skill/status` 返回 `installedVersion:null` 是旧 `readSkillVersion` 正则行为（cycle-31 修复已入 18:49 dist，宿主下次重启生效）——**「侥幸正确」时序案例**：旧行为碰巧正确掩盖了正则缺陷。

## 7. 工具展示层官方契约对齐（cycle-22）

出处：`dsh-plugin-dev-kb/kb/site/reference/cookbook/adding-a-tool.md`（execute() 约定的规则 + 工具在 UI 中的渲染方式）。

### 7.1 safeHandler 的 isError 语义修正

官方契约：**「抛出异常或返回无效值意味着 isError。基础设施故障请抛异常。成功的领域结果即使表示不理想的状态，也应写入规范值。」**

| 语义 | 旧实现（≤v0.22.0） | 新实现（cycle-22） |
|---|---|---|
| infra 故障（子进程 spawn 失败、文件系统异常等） | 被折叠为 `{ error: message }` 正常返回——模型/轨迹看到 `isError=false` 的「成功」 | 异常沿 Promise 拒绝传播给注册表 → 注册表收敛 `isError=true` |
| 领域失败（脚本非白名单、validateWorkspace 拒绝、eval exit!=0） | 显式 `{ error }` 规范值 | 不变——规范值 + Native 渲染器解释状态（官方推荐形态） |

grep 验证全部 `tools*.ts` gateway 无 intentional throw（所有抛出的异常确为 infra），rethrow 安全；`skillToolNative.test.ts` 的 `not whitelisted` 领域拒绝断言不受影响。

### 7.2 presentResult 第二参双形状归一化

官方签名：`presentResult(args, { content, isError, meta? })`——`content` 是模型可见内容块数组，`meta` 由 `output.presentationMeta(args, value)` 派生持久化在 `result.meta`，回放时重现。宿主 0.2.0-rc.2 实测宽容直传原始 execute 返回值（`{ exitCode, stdout, stderr }`）。

`src/host/presentation.ts` 新增 `normalizeToolResult(result)`（纯函数）：

- **官方形状判定**：`result.content` 是数组 → 从 `meta` 提取持久化事实（`exitCode/stdout/stderr`），`isError` 透传；`meta` 无输出时从 content text 块拼接兜底（结果文本不丢）；
- **宽容形状**：原样返回（宿主直传）。

`terminalResult()` 入参先过归一化；5 个 gateway（skill/hitl/flows/evolution/autoFix）与 `tools.ts anic_evaluate` 的 presentResult 全部接线。**收益**：0.3+ 宿主收紧传参形状时卡片不碎（多代防御）。

### 7.3 已知小偏差（未改，实测无害）

`presentCall` terminal 卡片字段官方为 `description`，dsh-anic 用 `summary`（`toolsSlot.ts TerminalCallView`）。宿主 0.2.0-rc.2 实测渲染正常——若未来版本卡片描述缺失，此处为第一排查点。

## 8. 分发正典化：DSH 市场收录（cycle-23）

> 出处：awesome-dsh-plugin/awesome-dsh-plugin `contributing.md`（2026-10-18 快照，web_fetch raw）+ dshmarket 1.66.35 README.zh.md + dsh-plugin-dev-kb `site/develop/basic/publish.md`。

### 8.1 DSH 插件分发三通道

| 通道 | 机制 | dsh-anic 状态 |
|---|---|---|
| **官方 bundle 安装** | `dsh plugin --profile <name> add <pkg>`（pnpm 转发；git 源码安装走 `prepare` 构建脚本 + `allowBuilds` 授权；npm/tarball 免授权） | manifest 已就绪（`dsh.bundle.patch` ✓ / peer 显式预发布分支 ✓ / `engines.dsh` 声明层 ✓） |
| **市场可视安装** | dshmarket 插件读精选目录 awesome-dsh-plugin（`data/plugins/<owner>__<repo>.yml`）一键装 | 条目草稿 `docs/agents/marketplace-提交草稿.md`（待用户建 GitHub 仓后提 PR） |
| **技能 CLI 分发** | `npx dsh-anic init <dir>`（技能-only 路径，不带 DSH 宿主） | **已实施**（cycle-25，`bin/anic-init.mjs` 134 行零依赖）：技能 69 文件 → `.dsh/skills/ai-native-iteration-cycle/` + `.cycles/` 骨架；`--framework claude|codex` 跨 harness；幂等三态；`--dry-run` 零写盘；e2e 由 `tests/unit/npxInit.test.ts` 守护（cycle-104 起 69 文件计数） |

### 8.2 收录硬性要求（对照本仓库逐项）

- `dsh.bundle` manifest ✓（只声明 `dsh.client` 会被 CI 拒——最常见的被拒形态）；
- 真实可用代码 ✓；仓库满 1 天（CI 自动查）✓；活跃维护 ✓；
- 仓库打 `dsh-plugin` topic（**用户动作项**，本仓库尚无 git remote）；
- 描述必须与代码核实一致：**19 个 anic_ 工具 / 62 个 HTTP 路由**——工具或路由增减后必须同步条目与 README（条目草稿内已警示）；
- peer 范围写显式预发布分支（`>=0.2.0-rc.2 <0.4.0-0`，§1.1 已是正确形态；contributing.md 的 semver 陷阱示例与本仓库实践一致）。

### 8.3 screenshots.json 惯例（已落地）

仓库根 `screenshots.json` 声明 1-8 张相对路径图（不得以 `/` 开头、不得含 `..`、第三方图床拒绝）→ 市场详情页 App Store 式轮播。本仓库三张真机截图（`docs/screenshots/`，Playwright 于 3080 测试宿主拍摄）：`workflow-graph.png`（工作流图+实时调用流顶部）、`ledger-hitl.png`（门禁账本+HITL 队列）、`autonomy-gauge.png`（自主级仪表带+技能健康区）。截图更新只推本仓库，无需再动市场条目。
