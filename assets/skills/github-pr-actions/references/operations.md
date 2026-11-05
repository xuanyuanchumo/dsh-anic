# github-pr-actions · 操作手册

> 详细操作手册。引用 `.github/PULL_REQUEST_TEMPLATE.md`（下称 PR 模板）、
> `.github/workflows/ci.yml`、`docs/agents/CI-CD与发布流程.md`（下称 CD 手册）。

## 0. 事实锚点（本仓实证）

| 事实 | 值 | 证据 |
|---|---|---|
| 证据纪律 | 「没有粘输出的『已通过』不算证据」 | `PULL_REQUEST_TEMPLATE.md:20` |
| 模板必填小节 | 变更摘要 / 关联循环 / 变更类型 / 验证证据 / 门禁状态 / 变更范围 / 破坏性变更 / 自查清单 / 人类判断门 | `PULL_REQUEST_TEMPLATE.md:1-82` |
| CI 依赖顺序 | build → typecheck → lint → test | `ci.yml:60-73` |
| CI 触发面 | push 到 `master`/`feat/**`/`fix/**`/`chore/**` + 所有 PR | `ci.yml:9-14` |
| CI 不跑 `--live` | 真实宿主 E2E 需本机 DSH 桌面端 + Chrome，CI 不具备——显式跳过 | `ci.yml:6-8,76` |
| 四件套 seeding | init-cycle → 四门 anchor → coverage → snapshot → workflow-state → 重建 dist | `ci.yml:88-123` |
| 合并前置 | PR 必须 CI 全绿方可合并 | `PULL_REQUEST_TEMPLATE.md:82` |
| 数字同步 | 工具/路由数变化须同步 README 数字与 marketplace 草稿 | `PULL_REQUEST_TEMPLATE.md:54-56` |
| 自查项 | G-IND / ≤250 行 / `t()` / dist 未提交 / 无令牌 | `PULL_REQUEST_TEMPLATE.md:64-70` |

## 1. 建 PR 前

### 1.1 分支与本地验证

按 `git-branch-workflow` 建分支，然后按 `ci.yml:60-73` 的顺序本地跑：

```sh
pnpm run build        # 先 build：lint C9/C10 检查 dist/，smoke 读 dist/client.js
pnpm run typecheck
pnpm run lint
pnpm run test         # 不加 --live（CI 同样不加）
```

### 1.2 生成 PR 正文

用模板逐节填写（PR 模板 `:1-82`）。**验证证据**必须贴命令与关键输出，例如：

```text
$ pnpm run typecheck
（粘贴输出）

$ pnpm run test
（粘贴输出，含最后的 === 测试汇总 === 表）
```

门禁状态表（`PULL_REQUEST_TEMPLATE.md:40-45`）：

| 门禁 | 结果 | 备注 |
|---|---|---|
| G0 评估收敛门 | PASS / FAIL / N/A | |
| G1 任务收敛门 | PASS / FAIL / N/A | |
| G2 测试收敛门 | PASS / FAIL / N/A | |
| G3 构建收敛门 | PASS / FAIL / N/A | |

## 2. gh CLI 操作

### 2.1 创建

```sh
gh pr create --base master --title "feat(host): add anic_skill_lib_status" \
  --body-file .cycles/pr-body.md
```

### 2.2 查看状态

```sh
gh pr view <N> --json number,title,state,mergeable,statusCheckRollup
gh pr checks <N>
```

### 2.3 合并

```sh
gh pr merge <N> --squash --delete-branch    # 合并即删分支（CD 手册:11-13）
```

### 2.4 Issue

```sh
gh issue create --title "..." --body "..."
gh issue view <N>
```

> **令牌纪律**：`gh` 凭据走 `gh auth login` 或 DSH 凭证库（`vault_set`/`vault_run`，
> 明文永不落盘/入对话）。CI 里用 `GITHUB_TOKEN`（`release.yml:145`）。

## 3. CI 失败分诊

**顺序即依赖**（`ci.yml:60-73`）：先 build，再 typecheck，再 lint，再 test。

| 步骤 | 失败常见原因 | 修复方向 |
|---|---|---|
| Build | tsdown 打包错误；dist 未重建 | 看构建日志；`pnpm run build` |
| Typecheck | 双 tsconfig 编译错误；`noUncheckedIndexedAccess` | 修类型；注意 `stats[f.script]` 需本地变量收窄 |
| Lint | DSH 规范符合性门 C9/C10（dist 形状/语法） | 先 build 再 lint |
| Test | 四层金字塔任一层失败 | 看分层输出（validate/vitest/smoke/trigger） |

seed 步骤失败（`ci.yml:88-123`）的经典原因（均已在 CI 修复）：
- `init-cycle` 必须先于 `coverage.mjs`（`.cycles` 被 gitignore，coverage 读 `config.yml`）
- `gate-ledger` 四门 anchor 必须在 coverage 运行前落（native F2 在 coverage 运行内断言）
- `generate-snapshot` 后必须重建 dist（smoke 断言 dist 渲染 == artifacts 快照同源）
- `ANIC_SELF_AUDIT=0` 必须在 **job 级** env（coverage 内部再起 vitest，Test 步骤级 env 传不到）

## 4. 评审协议

主干 R11：每条发现必须引用 `file:line` + 具体证据，按严重度排序，**每轮最多 5 条 nit**。

```sh
gh pr checkout <N>
# 在 PR 上做行级评审（GitHub MCP 的 add_comment_to_pending_review / pull_request_review_write）
```

评审输出建议结构：
1. **阻塞项**（必须改）：含 `file:line` 与影响
2. **建议项**（≤5 条 nit）：措辞/命名/小重构
3. **确认项**：行为已正确的部分

## 5. 合并策略

- `--squash`：把分支历史压成一条提交，适合功能分支（主干历史线性）。
- `--rebase`：保留每个提交，适合小提交系列。
- `--merge`：保留分支结构。
- 合并前必须确认 CI 全绿（R3）与门禁表已填（R6）。

## 6. 确定性脚本

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `scripts/pr-check.mjs` | 校验 PR 模板必填小节 + `gh` 可用性；`--pr N` 时读 PR 状态 | `0` 通过 / `1` 缺失或 CI 非绿 / `2` 用法错误 |
| `scripts/evidence-collect.mjs` | 采集 dist 新鲜度 / 测试报告 / 覆盖率 / 工作区证据，输出 Markdown 清单 | `0` 证据齐 / `1` 缺证据 / `2` 用法错误 |

调用契约：

```sh
node assets/skills/github-pr-actions/scripts/pr-check.mjs <workspace> [--pr N] [--offline] [--json]
node assets/skills/github-pr-actions/scripts/evidence-collect.mjs <workspace> [--out <workspace-relative>] [--json]
```

## 7. 与主干技能的对接

本技能喂 G0-G3 门禁（`skills.index.json:44` gates = G0-G3）：PR 的门禁表、CI 状态、
评审证据都成为 `eval-runner` / `gate-check --record` 的输入；发布卫生由 `npm-publish` 承接。

## 8. 通用 Git 知识（非本仓实证）

以下为通用实践，非本仓实测，仅作参考：
- `gh pr merge --auto` 的自动合并需分支保护规则配合；本仓未启用。
- 行级评审的 diff 坐标（`startLine`/`line`/`side`）语义见 GitHub REST/GraphQL 文档。
