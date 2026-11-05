# github-pr-actions · CHANGELOG

本技能遵循 dsh-anic 内部技能库三锚一致纪律：`SKILL.md` 版本标注、
`scripts/<primary>.mjs` 脚本版本串、本 CHANGELOG 顶层条目三处版本必须一致。

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
