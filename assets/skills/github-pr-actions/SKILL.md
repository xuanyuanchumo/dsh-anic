---
name: github-pr-actions
version: 0.2.0
whenToUse: >
  在 dsh-anic 及其衍生仓库里处理 PR 生命周期、CI 失败分诊、代码评审、合并决策、或 gh CLI
  操作时使用。
  触发词：PR、pull request、评审、review、CI 红、CI 失败、gh、合并、squash、门禁状态、证据粘贴。
  Trigger words: PR, pull request, review, CI red, CI failure, gh, merge, squash,
  evidence, gate status. Use when creating or reviewing a PR, triaging a failing CI
  run, running gh pr commands, filling the PR template, or deciding whether to merge.
description: >
  Triggers: PR、pull request、评审、review、CI 红、CI 失败、gh、合并、squash、证据粘贴、
  PR, pull request, review, CI red, gh, merge, squash, evidence. Use when a repo
  follows the dsh-anic PR workflow: no "passed" without pasted command output, CI
  must be green before merge, review findings must cite file:line with severity and
  a 5-nit cap, and the template's G0-G3 gate table must be filled. Provides deterministic
  scripts `pr-check.mjs` and `evidence-collect.mjs`.
---

# github-pr-actions（PR 生命周期与 CI 门禁操作）

> **一句话定位**：dsh-anic 的 PR 操作手册——怎么建 PR、怎么写证据、CI 红了怎么分诊、
> 评审怎么给发现、什么时候才能合并。叶技能，依赖 `git-branch-workflow`（分支先建对）。

## 一、硬性规则

| # | 规则 | 说明 | 依据 |
|---|---|---|---|
| R1 | 证据纪律 | **没有粘输出的「已通过」不算证据**；PR 必须贴命令与关键输出 | `.github/PULL_REQUEST_TEMPLATE.md:20` |
| R2 | 验证命令顺序 | 顺序即依赖：build → typecheck → lint → test | `.github/workflows/ci.yml:60-73` |
| R3 | CI 红禁止合并 | PR 必须 CI 全绿方可合并 | `PULL_REQUEST_TEMPLATE.md:82` |
| R4 | 评审须有证据 | 每条发现引用 `file:line` + 具体证据，按严重度排序，每轮最多 5 条 nit | 主干 R11 |
| R5 | 模板必填字段 | 变更摘要 / 关联循环 / 验证证据 / 门禁状态 / 变更范围 / 破坏性变更 / 自查清单 / 人类判断门 | `PULL_REQUEST_TEMPLATE.md:1-82` |
| R6 | G0-G3 门禁表 | 涉及循环迭代时逐行填 PASS/FAIL/N/A，不能空 | `PULL_REQUEST_TEMPLATE.md:40-45` |
| R7 | 数字变更同步 | 改工具/路由数量须同步 `README.md` 数字与 marketplace 草稿，否则契约红 | `PULL_REQUEST_TEMPLATE.md:54-56` |
| R8 | 自查清单 | 未引入父工程 import、单文件 ≤~250 行、用户面文本经 `t()`、`dist/` 未提交、无令牌 | `PULL_REQUEST_TEMPLATE.md:64-70` |
| R9 | 大改动走 PR | 单人仓库可直推 master，但必须写清「改了什么 + 为什么」 | `docs/agents/CI-CD与发布流程.md:18` |
| R10 | review 状态在无保护仓库**不阻塞** | `--request-changes` 只记录意见；本仓无 protection（404）也无 rulesets（`[]`）⇒ 评审不挡 merge，挡 merge 的只有人 | `references/operations.md` §6；`gh api repos/.../branches/master/protection` |
| R11 | 合并前先读仓库设置 | `allow_auto_merge:false` ⇒ `--auto` 会失败；`delete_branch_on_merge:false` ⇒ 须 `--delete-branch`；merge queue 需 ruleset（本仓 `[]`）⇒ 不可用 | `references/operations.md` §5/§7；`gh api repos/... --jq '{a:.allow_auto_merge,d:.delete_branch_on_merge}'` |
| R12 | PR 生命周期按 draft→ready→review→merge 走 | draft 不请求评审但照样跑 CI（`ci.yml:12-13`）；`gh pr ready` 转正；`gh pr review` 三态 | `gh pr create --draft` / `gh pr ready` / `gh pr review`（gh 2.92.0 `--help` 实测） |

### 规则→脚本

| 规则 | 建议层 | 确定层（脚本） | 检查点 |
|---|---|---|---|
| R5 模板字段 | 本表 + operations.md | `pr-check.mjs` | 建 PR 前 |
| R2 顺序 | operations.md §CI 分诊 | `evidence-collect.mjs` | 合并前 |
| R1/R6 证据 | PR 模板 + operations.md | `evidence-collect.mjs` | 提交 PR 前 |
| R3 CI 红禁合并 | operations.md §合并 | 人工门 | 合并前 |

## 二、快速启动

### 1. 建分支 + 本地验证

```sh
git switch -c feat/<域>-<主题>
pnpm run typecheck && pnpm run test && pnpm run build
```

### 2. 生成 PR 正文

```sh
# 模板必填字段（见 R5）：
#   ## 变更摘要（一到三句：改了什么、为什么，不复述 diff）
#   ### 关联循环 / 议题：cycle-{N} / Issue #{N} / 阶段
#   ### 变更类型：功能/修复/重构/文档/CI/破坏性
#   ## 验证证据（贴命令与关键输出）
#   ### 门禁状态（G0-G3 表）
#   ## 变更范围（修改/新增/删除文件数 + 是否触碰 src/**）
#   ## 破坏性变更（无则写「无」）
#   ## 自查清单（R8）
#   ## 人类判断门（规格意图/用户体验/业务约束/伦理合规）
```

### 3. 创建 PR 并检查 CI

```sh
# 起草（想先看 CI 绿不绿、不惊动评审时用 draft）
gh pr create --base master --draft --title "feat(x): <一句话>" --body-file .cycles/pr-body.md
gh pr ready <N>                        # 转正 → 才请求评审
gh pr checks <N> --watch --fail-fast   # 等全绿；--required 只看必需检查
gh pr view <N> --json state,mergeable,statusCheckRollup
```

### 4. 评审与合并

```sh
gh pr review <N> --approve            # 三态：--approve / --request-changes / --comment
gh pr merge <N> --squash --delete-branch   # 本仓 delete_branch_on_merge=false ⇒ 必须带 --delete-branch
```

合并前读仓库设置（R11，本仓实测值见 `references/operations.md` §5）：

```sh
gh api repos/xuanyuanchumo/dsh-anic --jq \
  '{s:.allow_squash_merge,r:.allow_rebase_merge,d:.delete_branch_on_merge,a:.allow_auto_merge}'
# → {"s":true,"r":true,"d":false,"a":false}：三法可用；不自动删分支；--auto 不可用
```

### 5. 确定性自检

```sh
# 校验模板必填字段 + gh 可用性（只读）
node assets/skills/github-pr-actions/scripts/pr-check.mjs <workspace>

# 采集证据：dist 新鲜度 / 测试报告 / 覆盖率 / 工作区状态（只读）
node assets/skills/github-pr-actions/scripts/evidence-collect.mjs <workspace> [--out .cycles/evidence.md]
```

## 三、导航索引

| 需要了解 | 读取 |
|---|---|
| PR 全流程操作手册（建/评/合/重跑） | `references/operations.md` §1-§4 |
| PR 生命周期 / review 语义 / 合并三法连带后果 / 合并队列 | `references/operations.md` §5-§7 |
| CI 红分诊、模板字段缺失、gh 未认证等 | `references/troubleshooting.md` |
| 模板必填字段 + gh 可用性守卫 | `scripts/pr-check.mjs` |
| 合并前证据采集 | `scripts/evidence-collect.mjs` |
| 脚本调用契约 | `scripts/README.md` |
| PR 模板原文 | `.github/PULL_REQUEST_TEMPLATE.md` |
| CI 触发面/依赖顺序 | `.github/workflows/ci.yml:9-14,60-73` |

## 四、边界

- 不做真实凭据操作：`gh` 认证由 `gh auth login` 或 DSH 凭证库完成，脚本只做可用性检查。
- 不自动合并：合并是 R01 人类门，脚本只报告 CI/门禁状态。
- 不替代 `ci-cd-release` 技能：本技能管 PR 层，workflow 设计与回滚矩阵由 `ci-cd-release` 承载。
