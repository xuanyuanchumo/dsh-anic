# gitee-mirror-sync · CHANGELOG

本技能遵循 dsh-anic 内部技能库三锚一致纪律：`SKILL.md` 版本标注、
`scripts/<primary>.mjs` 脚本版本串、本 CHANGELOG 顶层条目三处版本必须一致。

## v0.1.0 — 2026-11-05

### 新增（从零新建）

- **SKILL.md**：GitHub↔Gitee 镜像与 MR 同步操作手册；硬规则 R1-R8（先实证再操作 /
  令牌不出库 / 默认单向 / 漂移即证据 / 收录数字核实 / 收录文件唯一 / 不动本仓 remote /
  不触碰生产凭据）；快速启动；导航索引。
- **references/operations.md**：镜像策略三模式、Gitee 远端形态、Gitee API v5 与令牌、
  镜像同步、漂移检测、MR 与 Issue 模板同步、`data/plugins/*.yml` 收录、中文协作面差异、
  **§9 实测校验清单**。
- **references/troubleshooting.md**：T1-T10 失败模式与修复（remote 缺失 / 鉴权失败 /
  non-fast-forward / 漂移 / MR 404 / 网络不可达 / 令牌泄露 / 收录被打回 / --mirror 误删 /
  分支保护）。
- **scripts/mirror-sync.mjs**：fetch + push refs 同步；`--dry-run` 预演；`--mirror`/`--prune`；
  退出码 0/1/2。
- **scripts/drift-check.mjs**：比较 source/target 的 `refs/heads/*` SHA，输出
  diverged/source-only/target-only 清单；只读；退出码 0/1/2。
- **scripts/README.md**：位置参数契约、退出码、安全声明、Gitee 零覆盖声明。

### 知识来源（诚实分级）

- **【仓实证】**：本仓 Gitee 零覆盖（`docs/anic/25-原生优化与内部技能库研究.md:330`）；
  本仓 remote 仅 GitHub SSH（本机 `git remote -v`）；凭证库含 `gitee` 令牌
  （`docs/anic/25:331`）；awesome-dsh-plugin 收录规则
  （`docs/agents/marketplace-提交草稿.md:8-26`、`docs/agents/CI-CD与发布流程.md:99-110`）。
- **【通用知识】**：Gitee API v5 基址、鉴权头、MR 端点、Gitee CLI/凭据形态、
  中文协作面差异——均标注「待实测校验」，并在 `references/operations.md` §9 提供
  实测清单；动手前必须先核验，不得当作既成事实。

### 边界

- 不包含任何 Gitee 令牌；脚本只做 git refs 操作，API 调用由操作者按文档执行。
- 不做 API 调用（遵守叶技能脚本「仅 node:fs/child_process/path」约束）。
- 不自动删除远端 refs；`--mirror` 需人工确认。
