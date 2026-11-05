# gitee-mirror-sync · 故障排查

> 常见失败模式 + 修复。**注意**：Gitee 部分属通用知识，修复前先确认实测结论
> （见 `references/operations.md` §9）。

## T1. `gitee` remote 不存在

**症状**：`mirror-sync.mjs` / `drift-check.mjs` 退出码 2，报 `remote 'gitee' not found`。

**根因**：本仓默认只有 `origin`（GitHub SSH）；Gitee remote 需显式添加。

**修复**：
```sh
git remote add gitee https://gitee.com/<owner>/<repo>.git   # 或 SSH 形态
git remote -v
```

## T2. push 被拒：`Authentication failed` / `401`

**症状**：`git push gitee ...` 报认证失败；`curl` 调 API 返回 401。

**根因**：【通用知识】Gitee 凭据未配置或鉴权头不对（Gitee 惯例是
`Authorization: token <TOKEN>`，不是 `Bearer`；以官方文档为准）。

**修复**：
```sh
# git 凭据（HTTPS 形态）：
git config --global credential.helper manager   # Windows Git Credential Manager
# API（curl）：
GITEE_TOKEN=<vault 注入> curl -sS https://gitee.com/api/v5/repos/<owner>/<repo> \
  -H "Authorization: token ${GITEE_TOKEN}"
# 或改用 SSH 形态：git remote set-url gitee git@gitee.com:<owner>/<repo>.git
```

> 令牌只经环境变量注入，**绝不**写进命令行/文件/日志（R2）。

## T3. push 被拒：`non-fast-forward` / `! [rejected]`

**症状**：镜像同步报 `failed to push some refs to 'gitee'`，提示非快进。

**根因**：Gitee 侧已有 GitHub 没有的提交（双写分叉或历史重写）。

**修复**：
1. 先 `drift-check.mjs` 定位分叉分支。
2. 确认 Gitee 侧无需保留后，用 refspec 全量覆盖（脚本默认即 `+refs/heads/*:refs/heads/*`）。
3. **禁止** `git push --force gitee master`（改写远端历史）。

## T4. 漂移检测报 `source-only` / `shared-diverged`

**症状**：`drift-check.mjs` 退出码 1，列出差异分支。

**根因**：镜像未同步，或 Gitee 侧有额外提交。

**修复**：
```sh
node assets/skills/gitee-mirror-sync/scripts/mirror-sync.mjs <workspace> --dry-run
node assets/skills/gitee-mirror-sync/scripts/mirror-sync.mjs <workspace>
node assets/skills/gitee-mirror-sync/scripts/drift-check.mjs <workspace>
```

漂移清单是证据（R4），写入评估/复盘记录。

## T5. 建 MR 报 404 / 字段未知

**症状**：`POST /repos/{owner}/{repo}/pulls` 返回 404 或 `field not found`。

**根因**：【通用知识】Gitee MR 端点命名可能是 `pulls` 或 `merge_requests`；字段名
（`source_branch`/`target_branch` vs `head`/`base`）随版本变化。

**修复**：先查 Gitee 官方 API 文档，再试：
```sh
curl -sS "https://gitee.com/api/v5/repos/<owner>/<repo>/pulls?state=all" \
  -H "Authorization: token ${GITEE_TOKEN}"
```
确认端点可用后再建 MR。**不要**凭记忆反复试错后把不确定写进本技能。

## T6. Gitee 网络不可达 / 超时

**症状**：`git ls-remote gitee` 超时；`curl` 连接被重置。

**根因**：【通用知识】Gitee 域名在部分网络环境下可达性不同；代理/防火墙可能拦截。

**修复**：
```sh
git ls-remote gitee        # 诊断
# 代理：设置 GIT_SSL_NO_VERIFY 之外的正向代理；或改用 SSH
ssh -T git@gitee.com       # 【通用知识】Gitee SSH 端口 22
```

## T7. 令牌出现在日志里

**症状**：命令行/CI 日志出现明文 Gitee token。

**根因**：违反 R2（令牌不出库）。

**修复**：
1. 立即在 Gitee 撤销该令牌并轮换。
2. 改用 `vault_run` 注入（`env` 注入子进程，不进命令行/日志）。
3. 检查历史提交与 CI 日志，确认未落盘。

## T8. 收录条目 url 不一致 / 数字夸大被打回

**症状**：`data/plugins/*.yml` PR 被维护者打回。

**根因**：【仓实证】`url` 必须与仓库完全一致；描述数字必须与代码核实一致
（`docs/agents/CI-CD与发布流程.md:102-106`）。

**修复**：
```sh
grep -rho "name: 'anic_[a-z_]*'" src/host/tools*.ts | sort -u | wc -l   # → 24
# 同步 README 与 `docs/agents/marketplace-提交草稿.md:11-26` 的数字
```

## T9. `--mirror` 误删本地 refs

**症状**：本地分支/tag 被意外删除。

**根因**：`git push --mirror` 会删除 target 上不存在于 source 的 refs；若 source/target
指向同一仓库，会自伤。

**修复**：脚本默认只推 `refs/heads/*` 与 `refs/tags/*`；确需 `--mirror` 前先用
`--dry-run` 预览；本地 ref 丢失用 `git reflog` 恢复（通用 Git）。

## T10. Gitee 侧分支保护拒绝删除/推送

**症状**：push 被拒，提示受保护分支。

**根因**：【通用知识】Gitee 仓库可设置分支保护。

**修复**：在 Gitee 仓库设置中调整保护规则，或改推非保护分支；涉及主干需人工批准。

## 三态裁决

- `PASS`：镜像一致且有 `git ls-remote` 输出证据。
- `FAIL`：存在漂移或远端缺失。
- `SKIP`：Gitee 凭据/网络不可用；**SKIP 不是 PASS**，需说明原因。
