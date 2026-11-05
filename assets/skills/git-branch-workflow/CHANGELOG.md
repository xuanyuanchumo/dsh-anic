# git-branch-workflow · CHANGELOG

本技能遵循 dsh-anic 内部技能库三锚一致纪律：`SKILL.md` 版本标注、
`scripts/<primary>.mjs` 脚本版本串、本 CHANGELOG 顶层条目三处版本必须一致。

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
