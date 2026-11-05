---
name: npm-publish
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
| R09 | `files`/`repository`/`engines` 发布卫生 | 发布清单完整、`repository` 指回 GitHub、引擎范围显式 | `package.json:36-46,12-18,48-55`；`docs/agents/CI-CD与发布流程.md:92-95` |
| R10 | `.npmrc-publish` 永不提交 | 含 `${NPM_TOKEN}` 占位符，值由 `vault_run` 注入；必须 gitignore | `.gitignore:19-20` |
| R11 | 发布物先过四件套 | Build → Typecheck → Lint → Test，发布不能是「没验过的东西」 | `.github/workflows/release.yml:84-112` |
| R12 | 令牌明文不出 Host | 令牌经 DSH 凭证库（`vault_set`/`vault_run`）注入子进程环境变量，不入对话/日志/文件 | 主干 H1 + 本技能安全纪律 |

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
   node assets/skills/npm-publish/scripts/release-check.mjs D:\Projects\TraeProjects\dsh-anic v0.56.0
   node assets/skills/npm-publish/scripts/release-check.mjs D:\Projects\TraeProjects\dsh-anic v0.56.0 --report
   ```

3. **本地四件套全绿**（R11）：`pnpm run typecheck && pnpm run test && pnpm run build`。
4. **稳定名 tarball 计划**（不执行 `pnpm pack`，只校验命名规则并打印命令）：

   ```sh
   node assets/skills/npm-publish/scripts/pack-stable.mjs D:\Projects\TraeProjects\dsh-anic
   ```

5. **打 tag**（只推 tag，`release.yml` 自动接手）：

   ```sh
   git tag v0.56.0
   git push origin v0.56.0
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
| `files` | 含 `dist/ assets/skill/ assets/skills/ assets/index/ bin/ locale/ icon.svg cordis.patch.yml README.md LICENSE` | `package.json:36-46` |
| `repository` | 指向 GitHub 仓库（npm ↔ GitHub 关联） | `package.json:12-18` |
| `engines` | `node >=22.19`、`dsh` 范围显式 | `package.json:48-51` |
| `.npmrc-publish` | 被 gitignore 且未进 git 跟踪 | `.gitignore:19-20` |
| 干净构建 | `dist/` 不旧于 `src/` | `release.yml:84-112` |

## 版本号与 tag 规范

- 版本号唯一事实源：`package.json` 的 `version`（当前 `0.56.0`，`package.json:3`）。
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
