---
name: dsh-native-api
version: 0.2.2
whenToUse: >
   在 dsh-anic（或任何 DSH 插件）里需要理解/改造插件 manifest、打包为组合包（bundle）、
   安装进 profile、声明 `engines.dsh` 兼容范围、写 `cordis.patch.yml`、处理 git 安装的
   `prepare` + `allowBuilds`、配置 `deferLoading` 或用 `ctx.get(name, false)` 探测可选服务时使用。
   触发词（中文）：dsh plugin、bundle、profile、engines.dsh、cordis.patch、manifest、
   打包、安装、依赖注入、deferLoading、不变量探测。
   Trigger words (EN): dsh plugin, bundle, profile, engines.dsh, cordis.patch,
   manifest, packaging, install, dependency injection, deferLoading, probe.
description: >
   Triggers: dsh plugin, bundle, profile, engines.dsh, cordis.patch, manifest,
   packaging, install, dependency injection, deferLoading, probe. Use when building
   or installing a DSH plugin bundle, declaring engines.dsh compatibility, authoring
   cordis.patch.yml, handling git-install prepare/allowBuilds, configuring
   deferLoading, or probing optional services with ctx.get(name, false).
---

# DSH 原生 API（dsh-native-api）

## 一句话定位

dsh-anic 的 **DSH 打包/安装/插件原生面操作叶技能**：把「bundle vs profile 两种 manifest、
`dsh.bundle.patch` → `cordis.patch.yml`、`engines.dsh` SemVer、层加载顺序、git 安装的
`prepare` + `allowBuilds`、`ctx.get(name, false)` 探测纪律、`deferLoading`」固化为八条纪律，
并提供两个确定性检查脚本。是其他叶技能的**事实基座**。

> 本技能只提供**操作知识与确定性脚本**，不改变流程脊柱。KB 快照（`dsh-plugin-dev-kb`）与
> 实际安装的 DSH 运行时可能不一致——**以实际安装包为准**。

## 硬性规则

| # | 规则 | 说明 | 证据 |
|---|---|---|---|
| R01 | 区分 bundle 与 profile 两种 manifest | bundle 声明 `dsh.bundle`（贡献什么层）；profile 声明 `dsh.profile.bundles`（由哪些包组成） | KB `site/develop/basic/publish.md:14-19` |
| R02 | bundle 用 `dsh.bundle.patch` 指向 `cordis.patch.yml` | 无该声明仍可安装，但只作普通依赖，`dsh plugin` 会警告且不激活任何层 | KB `publish.md:45,67`；本仓 `package.json:80-82` |
| R03 | `engines.dsh` 用 SemVer 声明兼容 | 安装/启动拒绝不满足范围的组合包；`peers` 字段改名为 `requirements` | KB `publish.md:69`；`extra/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.zh.md:12-21` |
| R04 | 缺 `engines.dsh` 才回退 peer | `workspace:` 在 `engines.dsh` 中视为不兼容 | KB `plugin-engines-dsh/guide.zh.md:12-21` |
| R05 | 层顺序：bundles → profile patch → home patch → `--patch` | 后应用的层按行胜出；patch **整行替换** config 而非深合并 | KB `publish.md:123-137` |
| R06 | git 安装需 `prepare` + `allowBuilds` | pnpm ≥10 默认拒绝 git 依赖的 `prepare`；用户须把包键写入 `pnpm-workspace.yaml` 的 `allowBuilds` | KB `publish.md:164-184` |
| R07 | 可选服务用 `ctx.get(name, false)` 探测 | 默认 `strict=true` 会杀死正在 loading 的 provider | `CLAUDE.md:28`；KB `framework/service.md:92-103` |
| R08 | `deferLoading` 是宿主原生字段 | 置 `true` 延迟加载工具定义；只适合「所有场景一律延迟」 | `src/host/toolsSlot.ts:140-152`；KB `llm-streaming.md:704` |

### bundle vs profile

| | 组合包（bundle） | profile |
|---|---|---|
| 是什么 | 你编写并分发的 npm 包 | 用户用 `dsh --profile <name>` 启动的目录 |
| manifest | `dsh.bundle.patch` → `cordis.patch.yml` | `dsh.profile.bundles`（有序列表） |
| 回答的问题 | 这个包贡献什么？ | 这套配置由哪些包按什么顺序组成？ |
| 位置 | 任意 npm/git/tarball | `$DSH_HOME/profiles/<name>` |

证据：KB `publish.md:14-19,71-77`。

### 层加载顺序（R05）

```
1. profile 的 dsh.profile.bundles 列表所列各 bundle patch（按列表顺序）
2. profile 自己的 cordis.patch.yml
3. home 级 $DSH_HOME/cordis.patch.yml（各 profile 共享）
4. 每个 --patch <path> overlay（按 argv 顺序）
```

后应用的层按行胜出，且 patch **替换目标行的整个 `config` 值**，不是深度合并。
按 `id` 覆盖前面各层的行时，**必须重述该行需要的每一个键**（KB `publish.md:134-137`）。

证据：KB `publish.md:123-137`。

### 安装命令

```sh
dsh plugin --profile <name> add ./hello-plugin          # 本地 checkout
dsh plugin --profile <name> add github:you/hello-plugin # git 安装（见 R06）
dsh plugin --profile <name> add your-package            # npm 包（预构建，免构建授权）
dsh plugin --profile <name> remove <pkg>
dsh --profile <name> --dump-config                       # 只验证该层，不启动
dsh --profile <name>
```

证据：KB `publish.md:82-121,164-190`。

### git 安装的 `prepare` + `allowBuilds`（R06）

git 安装拉取的是**源码，不是构建产物**，没有任何环节运行 `build` 脚本，TypeScript 包到手时没有
`lib/`，加载会失败。两边各做一件事：

- **作者**：提供 `prepare` 脚本——pnpm 在 git 安装后运行它，从源码构建出发布入口，且必须自包含
  （不能假设旁边有 monorepo checkout）。
- **用户**：为构建授权。pnpm ≥10 在显式允许前拒绝运行 git 依赖的 `prepare`，第一次 `add` 会失败；
  把 pnpm 打印的确切包键复制进该 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

然后重新执行 `add`。**把这项授权视为允许该包代码在安装时于你的机器上执行**，且不在 agent 沙箱内；
只对源码可信的包授权，并锁定 commit（`github:you/hello-plugin#<sha>`）。

不想让用户授权，就改为分发构建产物：发布到 npm（`pnpm publish` 时已构建 `lib/`）或交付 tarball
（`pnpm pack`）。证据：KB `publish.md:164-190`。

### `ctx.get(name, false)` 探测纪律（R07）

- `ctx.get(name)` 默认 `strict=true`：服务缺失会**杀死正在 loading 的 provider**。
- 探测存在性一律用 `ctx.get(key, false)`。
- 本仓做法：`webServer` / `workspaceRegistry` 是可选依赖，用 `ctx.get(name, false)` 探测
  （`src/index.ts:125` 的 inject 只有 `['tools','sessions','skills']`；路由走独立子 fiber）。
- **不要**在 headless 下强 inject `webServer`/`pluginManager`——它们属 Web 组合，headless 无之，
  硬依赖会使整条 fiber pending。

证据：`CLAUDE.md:28`；`src/index.ts:4-28,125`；KB `framework/service.md:92-103`。

### `deferLoading` 字段（R08）

- 宿主原生字段（`ToolSchema.deferLoading?: true`），语义是「请求把该工具定义延迟加载进模型上下文」，
  用 Anthropic 的 `defer_loading` 术语（`src/host/toolsSlot.ts:141-152` 注释逐字引用）。
- 宿主注册时只校验 `output` 与 `timeoutMs`，其余字段原样收下；投影时 `schemaOf` 解构
  `{name,description,parameters,deferLoading}`，**仅当 `deferLoading === true`** 才放进模型 schema。
- 本仓 `src/host/toolsSlot.ts:152` 声明了该字段（cycle-74 契约补全）；**当前注册的工具都不带
  `deferLoading`**（默认零行为变更）。
- 作用域张力：`deferLoading` 只适合「本插件工具在所有场景一律延迟」的静态选择；per-workspace
  场景保留 `restrict` + loader 工具方案（`docs/agents/渐进式披露与轻量索引设计.md:448-480`）。

证据：`src/host/toolsSlot.ts:140-152`；KB `llm-streaming.md:77,704`。

## 快速启动

1. **打包**：`package.json` 的 `dsh` 键声明 `bundle.patch` 与 `client`（本仓 `package.json:78-90`）。
2. **写 patch**：`cordis.patch.yml` 用 `- insert:` 声明 entry（本仓 `cordis.patch.yml:10-13`），
   用 `disabled: !!js "..."` 防双挂载。
3. **声明兼容**：`engines.dsh` 用 SemVer 范围（本仓 `>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-rc.1 <0.4.0-0`，
   **两段显式**——不是单段 `<0.4.0-0`，单段会把 rc 分支挡在外面；`package.json:59`）。
4. **安装**：`dsh plugin --profile <name> add <pkg>`。
5. **跑检查**：
   - `node assets/skills/dsh-native-api/scripts/dsh-manifest-check.mjs <project-dir>`
   - `node assets/skills/dsh-native-api/scripts/layer-order-check.mjs <project-dir>`

## 本仓 manifest 基座（引用基座）

```jsonc
// package.json:78-90
"dsh": {
  "manifestVersion": 1,          // KB 中无该字段文档，属实现字段；勿据此做版本分支
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-conversation", "..."] }
}
```

```yaml
# cordis.patch.yml:10-13
- insert:
    - id: anic
      name: 'dsh-anic'
      disabled: !!js "[...ctx.loader.entries()].some((e) => e.options.name === 'dsh-anic' && e.options.id !== 'anic' && !e.disabled)"
```

证据：`package.json:78-90`；`cordis.patch.yml:10-13`。

## 导航索引

按需加载——只在需要时读取对应参考文档：

| 需要了解 | 读取 |
|---|---|
| 完整操作手册（manifest、安装、层顺序、peer、SkillProvider、WebServer、Tool） | `references/operations.md` |
| manifest 不合规、peer 冲突、层覆盖、git 安装失败、probe 陷阱的分诊 | `references/troubleshooting.md` |
| manifest 校验 + 层顺序检查脚本用法 | `scripts/README.md` |

## 与主干技能的对接

- 本技能产出的事实基座抽验证据 → 主干 G0 门禁（R14 事实基座抽验）。
- 不自我改码；发现问题走 tech-debt + 下一轮 cycle 任务清单（人类门）。

## 相关文档

- 权威基线：`.cycles/research-inputs/B-dsh-native-api-baseline.md`
- KB：`site/develop/basic/publish.md`、`site/develop/basic/config.md`、
  `site/reference/subsystems/web-server.md`、`site/reference/subsystems/tools.md`、
  `site/reference/subsystems/skills.md`
- 本仓：`package.json`、`cordis.patch.yml`、`src/index.ts`、`src/host/toolsSlot.ts`、
  `docs/agents/渐进式披露与轻量索引设计.md`
