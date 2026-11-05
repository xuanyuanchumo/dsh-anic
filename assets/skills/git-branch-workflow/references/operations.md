# git-branch-workflow · 操作手册

> 详细操作手册。所有命令均为 dsh-anic 仓库实测命令（引用 `docs/agents/CI-CD与发布流程.md`，
> 下称「CD 手册」）。通用 Git 知识标注为「通用」。

## 0. 事实锚点（本仓实证）

| 事实 | 值 | 证据 |
|---|---|---|
| 永久主干 | `master` | CD 手册 `:10` |
| 功能分支 | `feat/<域>-<主题>`，合并即删 | CD 手册 `:11` |
| 缺陷分支 | `fix/<issue号>-<主题>`，合并即删 | CD 手册 `:12` |
| 工程分支 | `chore/<主题>`，合并即删 | CD 手册 `:13` |
| commit 类型 | `feat`/`fix`/`docs`/`refactor`/`test`/`chore`/`v<版本号>` | CD 手册 `:24` |
| 版本收口前缀 | `v0.X.Y cycle-N:` | CD 手册 `:25` |
| CI 触发分支 | `master`、`feat/**`、`fix/**`、`chore/**` | `.github/workflows/ci.yml:11` |
| 远端 | `origin → git@github.com:xuanyuanchumo/dsh-anic.git`（SSH 形态） | 本仓 `git remote -v` 实测 |
| 主干推前门禁 | `pnpm run typecheck && pnpm run test && pnpm run build` | CD 手册 `:16` |

> **仓库现状注**：本仓当前只有 `master` 分支（`git branch -a` 实测），无 `feat/`/`fix/` 长期分支；
> 历史提交以 `fix(ci):`/`fix(test):` 等常规式为主（`git log` 实测，见 `:` 记录）。

## 1. 分支生命周期

### 1.1 建分支

```sh
git switch master
git pull --ff-only origin master     # 绝不 merge 未拉取的远端
git switch -c feat/<域>-<主题>
```

- `--ff-only`：本地主干落后远端时只允许快进，避免隐式 merge（通用 Git 最佳实践）。
- 域建议取模块名：`host`/`client`/`ci`/`skill`/`doc`。

### 1.2 合并即删

```sh
gh pr merge <N> --squash          # PR 模板要求 CI 全绿（见 github-pr-actions 技能）
git branch -d feat/<域>-<主题>     # -d 会检查是否已合并，未合并则拒绝
git push origin --delete feat/<域>-<主题>   # 远端清理
```

### 1.3 worktree 多分支并行

```sh
git worktree add ../dsh-anic-feat-x -b feat/x master
# 在 ../dsh-anic-feat-x 里独立开发；完成后
git worktree remove ../dsh-anic-feat-x
git worktree prune
```

> **注意（本仓坑）**：`create_worktree` 曾把 766 个文件塞进 `.agents/worktrees/`，污染 eval
> 源码扫描。worktree 必须落在仓库外（如 `../`），且 `.agents/` 已在 `.gitignore`
> （`.gitignore:13-17`）。

## 2. 提交规范

### 2.1 常规提交

```sh
git commit -m "<type>(<scope>): <一句话结论>"
```

- 一句话结论写「改了什么 + 为什么」，不写「修改了文件」这类空话。
- 示例（本仓真实提交，`git log` 实测）：
  - `fix(release): Build before seed coverage (dshConformance dist contract)`
  - `fix(ci): ANIC_SELF_AUDIT=0 提升 job 级 env——coverage.mjs 内部再起 vitest`

### 2.2 版本收口提交

```sh
git commit -m "v0.56.0 cycle-104:

- chore(skills): 新建 4 个叶技能——改了什么——为什么/实证出处
- fix(release): 构建先于 coverage 播种——dshConformance dist 契约要求"
```

### 2.3 commit 与 CHANGELOG 的关系

- 版本号唯一事实源是 `package.json.version`（CD 手册 `:47`）。
- **版本锚点同步**（v0.55.2 cycle-103 确立，CD 手册 `:48-49`）：改 version 时同轮改 CHANGELOG；
  README 中出现的工具数/路由数由 `tests/contract/readmeNumbers.test.ts` 钉死。

## 3. 主干保护

### 3.1 push 前门禁

```sh
pnpm run typecheck && pnpm run test && pnpm run build
```

三者顺序即依赖（`ci.yml:60-73`）：build 必须先于 lint/test，因为 lint 的 C9/C10 检查 `dist/`
存在性、smoke 直接 `readFileSync dist/client.js`、`deployFreshnessContract` 要求 dist 不旧于 src
（`ci.yml:61-65`）。

### 3.2 单人仓库直接 push master

CD 手册 `:18` 允许单人仓库直接 push master，但 commit message 必须写清「改了什么 + 为什么」。
多人协作一律走 PR（R01 人类门禁）。

### 3.3 禁止 force-push 主干

```sh
# 错误示范（禁止）：
# git push --force origin master
# 正确做法：
git revert <bad-commit> && git push origin master
```

## 4. 回退

| 场景 | 动作 | 依据 |
|---|---|---|
| master 上有坏提交 | `git revert <bad-commit>`（保历史） | CD 手册 `:118` |
| 本地分支要重写（未共享） | `git push -f origin <branch>` **仅非主干** | 通用 |
| tag 已误推 | `git push origin :refs/tags/vX.Y.Z`（见 npm-publish 技能） | CD 手册 `:117` |

> `git revert` 会生成一条新的反向提交，历史不被改写——这是 H4 账本「不改历史」精神在 Git 层的镜像。

## 5. Windows 网络与 SSH（cycle-104 实测）

```sh
ssh -T git@github.com
# 期望：Hi <user>! 即通
git remote -v
# 期望：origin git@github.com:<owner>/<repo>.git
```

- github.com 443 直连可能被重置（`Connection was reset` / timeout），而 `gh` API 与 SSH 443 通
  （CD 手册 `:123-125`）。
- 若 HTTPS remote 挂而 SSH 通，改 remote：
  ```sh
  git remote set-url origin git@github.com:xuanyuanchumo/dsh-anic.git
  ```
- `gh auth setup-git` 对 HTTPS 形态无效时，SSH 是唯一稳定通道（CD 手册 `:125`）。

## 6. 确定性脚本

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `scripts/branch-lint.mjs` | 校验当前分支名 + 最近 N 条 commit 类型 | 0 全过 / 1 违规 / 2 用法错误 |
| `scripts/pre-push-verify.mjs` | 主干 push 前门禁（脚本存在性 + 分支守卫 + 可选 `--run-gates`） | 0 过 / 1 门禁失败 / 2 用法错误 |

调用契约（`scripts/README.md` 有完整说明）：

```sh
node assets/skills/git-branch-workflow/scripts/branch-lint.mjs <workspace> [--limit 20] [--json]
node assets/skills/git-branch-workflow/scripts/pre-push-verify.mjs <workspace> [--allow-master] [--run-gates] [--json]
```

## 7. 与主干技能的对接

| 主干环节 | 本技能输入 | 本技能输出 |
|---|---|---|
| Build→Deploy 阶段按需加载 | git 状态 | 分支计划 + 提交信息 + 检查清单 |
| 门禁 G0-G3 | 主干门禁判定 | 分支/提交证据（R01/R09 证据源） |
| 修复 auto-fix-loop | 本技能故障手册 | 修复步骤 |

本技能**不喂门禁**（`skills.index.json:33` gates 为空），因为分支命名本身是确定性脚本守卫，
其结果作为人工门（R01）证据即可。
