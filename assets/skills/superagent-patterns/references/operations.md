# superagent-patterns · 操作手册

> 本文是 `superagent-patterns` 叶技能的详细操作手册。
>
> ⚠️ **证据来源（必读）**：本手册的 Superagent 事实**全部来自外部研究报告**
> `.cycles/research-inputs/A-dsh-superagent-study.md`（目标仓库 `deepseek-ai/dsh-superagent-prototype`，
> commit `8c32a9dc`，**未运行任何 build/test**），行号格式 `§N Ln` 指该报告的章节与行号。
> **不是 dsh-anic 本地源码**。凡涉及 dsh-anic 的对照，均在 §12 单列并明确标注。
> 研究原型自述「研究原型仅供参考，非 DeepSeek 官方产品」，部分方向未实现。

## 0. 证据边界（必读）

- **直接读取**：报告 §11 声明全部 `src/**` 行号来自 `git clone --depth 1` 后本地 `read`/`grep`；
  文档行号来自同一 clone 的 `docs/000`–`docs/008` 与 `README.md`。
- **间接/推断**：`docs/007-architecture.md` 的部分段落因抓取超时被截断；`src/executor/dsh.ts` 等
  只读了片段；`src/app/migration.ts`、`src/core/*`、`tests/**` 未读。相关结论均标注 `[推断]`。
- **未验证**：报告未运行 `pnpm install/check/build/test`，**无法验证**构建产物、运行时行为、
  测试是否通过、API 真实可调用性。所有 API 签名以源码声明为准。
- **dsh-anic 对照**：报告 §10 的「已有/缺失」判断**基于会话可见约定推断，未实测 dsh-anic 源码**，
  仅用于排序建议，不构成权威结论。

## 1. 项目定位与核心理念

- 定位：**面向单个 GitHub 仓库的 proactive coding agent**，以 DSH bundle 形式发布；监听 GitHub
  （可选 Feishu），被允许的人请求工作后，在**自己的 Session 与目录**里干活，并在原对话里答复。
- 核心原则：**"Take as little human attention as possible, and give as much value as possible."**
- 对 agent 的四条约束（§1 L14-18）：
  1. **只在被请求、或被团队写下的规则允许时行动**；默认从**只记录不做的 observe 模式**起步；
  2. **只在「必须有人行动」或「有人能用上结果」时开口**；
  3. **一次只问一个具体问题**，结构化；
  4. **按 impact 而非 effort 停下**；诚实报告，绝不绕过限制。
- "proactive" 的精确含义（§1 L21）：accept mode 是 Policy 的一部分——`off` 一切推断都不成候选；
  `observe`（默认）评估推断候选、正面评估记为 ignore 且标 "would accept"，**不接单**；`auto` 才接单。

证据：§1 L9-22。

## 2. 独立 profile 与 stateDir（R01/R02）

- **独立 profile**：`superagent`，从 DSH Web profile 模板创建，服务面板于 `127.0.0.1`；
  **必须与工作 profile 分开**（插件改进程级 PATH 与 git 设置、需要独立重启/升级）。
- **机器配置**（`examples/profile.cordis.patch.yml:1-12`）：

```yaml
webserver: { host: 127.0.0.1, port: 3082 }
dsh-superagent:
  config:
    stateDir: <abs>
```

- `stateDir` 是唯一必填；`promptMaxChars` / `admissionContextMaxPages` / `admissionContextTimeoutMs`
  可选且 volatile（读时生效、改了不重启）。
- **`stateDir` 内容**：数据库、目录锁、`worker-bin` shims、agent git 配置、默认 `work/` 下的
  Ticket 目录。`stateDir` **不可经面板改**。
- 前置：Node 22.19+ / 24+、pnpm、git 2.32+、Python 3.8+、tmux、`gh` 2.48+、模型 provider；
  `engines.dsh: ^0.2.1-alpha.2`，安装用 `@deepseek-ai/dsh@0.2.1-rc.3`。仅支持 github.com（不支持 GHES）。

证据：§8 L210-213。

## 3. 每小时 check 与四类退出码（R03/R04）

### 3.1 四类退出码

`scripts/dsh-superagent`（Python 3）在 tmux session `dsh-superagent` 里跑 `dsh --profile superagent`。
**四段退出码**：

| 退出码 | 语义 |
|---|---|
| 0 | 正常 |
| 1 | 不运行 / 运行两次 / runtime 报错（**重启可能修好**） |
| 2 | 运行但某部件报错（**重启修不好**） |
| 3 | 运行但等 setup |

日志在 `.artifacts/`（保留最新 20），控制文件在 `.artifacts/control/profiles/<profile>/`。

### 3.2 每小时 check 处置

**必须建在日常使用的 profile（不是 superagent）**，用 schedule 工具每小时跑
`scripts/dsh-superagent --profile superagent status`：

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

## 4. 域模型：Source / Policy / Executor（R05）

流程：Trigger → Eval → 执行；Source 产出 Trigger，Trigger 扇出为已订阅 Ticket 的上下文。

| 概念 | 语义 |
|---|---|
| Source | 事件流；kind=可复用实现，instance=一次配置；持有读位置与 bot 身份；重启不得重放事件 |
| Trigger | 不可变事件，审计与幂等的单元；同一 Trigger 被接受两次只创建一个 Ticket |
| Thread | 时间有序的 Trigger；同一时刻至多一个 Eval；持有 Subscriptions、运行中的 Eval 与 Decision 历史 |
| Policy | **版本化**的评估规则 + 每个 Source 的部分；改规则要丢弃运行中的 Eval |
| Eval | 两层——确定性的 gate + 模型 assessment；无状态 |
| Mandate | accept 授予的东西；**不可变**；Ticket 结束不结束它 |
| Ticket | 已授权工作的单元；**只有 Eval 能创建**；状态**不跟随 DSH Session** |
| Assignment | Ticket 到某个 Executor 实例的绑定；pending→running→ended |
| Subscription | Ticket↔Thread 多对多，**由 Thread 持有** |

Executor = 每 Ticket 一个持久 Session + 一个目录（Session 名 `worker-<ticket id>`，目录名取
Ticket 短名，默认在 `<stateDir>/work` 下）。

证据：§2 L25-37；§4 L70。

## 5. 授权模型：准入表与 Mandate（R06/R07）

### 5.1 两条路径

- **Eval 路径**：Source 记录消息是否点名 agent（`mention` / `direct`）。gate 检查发送者与该 Source 的
  Policy：在名单上的人点名 → explicit；有 Ticket 的 Thread 上的人后续消息 → follow-up 强度；
  其他人 → admission table；Source bot list 里的 bot → 只能是 inferred candidate，其他 bot 一律不准入。
- **Subscription 路径**：订阅 Thread 上的每条消息都作为上下文到达已订阅 Ticket（含 bot/CI），
  **绕过 gate、不授予新权威**；Ticket 仍受 Mandate 约束。

### 5.2 Strength 三级

- `explicit`：在名单且点名 / 有 Ticket 的 Thread 上后续 / admission cell=explicit。
- `inferred`：不在名单但在有 Ticket 的 Thread 上后续 / cell=inferred / bot list 的 bot 点名。
- `not admitted`：其他 bot、admission 忽略、off 模式下的所有 inferred。

### 5.3 准入表

行 = 接收 scope（Feishu：每个配置的 chat / 其他仅 @ 的群 / 私聊；GitHub：新 Issue / 新 PR / 评论 /
default branch CI）；每行最多三格（在名单未点名 / 不在名单但点名 / 不在名单未点名），
默认 `inferred`/`ignore`/`ignore`。**CI 无发送者只有最后一格**；**未点名格只在该 scope 接收全部
消息时可用**。表格属于 Policy version，削弱一格不会立刻停掉已存在的 Ticket，只会在恢复前
revalidate 时 revoke。

| Scope | 在名单未点名 | 不在名单但点名 | 不在名单未点名 |
|---|---|---|---|
| 新 Issue | inferred | ignore | ignore |
| 新 PR | inferred | ignore | ignore |
| 评论 | inferred | ignore | ignore |
| default branch CI | —（无发送者） | —（无发送者） | 仅此格可用（默认 ignore） |

### 5.4 Mandate 与 Policy version

- Mandate：accept 授予的东西（Policy 版本、scope、strength、命中的规则、发送者在该 Source 的身份、
  Source 如何收到该 Trigger）；**不可变**；Ticket 结束不结束它；只有人的 stop 撤回、Policy 不再成立
  才 revoke；恢复前要 revalidate。
- **只有三种操作改变 Mandate**：accept 创建、人的 stop 撤回、失败 revalidate revoke。
- **Revalidate（恢复前复查）**：Source 必须仍在监听原 Thread；explicit follow-up Mandate 直接通过；
  inferred Mandate 需要 `auto` + 命中规则仍启用；admission cell 授予的 Mandate 需今天的表格至少给出
  原强度；bot Mandate 需 bot 仍在 list；失败则 Ticket 保持 ended、不取等待消息、attach 被拒。

证据：§2 L34；§3 L49-52, L60-61。

## 6. 执行模型（简）

- **Ticket 阶段表**：`person/delivery → person/answer → person/review → person/blocked|failed →
  working/queued → idle → working`；`person/*` 表示「没有人工输入无法继续」。
- **并发与 worker slot**：Ticket 从 launch（含 prepare）到收到唤醒都占一个 slot；`maxWorkers`
  （默认 3，1–16）作用于这些 slot，**另有 1 个 slot 专留给人的消息或状态请求**。
- **后台工作与 slot 释放**：回合结束仍有 shell job / subagent 运行时，Ticket 保留 worker slot 且
  **不报 waiting**；后台工作最多 30 分钟后被 kill、Ticket 转 waiting；交给人时立刻释放 slot。
- **执行环境变量**：prepare 命令读环境变量，执行器在 prompt 里读它们的值与描述；**没有任何凭证**。
- **凭证与命令封装**：`<stateDir>/worker-bin` 里放 `gh`/`lark-cli` shim 与 blocked commands 的失败 shim；
  `<stateDir>/worker-gitconfig` 替换操作者全局/系统 git 配置。**这些是默认防护而非安全边界**。
- **失败与恢复**：provider/网络 408/429/5xx/连接重置类**瞬时失败**先重试 3 次；launch 失败不再自动重试；
  `blocked`/`failed` 时**工具保持可用**，人可以直接在 Session 里接手。

证据：§4 L69-80。

## 7. Management API（R08）

- 入口：DSH Web 侧栏 **Superagent**；三个问题依次回答：① 现在有什么需要我？② 系统健康且在做正确的事吗？
  ③ 一件工作从 Trigger 经 Eval 到 Ticket 的历史？
- 路由前缀 `/orchestrator`，只接受 `/orchestrator/api/*`；**无框架**，纯类型化 route +
  `parseRoute` + `sessionStorage` 记忆 + 手写 router（`match(table, method, segments)` 按 `:param` 匹配）。
- 路由表：`GET state|overview|search|sources|settings|threads|threads/:key|decisions|tickets|tickets/:id|
  policy/history|models|prompts`；`POST sources/:id/labels|threads/:key/unsubscribe|triggers/:id/requeue|
  decisions/:id/dismiss|tickets/:id/retry|tickets/:id/stop|executor/pause|policy-sync/:id|setup/check|
  prompts/preview`；`PUT settings/:block|prompts`。
- 数据源：**不是 GraphQL/Socket**，而是轮询本地 HTTP 管理 API（默认 5 秒，重启期间降到 1 秒、30 秒超时）。
- 安全：`sameOrigin()` 要求 `host` 是 `127.0.0.1:<port>` 或 `localhost:<port>`、带
  `x-orchestrator-request: 1`、`Origin` 同源，否则 403；请求体上限 128KB（prompts 4×promptMaxChars+4096）。
- `GET state` 形状：`setup{machine, problem, feishuProblem, accounts}`、`load{running, queued, maxWorkers}`、
  `masterId`、`paused`、`health{}`。

证据：§7 L195-201。

## 8. setup 环境变量剥离（R09）

setup 用 DSH subprocess 服务跑 CLI 探测，**移除名字含 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 的环境变量**；
写入 `worker-bin` shims 与 `worker-gitconfig`；Feishu 失败只禁用 Feishu Source。

证据：§8 L218。

## 9. 升级备份 / 回滚（R10）

1. 等到没有 Executor 在回合中；
2. 备份 `<stateDir>/orchestrator.sqlite`；
3. `git pull && pnpm install && pnpm build`；
4. `restart`；
5. 检查 status。

团队文本与覆盖的 prompt 段保留；**新库不能被旧版本打开**，回滚需要升级前备份。
升级 DSH 后重启实例以加载匹配 artifacts。

证据：§8 L216。

## 10. agent preset 不可缺（R11）

`cordis.patch.yml` 定义两个 agent preset：`dsh-superagent-worker` / `dsh-superagent-router`
（都是 `@deepseek-ai/dsh-agent-preset`，order 90/91），plugins 里按需启停
`bash-sandbox`/`pwsh-sandbox`、`tool-bash`/`tool-pwsh`，shell 组 `timeoutMs: 5000 maxTimeoutMs: 5000`，
`tool-jobs` 的 `waitTimeoutMs: 5000 maxWaitTimeoutMs: 5000`，compaction 组含 `tool-result-pruner`。

- worker preset 含工作所需工具，前台 shell 命令 5 秒后转后台 job；router preset 工具集更小。
- 两者都 `danger-full-access`、以操作者 OS 用户运行；**工人可以用绝对路径执行程序、可以读操作者 home**，
  真正的隔离要靠专用 OS 账号。
- worker 的子 agent 用 DSH `standard` preset。

证据：§5 L96；§4 L71。

## 11. 脚本接口

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `scripts/superagent-status-probe.mjs <state-dir> [--exit <0\|1\|2\|3>]` | 校验 `stateDir` 存在 + 把观测到的退出码归一为四档语义 | 0 通过 / 1 违规 / 2 用法错误 |
| `scripts/admission-table-check.mjs <project-dir> [--table <path>]` | 校验准入表结构（三格、CI 行、默认值） | 0 通过 / 1 违规 / 2 用法错误 |

详细契约见 `scripts/README.md`。

## 12. dsh-anic 对照（明确标注：非 Superagent 事实）

> 下表**左列是 Superagent 事实**（研究报告），**右列是 dsh-anic 本仓实测**。两者不可混用。

| Superagent 做法（研究报告） | dsh-anic 对照（本仓实测） | 出处 |
|---|---|---|
| 独立 profile + 独立 stateDir + tmux service + 四段退出码 + hourly check | `pnpm run j0` 六步协议探针（真实宿主，绝不启停宿主）；缺四段退出码与 hourly 自愈 | `CLAUDE.md:10` |
| worker/router 两套 preset 收窄工具集 + 前台 shell 5 秒转后台 job | `anic_skill` 的 `timeoutMs`（默认 90000）；缺「前台转后台 + 短 wait + 事件唤醒」预置 preset | `docs/agents/工具面参考.md:43` |
| 结构化 `human_action` 提问字段（不从自由文本推断「在等人」） | `anic_hitl` 已有 HITL 门禁入口（H1-H4） | `docs/agents/工具面参考.md:84` |
| 失败时不锁死 Executor 工具，让人直接接手 | 人始终可在工作区操作；缺显式规约与测试 | `docs/agents/API参考.md` 无工作区行为 |

## 13. 证据边界声明

- 本手册所有 `§N Ln` 引用指向 `.cycles/research-inputs/A-dsh-superagent-study.md`，
  该报告基于 `dsh-superagent-prototype` commit `8c32a9dc`（2026-10-31）的 clone，
  **未运行 build/test**，可能与当前安装的 DSH 运行时不一致。
- 报告 §10 的「dsh-anic 已有/缺失」判断基于推断，非实测源码。
- 本技能不执行任何 `pnpm` 命令或真实宿主探针；所有结论为文档契约层面的对标，需经实证验证。
