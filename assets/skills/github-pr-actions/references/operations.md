# github-pr-actions · 操作手册

> 详细操作手册。引用 `.github/PULL_REQUEST_TEMPLATE.md`（下称 PR 模板）、
> `.github/workflows/ci.yml`、`docs/agents/CI-CD与发布流程.md`（下称 CD 手册）。

## 0. 事实锚点（本仓实证）

| 事实 | 值 | 证据 |
|---|---|---|
| 证据纪律 | 「没有粘输出的『已通过』不算证据」 | `PULL_REQUEST_TEMPLATE.md:20` |
| 模板必填小节 | 变更摘要 / 关联循环 / 变更类型 / 验证证据 / 门禁状态 / 变更范围 / 破坏性变更 / 自查清单 / 人类判断门 | `PULL_REQUEST_TEMPLATE.md:1-82` |
| CI 依赖顺序 | build → typecheck → lint → test | `ci.yml:60-73` |
| CI 触发面 | push 到 `master`/`feat/**`/`fix/**`/`chore/**` + 所有 PR | `ci.yml:9-14` |
| CI 不跑 `--live` | 真实宿主 E2E 需本机 DSH 桌面端 + Chrome，CI 不具备——显式跳过 | `ci.yml:6-8,76` |
| 四件套 seeding | init-cycle → 四门 anchor → coverage → snapshot → workflow-state → 重建 dist | `ci.yml:88-123` |
| 合并前置 | PR 必须 CI 全绿方可合并 | `PULL_REQUEST_TEMPLATE.md:82` |
| 数字同步 | 工具/路由数变化须同步 README 数字与 marketplace 草稿 | `PULL_REQUEST_TEMPLATE.md:54-56` |
| 自查项 | G-IND / ≤250 行 / `t()` / dist 未提交 / 无令牌 | `PULL_REQUEST_TEMPLATE.md:64-70` |

## 1. 建 PR 前

### 1.1 分支与本地验证

按 `git-branch-workflow` 建分支，然后按 `ci.yml:60-73` 的顺序本地跑：

```sh
pnpm run build        # 先 build：lint C9/C10 检查 dist/，smoke 读 dist/client.js
pnpm run typecheck
pnpm run lint
pnpm run test         # 不加 --live（CI 同样不加）
```

### 1.2 生成 PR 正文

用模板逐节填写（PR 模板 `:1-82`）。**验证证据**必须贴命令与关键输出，例如：

```text
$ pnpm run typecheck
（粘贴输出）

$ pnpm run test
（粘贴输出，含最后的 === 测试汇总 === 表）
```

门禁状态表（`PULL_REQUEST_TEMPLATE.md:40-45`）：

| 门禁 | 结果 | 备注 |
|---|---|---|
| G0 评估收敛门 | PASS / FAIL / N/A | |
| G1 任务收敛门 | PASS / FAIL / N/A | |
| G2 测试收敛门 | PASS / FAIL / N/A | |
| G3 构建收敛门 | PASS / FAIL / N/A | |

## 2. gh CLI 操作

### 2.1 创建

```sh
gh pr create --base master --title "feat(host): add anic_skill_lib_status" \
  --body-file .cycles/pr-body.md
```

### 2.2 查看状态

```sh
gh pr view <N> --json number,title,state,mergeable,statusCheckRollup
gh pr checks <N>
```

### 2.3 合并

```sh
gh pr merge <N> --squash --delete-branch    # 合并即删分支（CD 手册:11-13）
```

### 2.4 Issue

```sh
gh issue create --title "..." --body "..."
gh issue view <N>
```

> **令牌纪律**：`gh` 凭据走 `gh auth login` 或 DSH 凭证库（`vault_set`/`vault_run`，
> 明文永不落盘/入对话）。CI 里用 `GITHUB_TOKEN`（`release.yml:145`）。

## 3. CI 失败分诊

**顺序即依赖**（`ci.yml:60-73`）：先 build，再 typecheck，再 lint，再 test。

| 步骤 | 失败常见原因 | 修复方向 |
|---|---|---|
| Build | tsdown 打包错误；dist 未重建 | 看构建日志；`pnpm run build` |
| Typecheck | 双 tsconfig 编译错误；`noUncheckedIndexedAccess` | 修类型；注意 `stats[f.script]` 需本地变量收窄 |
| Lint | DSH 规范符合性门 C9/C10（dist 形状/语法） | 先 build 再 lint |
| Test | 四层金字塔任一层失败 | 看分层输出（validate/vitest/smoke/trigger） |

seed 步骤失败（`ci.yml:88-123`）的经典原因（均已在 CI 修复）：
- `init-cycle` 必须先于 `coverage.mjs`（`.cycles` 被 gitignore，coverage 读 `config.yml`）
- `gate-ledger` 四门 anchor 必须在 coverage 运行前落（native F2 在 coverage 运行内断言）
- `generate-snapshot` 后必须重建 dist（smoke 断言 dist 渲染 == artifacts 快照同源）
- `ANIC_SELF_AUDIT=0` 必须在 **job 级** env（coverage 内部再起 vitest，Test 步骤级 env 传不到）

## 4. 评审协议

主干 R11：每条发现必须引用 `file:line` + 具体证据，按严重度排序，**每轮最多 5 条 nit**。

```sh
gh pr checkout <N>
# 在 PR 上做行级评审（GitHub MCP 的 add_comment_to_pending_review / pull_request_review_write）
```

评审输出建议结构：
1. **阻塞项**（必须改）：含 `file:line` 与影响
2. **建议项**（≤5 条 nit）：措辞/命名/小重构
3. **确认项**：行为已正确的部分

## 5. 合并策略：三法全开，但有两个连带后果

本仓实测（2026-11-06）：

```sh
gh api repos/xuanyuanchumo/dsh-anic --jq \
  '{s:.allow_squash_merge,m:.allow_merge_commit,r:.allow_rebase_merge,d:.delete_branch_on_merge,a:.allow_auto_merge}'
# → {"s":true,"m":true,"r":true,"d":false,"a":false}
```

| 策略 | 命令 | 主干历史形状 | 代价（真会踩到） |
|---|---|---|---|
| squash（本仓约定） | `gh pr merge <N> --squash` | 一条提交一功能，线性 | 原分支提交**不再是** `master` 的祖先 ⇒ `git branch -d <branch>` 拒绝（"not fully merged"），须 `-D` 或先比对内容 |
| rebase | `gh pr merge <N> --rebase` | 保留分支内每个提交，线性 | 提交 SHA 全变；分支若还活着再 push 会分叉 |
| merge | `gh pr merge <N> --merge` | 保留分支结构 + merge 提交 | `git log --graph` 里出现 `Merge branch …`，与本仓 `--ff-only` 线性纪律冲突 |

两个连带后果（都是仓库设置直接导致的，不是 Git 玄学）：

1. **远端分支不会自动消失**：`delete_branch_on_merge: false` ⇒ 网页点「Merge」**不删**远端分支。
   要删必须 `gh pr merge <N> --squash --delete-branch`，或事后 `git push origin --delete <branch>`。
2. **auto-merge 在本仓不可用**：`allow_auto_merge: false` ⇒ `gh pr merge --auto` 会失败。
   要用得先开 Settings → Allow auto-merge；这是仓库设置，不是命令写法问题。

## 6. PR 生命周期（draft → ready → review → merge）

| 阶段 | 命令（`gh` 2.92.0 实测 flag） | 语义 / 本仓现状 |
|---|---|---|
| 起草 | `gh pr create --base master --draft --title … --body-file …` | draft PR **不会被评审请求**，CI 照样跑（`ci.yml:12-13` 对 PR 全量触发），适合"先看 CI 绿不绿" |
| 转正 | `gh pr ready <N>`（转回 draft：`gh pr ready <N> --undo`） | 转正后才该请求评审 |
| 评审 | `gh pr review <N> --approve` / `--request-changes` / `--comment`（正文用 `-b` 或 `-F`） | 三种 review 状态；见下方「review 语义」 |
| 看检查 | `gh pr checks <N> --watch --fail-fast`；`--required` 只看必需检查 | 本仓无 required checks ⇒ `--required` 过滤后为空 |
| 合并 | `gh pr merge <N> --squash --delete-branch` | 前提是 CI 全绿（R3，人类门） |

**review 语义**（通用 GitHub 语义，本仓无保护时三者**都不阻塞合并**）：

| review 状态 | 意图 | 有无分支保护时的实际效果 |
|---|---|---|
| `--approve` | 认可，可合并 | 无保护：仅记录；有保护「Require approvals」：计数达标才能合 |
| `--request-changes` | 阻断，必须先改 | **无保护：仍可直接合**（这是 R3 的真实风险面）；有保护：会被挡住 |
| `--comment` | 只评论，不表态 | 永远不阻塞 |

**本仓现状（重要）**：`gh pr list --state all --limit 10` **空输出**，`gh api …/branches` 只有
`["master"]` —— PR 通道从未被使用过，全部提交直接 push `master`（`docs/agents/CI-CD与发布流程.md:18`
允许单人仓库直推）。因此本节的命令是**为将来多人协作准备的**：本仓没有任何"PR 强制"的机器保证，
`--admin`、`--request-changes` 后强合、`--auto` 之外的一切都只是纪律。

## 7. 合并队列（merge queue）：本仓不可用，别写进流程

**判据**：merge queue 是 **ruleset 上的 `merge_queue` 规则**，没有 ruleset 就没有队列。
本仓 `gh api repos/xuanyuanchumo/dsh-anic/rulesets` → `[]` ⇒ **合并队列不可用**。

`gh pr merge --help` 原文（gh 2.92.0 实测）已经把行为说清：

```text
When targeting a branch that requires a merge queue, no merge strategy is required.
If required checks have not yet passed, auto-merge will be enabled.
If required checks have passed, the pull request will be added to the merge queue.
To bypass a merge queue and merge directly, pass the `--admin` flag.
```

⇒ 在**有**队列的仓库里，`gh pr merge <N>` 的语义会从「立即合并」变成「入队/开 auto-merge」——
同一个命令在不同仓库设置下含义不同。迁移仓库时先 `gh ruleset check <branch> --repo <o>/<r>`
确认有没有队列规则，再决定写不写 `--squash`。本仓不适用。

## 8. 确定性脚本

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `scripts/pr-check.mjs` | 校验 PR 模板必填小节 + `gh` 可用性；`--pr N` 时读 PR 状态 | `0` 通过 / `1` 缺失或 CI 非绿 / `2` 用法错误 |
| `scripts/evidence-collect.mjs` | 采集 dist 新鲜度 / 测试报告 / 覆盖率 / 工作区证据，输出 Markdown 清单 | `0` 证据齐 / `1` 缺证据 / `2` 用法错误 |

调用契约：

```sh
node assets/skills/github-pr-actions/scripts/pr-check.mjs <workspace> [--pr N] [--offline] [--json]
node assets/skills/github-pr-actions/scripts/evidence-collect.mjs <workspace> [--out <workspace-relative>] [--json]
```

## 9. 与主干技能的对接

本技能喂 G0-G3 门禁（`skills.index.json` 中 `github-pr-actions` 的 gates = G0-G3）：PR 的门禁表、
CI 状态、评审证据都成为 `eval-runner` / `gate-check --record` 的输入；发布卫生由 `npm-publish` 承接。

## 10. 通用 Git/GitHub 知识（非本仓实证，标注以便区分）

以下为通用实践，非本仓实测，仅作参考：
- 行级评审的 diff 坐标（`startLine`/`line`/`side`）语义见 GitHub REST/GraphQL 文档；
  本仓 `add_comment_to_pending_review` 走 MCP 工具而非手工拼 API。
- required checks 的匹配键是**检查名**（本仓为 `ci.yml:26` 的
  `typecheck / lint / test (node 22)`）——改名即等于改规则匹配键，属未在本仓验证的写侧动作。
- 合并队列的规则细节（`merge_queue` 的 `max_entries_to_build` 等参数）本仓无 ruleset，
  未实测；验证方法：在测试仓库建 ruleset 后 `gh ruleset view <id> --repo <o>/<r>` 回读。
