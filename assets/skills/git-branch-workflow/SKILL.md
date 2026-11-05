---
name: git-branch-workflow
whenToUse: >
  在 dsh-anic 及其衍生仓库里进行分支管理、提交编写、主干保护、版本收口或回退时使用。
  触发词：分支、分支策略、commit、提交规范、合并、revert、主干保护、worktree、多分支并行、
  切分支、打 tag 前。
  Trigger words: branch, branches, commit, commit message, merge, revert, trunk
  protection, master protection, worktree, parallel branches, version rollup.
  Use when creating or deleting branches, writing conventional commits, merging a
  feature branch, rolling back master, or parallelizing work with git worktree.
description: >
  Triggers: 分支、分支策略、commit、提交规范、合并、revert、主干保护、worktree、
  branch, commit, merge, revert, trunk protection, parallel branches. Use when a
  repo needs the dsh-anic branch strategy: only `master` is permanent; `feat/`,
  `fix/`, `chore/` are deleted after merge; master only accepts verified commits;
  commits are `<type>(<scope>): <结论>`; rollback is `git revert`, never
  force-push. Provides deterministic guards `branch-lint.mjs` and
  `pre-push-verify.mjs`.
---

# git-branch-workflow（分支与提交操作手册）

> **一句话定位**：dsh-anic 分支策略与提交规范的操作知识——建哪类分支、commit 怎么写、
> 主干如何保护、回退用什么命令。叶技能，只提供操作知识与确定性脚本，不含流程脊柱
> （脊柱由主干技能 `ai-native-iteration-cycle` 承载）。

## 一、硬性规则

| # | 规则 | 说明 | 依据 |
|---|---|---|---|
| R1 | 主干唯一 | 只有 `master` 是永久主干，永远可安装可发布 | `docs/agents/CI-CD与发布流程.md:10` |
| R2 | 分支四类 | `master` / `feat/<域>-<主题>` / `fix/<issue>-<主题>` / `chore/<主题>`；后三类**合并即删** | `CI-CD与发布流程.md:10-13` |
| R3 | 主干只进验证过的提交 | push 前本地必须 `pnpm run typecheck && pnpm run test && pnpm run build` 全绿 | `CI-CD与发布流程.md:16` |
| R4 | commit 格式 | `<type>(<scope>): <一句话结论>`；type ∈ `feat`/`fix`/`docs`/`refactor`/`test`/`chore` | `CI-CD与发布流程.md:22-24` |
| R5 | 版本收口提交 | 版本收口以 `v0.X.Y cycle-N:` 开头，正文按领域列条目，每条写「改了什么——为什么/实证出处」 | `CI-CD与发布流程.md:25` |
| R6 | 回退用 revert | 主干回退用 `git revert <bad-commit>` 保历史；**禁止 force-push 主干** | `CI-CD与发布流程.md:118` |
| R7 | CI 触发面 | `master`/`feat/**`/`fix/**`/`chore/**` 的 push 与所有 PR 触发 CI；大改动走 PR | `CI-CD与发布流程.md:17-18`；`.github/workflows/ci.yml:9-14` |
| R8 | Windows 用 SSH remote | github.com 443 直连可能被重置；remote 用 `git@github.com:...` 形态，`gh` API 与 SSH 443 通 | `CI-CD与发布流程.md:123-125` |

### 规则→脚本

| 规则 | 建议层（本 SKILL） | 确定层（脚本） | 检查点 |
|---|---|---|---|
| R2 分支命名 | 本表 + operations.md | `branch-lint.mjs` | 建分支/push 前 |
| R4/R5 commit 类型 | 本表 + operations.md | `branch-lint.mjs` | 提交前 |
| R3 主干只进验证过的提交 | CLAUDE.md「验证你的工作」 | `pre-push-verify.mjs` | push 前 |
| R6 回退 | operations.md §回退 | — | 人工门 |
| R8 SSH | operations.md §Windows | — | 自检 `ssh -T git@github.com` |

## 二、快速启动

### 1. 新建分支

```sh
git switch master && git pull --ff-only origin master
git switch -c feat/host-tool-gate      # 域-主题，kebab-case
# 缺陷：git switch -c fix/128-snapshot-drift
# 工程/文档：git switch -c chore/readme-numbers
```

### 2. 提交

```sh
git add -A
git commit -m "fix(release): Build before seed coverage (dshConformance dist contract)"
# 版本收口（在 master 上）：
#   git commit -m "v0.56.0 cycle-104: ..."
```

### 3. 合并（PR 流程）

```sh
gh pr create --base master --title "feat(x): <一句话>" --body-file .cycles/pr-body.md
gh pr checks <N>          # CI 绿才合并
gh pr merge <N> --squash
git branch -d feat/x      # 合并即删
```

### 4. 回退

```sh
git revert <bad-commit>   # 保历史；禁止 git push --force origin master
```

### 5. 主干 push 前自检

```sh
# 确定性守卫（只读，零写入）
node assets/skills/git-branch-workflow/scripts/branch-lint.mjs <workspace>
node assets/skills/git-branch-workflow/scripts/pre-push-verify.mjs <workspace> [--run-gates]

# 完整门禁（人工确认）
pnpm run typecheck && pnpm run test && pnpm run build
```

### 6. Windows SSH 自检

```sh
ssh -T git@github.com     # 期望输出 Hi <user>!
git remote -v             # 期望 origin 为 git@github.com:<owner>/<repo>.git
```

## 三、导航索引

| 需要了解 | 读取 |
|---|---|
| 分支/提交操作手册（含 worktree、变基、冲突处理） | `references/operations.md` |
| 分支命名冲突、commit 类型违规、SSH 失败等 | `references/troubleshooting.md` |
| 分支命名 + commit 类型守卫 | `scripts/branch-lint.mjs` |
| 主干 push 前门禁（含 `--run-gates`） | `scripts/pre-push-verify.mjs` |
| 脚本调用契约（位置参数、退出码） | `scripts/README.md` |
| 版本锚点（三锚一致） | `CHANGELOG.md` 顶层条目 |
| 技能库注册表（触发词/依赖） | `assets/skills/skills.index.json` |

## 四、边界

- 不写历史、不 force-push、不跨仓库推送；`pre-push-verify.mjs` 默认只做只读检查。
- 不替代主干技能：流程门禁、评估、自主级由 `ai-native-iteration-cycle` 承载。
- 不含任何令牌：所有远端凭据走 DSH 凭证库或本机 SSH agent，脚本不接触明文。
