# dsh-native-api · 操作手册

> 本文是 `dsh-native-api` 叶技能的详细操作手册。KB 行号指向
> `C:/Users/86156/.dsh/profiles/desktop/node_modules/dsh-plugin-dev-kb/kb`（下文以 `kb/` 代指，
> 2026-10-21 快照，commit `687f282`）；本仓行号指向 dsh-anic 实测。
> 读取时机：打包、安装、声明兼容、改 patch、配置工具/技能/路由时。

## 0. 仓库事实基座（抽验）

| 事实 | 值 | 证据 |
|---|---|---|
| manifest 键 | `dsh.manifestVersion: 1`、`dsh.bundle.patch`、`dsh.client` | `package.json:78-90` |
| bundle patch 文件 | `./cordis.patch.yml`（13 行，单条 `insert` + `!!js` 防双挂载） | `package.json:81`；`cordis.patch.yml:10-13` |
| client 注入 | `@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-locale` | `package.json:84-89` |
| engines.dsh | `>=0.2.0-rc.2 <0.3.0-0 \|\| >=0.3.0-rc.1 <0.4.0-0`（两段显式） | `package.json:59` |
| peer | `@deepseek-ai/cordis ^4.0.1`；`@deepseek-ai/dsh` optional | `package.json:61-64` |
| inject | `['tools','sessions','skills']`（webServer 已移交子 fiber） | `src/index.ts:125` |
| deferLoading 契约 | `src/host/toolsSlot.ts:152` 声明；当前工具都不带 | `src/host/toolsSlot.ts:140-152`；`tests/contract/nativeDeferLoadingContract.test.ts:34-39` |

## 1. 两种 manifest

### 1.1 组合包 manifest（bundle）

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

证据：`kb/site/develop/basic/publish.md:36-47`。

`patch` 也接受有序文件列表（`["./base.patch.yml", "./web.patch.yml"]`），launcher 按序作为同一层应用；
无 `dsh.bundle` 声明的包仍可安装但只作普通依赖（`kb/publish.md:67`）。

### 1.2 profile manifest

profile 目录含两个文件：`package.json`（`dsh.profile.bundles` 有序列表 + 树外插件依赖）与
`cordis.patch.yml`（用户自己的 patch 层）。profile manifest 从不需要手写——
`dsh --profile <name> --from-default-profile <template>` 从随附模板创建/重置，
`dsh plugin` 创建以 base 为基础的 profile 并维护已安装 bundle 列表。

证据：`kb/publish.md:71-78`。

## 2. 安装进 profile

```sh
dsh plugin --profile demo add ./hello-plugin
```

首次使用初始化 profile（`@deepseek-ai/dsh-base` 作为第一个组合包），pnpm 链接 checkout，
`dsh` 因包声明了 `dsh.bundle` 把它追加进 `dsh.profile.bundles`：

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": { "dsh-hello-plugin": "link:/path/to/hello-plugin" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"] } }
}
```

通过链接安装的 checkout 保留自己的 `node_modules`。需要与宿主共享实例的 dsh 包**同时**声明在
`peerDependencies` 与 `devDependencies`；devDependency 副本供类型检查和独立测试使用。
需要独立版本的第三方依赖和无状态 dsh 工具包放 `dependencies`。

证据：`kb/publish.md:82-112`。

验证而不启动：`dsh --profile demo --dump-config`（显示 `# == dsh-hello-plugin` 层）→ `dsh --profile demo`。
移除：`dsh plugin --profile demo remove dsh-hello-plugin`（同时移除依赖和层）。

## 3. 层加载顺序（R05）

```
1. profile 的 dsh.profile.bundles 列表所列各 bundle patch（按列表顺序）
2. profile 自己的 cordis.patch.yml
3. home 级 $DSH_HOME/cordis.patch.yml（各 profile 共享）
4. 每个 --patch <path> overlay（按 argv 顺序）
```

后应用的层**按行胜出**，且 patch 替换目标行的整个 `config` 值，不是深度合并各键。两个推论：

- 你的 patch 可以按 `id` 覆盖前面各层的行（就像 `dsh-web-app` 覆盖 `dsh-base` 的行那样），
  **但必须重述该行需要的每一个键**，而不是只写改动的那个。
- 用户可以在自己 profile 的 `cordis.patch.yml` 中覆盖你的行，无需改包——优先给出用户大概率保留的
  默认值，其余交给 schema。

证据：`kb/publish.md:123-139`。

## 4. engines.dsh 与 peer / requirements

```json
"engines": { "dsh": ">=0.2.0 <0.3.0" }
```

- `engines.dsh` SemVer 范围决定兼容性；安装和 profile 启动会拒绝不满足该范围的组合包。
- 没有 `engines.dsh` 时，改为检查其 `@deepseek-ai/dsh*` peer 依赖范围。
- **`peers` 字段改名为 `requirements`**。
- `workspace:` 在 `engines.dsh` 中视为**不兼容**。

证据：`kb/publish.md:69`；`kb/extra/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.zh.md:12-21`。

本仓现状：`engines.dsh: ">=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-rc.1 <0.4.0-0"`（两段显式），peer `@deepseek-ai/dsh` optional
（`package.json:59,61-64`）。差距：上界 `<0.4.0-0` 在新规则下会被严格执行，可能阻塞后续 DSH——逐版本核对上界，建立
0.2.x→0.3.x 升级 checklist（`B-dsh-native-api-baseline.md` §2.1、§3 P-N9）。

## 5. git 安装：prepare + allowBuilds（R06）

git 安装拉源码不拉构建产物，没有环节运行 `build`，TS 包到手无 `lib/`，加载失败。

**作者**：提供 `prepare` 脚本，pnpm 在 git 安装后运行它，从源码构建出发布入口，必须自包含
（不能假设旁边有 monorepo checkout）。专用 tsdown 配置可直接转译 `src/`，不用项目引用，也不做类型检查。

**用户**：pnpm ≥10 在显式允许前拒绝运行 git 依赖的 `prepare`，第一次 `add` 失败；`dsh` 会指出修法——
把 pnpm 打印的确切包键复制进该 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

然后重新执行 `add`。**把这项授权视为允许该包代码在安装时于你的机器上执行**，且不在 agent 运行的任何
沙箱之内。只对源码可信的包授权，并锁定 commit（`github:you/hello-plugin#<sha>`）。

不想授权就分发构建产物：发布到 npm（`pnpm publish` 时构建 `lib/`）或交付 tarball（`pnpm pack`，
`dsh plugin add ./hello-plugin-0.1.0.tgz`）。

证据：`kb/publish.md:164-190`。

## 6. 插件配置 schema（config.md）

导出 `Config` 类型与同名 Schemastery schema，默认值写在 schema 中：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export interface Config { greeting: string; maxRetries: number; verbose?: boolean }

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) { /* config.greeting */ }
```

- Cordis 加载时通过导出的 schema 校验配置并填充默认值；**不要导出普通对象**作为 `Config`
  （不满足 Standard Schema 接口）。
- 无效配置在插件加载时失败并给出明确错误。
- 配置变更触发热替换：改 `cordis.yml` 中某插件 `config` 后，框架卸载旧实例加载新实例；
  注册都是 effect 会自动清理，替换后不保留旧注册。

证据：`kb/site/develop/basic/config.md:10-48,77-103`。

## 7. Service 与依赖注入（service.md）

- Service 基类：`class X extends Service`，`super(ctx,'name')`，`declare module '@deepseek-ai/cordis'` 声明合并。
- 静态 `export const inject=['tools']`；可选依赖用 `ctx.get('metrics')`（默认 strict）。
- 依赖服务消失 → 插件自动 dispose；恢复后自动重载。
- `group:true` + `isolate:{shell:true}` 让不同组看到不同实例。
- **不使用 `ctx.inject()` 动态挂载**：dsh-anic 已在真实宿主实证其回调不触发
  （`src/index.ts:20-27`），生产验证形态是静态 `inject`。

证据：`kb/site/develop/framework/service.md:40-144`；`src/index.ts:20-28`。

## 8. Tool 注册（tools.md）

### 8.1 defineTool 类型 DSL

```ts
defineTool({ name, description, parameters, output, execute, ... })
```

- `InferArgs` 按 `required:true` 推导；`ValueSchemaSpec` 支持 string/number/integer/boolean/null/array/object/json/oneOf。
- `defineTool` 把参数推导与 `parameterSchemaSpecToJsonSchema()`、`validateArgs()` 绑定，
  把 `execute`/`render`/`presentationMeta` 与 `InferValue<OutputSchema>` 绑定。
- 参数不匹配抛 `ToolArgsError`（`INVALID_ARGS`）；无效输出抛 `ToolOutputError`（`INVALID_TOOL_OUTPUT`）。
- 精确推导保持到 16 层容器，之后放宽为 `JsonValue`；运行时校验仍遍历完整 schema。

证据：`kb/site/reference/subsystems/tools.md:112-165`。

### 8.2 ToolDefinition 字段

| 字段 | 要求 | 证据 |
|---|---|---|
| `output` | 必填，`{ schema, render }`，schema 必须 object-rooted | `tools.md:19-27,165` |
| `execute(args, exec)` | 双参；`args` 为 lossless 冻结快照 | `tools.md:44` |
| `timeoutMs` | 可选，永不模型可见；声明即承诺 forward `exec.signal` | `tools.md:67-74` |
| `isConcurrencySafe` | 可选纯同步分类器，仅 `true` 入并行组 | `tools.md:75-88` |
| `presentCall` / `presentResult` | 纯函数、可回放、无副作用 | `tools.md:98-106` |
| `projectContent` / `finalizeContent` | 可选内容投影 | `tools.md:54-66` |

本仓走 **raw JSON-Schema ToolDefinition**（非 `defineTool` DSL），官方 `ctx.tools.register` 直接接受
（MCP 路线）；字段铁律逐项核对在 `src/host/toolsSlot.ts`。

证据：`docs/agents/工具面参考.md:122-138`；`kb/tools.md:13-108`。

### 8.3 `ctx.tools` 方法与限制

- `register` / `restrict` / `guard` / `get` / `schemas` / `executionMode` / `execute` / `presentAs`。
- `restrict` 对 unknown global tool **抛错**；`allow`/`deny` 取交集，scoped 注册不受约束。
- 执行流水线：`tools/pre-execute` → guard → `tools/execute` → `projectContent` → `tools/post-execute`
  → `finalizeContent` → `tools/result`。

证据：`kb/tools.md:167-186,526-599`。

## 9. Skill API（skills.md）

- `ctx.skills.registerProvider(create)`：注册 provider，`create` 收到 `SkillProviderControl`。
- `ctx.skills.register(skill)`：注册 runtime skill（本仓 `src/host/skillRegistration.ts:113` 走此路径）。
- `ctx.skills.list()` / `snapshot()` / `get(name)`。
- `SkillProvider`：`list(options)` / `get(candidate, options)`；非权威观测不可缓存。
- 身份：kebab-case `^[a-z0-9]+(?:-[a-z0-9]+)*$`；rank 100~600 各根目录。
- 调用策略：`SkillInvocationPolicy{modelInvocable,userInvocable}`；frontmatter
  `disable-model-invocation` / `user-invocable`。

证据：`kb/site/reference/subsystems/skills.md:23-66,68-132,272-330`。

## 10. WebServer（web-server.md）

- `ctx.webServer.register(route)` 添加具名路由并返回 disposer；**重复 `(kind, path)` 抛异常**
  （路由模式是组合层约定，冲突即配置错误）。
- WebServer 只做 gzip/TLS/认证，**不自动加 ETag**；插件需自实现条件请求。
- 本仓 `snapshotRoute.ts` 已实现 `If-None-Match` → 304 + `X-ANIC-Snapshot-Digest`
  （`src/host/snapshotRoute.ts:175-241`）。
- `kind: 'exact'` 精确匹配（非前缀）；本仓 62 个端点全是 exact。

证据：`kb/site/reference/subsystems/web-server.md:84-90,196-204`；`src/host/snapshotRoute.ts:175-241`；
`docs/agents/API参考.md:25`。

## 11. `deferLoading`（R08）

- 宿主原生字段 `ToolSchema.deferLoading?: true`；语义「请求把该工具定义延迟加载进模型上下文」，
  用 Anthropic 的 `defer_loading` 术语。
- 宿主注册时只校验 `output` 与 `timeoutMs`，其余字段原样收下；投影时 `schemaOf` 解构
  `{name,description,parameters,deferLoading}`，仅当 `deferLoading === true` 才放进模型 schema。
- 本仓 `src/host/toolsSlot.ts:152` 已声明；当前注册的工具都不带（默认零行为变更）。
- 作用域张力：`deferLoading` 只适合「所有场景一律延迟」的静态选择；per-workspace 保留
  `restrict` + loader 工具方案。

证据：`src/host/toolsSlot.ts:140-152`；`docs/agents/渐进式披露与轻量索引设计.md:448-480`；
`kb/site/reference/subsystems/llm-streaming.md:77,704`。

## 12. `ctx.get(name, false)` 探测纪律（R07）

- `ctx.get(name)` 默认 `strict=true`：服务缺失会杀死正在 loading 的 provider。
- 探测存在性一律 `ctx.get(key, false)`。
- 本仓 `inject=['tools','sessions','skills']`；`webServer` / `workspaceRegistry` 用探测，
  路由走独立子 fiber（`src/index.ts:4-28,125,142`）。
- 不在 headless 下强 inject `webServer`/`pluginManager`。

证据：`CLAUDE.md:28`；`src/index.ts:4-28,125`；`kb/site/develop/framework/service.md:92-103`。

## 13. 脚本接口

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `scripts/dsh-manifest-check.mjs <project-dir>` | 校验 manifest v1 / `dsh.bundle.patch` / `dsh.client` / `engines.dsh` / `files` / `peerDependencies` | 0 通过 / 1 违规 / 2 用法错误 |
| `scripts/layer-order-check.mjs <project-dir>` | 校验层加载顺序声明（bundle → profile patch → home patch → overlay） | 0 通过 / 1 违规 / 2 用法错误 |

详细契约见 `scripts/README.md`。

## 14. 证据边界

- 本文引用的 KB 行号均为 `dsh-plugin-dev-kb` **2026-10-21 快照**（commit `687f282`）实测行号；
  与实际安装的 DSH 运行时可能不一致——**以实际安装包为准**。
- 本文引用的本仓行号为写作时点（commit `75e8602`）实测。
- 「原生化机会」均为文档契约层面的可行性判断，需经类型检查与冒烟验证
  （`B-dsh-native-api-baseline.md` §6 证据边界声明）。
- 本技能不执行 `pnpm build/test/lint` 或真实宿主探针。
