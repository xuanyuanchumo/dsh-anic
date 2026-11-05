# npm-publish · 故障排查

> 失败模式 → 根因 → 修复 → 复验。每条都标注证据出处。按「先定位、再修复、后复验」顺序执行。
> 三条 npm 发布实测坑位（cycle-104）单独列于 §10-§12，是最高频失败。

## 1. tag 与 version 不一致

**症状**：`tag 'vX.Y.Z' 与 package.json version 'W.X.Y' 不一致`。

**根因**：改了 `package.json.version` 却没同步 tag，或 tag 手误。

**修复**：`release.yml:59-68` 是硬校验，不猜。改回一致；版本号唯一事实源是
`package.json.version`（`docs/agents/CI-CD与发布流程.md:47`）。

**复验**：`node scripts/release-check.mjs . vX.Y.Z` 退出 0。

## 2. CHANGELOG 没有该版本段落

**症状**：`CHANGELOG.md 中没有 vX.Y.Z 的版本段落`。

**根因**：改 version 时未同轮改 CHANGELOG（v0.55.2 cycle-103 确立的纪律，
`docs/agents/CI-CD与发布流程.md:48-49`）。

**修复**：在 CHANGELOG 顶部加 `## vX.Y.Z — <date>（cycle-N：…）` 段；release notes 直接从这里抽。

## 3. `Cannot read properties of null (reading 'prerelease')`

**症状**：`vault_run npm publish` 报此错。

**根因**：`vault_run` 默认 cwd 是 desktop profile，读错 `package.json`
（cycle-104 实测，`docs/agents/CI-CD与发布流程.md:82-84`）。

**修复**：让 npm 进程 cwd 落在项目目录——用包装脚本 `execFileSync` 指定 `cwd`，或用
`pnpm publish` 在项目目录执行（见 `references/operations.md` §5.2）。

**复验**：包装脚本路径下 `npm publish` 不再报 null。

## 4. npm 11 报认证失败 / `401`

**症状**：`npm publish` 401，环境里确实有 `NPM_TOKEN`。

**根因**：npm 11 不把裸 `NPM_TOKEN` 环境变量当凭据（cycle-104 实测，
`docs/agents/CI-CD与发布流程.md:85-87`）。

**修复**：仓库根放 `.npmrc-publish`（已 gitignore，`.gitignore:19-20`）写
`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`，发布时 `--userconfig .npmrc-publish`。

## 5. 新包首次发布后 registry 出现 `0.0.0-stage` / `409`

**症状**：`409 Cannot publish over previously staged version`。

**根因**：不是失败——官方 registry 新包要先过审核/传播队列（`docs/agents/CI-CD与发布流程.md:88-90`）。

**修复**：等待审核窗口，**不要反复重发**；确认 package 元数据无误即可。

## 6. marketplace tarball URL 404

**症状**：下一版发布后旧 tarball URL 404。

**根因**：`pnpm pack` 默认文件名带版本号（`dsh-anic-0.55.2.tgz`），URL 随版本变化
（`release.yml:114-125`；`docs/agents/CI-CD与发布流程.md:65-67`）。

**修复**：重命名为稳定名 `dsh-anic.tgz` + `dsh-anic.tgz.sha256`。

**复验**：`node scripts/pack-stable.mjs .` 显示 `STABLE`。

## 7. `files` 缺项导致发布物缺文件

**症状**：安装后缺 `dist/`、`locale/`、`assets/` 等。

**根因**：`package.json.files` 未覆盖发布必需项（`package.json:36-46`）。

**修复**：补齐 `dist/ assets/skill/ assets/skills/ assets/index/ bin/ locale/ icon.svg cordis.patch.yml README.md LICENSE`；
用 `release-check.mjs` 的 C3 项核对。

## 8. `.npmrc-publish` 被提交

**症状**：`release-check.mjs` 报 `.npmrc-publish 已被 git 跟踪`。

**根因**：凭据占位符文件误入版本库。

**修复**：`git rm --cached .npmrc-publish`，确认 `.gitignore:19-20` 有忽略条目，**不要**删除磁盘文件
（它是发布时的 `--userconfig` 输入）；轮换该令牌。

## 9. 回滚失败（想删版本）

**症状**：registry 无法删除版本。

**根因**：npm 政策不真删（`docs/agents/CI-CD与发布流程.md:114-116`）。

**修复**：`npm deprecate dsh-anic@X.Y.Z "reason"` + 发修复版；Release 附件错误则
`gh release delete vX.Y.Z --yes && git push origin :refs/tags/vX.Y.Z`。

## 10. Windows 本地推不动（`Connection was reset`）

**症状**：`git push` 报 `Connection was reset` / timeout，但 `gh` API 正常。

**根因**：github.com 443 直连被重置，SSH 443 通（cycle-104 实测，
`docs/agents/CI-CD与发布流程.md:121-126`）。

**修复**：remote 用 SSH 形态 `git@github.com:xuanyuanchumo/dsh-anic.git`；
自检 `ssh -T git@github.com` → `Hi <user>!`。详见 `token-ssh-security` 技能。

## 11. `release-check.mjs` 退出 2

**症状**：脚本报「只接受 1..2 个位置参数」或「项目目录不存在」。

**根因**：位置参数契约被破坏——项目目录不在 `args._[0]`，或传了 `--project-dir` 旗标。

**修复**：`node release-check.mjs <project-dir> [tag] [--report]`；经网关调用时
`workspace` 参数即项目目录（见 `scripts/README.md`）。

## 12. `pack-stable.mjs` 报命名违规

**症状**：`[pack-stable] 命名违规：产物必须重命名为 dsh-anic.tgz`。

**根因**：`.pack/` 或项目根存在版本名 tarball（`dsh-anic-0.56.0.tgz`）而稳定名未就位。

**修复**：`cp dsh-anic-0.56.0.tgz dsh-anic.tgz` 后重跑 `pack-stable.mjs`。

## 13. 定位纪律

- **先证据后结论**：每条结论引用 `file:line` 或 CI run 号，不凭印象。
- **不降级**：不为让发布变绿而放宽校验、跳过步骤或删 CHANGELOG 段落。
- **不假绿**：`409 staged` 按「已在队列」处理，不当作成功也不反复重发。
- **无证据 ≠ 通过**：`--report` 输出 `passed:false` 时按未通过处理。

## 14. 常见命令速查

```sh
# 发布卫生（只读）
node assets/skills/npm-publish/scripts/release-check.mjs . vX.Y.Z

# 稳定名计划（不跑 pnpm pack）
node assets/skills/npm-publish/scripts/pack-stable.mjs .

# 本地发布（人类授权 + vault_run 注入令牌 + 包装脚本钉 cwd）
vault_run node publish-npm-local.mjs D:\Projects\TraeProjects\dsh-anic

# 回滚
npm deprecate dsh-anic@X.Y.Z "reason"
```
