# gitee-mirror-sync · 操作手册

> 详细操作手册。**本仓对 Gitee 零覆盖**（`docs/anic/25-原生优化与内部技能库研究.md:330`
> 全仓 grep `gitee` 零命中）。因此每节开头标注知识来源：
>
> - **【仓实证】**：引用本仓真实 `file:line` 或本机实测。
> - **【通用知识】**：来自 Gitee 官方文档的通用常识，**动手前必须按 §9 实测校验**。

## 0. 事实锚点

| 事实 | 值 | 来源 |
|---|---|---|
| 本仓 Gitee 覆盖 | **零**（全仓 grep `gitee` 无业务命中） | 【仓实证】`docs/anic/25:330` |
| 本仓 remote | 仅 `origin → git@github.com:xuanyuanchumo/dsh-anic.git`（SSH） | 【仓实证】本机 `git remote -v` |
| 凭证库 Gitee 令牌 | 存在（`vault_list` 实测：gitee/github/npm 三个） | 【仓实证】`docs/anic/25:331` |
| GitHub 收录规则 | `data/plugins/<owner>__<repo>.yml`；一个 PR 最多 3 条；`category: workflow`；描述数字须核实 | 【仓实证】`docs/agents/marketplace-提交草稿.md:8-26`；`docs/agents/CI-CD与发布流程.md:99-110` |
| 工具/路由数 | 24 个 `anic_*` 工具（本机 `git grep` 实测）；README 数字由契约钉死 | 【仓实证】`docs/agents/CI-CD与发布流程.md:49` |
| Gitee API 基址 | `https://gitee.com/api/v5` | 【通用知识】待校验 |

## 1. 镜像策略

### 1.1 三种模式

| 模式 | 方向 | 适用 | 风险 |
|---|---|---|---|
| 单向 pull-mirror（默认） | GitHub → Gitee | 中文协作面分发 | Gitee 不接受回写 |
| 双写 | GitHub ⇄ Gitee | 双向协作 | 需人工批准；易产生分叉 |
| 导入镜像（import） | Gitee 从 GitHub 拉取 | 一次性迁移 | 只拉默认分支快照 |

**默认用单向 pull-mirror**（R3）。双写需显式 `--two-way` 且人工批准。

### 1.2 Gitee 远端形态

```sh
# 【通用知识】HTTPS（需凭据 helper）
git remote add gitee https://gitee.com/<owner>/<repo>.git
# 【通用知识】SSH（推荐；需 ssh-agent 或 ~/.ssh/config）
git remote add gitee git@gitee.com:<owner>/<repo>.git
git remote -v
```

> 【通用知识】Gitee 支持 HTTPS 与 SSH 两种 git 协议；SSH 形态与 GitHub 一致
> （`git@gitee.com:<owner>/<repo>.git`）。

## 2. 镜像同步操作

### 2.1 预演（必做）

```sh
node assets/skills/gitee-mirror-sync/scripts/mirror-sync.mjs <workspace> --dry-run
```

`--dry-run` 只打印将要执行的 `git fetch` / `git push` 命令，不执行。

### 2.2 实跑

```sh
# 默认：先 fetch source，再 push branches+tags（强制覆盖）
node assets/skills/gitee-mirror-sync/scripts/mirror-sync.mjs <workspace>

# 完整镜像（含 notes/replace 等 refs）
node assets/skills/gitee-mirror-sync/scripts/mirror-sync.mjs <workspace> --mirror

# 推送后删除 target 上已不存在的 refs
node assets/skills/gitee-mirror-sync/scripts/mirror-sync.mjs <workspace> --prune
```

脚本内部等价命令（只读预演会原样打印）：

```sh
git fetch --prune origin
git push gitee +refs/heads/*:refs/heads/* +refs/tags/*:refs/tags/*
```

> **禁止**：`git push --force gitee master`（会改写远端历史）；镜像同步用 refspec 全量覆盖，
> 但绝不针对 `master` 单独 force-push。

## 3. Gitee API v5 与令牌（通用知识）

> 以下端点、头、字段名均属【通用知识】，可能随 Gitee 版本变化。

### 3.1 令牌

- 私人令牌申请页：`https://gitee.com/profile/personal_access_tokens`
- 鉴权头（Gitee 惯例）：`Authorization: token <ACCESS_TOKEN>`
  （注意不是 `Bearer`；以官方文档为准）
- 令牌**只经环境变量注入**子进程，绝不写入命令行、文件、日志。

```sh
GITEE_TOKEN=<vault 注入> curl -sS https://gitee.com/api/v5/repos/<owner>/<repo> \
  -H "Authorization: token ${GITEE_TOKEN}"
```

### 3.2 常用端点（通用知识，待校验）

| 用途 | 方法与路径 |
|---|---|
| 读仓库 | `GET /repos/{owner}/{repo}` |
| 读分支 | `GET /repos/{owner}/{repo}/branches` |
| 建 MR | `POST /repos/{owner}/{repo}/pulls` |
| 读 MR | `GET /repos/{owner}/{repo}/pulls/{number}` |
| 合 MR | `POST /repos/{owner}/{repo}/pulls/{number}/merge` |
| MR 评论 | `GET /repos/{owner}/{repo}/pulls/{number}/comments` |

> Gitee web UI 将 MR 称「合并请求」，但 API v5 常以 `pulls` 暴露；也有资料提及
> `merge_requests` 命名。**动手前务必先用 curl 试跑一个最小 MR 确认端点**。

### 3.3 MR 创建示例

```sh
GITEE_TOKEN=<vault 注入> \
curl -sS -X POST "https://gitee.com/api/v5/repos/<owner>/<repo>/pulls" \
  -H "Authorization: token ${GITEE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"source_branch":"feat/x","target_branch":"master","title":"feat(x): <结论>","body":"...","issue_id":0}'
```

字段名（`source_branch`/`target_branch` 或 `head`/`base`）以官方文档为准。

## 4. 漂移检测

```sh
node assets/skills/gitee-mirror-sync/scripts/drift-check.mjs <workspace> [--json]
```

脚本用 `git ls-remote` 比较 `origin`（GitHub）与 `gitee` 的 `refs/heads/*` SHA：
- `shared-diverged`：同名分支 SHA 不同。
- `source-only`：GitHub 有、Gitee 无。
- `target-only`：Gitee 有、GitHub 无。

退出码：`0` 全部一致 / `1` 存在漂移 / `2` 用法或远端缺失。

> 漂移必须产出清单证据（R4），不允许「看起来一样」。

## 5. MR 与 Issue 模板同步

- 【通用知识】Gitee 仓库设置里可配置 MR/Issue 模板；可用 API 上传模板文件。
- 【仓实证】本仓的 PR 模板在 `.github/PULL_REQUEST_TEMPLATE.md:1-82`，可作为 Gitee 侧
  MR 模板的内容蓝本（字段对应：变更摘要→变更摘要，门禁状态→门禁状态）。
- 【通用知识】Gitee webhook 可在 MR 状态变化时触发通知。

## 6. 收录（`data/plugins/*.yml`）

### 6.1 awesome-dsh-plugin（仓实证）

规则来源：`docs/agents/marketplace-提交草稿.md:8-26` 与 `docs/agents/CI-CD与发布流程.md:99-110`。

- fork 后新增**一个文件** `data/plugins/<owner>__<repo>.yml`（一个 PR 最多 3 条）。
- `url` 必须与仓库完全一致；`category: workflow`。
- **描述数字必须与代码核实一致**（夸大是唯一被打回原因）：

```sh
grep -rho "name: 'anic_[a-z_]*'" src/host/tools*.ts | sort -u | wc -l   # → 24
```

- 含 `: ` 的英文描述必须整体加引号。
- 仓库需满 1 天 + topic `dsh-plugin`；CI 绿是前置条件。

### 6.2 Gitee 侧收录（通用知识，待校验）

若目标索引沿用 awesome-dsh-plugin 的 `data/plugins/<owner>__<repo>.yml` 布局，
则同样的「一条目一个文件 / url 与仓库一致 / 描述数字核实」规则适用。
**动手前先读目标索引的 contributing 文档**，不要假设字段名。

## 7. 中文协作面差异（通用知识）

| 维度 | 说明 |
|---|---|
| 网络可达性 | Gitee 在中国大陆访问稳定，适合国内协作者 |
| 术语 | web UI 称「合并请求」（MR），issue 称「议题」 |
| 社区 | 开源中国（OSChina）社区与 GVP（Gitee 最有价值开源项目）计划 |
| 评审文化 | 中文评审更倾向于在 MR 下直接贴代码片段与行号 |
| 模板 | MR/Issue 模板字段应与 PR 模板对齐，便于双托管维护 |

## 8. 与主干技能的对接

| 主干环节 | 本技能输入 | 本技能输出 |
|---|---|---|
| 评估 E6 安全检查 | 漂移清单 / 令牌用法 | 镜像漂移证据 |
| 门禁 G0-G3 | 本技能检查结果 | 镜像一致性证据（本技能不喂门禁，见 `skills.index.json:55`） |
| 修复 auto-fix-loop | 故障手册 | 重同步步骤 |

本技能 `gates` 为空（`skills.index.json:55`），漂移结果作为 E6/Q4 证据源，不直接关门。

## 9. 实测校验清单（动手前必做）

> 本节是本技能对「通用知识」的诚实降级：以下每一项都需在本机实测后再据实更新本手册。

1. 确认 Gitee 账号下已创建目标仓库，`git remote -v` 能看到 `gitee`。
2. 用 `GITEE_TOKEN` 跑一次 `GET /repos/{owner}/{repo}`，确认鉴权头与返回结构。
3. 用 `curl` 试建一个最小 MR，确认端点是 `pulls` 还是 `merge_requests`、字段名是什么。
4. 跑 `drift-check.mjs`，确认 `git ls-remote gitee` 无需交互认证。
5. 确认 Gitee 侧 MR/Issue 模板字段与本仓 PR 模板字段对齐。
6. 若存在 Gitee 插件索引，读其 contributing 文档，确认 `data/plugins/*.yml` 字段。
