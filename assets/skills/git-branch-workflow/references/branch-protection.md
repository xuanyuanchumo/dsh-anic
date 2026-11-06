# 分支保护 · rebase vs merge · 冲突处理（branch-protection）

> 归属：`git-branch-workflow` 叶技能的参考文件（v0.2.0，cycle-108）。
> 本文件只讲三件会被真实踩到的事：**保护分支与 required checks 在本仓到底有没有开**、
> **rebase 与 merge 怎么选**、**冲突怎么收**。每条结论都带可执行复验命令。
> 通用 Git/GitHub 语义会明确标注「通用」；本仓没验证过的写「未验证」并给验证方法。

## 0. 本仓实测基线（2026-11-06，gh 2.92.0）

| 事实 | 实测值 | 复验命令 |
|---|---|---|
| `master` 是否受保护 | **否** —— HTTP 404 `Branch not protected` | `gh api repos/xuanyuanchumo/dsh-anic/branches/master/protection` |
| 仓库 rulesets | **空数组 `[]`**（无规则集） | `gh api repos/xuanyuanchumo/dsh-anic/rulesets` |
| 默认分支 | `master` | `gh api repos/xuanyuanchumo/dsh-anic --jq .default_branch` |
| 允许的合并方式 | `squash` / `merge` / `rebase` **三者全开** | `gh api repos/xuanyuanchumo/dsh-anic --jq '{s:.allow_squash_merge,m:.allow_merge_commit,r:.allow_rebase_merge}'` |
| 合并后自动删分支 | **关**（`delete_branch_on_merge: false`） | 同上 `--jq .delete_branch_on_merge` |
| 本仓分支 | 只有 `master` + `origin/master`（无长期分支） | `git branch -a` |
| `pull.rebase` | `false`（`git pull` 默认走 merge） | `git config --get pull.rebase` |
| `init.defaultBranch` | `master` | `git config --get init.defaultBranch` |
| gh 是否支持 ruleset 子命令 | 支持：`gh ruleset check / list / view`（别名 `gh rs`） | `gh ruleset --help`；`gh --version` |

**结论（这是判断而非推测）**：本仓 `master` 目前**没有任何机器级保护**——既无 classic
branch protection，也无 rulesets。所以「主干只进验证过的提交」（SKILL.md R3）**只由人（R01 人类门）
与 commit 纪律保证，不由 GitHub 拒绝 push 保证**。任何「CI 绿才能合并」的说法在本仓
都是**约定**，不是**强制**；要变成强制，必须开保护（见 §1.3），否则 `gh pr merge --admin`
永远能绕过。

> 单人仓库 + 直接 push master 是 `docs/agents/CI-CD与发布流程.md:18` 的显式许可。
> 保护分支在这里是「将来多人协作/引入外部贡献者时」的开关，不是当下的缺失缺陷。

## 1. 保护分支与 required checks

### 1.1 两种形态（通用，端点/子命令已在本仓实测存在）

| 形态 | 读 | 写 |
|---|---|---|
| classic branch protection | `gh api repos/<o>/<r>/branches/<branch>/protection`（未开保护返回 404 `Branch not protected` —— 这就是本仓现状） | `gh api --method PUT repos/<o>/<r>/branches/<branch>/protection`（**请求体字段未在本仓验证**，见 §1.3） |
| repository ruleset（新形态） | `gh ruleset list` / `gh api repos/<o>/<r>/rulesets`（本仓 `[]`） | `gh ruleset` **只有 check/list/view，没有 create**（`gh ruleset --help` 实测）⇒ 创建只能在 GitHub 网页或 REST |

**判据**：能用 REST 读到的两种形态都要读；只读 ruleset 会漏掉 classic protection（反之亦然）。
本仓两种都读了，都是空。

### 1.2 required checks 的前提：job 名必须稳定

required checks 是按**检查名**匹配的，名字一变规则就静默失效。本仓的检查名来自
`.github/workflows/ci.yml`：

```yaml
jobs:
  verify:
    name: typecheck / lint / test (node 22)   # ci.yml:25-26
```

- 传给 GitHub 的 check 名是 `<job name>`（workflow + job 组合，UI 上显示为
  `typecheck / lint / test (node 22)`）。
- **纪律**：改 `jobs.<id>.name` 等同于改 required check 的匹配键。改名前先
  `gh ruleset check master`（取决于是否有 ruleset）或在 Settings → Branches 里核对；
  无保护时改名无副作用——这也是本仓暂时安全的唯一原因。
- 真实运行可查：`gh run list -R xuanyuanchumo/dsh-anic --limit 3`
  （实测：`completed success CI master push 42156424415 3m14s`）。

### 1.3 要开保护时的最小动作（写侧未验证，按此顺序验证再落地）

```sh
# 1) 先看当前状态，确认确实是空的（不是权限不足导致的假空）
gh api repos/xuanyuanchumo/dsh-anic/branches/master/protection   # 期望 404 Branch not protected
gh ruleset list -R xuanyuanchumo/dsh-anic                          # 期望 无规则集

# 2) 在 GitHub 网页开（推荐：Rulesets → New branch ruleset → Target master →
#    Require a pull request before merging + Require status checks to pass）
#    或经典路径 Settings → Branches → Add branch protection rule

# 3) 开完立刻回读，证明真的生效（而不是"点过了"）
gh api repos/xuanyuanchumo/dsh-anic/branches/master/protection --jq '.required_status_checks.contexts'
gh ruleset list -R xuanyuanchumo/dsh-anic
gh ruleset check master -R xuanyuanchumo/dsh-anic                  # 看哪些规则会作用到 master
```

> **未验证**：`PUT .../branches/master/protection` 的请求体字段名（`required_status_checks`
> / `enforce_admins` / `restrictions` 的形状）本仓未实测。验证方法：先在一人 fork 上 PUT 一次
> 再 GET 回读比对；不要把「记得的字段名」当结论写进流程。

## 2. rebase vs merge

| 场景 | 用什么 | 为什么 |
|---|---|---|
| 本地主干追远端 | `git pull --ff-only origin master` | 只允许快进；本地有分叉就报错而不是偷偷生成 merge 提交（本仓 SKILL.md §二 已用此形态） |
| 功能分支同步主干 | `git rebase master`（未共享的分支） | 历史线性、review 好读；**已 push 且有人基于它工作时禁止 rebase**（会改写别人的基） |
| 已共享的功能分支同步主干 | `git merge master` | 不改写已发布历史；代价是主干里多一条 merge 提交 |
| 合入主干 | PR 上 `--squash`（本仓默认动作） | 主干历史一条一功能；代价见 §3 |
| 想保留分支内每个提交 | PR 上 `--rebase` | 本仓 `allow_rebase_merge: true`，可用 |

**本仓现状导致的一个真实坑**：`pull.rebase=false`（实测），所以裸 `git pull` 会生成 merge 提交。
本仓的约定写法是显式 `--ff-only`；要改成默认 rebase 需 `git config pull.rebase true`——
**这会改所有人的行为**，属团队决策，不要单方面设。

复验：

```sh
git config --get pull.rebase            # 当前 false
git log --graph --oneline -10           # 看历史里有没有意外 merge 提交（有 "Merge branch" 即中招）
```

## 3. squash 合并的两个连带后果（必读）

1. **分支不再被 Git 认为「已合并」**：squash 生成的是**新**提交，原分支的提交不在 `master` 祖先链上
   ⇒ `git branch -d <branch>` 会拒绝（"not fully merged"），必须 `git branch -D <branch>`
   或先确认 `git log master..<branch>` 与 squash 内容一致再删。
   复验：`git branch --merged master | grep <branch>` —— 空即「未合并」。
2. **远端分支不会自动消失**：本仓 `delete_branch_on_merge: false`（实测）⇒ 网页上点合并**不删**
   远端分支。要么 `gh pr merge <N> --squash --delete-branch`，要么事后
   `git push origin --delete <branch>`。

## 4. 冲突处理（可执行序列）

先确认冲突面，再决定 ours/theirs——**不看 `git status` 就直接 `checkout --ours` 是最常见的错**。

```sh
# 1) 谁跟谁冲突（merge 或 rebase 都会列）
git status --short
git diff --name-only --diff-filter=U          # 只列未解冲突文件
git ls-files -u | head -20                    # 带 stage(1/2/3) 的原始冲突记录

# 2) 逐文件选定一侧（ours = 当前分支；rebase 时 ours 语义会反转，见下）
git checkout --ours  path/to/file
git checkout --theirs path/to/file
git add path/to/file

# 3) 继续或放弃
git rebase --continue        # 或 git merge --continue
git rebase --abort           # 或 git merge --abort（回到动手前）
```

**rebase 时的 ours/theirs 反转（通用，最易错）**：
rebase 的 `ours` 是**被 rebase 到的目标分支**（即 master），`theirs` 才是你正在重放的提交。
理不清时用 `git show :2:file` / `git show :3:file` 直接看两版内容，别背口诀。

**收尾验证（必须做，别只看 `git status` 变干净）**：

```sh
git diff --name-only --diff-filter=U   # 期望无输出
git log --oneline -5                   # rebase 后提交是否都还在
git merge-base --is-ancestor master HEAD && echo "已含 master" # 分支是否真的追上了
```

冲突解完仍要跑 SKILL.md R3 的三件套（`pnpm run typecheck && pnpm run test && pnpm run build`）——
**冲突解决正确 ≠ 逻辑正确**。

## 5. 与本技能其他文件的分工

| 想做的事 | 读 |
|---|---|
| 分支命名 / 提交规范 / worktree / 回退 | `references/operations.md` |
| 保护分支 / rebase vs merge / 冲突 | 本文件 |
| 命名与 commit 类型机械守卫 | `scripts/branch-lint.mjs` |
| push 前门禁（含 `--run-gates`） | `scripts/pre-push-verify.mjs` |