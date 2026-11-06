---
name: npm-publish
version: 0.2.0
whenToUse: >
  在 dsh-anic（或任意 DSH 插件）仓库里执行 npm 版本号收口、打 tag、打包发布、registry 回滚、
  tarball 稳定名管理、发布卫生检查时使用。触发词（中文）：npm publish、npm 发布、发版、版本号、
  tag、CHANGELOG、deprecate、tarball、pnpm pack、.npmrc-publish、回滚、registry、稳定名、发布卫生。
  Trigger words (EN): npm publish, publish to npm, version bump, tag, CHANGELOG, deprecate,
  tarball, stable name, npm registry, rollback, pnpm pack, publish hygiene, npmrc.
description: >
  Triggers: npm publish, npm 发布, 发版, 版本号, tag, CHANGELOG, deprecate, tarball,
  pnpm pack, .npmrc-publish, 回滚, registry, stable name, rollback, npm registry,
  publish to npm, version bump, 版本号同步, 发布卫生. Use when publishing a package to the
  npm registry or GitHub Release, bumping the version, cutting a tag, packing a stable-name
  tarball, or rolling back an npm release with npm deprecate.
---

# npm-publish（npm 版本 / 打包 / 发布 / 回滚）

> **一句话定位**：dsh-anic 的 **npm 发布面操作知识叶技能**——把 `docs/agents/CI-CD与发布流程.md`
> §4-§6 的实测结论固化为「版本唯一事实源、tag 硬校验、稳定名 tarball、vault_run cwd 与凭据、
> 新包 staged 语义、deprecate 回滚」六条纪律，并提供两个确定性校验脚本。
> 叶技能，依赖 `github-pr-actions`（合并证据）与 `ci-cd-release`（流水线骨架）。

本技能只提供**操作知识与确定性脚本**，不改变流程脊柱。发布授权属人类门（主干 R01/R02）：
Agent 产出的变更止于「发布清单 + 校验报告」，**绝不**在无人授权时执行 `npm publish`。

## 硬性规则

| # | 规则 | 说明 | 证据 |
|---|---|---|---|
| R01 | 版本号唯一事实源 | `package.json.version`；改 version 必须同轮改 CHANGELOG | `docs/agents/CI-CD与发布流程.md:47-49`；`package.json:3` |
| R02 | CHANGELOG 必须有版本段 | 标题形如 `## vX.Y.Z — <date>（cycle-N：…）`；release notes 直接从这里抽 | `.github/workflows/release.yml:72-79,129-141` |
| R03 | tag 与 version 完全一致 | `vX.Y.Z` 必须逐字符等于 `v${package.json.version}`，不一致直接红，不猜 | `.github/workflows/release.yml:59-68` |
| R04 | tarball 用稳定名 | `pnpm pack` 产物重命名为 `dsh-anic.tgz` + `dsh-anic.tgz.sha256` | `.github/workflows/release.yml:117-125`；`docs/agents/CI-CD与发布流程.md:65-67` |
| R05 | vault_run 的 cwd 必须落项目目录 | 默认 cwd 是 desktop profile，在那里 publish 会读错 package.json | `docs/agents/CI-CD与发布流程.md:82-84` |
| R06 | npm 11 不认裸 `NPM_TOKEN` | 需 `.npmrc-publish`（已 gitignore）+ `--userconfig .npmrc-publish` | `docs/agents/CI-CD与发布流程.md:85-87`；`.npmrc-publish:1-5` |
| R07 | 新包 staged 不是失败 | 首次发布后 registry 先呈 `0.0.0-stage`；`409 Cannot publish over previously staged version` 表示已在审核/传播队列 | `docs/agents/CI-CD与发布流程.md:88-90` |
| R08 | 回滚用 `npm deprecate` | npm 政策不能真删版本；`npm deprecate dsh-anic@X.Y.Z "reason"` + 发修复版 | `docs/agents/CI-CD与发布流程.md:114-116` |
| R09 | `files`/`repository`/`engines` 发布卫生 | 发布清单完整、`repository` 指回 GitHub、引擎范围显式 | `package.json:44-56,12-18,57-60`；`docs/agents/CI-CD与发布流程.md:92-95` |
| R10 | `.npmrc-publish` 永不提交 | 含 `${NPM_TOKEN}` 占位符，值由 `vault_run` 注入；必须 gitignore | `.gitignore:19-20` |
| R11 | 发布物先过四件套 | Build → Typecheck → Lint → Test，发布不能是「没验过的东西」 | `.github/workflows/release.yml:84-112` |
| R12 | 令牌明文不出 Host | 令牌经 DSH 凭证库（`vault_set`/`vault_run`）注入子进程环境变量，不入对话/日志/文件 | 主干 H1 + 本技能安全纪律 |
| R13 | registry 必须显式钉住 | 本机默认 registry 是**镜像站**（`npm config get registry` → `https://registry.npmmirror.com`）；发布必须 `--userconfig .npmrc-publish`（内部钉了 `registry=https://registry.npmjs.org/`）或显式 `--registry https://registry.npmjs.org/` | 2026-11-06 实测两条命令，见 §registry 与 .npmrc 纪律 |
| R14 | provenance 只在 CI 成立 | `--provenance` 依赖 OIDC 身份源，只在 `.github/workflows/release.yml` 里用（`id-token: write`）；本地手工发布**不带** | `release.yml:14-16,163` |

### 三条实测坑位（cycle-104，勿重踩）

1. **cwd 错配**：`vault_run` 默认 cwd 是 desktop profile——在那里跑 publish 读错 `package.json`，
   报 `Cannot read properties of null (reading 'prerelease')`。**必须**用包装脚本
   （`execFileSync` 指定 `cwd`）让 npm 进程落在项目目录（`docs/agents/CI-CD与发布流程.md:82-84`）。
2. **凭据不注入**：npm 11 **不**把裸 `NPM_TOKEN` 环境变量当凭据——仓库根的 `.npmrc-publish`
   （已 gitignore）写 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`，发布时加
   `--userconfig .npmrc-publish`（`docs/agents/CI-CD与发布流程.md:85-87`）。
3. **staged 语义**：新包首次发布成功后 registry 先呈 `0.0.0-stage`；再发同版本报
   `409 Cannot publish over previously staged version`——**已在审核/传播队列，不是失败**，
   不要反复重发（`docs/agents/CI-CD与发布流程.md:88-90`）。

## 快速启动

1. **改版本号**：`package.json.version` 与 `CHANGELOG.md` **同轮**改（R01/R02）。
2. **跑发布卫生校验**（只读，可加 `--report` 输出 JSON）：

   ```sh
   node assets/skills/npm-publish/scripts/release-check.mjs D:\Projects\TraeProjects\dsh-anic "v$(node -p 'require("./package.json").version')"
   node assets/skills/npm-publish/scripts/release-check.mjs D:\Projects\TraeProjects\dsh-anic "v$(node -p 'require("./package.json").version')" --report
   ```

   用 `$(node -p …)` 现算 tag，避免文档里的版本号过期（本轮实测就抓到 `0.56.0` 残留）。

3. **本地四件套全绿**（R11）：`pnpm run typecheck && pnpm run test && pnpm run build`。
4. **稳定名 tarball 计划**（不执行 `pnpm pack`，只校验命名规则并打印命令）：

   ```sh
   node assets/skills/npm-publish/scripts/pack-stable.mjs D:\Projects\TraeProjects\dsh-anic
   ```

5. **打 tag**（只推 tag，`release.yml` 自动接手）：

   ```sh
   git tag "v$(node -p 'require("./package.json").version')"
   git push origin "v$(node -p 'require("./package.json").version')"
   ```

6. **本地手动发 npm**（需人类授权 + `vault_run` 注入令牌，见 `references/operations.md` §5）：

   ```sh
   vault_run npm publish --access public --userconfig .npmrc-publish
   ```

   注意 `vault_run` 的 cwd 问题——正确形态是用包装脚本把 cwd 钉在项目目录（R05）。
7. **回滚**：`npm deprecate dsh-anic@X.Y.Z "reason"`（R08），禁止反复重发或假删。

## 发布卫生清单（发版前逐项核对）

| 检查 | 期望 | 证据 |
|---|---|---|
| 版本号 | `package.json.version` 合法 `X.Y.Z` | `package.json:3` |
| CHANGELOG | 存在 `## vX.Y.Z` 段 | `CHANGELOG.md:3` |
| tag | `v${version}`，逐字符一致 | `release.yml:59-68` |
| `files` | 含 `dist/ assets/skill/ assets/skills/ assets/index/ assets/icon-180.png bin/ locale/ icon.svg cordis.patch.yml README.md LICENSE` | `package.json:44-56` |
| `repository` | 指向 GitHub 仓库（npm ↔ GitHub 关联） | `package.json:12-18` |
| `engines` | `node >=22.19`、`dsh` 范围显式（`>=0.2.0-rc.2 <0.3.0-0 \|\| >=0.3.0-rc.1 <0.4.0-0` —— **两段**，不是单段） | `package.json:57-60` |
| `.npmrc-publish` | 被 gitignore 且未进 git 跟踪 | `.gitignore:19-20` |
| 干净构建 | `dist/` 不旧于 `src/` | `release.yml:84-112` |

## 版本号与 tag 规范

- 版本号唯一事实源：`package.json` 的 `version`（2026-11-06 实测 `0.58.0`，`package.json:3`；
  **文档不写死**，读时现算 `node -p "require('./package.json').version"`）。
- CHANGELOG 必须有对应 `## vX.Y.Z` 段（标题形如 `## v0.56.0 — 2026-11-04（cycle-104：…）`，
  `CHANGELOG.md:3`；校验逻辑 `release.yml:70-79`）。
- tag 形如 `vX.Y.Z`，与 `package.json.version` **逐字符完全一致**（`release.yml:59-68` 硬校验，
  不一致直接红，不猜）。
- 版本锚点同步（v0.55.2 cycle-103 确立）：改 version 时同轮改 CHANGELOG；README 中出现的
  工具数/路由数由 `tests/contract/readmeNumbers.test.ts` 契约钉死，改面必须同步
  （`docs/agents/CI-CD与发布流程.md:48-49`）。

## 发布四件套（R11）

发布不能是「没验过的东西」，`release.yml:84-112` 依次跑：

```sh
pnpm run build       # dist/ 在 .gitignore，CI/发布必须自建
pnpm run typecheck   # tsconfig.client + tsconfig.host 双编译
pnpm run lint        # DSH 规范符合性门 validate-dsh.mjs
pnpm run test        # 离线四层，不含 --live（CI 显式跳过并说明，非假绿）
```

顺序敏感：`Build` 必须先于播种的 `coverage`——`dshConformance` 的 dist 契约（C9/C10）
要求 `dist/` 已存在，coverage 不依赖 dist（run 41901601533 实录修正，`release.yml:82-103`）。

## 版本语义（0.x 阶段怎么升）

本包当前 `0.58.0`（`package.json:3`），**仍是 0.x** ⇒ semver 的 `MAJOR` 还没被"稳定 API"占用。
行业惯例（npm 生态，通用）与本仓实际做法：

| 改动性质 | 本仓该升哪一位 | 实例 |
|---|---|---|
| 破坏性变更（宿主契约、配置字段重命名） | `0.(MINOR)` 而非 `1.0.0`；0.x 期间用次版本位表达破坏 | v0.57.0 → v0.58.0 含契约调整 |
| 新增能力（新工具/新路由/新技能） | `0.(MINOR)` | cycle-108 新增只读对账与技能库 |
| 修 bug / 文档 / 性能（无行为破坏） | `0.x.(PATCH)` | `fix(release): Build before seed coverage` 类 |
| 预发布 | `0.59.0-rc.1`（`engines.dsh` 也用 rc 段，`package.json:59`） | — |

**判据不是"数字好不好看"，而是"安装者会不会被迫改代码"**；会被迫改 = 次版本位。
升完必须同轮改 `CHANGELOG.md`（R01/R02），否则 `release.yml` 的 CHANGELOG 硬校验直接红。

## registry 与 `.npmrc` 纪律（本仓实测，最容易踩）

本仓 `.npmrc`（**已跟踪**）里**没有** `registry=` 行，只有 `auto-install-peers=false`
（给 pnpm 旧版回退用）⇒ 因此 registry 取的是**机器/user 级配置**。本机实测：

```sh
npm config get registry                                        # → https://registry.npmmirror.com
npm config get registry --userconfig .npmrc-publish            # → https://registry.npmjs.org/
```

**结论**：不加 `--userconfig`/`--registry` 的发布或查询会打到**镜像站**（镜像有同步延迟，
`dist-tags` 可能是旧的；发布则根本不该往镜像发）。仓库根 `.npmrc-publish`（gitignored，
`.gitignore:19-20`）已把三行写全：

```ini
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
always-auth=true
```

**纪律**：
- 发布**必须** `--userconfig .npmrc-publish`（同时拿到官方 registry + 凭据）。
- 只查询版本时也要显式 `--registry https://registry.npmjs.org/`，别用镜像结果当"已发布"证据：
  ```sh
  npm view dsh-anic dist-tags --registry https://registry.npmjs.org/
  # 2026-11-06 实测 → { latest: '0.58.0' }
  ```
- `.npmrc-publish` **永不提交**；`vault_run` 注入 `NPM_TOKEN` 后由 `${NPM_TOKEN}` 占位符取用。

## provenance / OIDC：只在 CI 里成立（R14）

| 场景 | 命令 | 说明 |
|---|---|---|
| CI（release.yml） | `pnpm publish --no-git-checks --access public --provenance` | 作业开了 `id-token: write`（`release.yml:14-16`），npm 可验签来源 |
| 本地手工 | `vault_run npm publish --access public --userconfig .npmrc-publish` | **不带** `--provenance`：本机没有可信 OIDC 身份源 |

**未验证**（不写成结论）：本地 `--provenance` 的确切报错形态。验证方法：临时包上跑
`npm publish --dry-run --provenance`，若报 provenance/OIDC 相关错误即证实"依赖 CI 环境"。

## `files` 白名单：发布物是白名单不是黑名单

`files`（`package.json:44-56`）决定 tarball 内容；**没列进去的目录不会进包**，
`dist/`、`assets/skill/`、`assets/skills/`（`:47`）、`bin/`、`locale/`、`icon.svg`、
`cordis.patch.yml`、`README.md`、`LICENSE` 都在列。新增运行期资源时必须同时改这里，
否则"本地能跑、装上就缺文件"。核对命令（只读，不发布）：

```sh
npm pack --dry-run --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const f=JSON.parse(s)[0].files.map(x=>x.path);console.log(f.filter(p=>/^(dist|assets|bin|locale)\//.test(p)).length+' 个运行期文件')})"
```

## 回滚：deprecate 优先，unpublish 是例外

| 手段 | 命令 | 何时用 | 代价 |
|---|---|---|---|
| `deprecate`（R08 首选） | `npm deprecate dsh-anic@X.Y.Z "reason" --registry https://registry.npmjs.org/` | 某版本有缺陷但已被安装 | 安装者仍能装到，但会看到弃用警告；**历史不可撤**，须发修复版 |
| `unpublish` | `npm unpublish dsh-anic@X.Y.Z`（危险） | 泄露凭据/不可用产物等极端情形 | npm 对删包有严格限制（时间窗/下载量/依赖者），**删不掉是常态** |

**未验证**：`unpublish` 在 0.58.0 上的实际可行性（npm 政策随版本变化）。验证方法：
先 `npm view dsh-anic@0.58.0 --registry https://registry.npmjs.org/` 看依赖者规模，
再在**另一个测试包**上试 `unpublish` 观察报错，**不要拿线上包试**。

## 导航索引

按需加载——只在需要时读取对应参考文档：

| 需要了解 | 读取 |
|---|---|
| 版本/tag/打包/发布/回滚完整操作手册（含包装脚本示例、sha256 命令） | `references/operations.md` |
| `401`、`409`、cwd 错配、CHANGELOG 缺失、tarball 404 等失败模式与修复 | `references/troubleshooting.md` |
| 脚本位置参数契约、退出码、`--report` 语义 | `scripts/README.md` |

## 与主干技能的对接

- 本技能产出的发布校验报告与发布记录 → 主干 `eval-runner` / `gate-check --record`
  （`gates: G3`，见 `skills.index.json` 的 `npm-publish` 条目）。
- 本技能不自我改码；发现问题按主干宪章走 tech-debt + 下一轮 cycle 任务清单（人类门）。
- 与 `ci-cd-release` 的分工：后者管 GitHub Actions 流水线骨架与回滚矩阵；本技能只管
  **npm registry 发布面**的本地操作与坑位。

## 相关文档

- 主手册：`docs/agents/CI-CD与发布流程.md`（§4 版本/tag、§5 发布流程、§6 npm 发布）
- 工作流定义：`.github/workflows/release.yml`
- 仓库事实：`package.json`、`.npmrc`、`.npmrc-publish`、`.gitignore`、`CHANGELOG.md`
- 设计依据：`.cycles/research-inputs/D-skill-library-design.md` §3.4
