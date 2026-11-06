# npm-publish · 操作手册

> 本文是 `npm-publish` 叶技能的详细操作手册。所有命令与行号指向 dsh-anic 仓库实测事实。
> 读取时机：改版本号、打包 tarball、本地/CI 发 npm、registry 回滚、发布前卫生核对。
> 安全前提：**发布授权是人类门**——Agent 只产出校验报告与发布清单，`npm publish` 须人类授权。

## 0. 仓库事实基座（抽验）

| 事实 | 值 | 证据 |
|---|---|---|
| 当前版本 | `0.58.0`（读时现算：`node -p "require('./package.json').version"`） | `package.json:3` |
| 包名 | `dsh-anic` | `package.json:2` |
| 发布文件清单 | `dist/ assets/skill/ assets/skills/ assets/index/ assets/icon-180.png bin/ locale/ icon.svg cordis.patch.yml README.md LICENSE` | `package.json:44-56` |
| repository | `git+https://github.com/xuanyuanchumo/dsh-anic.git` | `package.json:12-15` |
| engines.node | `>=22.19` | `package.json:58` |
| engines.dsh | `>=0.2.0-rc.2 <0.3.0-0 \|\| >=0.3.0-rc.1 <0.4.0-0`（两段显式） | `package.json:59` |
| peer | `@deepseek-ai/cordis ^4.0.1`；`@deepseek-ai/dsh` optional | `package.json:61-64` |
| `.npmrc` | `auto-install-peers=false`（旧版回退注释） | `.npmrc:1-5` |
| `.npmrc-publish` | `registry=` + `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` + `always-auth=true` | `.npmrc-publish:1-5` |
| gitignore 保护 | `.npmrc-publish` 被忽略 | `.gitignore:19-20` |

## 1. 版本号唯一事实源与 CHANGELOG 同步（R01/R02）

- 版本号唯一事实源是 `package.json` 的 `version`（`docs/agents/CI-CD与发布流程.md:47`）。
- 改 version **必须同轮**改 CHANGELOG——v0.55.2 cycle-103 确立的纪律
  （`docs/agents/CI-CD与发布流程.md:48-49`）。
- CHANGELOG 版本标题形如 `## v0.56.0 — 2026-11-04（cycle-104：…）`（`CHANGELOG.md:3`）。
- release notes 直接从 CHANGELOG 抽取，杜绝手写漂移
  （`.github/workflows/release.yml:70-79,129-141`）。

操作：

```sh
# 1) 改 package.json.version（唯一事实源）
# 2) CHANGELOG.md 顶部加 `## vX.Y.Z — <date>（cycle-N：…）` 段
# 3) README 工具数/路由数若变动，同步 tests/contract/readmeNumbers.test.ts
```

## 2. tag 一致性硬校验（R03）

tag 形如 `vX.Y.Z`，必须与 `package.json.version` **逐字符一致**。release.yml 里有硬校验，
不一致直接红、不猜（`docs/agents/CI-CD与发布流程.md:50`；`release.yml:59-68`）：

```sh
PKG_VERSION="$(node -p "require('./package.json').version")"
EXPECTED="v${PKG_VERSION}"
[ "$TAG" = "$EXPECTED" ] || { echo "::error::tag 与 version 不一致"; exit 1; }
```

打 tag 与推送（只推 tag，release.yml 自动接手，`docs/agents/CI-CD与发布流程.md:51-56`）：

```sh
git tag "v$(node -p 'require("./package.json").version')"
git push origin "v$(node -p 'require("./package.json").version')"
```

> 现算 tag 而不是抄文档里的版本号：本轮审计就抓到 SKILL/operations 里残留 `v0.56.0`
> （当时真实版本已是 `0.58.0`），抄错即等于把 tag 打到不存在的版本上。

## 3. 稳定名 tarball + sha256（R04）

`pnpm pack` 默认文件名带版本号（`dsh-anic-0.55.2.tgz`），必须重命名为**稳定名**
`dsh-anic.tgz`——marketplace `tarball:` 字段要求 URL 不随版本变化；带版本名的 URL
下次发版就 404（`docs/agents/CI-CD与发布流程.md:65-67`；`release.yml:114-125`）：

```sh
rm -rf .pack && mkdir -p .pack
pnpm pack --pack-destination .pack
SRC="$(ls .pack/*.tgz | head -1)"
cp "$SRC" dsh-anic.tgz
sha256sum dsh-anic.tgz | tee dsh-anic.tgz.sha256
```

Windows PowerShell 等价：

```powershell
Get-FileHash -Algorithm SHA256 dsh-anic.tgz
```

本技能提供 `scripts/pack-stable.mjs` 校验命名规则并打印上述命令（**不执行 `pnpm pack`**）：

```sh
node assets/skills/npm-publish/scripts/pack-stable.mjs D:\Projects\TraeProjects\dsh-anic
```

## 4. 发布四件套（R11）

发布不能是「没验过的东西」：`Build → Typecheck → Lint → Test`（`release.yml:84-112`）。
顺序敏感：`Build` 必须在播种的 `coverage` 之前——`dshConformance` 的 dist 契约（C9/C10）
要求 `dist/` 已存在，coverage 不依赖 dist（run 41901601533 实录修正）。

本地发布前跑四件套（`CLAUDE.md:13`）：

```sh
pnpm run typecheck && pnpm run test && pnpm run build
```

## 5. npm publish 本地路径（R05/R06/R12）

### 5.1 令牌来源

令牌经 DSH 凭证库注入（明文永不落盘/入对话/入命令行）。凭证库写入在 设置 → 凭证库 或
`vault_set`；执行用 `vault_run`（命令白名单 `gh / npm / npx / node / git`），令牌只注入子进程
环境变量：

- `vault_run` 的 `npm`/`node` 令牌默认注入环境变量名 `NPM_TOKEN`（`vault_run` 的 `env_name` 可覆盖）。
- **绝不**把令牌值贴进回复、写入工作区文件、或传给 `vault_show` 之外的任何工具。

### 5.2 坑位 1：cwd 必须落项目目录（R05）

`vault_run` 默认 cwd 是 desktop profile——在那里跑 publish 会读错 `package.json`，报
`Cannot read properties of null (reading 'prerelease')`。必须让 npm 进程 cwd 落在项目目录。

推荐形态：一个**包装脚本**（落在仓库根、由人类维护、不提交令牌）用 `execFileSync` 指定 `cwd`：

```js
// publish-npm-local.mjs —— 示例包装器（不在本技能包内，勿提交令牌）
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// NPM_TOKEN 已由 vault_run 注入 process.env；这里只负责把 cwd 钉在项目目录。
const projectDir = resolve(process.argv[2] ?? process.cwd());
execFileSync('npm', ['publish', '--access', 'public', '--userconfig', '.npmrc-publish'], {
  cwd: projectDir,
  stdio: 'inherit',
});
```

调用（`vault_run` 注入令牌，`node` 是白名单命令）：

```sh
vault_run node publish-npm-local.mjs D:\Projects\TraeProjects\dsh-anic
```

或在项目目录内直接用 pnpm（同样要 cwd 正确）：

```sh
pnpm publish --no-git-checks --access public --provenance
```

### 5.3 坑位 2：npm 11 不认裸 `NPM_TOKEN`（R06）

npm 11 **不**把裸 `NPM_TOKEN` 环境变量当凭据。仓库根的 `.npmrc-publish`（已 gitignore）
提供占位符注入（`docs/agents/CI-CD与发布流程.md:85-87`；`.npmrc-publish:1-5`）：

```ini
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
always-auth=true
```

发布时加 `--userconfig .npmrc-publish`。**此文件必须保持 gitignore**
（`.gitignore:19-20`）——含 `${NPM_TOKEN}` 占位符，值由 `vault_run` 注入环境变量提供。

CI 侧等价写法（`release.yml:156-164`）：`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` +
`pnpm publish --no-git-checks --access public --provenance`。

### 5.4 坑位 3：新包 staged 语义（R07）

新包首次发布成功后 registry 会先呈现 `0.0.0-stage`（占位 staged 包）；再发同版本报
`409 Cannot publish over previously staged version`——表示**已在审核/传播队列**，
不是失败。官方 registry 新包要过 npm 的人工/自动审核窗口才对外可见
（`docs/agents/CI-CD与发布流程.md:88-90`）。**不要反复重发。**

### 5.5 发布卫生核对（R09）

发版前逐项核对（`docs/agents/CI-CD与发布流程.md:92-95`）：

- `package.json.repository` 必须指回被收录的 GitHub 仓库（npm ↔ GitHub 关联靠它）。
- `files` 字段已含 `dist/ assets/skill/ assets/skills/ assets/index/ bin/ locale/ icon.svg cordis.patch.yml README.md LICENSE`。
- `engines.dsh` / `peerDependencies` 的预发布分支写法已是 explicit `||` 形态。

自动化核对：

```sh
node assets/skills/npm-publish/scripts/release-check.mjs D:\Projects\TraeProjects\dsh-anic "v$(node -p 'require("./package.json").version')"
node assets/skills/npm-publish/scripts/release-check.mjs D:\Projects\TraeProjects\dsh-anic "v$(node -p 'require("./package.json").version')" --report
```

## 6. GitHub Release 面（R04 配套）

release.yml 在 tarball 之后：先删同名 release 防撞车，再 `gh release create`
（`release.yml:143-154`）：

```sh
gh release delete "$TAG" --yes --cleanup-tag=false 2>/dev/null || true
gh release create "$TAG" --title "$TAG" --notes-file release-notes.md \
  --verify-tag dsh-anic.tgz dsh-anic.tgz.sha256
```

## 7. 回滚（R08）

npm 政策**不能真删**版本（`docs/agents/CI-CD与发布流程.md:114-116`）：

```sh
npm deprecate dsh-anic@X.Y.Z "reason"
# 然后发修复版
```

其余场景见 `ci-cd-release` 技能的回滚矩阵：删 release 重打 tag / `git revert` / `anic_reload_self`。

## 8. 脚本接口

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `scripts/release-check.mjs <project-dir> [tag] [--report]` | 发布卫生校验：version⇄CHANGELOG、tag⇄version、`files` 完整性、`.npmrc-publish` 未提交（另附 `repository`/`engines`） | 0 通过 / 1 违规 / 2 用法错误 |
| `scripts/pack-stable.mjs <project-dir> [--report]` | 稳定名 tarball 命名规则校验 + 重命名/sha256 命令（不执行 `pnpm pack`） | 0 通过 / 1 命名违规 / 2 用法错误 |

详细契约见 `scripts/README.md`。

## 9. 证据边界

- 本文引用的行号均为 dsh-anic 仓库实测行号（写作时点 commit `75e8602` 之后）。
- 关于 npm registry 审核窗口、`deprecate` 政策、marketplace `tarball:` 字段语义的通用知识，
  来自 `docs/agents/CI-CD与发布流程.md` 的转述（一手为该文档的实测记录）。
- `.npmrc-publish` 的 `${NPM_TOKEN}` 占位符语法属 npm 官方 npmrc 文档通用知识。
- 本文不修改任何既有文件；`.npmrc-publish` 仅读取校验。
