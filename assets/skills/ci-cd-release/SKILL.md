---
name: ci-cd-release
version: 0.3.0
whenToUse: >
   在 dsh-anic（或任何 DSH 插件）仓库里需要设计/修改 GitHub Actions 工作流、发布流水线、
   tag/版本收口、artifact 上传、回滚预案或 marketplace 收录条目时使用。触发词（中文）：
   CI、workflow、release、回滚、marketplace、发布流水线、门禁映射、artifact、tag、流水线。
   Trigger words (EN): CI, workflow, release, pipeline, rollback, marketplace,
   artifact, deploy, tag, GitHub Actions, gate mapping.
description: >
   Triggers: CI, workflow, release, pipeline, rollback, marketplace, artifact, deploy,
   tag, GitHub Actions, 发布流水线, 回滚, 门禁映射, pipeline, pipeline gate. Use when
   designing or fixing a GitHub Actions workflow, a release/tag flow, artifact upload,
   a rollback plan, or a marketplace listing for a DSH plugin.
---

# CI-CD 与发布（ci-cd-release）

## 一句话定位

dsh-anic 的 **GitHub Actions 工作流与发布流水线操作知识叶技能**：把 `docs/agents/CI-CD与发布流程.md`
与 `.github/workflows/{ci,release}.yml` 的实测结论固化为「四件套顺序、版本唯一事实源、稳定名 tarball、
回滚矩阵、marketplace 数字核实」五条纪律，并提供两个确定性检查脚本。

> 本技能只提供**操作知识与确定性脚本**，不改变流程脊柱。流程脊柱（宏观六阶段、G0-G3 门禁、
> L1-L4 自主）由 `ai-native-iteration-cycle` 主干技能承载；本技能产出的证据（CI 状态、发布记录、
> 账本事件）喂给主干 `eval-runner` / `gate-check --record`。

## 硬性规则

| # | 规则 | 说明 | 证据 |
|---|---|---|---|
| R01 | 四件套顺序固定 | Build → Typecheck → Lint → Test，顺序即依赖 | `.github/workflows/ci.yml:66-73` |
| R02 | 主干只进验证过的提交 | push 前本地必须 `typecheck && test && build` 全绿 | `CLAUDE.md:13`；`docs/agents/CI-CD与发布流程.md:16` |
| R03 | 版本号唯一事实源 | `package.json.version`；改 version 同轮改 CHANGELOG | `docs/agents/CI-CD与发布流程.md:47-49` |
| R04 | tag 与 version 硬校验 | 不一致直接红，不猜 | `.github/workflows/release.yml:59-68` |
| R05 | CHANGELOG 必须有版本段 | release notes 直接从 CHANGELOG 抽，杜绝手写漂移 | `.github/workflows/release.yml:72-79,129-141` |
| R06 | tarball 用稳定名 | `pnpm pack` 产物重命名为 `dsh-anic.tgz` + sha256 | `.github/workflows/release.yml:117-125` |
| R07 | CI 不跑 `--live` | 真实宿主 E2E 需本机 DSH+Chrome，显式跳过并说明，非假绿 | `.github/workflows/ci.yml:8,76-77` |
| R08 | 依赖安装冻结 | `pnpm install --frozen-lockfile`；`autoInstallPeers=false` | `.github/workflows/ci.yml:57-58`；`docs/agents/CI-CD与发布流程.md:40-41` |
| R09 | 发布物复跑四件套 | 发布不能是「没验过的东西」 | `.github/workflows/release.yml:84-112` |
| R10 | 播种先于测试 | `init-cycle` → 四门锚点 → `coverage` → `generate-snapshot` → `workflow-state` → 重建 dist | `.github/workflows/ci.yml:88-123` |
| R11 | 回滚矩阵逐场景 | npm deprecate / 删 release 重打 tag / revert / reload | `docs/agents/CI-CD与发布流程.md:112-119` |
| R12 | marketplace 数字与代码一致 | 描述数字必须 `grep` 核实，夸大是唯一被打回原因 | `docs/agents/CI-CD与发布流程.md:102-106` |
| R13 | secrets 落点分级 | job 级 `env` 只用于**判空**（`NPM_TOKEN`），凭据本体放 step 级 `env`（`NODE_AUTH_TOKEN`）；`GITHUB_TOKEN` 自动签发不建 secret | `release.yml:34,145,160` |
| R14 | OIDC 最小权限 | `id-token: write` 只给发布作业（provenance）；CI 作业严禁开 | `ci.yml:21-22`；`release.yml:14-16`（`workflow-lint` ⑪ 机械校验） |
| R15 | 超时与重跑幂等 | job 级 `timeout-minutes: 30`（实测耗时 3m14s/3m18s，≈10 倍余量）；重跑靠 `gh run rerun --failed` + `gh release delete … \|\| true` 保证幂等 | `ci.yml:28`；`release.yml:26,148-149`；`gh run list -R xuanyuanchumo/dsh-anic` |

## 触发面与执行顺序

| 触发 | 范围 | 证据 |
|---|---|---|
| push 到 `master`/`feat/**`/`fix/**`/`chore/**`、所有 PR、`workflow_dispatch` | CI | `.github/workflows/ci.yml:9-14` |
| push `v*` tag 或 `workflow_dispatch`（须传 `tag`） | Release | `.github/workflows/release.yml:5-13` |
| 同分支新 push 取消旧运行 | `concurrency.cancel-in-progress: true` | `.github/workflows/ci.yml:17-19` |
| 发布重跑不撞车 | 先删同名 release | `.github/workflows/release.yml:148-154` |

CI 四步播种（缺一即真红，非测试缺陷）：

```sh
node assets/skill/scripts/init-cycle.mjs .
for g in G0 G1 G2 G3; do
  node assets/skill/scripts/gate-ledger.mjs . --gate "$g" --result PASS --detail "CI seeded anchor"
done
node scripts/coverage.mjs
node scripts/generate-snapshot.mjs
node assets/skill/scripts/workflow-state.mjs . check
pnpm run build            # generate-snapshot 重写了快照源，dist 必须重建对齐
```

证据：`.github/workflows/ci.yml:88-123`。

## 快速启动

1. **改 CI**：先读 `.github/workflows/ci.yml` 全文件，确认顺序 R01 未被破坏；改完跑
   `node assets/skills/ci-cd-release/scripts/workflow-lint.mjs <project-dir>`。
2. **发版**：`package.json.version` + CHANGELOG 同轮改 → `git tag vX.Y.Z` → `git push origin vX.Y.Z`
   （只推 tag，release.yml 自动接手）。发布前跑
   `node assets/skills/ci-cd-release/scripts/release-check.mjs <project-dir> vX.Y.Z`。
3. **排查 CI 红**：按 `build → typecheck → lint → test` 顺序定位；测试报告在
   `.cycles/cycles/*/test-reports/`（gitignore，由 `upload-artifact` 上传，14 天保留）。
4. **回滚**：按 R11 矩阵选择动作，禁止 force-push 主干。
5. **收录 marketplace**：fork `awesome-dsh-plugin`，新增一个 `data/plugins/<owner>__<repo>.yml`。

## 版本与 tag 规范

- 版本号唯一事实源：`package.json` 的 `version`（2026-11-06 实测 `0.58.0`，`package.json:3`）。
  **文档里不要写死版本号**——读的时候现算：`node -p "require('./package.json').version"`。
  本轮就抓到两处残留 `0.56.0`（本文件与 `references/operations.md`），已修正。
- CHANGELOG 必须有对应 `## vX.Y.Z` 段落（标题形如 `## v0.55.2 — 2026-11-03（cycle-103：…）`，
  `.github/workflows/release.yml:70-79`）。
- tag 形如 `vX.Y.Z`，与 `package.json.version` **完全一致**（`release.yml:59-68` 硬校验）。
- README 中的工具数/路由数由 `tests/contract/readmeNumbers.test.ts` 契约钉死，改面必须同步
  （`docs/agents/CI-CD与发布流程.md:49`）。

## 回滚矩阵

| 场景 | 动作 |
|---|---|
| npm 某版本损坏 | `npm deprecate dsh-anic@X.Y.Z "reason"`；不能真删（npm 政策），发修复版 |
| Release 附件错误 | `gh release delete vX.Y.Z --yes && git push origin :refs/tags/vX.Y.Z`，修好重推 |
| master 回退 | `git revert <bad-commit>`（保历史）；禁止 force-push 主干 |
| 宿主里插件损坏 | `anic_reload_self`（热重载）或重装插件包 |

证据：`docs/agents/CI-CD与发布流程.md:112-119`。

## 导航索引

按需加载——只在需要时读取对应参考文档：

| 需要了解 | 读取 |
|---|---|
| CI/发布完整操作手册（含 npm 发布、marketplace、Windows 网络） | `references/operations.md` |
| CI 红、发布失败、回滚失败的分诊与修复 | `references/troubleshooting.md` |
| workflow 语法面：触发器/matrix/并发/缓存/artifacts/OIDC/权限/钉版本/secrets/重试超时 | `references/actions-authoring.md` §1-§16 |
| 工作流结构校验 + 发布前四项卫生校验 | `scripts/README.md` |

## 与主干技能的对接

- 本技能产出的 CI 状态/发布记录 → 主干 `eval-runner` / `gate-check --record`。
- 本技能不自我改码；发现问题按主干宪章走 tech-debt + 下一轮 cycle 任务清单（人类门）。
- 命令清单与脚本位置见 `scripts/README.md`。

## 相关文档

- 主手册：`docs/agents/CI-CD与发布流程.md`
- 工作流定义：`.github/workflows/ci.yml`、`.github/workflows/release.yml`
- 工具面/HTTP 面对照：`docs/agents/工具面参考.md`、`docs/agents/API参考.md`
- 依赖与清单：`package.json`、`.gitignore`、`CLAUDE.md`
