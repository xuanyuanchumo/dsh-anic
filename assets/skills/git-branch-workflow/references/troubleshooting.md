# git-branch-workflow · 故障排查

> 常见失败模式 + 修复。所有命令在本仓（Windows / git for Windows）实测。

## T1. 分支名不符合四类规则

**症状**：`branch-lint.mjs` 报 `branch 'feature/x' does not match ...`，或 CI 触发面不覆盖该分支
（`ci.yml:11`）。

**根因**：分支名必须落在 `master` / `feat/...` / `fix/...` / `chore/...`（CD 手册 `:10-13`）。
`feature/x`、`bugfix/x`、`hotfix/x` 都不在规则内。

**修复**：
```sh
git branch -m feature/x feat/x       # 本地改名（未推送时）
git push origin -f feat/x && git push origin --delete feature/x   # 已推送时
```

## T2. commit 类型不在六类内

**症状**：`branch-lint.mjs` 报 `commit subject not conventional: ...`。

**根因**：CD 手册 `:24` 只列 `feat`/`fix`/`docs`/`refactor`/`test`/`chore`/`v<版本号>`。
`update`、`change`、`wip`、`abc123` 都不合规。

**修复**：按语义归类后改写（未推送用 `git commit --amend`）：
```sh
git commit --amend -m "docs(skills): 说明分支四类规则"
```

## T3. 版本收口提交格式错误

**症状**：`branch-lint.mjs` 把 `v0.56.0 cycle-104: ...` 判为不合规（若脚本未识别版本收口形态）。

**根因**：版本收口是六类之外的特殊形态，正则必须同时接受
`v\d+\.\d+\.\d+ cycle-\d+:`（CD 手册 `:25`）。

**修复**：见 `branch-lint.mjs` 的 `classify()` 实现；若你的脚本版本较旧，升级到本技能 v0.1.0。

## T4. push 主干被拦 / 本地验证不过

**症状**：`pre-push-verify.mjs` 报 `master push blocked` 或 `package.json scripts missing`。

**根因**：R3 主干只进验证过的提交（CD 手册 `:16`）；`package.json` 必须声明
`typecheck`/`test`/`build` 三个 scripts（`package.json:91-111`）。

**修复**：
```sh
pnpm run typecheck && pnpm run test && pnpm run build
# 确认三个 scripts 存在：
node -e "const s=require('./package.json').scripts; console.log(s.typecheck,s.test,s.build)"
```

## T5. `git push` 报 `Connection was reset` / timeout

**症状**：HTTPS push 被重置，`gh` API 正常。

**根因**：github.com 443 直连被重置（CD 手册 `:123-124`）。

**修复**：改用 SSH remote（CD 手册 `:124-125`）：
```sh
git remote set-url origin git@github.com:xuanyuanchumo/dsh-anic.git
ssh -T git@github.com        # Hi <user>! 即通
```

## T6. 非主干分支想重写历史

**症状**：需要 amend / rebase 已推送的 `feat/` 分支。

**处理**：非主干允许 `git push --force-with-lease origin <branch>`（通用）；
**主干绝不 force-push**（CD 手册 `:118`），用 `git revert`。

> `--force-with-lease` 比 `--force` 安全：远端有他人新提交时拒绝推送。

## T7. `git branch -d` 拒绝删除

**症状**：`error: branch 'feat/x' not fully merged`。

**根因**：该分支有主干没有的提交（尚未合并）。

**修复**：先合并或 revert，再删；确认无需保留后用 `git branch -D`（危险，仅非主干）。

## T8. `worktree` 产物污染评估

**症状**：eval 源码扫描突然「文件数暴增 / 变化率异常」。

**根因**：worktree 落在仓库内（如 `.agents/worktrees/`）被当成项目源码（`.gitignore:13-17` 注释实录）。

**修复**：worktree 建在仓库外（`../`）；`.agents/` 已在 `.gitignore`；必要时
`git worktree prune` 清理注册表。

## T9. 版本号改了但 CHANGELOG 没动

**症状**：`release.yml` 的 `Verify CHANGELOG has this version` 步骤红（`release.yml:72-79`）。

**根因**：版本锚点同步纪律（CD 手册 `:48`）：改 `version` 必须同轮改 CHANGELOG 的 `## vX.Y.Z` 段。

**修复**：
```sh
# 确认段落存在：
grep -nE "^#{2,3}[[:space:]]*v${PKG_VERSION//./\\.}([[:space:]]|$)" CHANGELOG.md
# 补写段落后重跑 release-check（见 npm-publish 技能）
```

## T10. 脚本报「workspace 不存在 / 不是 git 仓库」

**症状**：`branch-lint.mjs` 退出码 2 并打印 `workspace not found`。

**根因**：第一位置参数必须是项目目录（`<workspace>`），且必须是 git 仓库根。
本仓所有技能脚本都遵循「第一位置参数 = 项目目录」契约（跨项目调用契约）。

**修复**：
```sh
node assets/skills/git-branch-workflow/scripts/branch-lint.mjs D:\Projects\TraeProjects\dsh-anic
```

## 三态裁决

本技能所有检查遵循「无证据 ≠ 通过」（主干 R05）：
- `PASS`：检查通过且有输出证据。
- `FAIL`：检查不通过。
- `SKIP`：检查未执行（如非 git 仓库、参数缺失）。**SKIP 不是 PASS。**
