# github-pr-actions · CHANGELOG

本技能遵循 dsh-anic 内部技能库三锚一致纪律：`SKILL.md` 版本标注、
`scripts/<primary>.mjs` 脚本版本串、本 CHANGELOG 顶层条目三处版本必须一致。

## v0.2.0 — 2026-11-06（cycle-108：补 PR 生命周期 / review 语义 / 合并队列与设置面）

> 起点：v0.1.0（cycle-105）。本轮补的是**此前完全没写、且能用 `gh` 实测钉死**的四块。

### 新增（`references/operations.md` §5-§7）

- **§5 合并策略连带后果**：本仓实测 `allow_squash_merge/merge/rebase` 三法全 `true`、
  `delete_branch_on_merge: false`、`allow_auto_merge: false`。据此写明两条真会踩的后果：
  ① squash 后原分支**不再是** `master` 祖先 ⇒ `git branch -d` 拒绝、须 `-D`；
  ② `delete_branch_on_merge=false` ⇒ 网页合并不删远端分支，必须 `gh pr merge --delete-branch`。
- **§6 PR 生命周期 draft→ready→review→merge**：全链路 `gh` 命令（flag 均以 `gh 2.92.0 --help`
  实测：`gh pr create --draft` / `gh pr ready [--undo]` / `gh pr review --approve|--request-changes|
  --comment` / `gh pr checks --watch --fail-fast --required`），并给**review 三态在有无保护时的
  真实效果差异**——无保护仓库 `--request-changes` **不阻塞合并**。
- **§7 合并队列不可用**：本仓 `rulesets` → `[]` ⇒ 无 `merge_queue` 规则；引 `gh pr merge --help`
  原文说明「有队列时 `gh pr merge` 语义变成入队/auto-merge」，提醒跨仓迁移前先
  `gh ruleset check <branch>` 确认。
- **本仓现状硬事实**：`gh pr list --state all --limit 10` **空输出**、`gh api .../branches` 只有
  `["master"]` ⇒ PR 通道从未使用过，全部直推 master。故本节定位为「为多人协作预备」，
  并明确写出本仓**没有任何机器级 PR 强制**。

### 变更

- `SKILL.md`：新增 R10（无保护时 review 不阻塞）/ R11（合并前先读仓库设置）/ R12（draft→ready→
  review→merge 生命周期）；快速启动 §3 改为 draft 起步 + `--watch --fail-fast`，§4 改为
  评审三态 + `--delete-branch` + 设置回读命令；导航索引按 §区间拆行；
  frontmatter 补 `version: 0.2.0`（激活此前休眠的 `anchor:version` 锚）。
- `skills.index.json`：补显式 `dir` 字段。

### 依据（可复验）

```sh
gh api repos/xuanyuanchumo/dsh-anic --jq '{s:.allow_squash_merge,m:.allow_merge_commit,r:.allow_rebase_merge,d:.delete_branch_on_merge,a:.allow_auto_merge}'
gh api repos/xuanyuanchumo/dsh-anic/rulesets      # []
gh pr list -R xuanyuanchumo/dsh-anic --state all --limit 10   # 空输出
gh api repos/xuanyuanchumo/dsh-anic/branches --jq '[.[].name]' # ["master"]
gh pr create --help ; gh pr ready --help ; gh pr review --help ; gh pr checks --help ; gh pr merge --help
gh ruleset --help ; gh --version                  # 2.92.0
```

### 安全

- 全部 `gh` 调用为只读；认证经 DSH 凭证库 `vault_run`（`github` → `GH_TOKEN`），令牌不入对话/日志。
- 未在本仓实测的写侧（required checks 字段、merge_queue 参数）标注「未实测/通用知识」并给验证方法。

## v0.1.0 — 2026-11-05

### 新增

- **SKILL.md**：PR 生命周期与 CI 门禁操作手册；硬规则 R1-R9（证据纪律 / 验证命令顺序 /
  CI 红禁合并 / 评审证据化 / 模板必填字段 / G0-G3 门禁表 / 数字同步 / 自查清单 / 大改动走 PR）；
  快速启动；导航索引。
- **references/operations.md**：建 PR 前流程、`gh pr` 操作、CI 失败分诊表、评审协议、
  合并策略、脚本契约。
- **references/troubleshooting.md**：T1-T9 失败模式与修复（补证据 / CI 红本地绿 /
  build 顺序 / 数字不同步 / gh 未认证 / Windows 网络 / 模板字段 / 删分支 / 无 file:line）。
- **scripts/pr-check.mjs**：校验 PR 模板九个必填小节 + `gh` 可用性；`--pr N` 读 PR 状态；
  `--offline` 离线模式；退出码 0/1/2。
- **scripts/evidence-collect.mjs**：采集 dist 新鲜度 / 测试报告 / 覆盖率 / 工作区干净度 /
  工具数五项证据，输出 Markdown 清单；`--out` 限制在 workspace 内。
- **scripts/README.md**：位置参数契约、退出码、安全声明。

### 事实基座

- PR 模板必填字段引用 `.github/PULL_REQUEST_TEMPLATE.md:1-82`；证据纪律引用 `:20`；
  合并前置引用 `:82`；数字同步引用 `:54-56`；自查清单引用 `:64-70`。
- CI 依赖顺序引用 `.github/workflows/ci.yml:60-73`；CI 触发面引用 `:9-14`；
  四件套 seeding 引用 `:88-123`。
- CD 手册分支策略引用 `docs/agents/CI-CD与发布流程.md:18`。
- 工具数采集命令引用 `CI-CD与发布流程.md:105`（`grep -rho "name: 'anic_[a-z_]*'" src/host/tools*.ts`）。

### 边界

- 不做真实凭据操作：`gh` 认证由 `gh auth login` 或 DSH 凭证库完成。
- 不自动合并：合并是 R01 人类门，脚本只报告状态。
- 不替代 `ci-cd-release` 技能：workflow 设计与回滚矩阵由其承载。
