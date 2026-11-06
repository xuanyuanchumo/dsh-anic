---
name: gitee-mirror-sync
version: 0.1.1
whenToUse: >
  在把 dsh-anic（或任意 GitHub 仓库）镜像到 Gitee、向 Gitee 远端推送 git refs、检测镜像漂移、
  用 Gitee API 建 MR、或在中文开源索引（Gitee 生态）登记插件时使用。
  触发词：Gitee、镜像、mirror、MR、合并请求、同步、双托管、开源中国、Gitee API、
  gitee push、镜像漂移。
  Trigger words: Gitee, mirror, mirror sync, MR, merge request, sync, dual hosting,
  Gitee API, gitee push, drift detection. Use when mirroring a GitHub repo to Gitee,
  pushing refs to a Gitee remote, detecting mirror drift, or registering a plugin on a
  Chinese open-source index.
description: >
  Triggers: Gitee、镜像、MR、同步、双托管、Gitee API、mirror sync、drift detection.
  Use when mirroring a GitHub repo to Gitee, pushing git refs to a Gitee remote,
  detecting mirror drift, or registering a plugin on a Chinese open-source index.
  注意：本仓对 Gitee 零覆盖（grep 实证），Gitee API/CLI 细节属**通用知识**，
  收录规则属**本仓实证**；动手前先按本技能「实测校验」清单核验。
---

# gitee-mirror-sync（GitHub↔Gitee 镜像与 MR 同步）

> **一句话定位**：GitHub↔Gitee 镜像策略、refs 同步、漂移检测、MR 与收录操作。
> 叶技能，依赖 `git-branch-workflow`（远端与分支先建对）。
>
> **重要声明**：本仓**源码/文档对 Gitee 零覆盖**（`docs/anic/25-原生优化与内部技能库研究.md:330`
> 全仓 grep `gitee` 零命中），**但 Gitee 侧账号与连通性已于 2026-11-06 实测**（见 §0）。
> 因此本技能分两类知识：
> - **【仓实证】**：引用本仓真实 `file:line`，或本轮实测的命令与输出。
> - **【通用知识】**：Gitee API 端点/字段名等尚未在本仓触发过的细节，**动手前必须先实测**
>   （见 `references/operations.md` §7「实测校验清单」）。

## 0. 实测基线（2026-11-06，本轮新增）

| 事实 | 实测结果 | 复验命令 / 工具 |
|---|---|---|
| Gitee 账号与令牌 | **可用**：`login=xuanyuanchumo`、`name=轩辕初墨`、`id=12239874` | MCP `get_user_info`（令牌经凭证库注入） |
| 该账号下 `dsh-anic` 仓库 | **不存在**：`list_user_repos(q=dsh-anic)` → `[]` | MCP `list_user_repos` |
| Gitee 全站搜 `dsh-anic` | **0 命中**：`search_open_source_repositories` → `{"total_count":0,"data":[]}` | MCP `search_open_source_repositories` |
| 本仓 `gitee` remote | **未配置**：Git 侧没有该远端 | `node scripts/mirror-sync.mjs . --dry-run` → exit 2「target remote 'gitee' not found」 |
| 漂移检测 | **无对象**：连不上 target 即报错，不会假报"零漂移" | `node scripts/drift-check.mjs .` → exit 2「'gitee' does not appear to be a git repository」 |
| Gitee 令牌名 | 凭证库里叫 `gitee`；`vault_run` 默认只映射 `github→GH_TOKEN` / `npm→NPM_TOKEN` ⇒ 用 Gitee 令牌**必须** `env_name: GITEE_TOKEN` | `vault_list`（只回名称）；本技能 §命令 |

**结论（判断而非推测）**：镜像**尚未建立**，当前处于"第 0 步"。所以现在的正确动作是
**先建仓 + 加 remote**，而不是跑 `mirror-sync` 实跑；`drift-check` 在无 remote 时报 exit 2
是**正确行为**（无对象 ≠ 零差异），不要把它改成"通过"。

```sh
# 第 0 步：建仓（Gitee 网页：新建仓库，不要初始化 README/ignore，保持空仓）
git remote add gitee git@gitee.com:xuanyuanchumo/dsh-anic.git
git remote -v          # 确认 origin 仍是 GitHub SSH，gitee 是附加项（R7）
node assets/skills/gitee-mirror-sync/scripts/mirror-sync.mjs . --dry-run   # 0 = remote 就绪
```

## 一、硬性规则

| # | 规则 | 说明 | 依据 |
|---|---|---|---|
| R1 | 先实证再操作 | Gitee 源码零覆盖；任何 Gitee 端点/令牌用法先跑 `operations.md` §7 校验清单；§0 已给出 2026-11-06 实测基线（账号可用 / 仓库不存在） | `docs/anic/25:330`；本技能 §0 |
| R2 | 令牌不出库 | Gitee 令牌走 DSH 凭证库（`vault_set`/`vault_run`），明文永不落盘/入对话/入命令行；Gitee 令牌名是 `gitee`，**须显式 `env_name: GITEE_TOKEN`**（默认映射只认 github/npm） | 本技能安全纪律 + `vault_list` 实测 |
| R3 | 镜像默认单向 | 默认 GitHub → Gitee 单向 pull-mirror；双写需显式 `--two-way` 且人工批准 | 通用镜像实践 |
| R4 | 漂移即证据 | 漂移检测必须产出 `file:line` 级差异清单，不允许「看起来一样」 | 主干 R05 证据纪律 |
| R5 | 收录数字核实 | 任何 `data/plugins/*.yml` 描述数字必须与代码核实一致；夸大是唯一被打回原因 | `docs/agents/CI-CD与发布流程.md:102-106` |
| R6 | 收录文件唯一 | 一条目一个文件：`data/plugins/<owner>__<repo>.yml`；一个 PR 最多 3 条 | `docs/agents/marketplace-提交草稿.md:8-9` |
| R7 | 不动本仓 remote | 本仓 `origin → git@github.com:...`（SSH）是发布链路；Gitee 作为**附加** remote | `git remote -v` 实测 |
| R8 | 不触碰生产凭据 | 镜像/MR 操作不涉及真实凭据；涉及须先过 H1 检查点 | 主干 H1 |

### 规则→脚本

| 规则 | 建议层 | 确定层（脚本） | 检查点 |
|---|---|---|---|
| R4 漂移检测 | operations.md §5 | `drift-check.mjs` | 每日/发布前 |
| R3 镜像同步 | operations.md §4 | `mirror-sync.mjs`（`--dry-run` 预演） | 发布后 |
| R5/R6 收录 | operations.md §6 | 人工门（对照本仓 `marketplace-提交草稿.md`） | 提交 PR 前 |

## 二、快速启动

### 1. 添加 Gitee remote（只加不删，R7）

```sh
# 通用知识：HTTPS 形态（需 Gitee 凭据 helper 或 token 填入 URL）
git remote add gitee https://gitee.com/<owner>/<repo>.git
# 通用知识：SSH 形态（推荐，避免 token 落盘）
git remote add gitee git@gitee.com:<owner>/<repo>.git
git remote -v        # 确认 origin 仍是 GitHub SSH，gitee 是附加项
```

### 2. 镜像同步（先 dry-run）

```sh
node assets/skills/gitee-mirror-sync/scripts/mirror-sync.mjs <workspace> --dry-run
node assets/skills/gitee-mirror-sync/scripts/mirror-sync.mjs <workspace>        # 实跑
```

### 3. 漂移检测

```sh
node assets/skills/gitee-mirror-sync/scripts/drift-check.mjs <workspace> [--json]
```

### 4. 建 Gitee MR（通用知识，需实测校验）

```sh
# Gitee API v5（通用知识；token 经环境变量注入，绝不出现在命令行）
GITEE_TOKEN=<vault 注入> \
curl -sS -X POST https://gitee.com/api/v5/repos/<owner>/<repo>/pulls \
  -H "Authorization: token ${GITEE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"source_branch":"feat/x","target_branch":"master","title":"feat(x): ...","body":"...","issue_id":0}'
```

> **先用 `curl`/MCP 试跑一个最小 MR**，确认端点与字段名（Gitee 端点细节见
> `references/operations.md` §3）。MCP 连接器若存在则优先走 MCP。
>
> **本轮实测边界**：Gitee MCP 连接器**账号态已通**（`get_user_info` 返回 login），
> 但 `create_pull` 需目标仓库存在——本仓 Gitee 侧仓库尚未建立（§0），故 MR 创建
> **属「未实测」**。验证方法：建仓并推一个 `feat/x` 分支后，用 MCP `create_pull`
> 或上面的 curl 各建一次，比对返回字段与 Gitee 网页是否一致。

### 5. 收录（Gitee 生态 / awesome-dsh-plugin）

```sh
# 【仓实证】awesome-dsh-plugin 规则（docs/agents/marketplace-提交草稿.md:8-26）
# 新增 data/plugins/<owner>__<repo>.yml；url 必须与仓库完全一致；category: workflow
# 描述含 ": " 的英文描述必须整体加引号；描述数字必须与代码核实一致
```

## 三、导航索引

| 需要了解 | 读取 |
|---|---|
| **当前实测基线（账号态 / 仓库是否存在 / remote 是否就绪）** | 本文件 §0 |
| 镜像策略 / Gitee API / MR / 收录操作细则 | `references/operations.md` |
| 漂移、鉴权、网络、MR 失败等 | `references/troubleshooting.md` |
| 镜像同步（fetch + push refs） | `scripts/mirror-sync.mjs` |
| 漂移检测（比较 GitHub/Gitee 分支 SHA） | `scripts/drift-check.mjs` |
| 脚本调用契约 | `scripts/README.md` |
| Gitee 收录/双托管的本仓实证背景 | `docs/anic/25-原生优化与内部技能库研究.md:328-333` |
| awesome-dsh-plugin 收录规则（对照） | `docs/agents/marketplace-提交草稿.md` |
| 技能库注册表 | `assets/skills/skills.index.json` |

## 四、边界

- **通用知识未经本仓实测**：Gitee API v5 的端点、令牌头、MR 字段名属通用知识，
  可能随 Gitee 版本变化；本技能不将其当作既成事实。
- 不自动删除远端 refs；不跨托管改写提交历史（禁止 force-push 镜像）。
- 不包含任何 Gitee 令牌；脚本只做 git refs 操作，API 调用由操作者按文档执行。
