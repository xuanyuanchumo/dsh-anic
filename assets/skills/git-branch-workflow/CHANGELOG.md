# git-branch-workflow · CHANGELOG

本技能遵循 dsh-anic 内部技能库三锚一致纪律：`SKILL.md` 版本标注、
`scripts/<primary>.mjs` 脚本版本串、本 CHANGELOG 顶层条目三处版本必须一致。

## v0.2.0 — 2026-11-06（cycle-108：补保护分支 / rebase-merge / 冲突三块知识缺口）

> 起点：v0.1.0（cycle-105）。本轮只补**已被实测证实**的缺口，不扩写已有内容。

### 新增

- **`references/branch-protection.md`（新建）**：三块此前全无覆盖的知识面——
  1. **保护分支与 required checks**：本仓 2026-11-06 实测基线（`branches/master/protection`
     → HTTP 404 `Branch not protected`；`rulesets` → `[]`；gh 2.92.0；`gh ruleset --help`
     证实子命令只有 `check/list/view`、无 create）。结论明确：本仓「CI 绿才合并」是**约定**
     不是**强制**，`--admin` 永远可绕过；给开保护的最小动作与回读验证命令
     （`required_status_checks.contexts` 写侧本仓未实测，标注「未验证」+ 验证方法）。
  2. **rebase vs merge**：五场景决策表（`--ff-only` 追主干 / 未共享分支 rebase / 已共享分支禁
     rebase / squash / rebase-merge），并给本仓真实坑——`pull.rebase=false` 实测值意味着裸
     `git pull` 会生成 merge 提交。
  3. **冲突处理**：`git diff --name-only --diff-filter=U` → ours/theirs → `--continue/--abort`
     可执行序列；点明 rebase 下 `ours/theirs` **语义反转**（通用 Git 语义，给 `git show :2:/:3:`
     自查法绕开背诵）；收尾复验三条命令。
- **squash 连带后果**：原分支不再是 `master` 祖先 ⇒ `git branch -d` 拒绝、须 `-D` 或先比对；
  本仓 `delete_branch_on_merge: false` 实测 ⇒ 网页合并不删远端分支。

### 变更

- `SKILL.md`：新增 R9（主干保护是约定不是强制）/ R10（合并方式与删分支按仓库设置走）/
  R11（追主干用 `--ff-only`，已共享分支不 rebase）/ R12（冲突解决后必须复验）；
  规则→脚本映射表同步 4 行；快速启动新增 §7（`gh api` 查保护与合并设置）与 §8（冲突收尾）；
  导航索引指向新参考文件；frontmatter 补 `version: 0.2.0`（此前 SKILL.md 未声明版本，
  manifest 的 `anchor:version` 守卫**无处可比**、形同休眠——本轮激活它）。
- `skills.index.json`：补显式 `dir` 字段（此前 9 条叶技能全缺，机器面隐身）；
  `anchors` 增列 `references/branch-protection.md`。

### 依据（全部可复验）

```sh
gh api repos/xuanyuanchumo/dsh-anic/branches/master/protection   # 404 Branch not protected
gh api repos/xuanyuanchumo/dsh-anic/rulesets                     # []
gh api repos/xuanyuanchumo/dsh-anic --jq '{s:.allow_squash_merge,r:.allow_rebase_merge,d:.delete_branch_on_merge}'
gh ruleset --help ; gh --version                                  # 2.92.0，子命令 check/list/view
git config --get pull.rebase ; git branch -a ; git remote -v
```

### 安全

- 不新增任何令牌操作；`gh api` 只读调用经 DSH 凭证库注入（`vault_run`），明文不入对话。
- 写侧（`PUT .../protection`）本仓未实测，明确标注「未验证」并给「先 fork 后回读」的验证方法，
  未把记忆中的字段名写成结论。

## v0.1.0 — 2026-11-05

### 新增

- **SKILL.md**：分支策略与提交规范操作手册；硬规则 R1-R8（主干唯一 / 分支四类 /
  主干只进验证过的提交 / commit 格式 / 版本收口 / revert 红线 / CI 触发面 / Windows SSH remote）；
  快速启动；导航索引。依据 `docs/agents/CI-CD与发布流程.md:6-25,112-126`。
- **references/operations.md**：分支生命周期、worktree 并行、提交规范、主干保护、
  回退矩阵、Windows SSH 自检、脚本调用契约。
- **references/troubleshooting.md**：T1-T10 失败模式与修复（分支名/commit 类型/版本收口/
  push 门禁/443 重置/force-push/分支删除/worktree 污染/CHANGELOG 同步/参数错误）。
- **scripts/branch-lint.mjs**：确定性守卫，校验当前分支名 + 最近 N 条 commit
  类型与版本收口形态；`--json` 机器可读；退出码 0/1/2。
- **scripts/pre-push-verify.mjs**：主干 push 前门禁；校验 `package.json` 三件套脚本、
  分支守卫、工作区状态；`--run-gates` 按 `ci.yml:60-73` 依赖顺序跑 typecheck → test → build。
- **scripts/README.md**：位置参数契约（第一位置参数 = 项目目录）、退出码、安全声明。

### 事实基座

- 所有仓库结论引用真实 `file:line`：`docs/agents/CI-CD与发布流程.md`、
  `.github/workflows/ci.yml`、`package.json`、`.gitignore`。
- 远端形态 `git@github.com:xuanyuanchumo/dsh-anic.git` 由 `git remote -v` 本机实测。
- 分支四类与 commit 类型来自 `CI-CD与发布流程.md:10-13,24`；版本收口前缀来自 `:25`。

### 边界

- 不喂 G0-G3 门禁（`skills.index.json:33` gates 为空），分支守卫作为 R01 人工门证据。
- 不含任何令牌；远端凭据走 DSH 凭证库或 SSH agent。
