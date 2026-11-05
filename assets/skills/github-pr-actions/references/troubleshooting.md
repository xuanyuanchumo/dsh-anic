# github-pr-actions · 故障排查

> 常见失败模式 + 修复。引用 `.github/PULL_REQUEST_TEMPLATE.md`、`.github/workflows/ci.yml`。

## T1. PR 被要求补证据（「没有粘输出」）

**症状**：评审人回复要求贴命令输出；`pr-check.mjs` 报证据段缺失。

**根因**：PR 模板 `:20` 明文「没有粘输出的『已通过』不算证据」。

**修复**：把 `pnpm run typecheck` / `lint` / `test` 的关键输出粘进「验证证据」，
含 `=== 测试汇总 ===` 表（`PULL_REQUEST_TEMPLATE.md:22-31`）。

## T2. CI 红了但本地绿

**症状**：本地 `pnpm run test` 全绿，CI Test 层失败。

**根因**（多为 seed 步骤，见 `ci.yml:78-123` 注释）：
1. CI 全新检出没有 `.cycles/`（gitignore），`coverage.mjs` 读 `config.yml` 0.4s exit 2。
2. `ANIC_SELF_AUDIT=0` 只设在 Test 步骤级，`coverage.mjs` 内部再起 vitest 拿不到开关。
3. `generate-snapshot` 重写 artifacts 后没有重建 dist，smoke 断言「dist 渲染 == artifacts」失败。
4. 自指/真实数据面契约在新检出上结构性不满足（需 job 级 `ANIC_SELF_AUDIT=0`）。

**修复**：确认 `ci.yml:88-123` 的 seed 链与 job 级 env；本地模拟全新检出重跑。

## T3. Build 先于 lint/test 的顺序错了

**症状**：lint 报 dist 不存在（C9/C10），或 smoke `readFileSync dist/client.js` ENOENT。

**根因**：`ci.yml:60-65` 注释——build 必须先于 lint/test；`dist/` 在 `.gitignore:2`，CI 必须自建。

**修复**：调整步骤顺序为 Build → Typecheck → Lint → Test（`ci.yml:66-73`）。

## T4. 工具/路由数字不同步

**症状**：`tests/contract/readmeNumbers.test.ts` 契约红；marketplace 草稿数字被维护者打回。

**根因**：PR 模板 `:54-56` 要求改工具注册面/HTTP 路由数量时同步 README 数字与
`docs/agents/marketplace-提交草稿.md`；CD 手册 `:102-106` 要求描述数字与代码核实一致。

**修复**：
```sh
grep -rho "name: 'anic_[a-z_]*'" src/host/tools*.ts | sort -u | wc -l   # → 24
# 同步 README 与 marketplace 草稿，再跑契约测试
pnpm run test
```

## T5. gh 未认证 / 找不到 PR

**症状**：`gh pr view` 报 `could not find a PR` 或 auth 错误。

**根因**：`gh` 未登录，或当前目录不在仓库内，或 PR 编号错误。

**修复**：
```sh
gh auth status                 # 未登录则 gh auth login
gh pr list --state all        # 确认编号
# 令牌替代：DSH 凭证库 vault_run gh ...（明文不落盘）
```

## T6. Windows 上 `gh pr` 网络失败

**症状**：`gh` API 正常但 `git push` 报 `Connection was reset`。

**根因**：见 `git-branch-workflow` 技能 T5——github.com 443 直连被重置（CD 手册 `:123-125`）。

**修复**：remote 改 SSH 形态（CD 手册 `:124-125`）。

## T7. 模板字段缺失

**症状**：`pr-check.mjs` 报 missing section: 门禁状态 / 破坏性变更 / ...。

**根因**：模板必填小节（PR 模板 `:1-82`）。

**修复**：逐节补齐；无破坏性变更也要写「无」（`PULL_REQUEST_TEMPLATE.md:62`）。

## T8. 合并后忘了删分支

**症状**：远端残留 `feat/...` 分支，CD 手册要求「合并即删」。

**修复**：
```sh
git branch -d feat/<域>-<主题>
git push origin --delete feat/<域>-<主题>
```

## T9. 评审发现没有 file:line

**症状**：评审意见被驳回，要求具体位置。

**根因**：主干 R11 要求每条发现引用 `file:line` + 具体证据。

**修复**：重写发现，给出路径+行号+影响；每轮 nit ≤5。

## 三态裁决

本技能检查遵循「无证据 ≠ 通过」（主干 R05）：
- `PASS`：字段齐备且有输出证据。
- `FAIL`：字段缺失或 CI 非绿。
- `SKIP`：`gh` 不可用且用 `--offline`；**SKIP 不是 PASS**，需在 PR 中说明原因。
