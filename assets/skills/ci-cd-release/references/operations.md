# ci-cd-release · 操作手册

> 本文是 `ci-cd-release` 叶技能的详细操作手册。所有命令与行号指向 dsh-anic 仓库实测事实。
> 读取时机：改 CI、发版、收录 marketplace、回滚时。

## 0. 仓库事实基座（抽验）

| 事实 | 值 | 证据 |
|---|---|---|
| 当前版本 | `0.56.0` | `package.json:3` |
| DSH 引擎范围 | `>=0.2.0-rc.2 <0.4.0-0` | `package.json:47-50` |
| peer | `@deepseek-ai/cordis ^4.0.1`；`@deepseek-ai/dsh` optional | `package.json:51-59` |
| Node 引擎 | `>=22.19` | `package.json:48` |
| 发布文件清单 | `dist/ assets/skill/ assets/index/ bin/ locale/ icon.svg cordis.patch.yml README.md LICENSE` | `package.json:36-46` |
| gitignore 白名单 | `!.cycles/config.yml`、`!.cycles/workflow-graph.yaml` | `.gitignore:5-6,21` |
| npmrc 保护 | `.npmrc-publish` 被忽略 | `.gitignore:19-20` |

## 1. 分支策略与提交规范

| 分支 | 用途 | 生命周期 |
|---|---|---|
| `master` | 主干，永远可安装可发布 | 永久 |
| `feat/<域>-<主题>` | 功能开发 | 合并即删 |
| `fix/<issue号>-<主题>` | 缺陷修复 | 合并即删 |
| `chore/<主题>` | 工程/文档 | 合并即删 |

证据：`docs/agents/CI-CD与发布流程.md:8-18`。

提交格式：`<type>(<scope>): <一句话结论>`，type ∈ `feat`/`fix`/`docs`/`refactor`/`test`/`chore`/`v<版本号>`。
版本收口提交以 `v0.X.Y cycle-N:` 开头，正文按领域列条目，每条写「改了什么——为什么/实证出处」
（`docs/agents/CI-CD与发布流程.md:22-25`）。

主干 push 前本地必须 `pnpm run typecheck && pnpm run test && pnpm run build` 全绿
（`CLAUDE.md:13`；`docs/agents/CI-CD与发布流程.md:16`）。

## 2. CI 工作流（ci.yml）逐项

### 2.1 触发面与并发

```yaml
on:
  push:
    branches: [master, 'feat/**', 'fix/**', 'chore/**']
  pull_request:
    branches: [master]
  workflow_dispatch:
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
```

证据：`.github/workflows/ci.yml:9-22`。

### 2.2 环境与依赖

- pnpm `version: 11`（`pnpm-workspace.yaml` 的 `autoInstallPeers` 需 pnpm ≥10.13 才被读取），
  `ci.yml:39-44`。
- Node `22`（`engines.node: >=22.19`），`ci.yml:46-52`。
- `pnpm install --frozen-lockfile`；**绝不** `autoInstallPeers=true`（会把宿主整棵树 ~824 包拖进 CI），
  `ci.yml:57-58`；`docs/agents/CI-CD与发布流程.md:40-41`。
- `ANIC_SELF_AUDIT: '0'` 是 **job 级** env（coverage.mjs 内部再起一次 vitest，
  只在 Test 步骤设 env 会让 coverage 拿不到开关照样红），`ci.yml:29-33`。

### 2.3 四件套顺序（R01）

```yaml
- name: Build            # ci.yml:66-67
- name: Typecheck        # ci.yml:69-70
- name: Lint             # ci.yml:72-73
- name: Test             # ci.yml:126-127
```

顺序即依赖：lint 的 C9/C10 检查 `dist/client.js`/`dist/host.js` 存在性，smoke 层直接
`readFileSync dist/client.js`，`deployFreshnessContract` 要求 dist 不旧于 src；`dist/` 在
`.gitignore:2`，CI 必须自建（`ci.yml:60-65`）。

### 2.4 测试分层

离线四层金字塔：`validate → vitest（单元+契约）→ smoke（stub 宿主）→ trigger`。
**不加 `--live`**：真实宿主 E2E 需本机 DSH 桌面端 + Chrome，CI 不具备——显式跳过并说明，不是假绿
（`ci.yml:8,76-77`；`docs/agents/CI-CD与发布流程.md:36-37`）。

### 2.5 播种五步（R10）

顺序敏感（v2 实测）：`coverage.mjs` 读 `.cycles/config.yml`，而 `.cycles/` 被 gitignore 不随检出，
**init-cycle 必须先跑**，否则 coverage 0.4s 退出 2 且 Test 层全 ENOENT（run 41869380778 实录）。

```sh
set -euo pipefail
node assets/skill/scripts/init-cycle.mjs .
for g in G0 G1 G2 G3; do
  node assets/skill/scripts/gate-ledger.mjs . --gate "$g" --result PASS --detail "CI seeded anchor"
done
if ! node scripts/coverage.mjs > coverage-seed.log 2>&1; then
  echo "::error::coverage seeding failed — failing tests and tail:"
  grep -E "× |FAIL |AssertionError|Error: |exit" coverage-seed.log | head -40 || true
  tail -30 coverage-seed.log
  exit 1
fi
tail -8 coverage-seed.log
node scripts/generate-snapshot.mjs
node assets/skill/scripts/workflow-state.mjs . check
pnpm run build   # generate-snapshot 重写了嵌入快照源，dist 必须与 artifacts 对齐
```

证据：`.github/workflows/ci.yml:88-123`。门锚点 G0-G3 全写（`gateToolMappingContract` 要求账本非空时
必须含全集，防「永不命中」型死键）。

### 2.6 artifact 上传

```yaml
- name: Upload test reports
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: test-reports
    path: |
      .cycles/cycles/*/test-reports/
      test-results/
    if-no-files-found: warn
    retention-days: 14
```

证据：`.github/workflows/ci.yml:129-140`。`.cycles/` 被 gitignore，必须显式上传才是可下载证据。

## 3. Release 工作流（release.yml）逐项

触发：push `v*` tag；或 `workflow_dispatch`（须显式传 `tag`）。权限 `contents: write` +
`id-token: write`（`release.yml:5-16`）。

### 3.1 两道前置硬校验

```sh
PKG_VERSION="$(node -p "require('./package.json').version")"
EXPECTED="v${PKG_VERSION}"
if [ "$TAG" != "$EXPECTED" ]; then ... exit 1; fi        # release.yml:59-68

grep -qE "^#{2,3}[[:space:]]*v${PKG_VERSION//./\\.}([[:space:]]|$)" CHANGELOG.md  # release.yml:72-79
```

### 3.2 发布四件套

`Build → Seed → Typecheck → Lint → Test`（release.yml:84-112）。顺序修正（run 41901601533 实录）：
**Build 必须在播种的 coverage 之前**——`dshConformance` 的 dist 契约（C9/C10）要求 dist 已存在，
coverage 不依赖 dist。

### 3.3 tarball 稳定名（R06）

```sh
rm -rf .pack && mkdir -p .pack
pnpm pack --pack-destination .pack
SRC="$(ls .pack/*.tgz | head -1)"
cp "$SRC" dsh-anic.tgz
sha256sum dsh-anic.tgz | tee dsh-anic.tgz.sha256
```

marketplace `tarball:` 字段要求 URL 不随版本变化；带版本名的 URL 下次发版就 404
（`docs/agents/CI-CD与发布流程.md:65-67`；`release.yml:114-125`）。

### 3.4 release notes 抽取

从 CHANGELOG 抽出该版本段落；抽不到回退到 tag 名，不编造内容（`release.yml:129-141`）。

### 3.5 创建 GitHub Release

```sh
gh release delete "$TAG" --yes --cleanup-tag=false 2>/dev/null || true
gh release create "$TAG" --title "$TAG" --notes-file release-notes.md --verify-tag \
  dsh-anic.tgz dsh-anic.tgz.sha256
```

证据：`release.yml:143-154`。`GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`。

### 3.6 npm publish（可选）

仅当 `NPM_TOKEN` 非空才执行；未配置 → 显式 skip，不是失败（`release.yml:156-168`）。

```sh
NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
pnpm publish --no-git-checks --access public --provenance
```

本地手动路径（令牌经 DSH 凭证库注入，明文永不落盘/入对话）：

```sh
npm publish --access public   # 经 vault_run npm 执行，cwd 必须落项目目录
```

## 4. npm 发布实测坑位（cycle-104，勿重踩）

1. `vault_run` 默认 cwd 是 desktop profile——在那里跑 publish 会读错 `package.json`，
   报 `Cannot read properties of null (reading 'prerelease')`。必须让 npm 进程 cwd 落在项目目录。
2. npm 11 **不**把裸 `NPM_TOKEN` 环境变量当凭据——需 `.npmrc-publish`（仓库根，已 gitignore，
   `.gitignore:19-20`）写 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`，发布时
   `--userconfig .npmrc-publish`。
3. 新包首次发布成功后 registry 会先呈现 `0.0.0-stage`（占位 staged 包），
   `409 Cannot publish over previously staged version` 表示**已在审核/传播队列**，不是失败。

证据：`docs/agents/CI-CD与发布流程.md:81-90`。

发布前核对（contributing.md 硬性要求）：

- `package.json.repository` 必须指回被收录的 GitHub 仓库（npm ↔ GitHub 关联靠它）；
- `files` 字段已含发布必需项（`package.json:36-46`）；
- `engines.dsh` / peerDependencies 的预发布分支写法已是 explicit `||` 形态。

## 5. marketplace 收录（awesome-dsh-plugin）

- fork 后新增**一个文件** `data/plugins/xuanyuanchumo__dsh-anic.yml`（一个 PR 最多 3 条）；
- `url` 必须与仓库完全一致；`category: workflow`；
- **描述数字必须与代码核实一致**（夸大是唯一会被打回的原因）：

```sh
grep -rho "name: 'anic_[a-z_]*'" src/host/tools*.ts | sort -u | wc -l   # → 24（工具数）
```

- 含 `: ` 的英文描述必须整体加引号；
- 仓库需满 1 天 + topic `dsh-plugin`；
- CI 绿是前置条件不是结论，维护者会读源码核对描述。

证据：`docs/agents/CI-CD与发布流程.md:97-110`。

## 6. Windows 本地网络注意（cycle-104）

- github.com 443 直连可能被重置（`git push` 报 `Connection was reset` / timeout），
  而 `gh` API 与 SSH 443 通——**remote 用 SSH 形态**（`git@github.com:...`），
  `gh auth setup-git` 对 HTTPS 形态无效时这是唯一稳定通道。
- SSH 认证自检：`ssh -T git@github.com` → `Hi <user>!` 即通。

证据：`docs/agents/CI-CD与发布流程.md:121-126`；本仓实际 remote：
`git@github.com:xuanyuanchumo/dsh-anic.git`（`git remote -v`）。

## 7. 脚本接口

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `scripts/workflow-lint.mjs <project-dir>` | 校验 `.github/workflows/*.yml` 的触发面/权限/四件套顺序/冻结安装/无 `--live`/`ANIC_SELF_AUDIT` | 0 通过 / 1 违规 |
| `scripts/release-check.mjs <project-dir> [tag]` | 校验 tag↔version、CHANGELOG 版本段、`files` 发布清单 | 0 通过 / 1 违规 |

详细契约见 `scripts/README.md`。

## 8. 证据边界

- 本文引用的行号均为 dsh-anic 仓库实测行号（写作时点 commit `75e8602`）。
- 关于 GitHub Actions 官方语义的通用知识（如 artifact 保留、OIDC provenance）标注为通用知识。
- 未在本仓验证的 marketplace 维护者行为（如「一个 PR 最多 3 条」）来自
  `docs/agents/CI-CD与发布流程.md:100` 的转述，属二手证据。
