# ci-cd-release · 故障排查

> 失败模式 → 根因 → 修复。每条都标注证据出处。按「先定位、再修复、后复验」顺序执行。

## 1. CI 红：按四件套顺序定位

**症状**：CI 在某个步骤失败，日志看不出是哪一层。

**根因**：四件套顺序即依赖（R01），上层失败会掩盖下层。

**修复**：按 `Build → Typecheck → Lint → Test` 顺序逐层看；测试报告在
`.cycles/cycles/*/test-reports/`，由 `upload-artifact` 上传，14 天保留
（`.github/workflows/ci.yml:66-73,129-140`）。

**复验**：`pnpm run typecheck && pnpm run test && pnpm run build` 本地全绿后再推。

## 2. coverage 0.4s 退出 2，Test 层全 ENOENT

**症状**：`coverage seeding failed`，Test 层全部 ENOENT。

**根因**：`coverage.mjs` 读 `.cycles/config.yml`，而 `.cycles/` 被 gitignore 不随检出；
`init-cycle` 未先跑（`ci.yml:78-86` 注释，run 41869380778 实录）。

**修复**：播种顺序必须是 `init-cycle → 四门锚点 → coverage → generate-snapshot → workflow-state`。
不要把 `init-cycle` 挪到 coverage 之后。

## 3. `ANIC_SELF_AUDIT` 只在 Test 步骤设置，coverage 仍红

**症状**：coverage 3s 退出非 0，但 Test 层设了 `ANIC_SELF_AUDIT=0`。

**根因**：coverage.mjs 内部再起一次 vitest（播种步骤里），job 级 env 才能覆盖
（`ci.yml:29-33` 注释，run 41877723121 实录）。

**修复**：`ANIC_SELF_AUDIT: '0'` 必须在 **job 级** `env:`，不是 step 级。

## 4. `pnpm install` 把宿主整棵树拖进 CI（~824 包）

**症状**：CI 安装体积爆炸、时间超限。

**根因**：误设 `autoInstallPeers=true`。peer 设置住在 `pnpm-workspace.yaml`，需要 pnpm ≥10.13
（`docs/agents/CI-CD与发布流程.md:40-41`）。

**修复**：保持 `autoInstallPeers=false`（`.github/workflows/ci.yml:54-58`）；pnpm 锁 `version: 11`。

## 5. release：tag 与 version 不一致

**症状**：`tag 'vX.Y.Z' 与 package.json version 'W.X.Y' 不一致`。

**根因**：改了 `package.json.version` 却没同步 tag，或 tag 手误。

**修复**：`release.yml:59-68` 是硬校验，不猜。改回一致；版本号唯一事实源是
`package.json.version`（`docs/agents/CI-CD与发布流程.md:47`）。

## 6. release：CHANGELOG 没有该版本段落

**症状**：`CHANGELOG.md 中没有 vX.Y.Z 的版本段落`。

**根因**：改 version 时未同轮改 CHANGELOG（v0.55.2 cycle-103 确立的纪律，
`docs/agents/CI-CD与发布流程.md:48-49`）。

**修复**：在 CHANGELOG 顶部加 `## vX.Y.Z — <date>（cycle-N：…）` 段落；release notes 直接从这里抽。

## 7. release：Build 在 coverage 之前失败

**症状**：`dshConformance` 的 dist 契约 C9/C10 红。

**根因**：顺序错误。`dshConformance` 要求 dist 已存在；coverage 不依赖 dist。
正确顺序是 **Build 先于播种的 coverage**（run 41901601533 实录修正，`release.yml:82-103`）。

**修复**：把 `pnpm run build` 移到 `Seed self-audit prerequisites` 之前。

## 8. marketplace tarball URL 404

**症状**：下一版发布后旧 tarball URL 404。

**根因**：`pnpm pack` 默认文件名带版本号（`dsh-anic-0.55.2.tgz`），URL 随版本变化。

**修复**：重命名为稳定名 `dsh-anic.tgz` + `dsh-anic.tgz.sha256`（`release.yml:117-125`；
`docs/agents/CI-CD与发布流程.md:65-67`）。

## 9. marketplace 描述数字被维护者打回

**症状**：PR 被拒，理由是描述与代码不符。

**根因**：夸大是唯一会被打回的原因（`docs/agents/CI-CD与发布流程.md:102`）。

**修复**：数字必须 `grep` 核实：

```sh
grep -rho "name: 'anic_[a-z_]*'" src/host/tools*.ts | sort -u | wc -l   # → 24
```

改面（加/减工具）必须同步 README 数字与 `readmeNumbers.test.ts` 契约
（`docs/agents/CI-CD与发布流程.md:49,105`）。

## 10. `git push` 报 `Connection was reset` / timeout

**症状**：Windows 本地推不动，但 `gh` API 正常。

**根因**：github.com 443 直连被重置，SSH 443 通（cycle-104 实测，
`docs/agents/CI-CD与发布流程.md:121-126`）。

**修复**：remote 用 SSH 形态 `git@github.com:xuanyuanchumo/dsh-anic.git`；
自检 `ssh -T git@github.com` → `Hi <user>!`。详见 `token-ssh-security` 技能。

## 11. 回滚失败

| 场景 | 症状 | 修复 |
|---|---|---|
| npm 版本损坏 | registry 无法删除 | `npm deprecate dsh-anic@X.Y.Z "reason"`，发修复版（npm 政策不真删） |
| Release 附件错误 | 附件版本不对 | `gh release delete vX.Y.Z --yes && git push origin :refs/tags/vX.Y.Z`，修好重推 |
| master 坏提交 | 主干有错 | `git revert <bad-commit>` 保历史；**禁止 force-push 主干** |
| 宿主插件损坏 | 运行中报错 | `anic_reload_self` 热重载或重装插件包 |

证据：`docs/agents/CI-CD与发布流程.md:112-119`。

## 12. npm publish 报 `Cannot read properties of null (reading 'prerelease')`

**症状**：`vault_run npm publish` 失败。

**根因**：`vault_run` 默认 cwd 是 desktop profile，读错 `package.json`
（cycle-104 实测，`docs/agents/CI-CD与发布流程.md:82-84`）。

**修复**：让 npm 进程 cwd 落在项目目录（包装脚本 `execFileSync` 指定 cwd）；
或用 `pnpm publish` 在项目目录执行。

## 13. npm 11 报认证失败 / `401`

**症状**：`npm publish` 401，环境里确实有 `NPM_TOKEN`。

**根因**：npm 11 不把裸 `NPM_TOKEN` 环境变量当凭据（cycle-104 实测，
`docs/agents/CI-CD与发布流程.md:85-87`）。

**修复**：仓库根放 `.npmrc-publish`（已 gitignore，`.gitignore:19-20`）写
`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`，发布时 `--userconfig .npmrc-publish`。

## 14. 新包首次发布后 registry 出现 `0.0.0-stage`

**症状**：`409 Cannot publish over previously staged version`。

**根因**：不是失败——官方 registry 新包要先过审核/传播队列
（`docs/agents/CI-CD与发布流程.md:88-90`）。

**修复**：等待审核窗口，不要反复重发；确认 package 元数据无误即可。

## 15. 定位纪律

- **先证据后结论**：每条结论引用 `file:line` 或 CI run 号，不凭印象。
- **不降级**：不为让 CI 变绿而放宽阈值、跳过步骤或删测试。
- **不假绿**：`--live` 在 CI 上显式跳过并说明原因（`ci.yml:8,76-77`），不是隐藏失败。
- **无证据 ≠ 通过**：测试报告缺失时按 SKIP 处理，不当作 PASS。
