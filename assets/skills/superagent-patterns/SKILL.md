---
name: superagent-patterns
version: 0.1.1
whenToUse: >
   在 dsh-anic（或任何 DSH 插件）里需要参考 Superagent 研究原型的部署/授权/执行模式时使用：
   独立 profile 隔离、stateDir、每小时 check、四类退出码、Source/Policy/Executor、
   准入表（explicit/inferred/not admitted）、Mandate 与 Policy version、Management API、
   setup 环境变量剥离、升级备份回滚、agent preset。
   触发词（中文）：superagent、部署模型、stateDir、hourly check、准入、Mandate、
   退出码、Source、Policy、Executor、独立 profile。
   Trigger words (EN): superagent, deployment model, stateDir, hourly check,
   admission table, Mandate, exit code, Source, Policy, Executor, isolated profile.
description: >
   Triggers: superagent, deployment model, stateDir, hourly check, admission table,
   Mandate, exit code, Source, Policy, Executor, isolated profile. Use when studying
   or adapting the dsh-superagent research prototype's deployment, authorization
   and execution patterns (isolated profile, stateDir, hourly check, four-tier
   exit codes, admission table, Mandate, Management API, env stripping, upgrade).
---

# Superagent 模式（superagent-patterns）

## 一句话定位

dsh-anic 的 **Superagent 部署/授权/执行模式对标叶技能**：把外部研究原型
`deepseek-ai/dsh-superagent-prototype` 的「独立 profile、`stateDir`、每小时 check、
四类退出码、Source/Policy/Executor、准入表、Mandate、Management API、环境变量剥离、
升级备份回滚」固化为十条纪律，并提供两个确定性检查脚本。

> ⚠️ **证据边界（必读）**：本技能的 Superagent 事实**全部来自外部研究报告**
> `.cycles/research-inputs/A-dsh-superagent-study.md`（clone commit `8c32a9dc`，未运行任何
> build/test），**不是 dsh-anic 本地源码**。凡涉及 dsh-anic 现状的对照，均明确标注「对照」并
> 与 Superagent 事实分开。研究原型自述「研究原型仅供参考，非 DeepSeek 官方产品」，部分方向未实现。

## 硬性规则

| # | 规则 | 说明 | 证据（研究报告行号） |
|---|---|---|---|
| R01 | 独立 profile 隔离 | `superagent` profile 从 DSH Web 模板创建，服务面板于 `127.0.0.1`；**必须与工作 profile 分开**（插件改进程级 PATH 与 git 设置，需独立重启/升级） | §8 L210 |
| R02 | `stateDir` 是唯一必填 | 含数据库、目录锁、`worker-bin` shims、agent git 配置、默认 `work/` 下的 Ticket 目录；**不可经面板改** | §8 L212-213 |
| R03 | 每小时 check 建在日常 profile | 用 schedule 每小时跑 `scripts/dsh-superagent --profile superagent status`；退出码分档处置（见 R04） | §8 L215 |
| R04 | 四类退出码分档处置 | 0 静默 / 1 `--respect-stop restart` / 2 只报 errors 不重启 / 3 只报 setup 不重启 | §8 L214-215 |
| R05 | 三块域模型 | Source（事件流）/ Policy（版本化评估规则）/ Executor（每 Ticket 一个持久 Session + 目录） | §2 L25-37 |
| R06 | 准入三级 | `explicit` / `inferred` / `not admitted`；未点名格只在 scope 接收全部消息时可用 | §3 L51-52 |
| R07 | Mandate 不可变 + Policy version | 只有三种操作改变 Mandate：accept 创建、人的 stop 撤回、失败 revalidate revoke | §3 L35, L61 |
| R08 | Management API 是面板唯一写入口 | `GET state` / `PUT settings` / `POST executor/pause` 等；只有面板能改执行环境设置 | §7 L199-203 |
| R09 | setup 剥离敏感环境变量 | 移除名字含 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 的环境变量 | §8 L218 |
| R10 | 升级先备份再回滚 | 等无 Executor 在回合中 → 备份 `orchestrator.sqlite` → 升级 → restart → 检查；新库不能被旧版本打开 | §8 L216 |
| R11 | agent preset 不可缺 | `dsh-superagent-worker` / `dsh-superagent-router` 两个 preset 定义在 `cordis.patch.yml`（order 90/91） | §5 L96 |

### 独立 profile 与 `stateDir`（R01/R02）

```yaml
# examples/profile.cordis.patch.yml:1-12
webserver: { host: 127.0.0.1, port: 3082 }
dsh-superagent:
  config:
    stateDir: <abs>
```

- `stateDir` 是唯一必填；`promptMaxChars` / `admissionContextMaxPages` / `admissionContextTimeoutMs`
  可选且 volatile（读时生效、改了不重启）。
- Feishu 需再开 `dsh-superagent-feishu disabled:false`。

证据：§8 L212。

### 每小时 check 与四类退出码（R03/R04）

**四类退出码**（`scripts/dsh-superagent`）：

| 退出码 | 语义 |
|---|---|
| 0 | 正常 |
| 1 | 不运行 / 运行两次 / runtime 报错（**重启可能修好**） |
| 2 | 运行但某部件报错（**重启修不好**） |
| 3 | 运行但等 setup |

**每小时 check 的处置**（必须建在**日常使用的 profile**，不是 superagent）：

| 观察到的退出码 | 动作 |
|---|---|
| 0 | 静默 |
| 2 | 只报告 `errors`，**不重启** |
| 3 | 只报告 `setup`，**不重启** |
| `manually_stopped: true` | 保持停止 |
| 1 | 跑 `--respect-stop restart` |
| 失败 | 读最新日志并修 |

**只有 `stop` 写 marker，`start` 清 marker，`restart` 不写。**

证据：§8 L214-215。

### Source / Policy / Executor（R05）

- **Source**：事件流；kind=可复用实现，instance=一次配置；持有读位置与 bot 身份；重启不得重放事件。
- **Policy**：**版本化**的评估规则 + 每个 Source 的部分；改规则要丢弃运行中的 Eval。
- **Executor**：每 Ticket 一个持久 Session + 一个目录（Session 名 `worker-<ticket id>`，目录默认在 `<stateDir>/work` 下）。

证据：§2 L27-35；§4 L70。

### 准入表（R06）

行 = 接收 scope（Feishu：每个配置的 chat / 其他仅 @ 的群 / 私聊；GitHub：新 Issue / 新 PR / 评论 /
default branch CI）；每行最多三格（在名单未点名 / 不在名单但点名 / 不在名单未点名），
默认 `inferred`/`ignore`/`ignore`。**CI 无发送者只有最后一格**；**未点名格只在该 scope 接收全部
消息时可用**。表格属于 Policy version，削弱一格不会立刻停掉已存在的 Ticket，只会在恢复前
revalidate 时 revoke。

Strength 三级：`explicit`（在名单且点名 / 有 Ticket 的 Thread 上后续 / admission cell=explicit）、
`inferred`（不在名单但在有 Ticket 的 Thread 上后续 / cell=inferred / bot list 的 bot 点名）、
`not admitted`（其他 bot、admission 忽略、off 模式下的所有 inferred）。

默认表格（三格默认值；CI 行只有最后一格可用）：

| Scope | 在名单未点名 | 不在名单但点名 | 不在名单未点名 |
|---|---|---|---|
| 新 Issue | inferred | ignore | ignore |
| 新 PR | inferred | ignore | ignore |
| 评论 | inferred | ignore | ignore |
| default branch CI | —（无发送者） | —（无发送者） | 仅此格可用（默认 ignore） |

证据：§3 L51-52（Strength 三级与表格默认值）；§3 L49-50（Eval/Subscription 两条路径）。

### Mandate + Policy version（R07）

- Mandate：accept 授予的东西（Policy 版本、scope、strength、命中的规则、发送者身份、Source 如何收到该 Trigger）；
  **不可变**；Ticket 结束不结束它；只有人的 stop 撤回、Policy 不再成立才 revoke；恢复前要 revalidate。
- **只有三种操作改变 Mandate**：accept 创建、人的 stop 撤回、失败 revalidate revoke。

证据：§2 L34；§3 L61。

### Management API（R08）

- 路由前缀 `/orchestrator`，只接受 `/orchestrator/api/*`；**无框架**，纯类型化 route + 手写 router。
- `GET state|overview|search|sources|settings|threads|decisions|tickets|policy/history|models|prompts`；
  `POST sources/:id/labels|threads/:key/unsubscribe|triggers/:id/requeue|decisions/:id/dismiss|tickets/:id/retry|tickets/:id/stop|executor/pause|policy-sync/:id|setup/check|prompts/preview`；
  `PUT settings/:block|prompts`。
- 安全：`sameOrigin()` 要求 `host` 是 `127.0.0.1:<port>` 或 `localhost:<port>`、带
  `x-orchestrator-request: 1`、`Origin` 同源，否则 403；请求体上限 128KB。

证据：§7 L199-200。

### setup 环境变量剥离（R09）

setup 用 DSH subprocess 服务跑 CLI 探测，**移除名字含 `KEY`/`PASSWORD`/`SECRET`/`TOKEN`
的环境变量**；写入 `worker-bin` shims 与 `worker-gitconfig`；Feishu 失败只禁用 Feishu Source。

证据：§8 L218。

### 升级备份/回滚（R10）

1. 等到没有 Executor 在回合中；
2. 备份 `<stateDir>/orchestrator.sqlite`；
3. `git pull && pnpm install && pnpm build`；
4. `restart`；
5. 检查 status。

团队文本与覆盖的 prompt 段保留；**新库不能被旧版本打开**，回滚需要升级前备份。
升级 DSH 后重启实例以加载匹配 artifacts。

证据：§8 L216。

### agent preset 不可缺（R11）

`cordis.patch.yml` 定义两个 agent preset：`dsh-superagent-worker` / `dsh-superagent-router`
（都是 `@deepseek-ai/dsh-agent-preset`，order 90/91）。worker preset 含工作所需工具，
前台 shell 命令 5 秒后转后台 job；router preset 工具集更小。两者都 `danger-full-access`、
以操作者 OS 用户运行；**真正的隔离要靠专用 OS 账号**。

证据：§5 L96；§4 L71。

## 快速启动

1. **读研究边界**：先读 `.cycles/research-inputs/A-dsh-superagent-study.md` 的 §11 证据边界声明。
2. **建独立 profile**：从 DSH Web profile 模板创建 `superagent`，服务面板于 `127.0.0.1`。
3. **配 `stateDir`**：写 `examples/profile.cordis.patch.yml`（`webserver` + `dsh-superagent.config.stateDir`）。
4. **跑自检**：
   - `node assets/skills/superagent-patterns/scripts/superagent-status-probe.mjs <state-dir>`
   - `node assets/skills/superagent-patterns/scripts/admission-table-check.mjs <project-dir>`
5. **每小时 check**：在日常 profile 上用 schedule 每小时跑 `status`，按 R04 分档处置。
6. **升级**：按 R10 先备份再升级。

## 导航索引

按需加载——只在需要时读取对应参考文档：

| 需要了解 | 读取 |
|---|---|
| 完整操作手册（profile/stateDir/check/退出码/域模型/准入/Mandate/API/setup/升级） | `references/operations.md` |
| 退出码错判、profile 混用、stateDir 误改、准入表错配、升级失败的分诊 | `references/troubleshooting.md` |
| 退出码归一探针 + 准入表校验脚本用法 | `scripts/README.md` |

## 与 dsh-anic 的对照（明确标注：非 Superagent 事实）

| Superagent 做法 | dsh-anic 对照（本仓实测） | 出处 |
|---|---|---|
| 独立 profile + 独立 stateDir + tmux service + 四段退出码 + hourly check | `pnpm run j0` 六步协议探针（真实宿主，绝不启停宿主）；缺四段退出码与 hourly 自愈 | `CLAUDE.md:10` |
| worker/router 两套 preset 收窄工具集 + 前台 shell 5 秒转后台 job | `anic_skill` 的 `timeoutMs`（默认 90000）；缺「前台转后台 + 短 wait + 事件唤醒」预置 preset | `docs/agents/工具面参考.md:43` |
| 结构化 `human_action` 提问字段 | `anic_hitl` 已有 HITL 门禁入口 | `docs/agents/工具面参考.md:84` |

> 上表的「dsh-anic 对照」来自本仓实测行号；Superagent 侧来自研究报告。

## 相关文档

- 外部研究：`.cycles/research-inputs/A-dsh-superagent-study.md`（§2 域模型、§3 授权、§4 执行、§5 DSH API、§7 面板、§8 部署）
- 技能库设计：`.cycles/research-inputs/D-skill-library-design.md` §3.8
