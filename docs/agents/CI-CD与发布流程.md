# CI-CD 与发布流程（cycle-104）

> 本文是 dsh-anic 的分支管理 / CI / 发布操作手册。所有命令均已在本仓实测。
> 工作流定义：[.github/workflows/ci.yml](../../.github/workflows/ci.yml) / [.github/workflows/release.yml](../../.github/workflows/release.yml)

## 1. 分支策略

| 分支 | 用途 | 生命周期 |
|---|---|---|
| `master` | 主干，永远可安装可发布 | 永久 |
| `feat/<域>-<主题>` | 功能开发 | 合并即删 |
| `fix/<issue号>-<主题>` | 缺陷修复 | 合并即删 |
| `chore/<主题>` | 工程/文档 | 合并即删 |

规则：
- **主干只进验证过的提交**——push 前本地必须 `pnpm run typecheck && pnpm run test && pnpm run build` 全绿（CLAUDE.md 纪律）。
- CI 对 `master`、`feat/**`、`fix/**`、`chore/**` 的 push 与所有 PR 触发（ci.yml `on:` 段）。
- 大改动走 PR；单人仓库允许直接 push master，但 commit message 必须写清「改了什么 + 为什么」。

## 2. Commit 规范

格式：`<type>(<scope>): <一句话结论>`

type 取值：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `v<版本号>`（版本收口提交）。
本仓惯例（见 `git log`）：版本收口提交以 `v0.X.Y cycle-N:` 开头，正文按领域列条目，每条写「改了什么——为什么/实证出处」。

## 3. CI 检查项（ci.yml）

顺序即依赖关系，**build 必须先于 lint/test**：

1. **Build**（`pnpm run build`）——`dist/` 在 .gitignore 里，CI 必须自建；
   lint 的 C9/C10 检查 dist 存在性，smoke 层直接读 dist/client.js，
   deployFreshnessContract 要求 dist 不旧于 src。
2. **Typecheck**（tsconfig.client + tsconfig.host 双编译）。
3. **Lint**（DSH 规范符合性门 validate-dsh.mjs）。
4. **Test**（离线四层金字塔：validate → vitest → smoke → trigger）。
   **不跑 `--live`**：真实宿主 E2E 需要本机 DSH 桌面端 + Chrome，CI 不具备——显式跳过并说明，不是假绿。

CI 环境要点（都是实测踩过的坑）：
- `pnpm install --frozen-lockfile`，**绝不** `autoInstallPeers=true`（会把宿主整棵树 ~824 包拖进 CI）；
  peer 设置住在 pnpm-workspace.yaml，需要 pnpm ≥10.13，故 action 固定 pnpm 11。
- Node 22（`engines.node: >=22.19`）。
- 测试报告（`.cycles/cycles/*/test-reports/`，被 gitignore）用 upload-artifact 显式上传，14 天保留。

## 4. 版本号与 tag 规范

- 版本号唯一事实源：`package.json` 的 `version`。CHANGELOG.md 必须有对应 `## vX.Y.Z` 段落。
- **版本锚点同步**（v0.55.2 cycle-103 确立的纪律）：改 version 时同轮改 CHANGELOG；
  README 中出现的工具数/路由数由 `tests/contract/readmeNumbers.test.ts` 契约钉死，改面必须同步。
- tag 形如 `vX.Y.Z`，与 package.json.version **完全一致**——release.yml 里有硬校验，不一致直接红。
- 打 tag 与推送：

```sh
git tag v0.56.0
git push origin v0.56.0   # 只推 tag，release.yml 自动接手
```

## 5. 发布流程（release.yml）

tag push 触发，依次执行：

1. tag ↔ package.json 版本一致性校验（不一致 fail，不猜）。
2. CHANGELOG 版本段落存在性校验（release notes 直接取自 CHANGELOG，杜绝手写漂移）。
3. Build → Typecheck → Lint → Test（同 CI 四件套——发布物不能是没验过的东西）。
4. `pnpm pack` 产出 tarball，重命名为**稳定名** `dsh-anic.tgz`（marketplace `tarball:` 字段
   要求 URL 不随版本变化；带版本名的 URL 下次发版就 404——contributing.md 明文警告），
   附 sha256。
5. `gh release create`（重跑时先删旧 release 防撞车）。
6. **npm publish（可选）**：仓库 Settings → Secrets 配置 `NPM_TOKEN` 后自动执行
   `pnpm publish --access public --provenance`；未配置则显式 skip 并提示（不算失败）。

## 6. npm 发布（本地手动路径）

令牌经 DSH 凭证库注入（明文永不落盘/入对话）：

```sh
# 凭证库预置 NPM_TOKEN（env 注入子进程，不进 shell 历史）
npm publish --access public   # 经 vault_run npm 执行
```

**实测坑位（cycle-104，勿重踩）**：
1. `vault_run` 默认 cwd 是 desktop profile——在那里跑 publish 会读错 package.json，
   报 `Cannot read properties of null (reading 'prerelease')`。必须让 npm 进程 cwd
   落在项目目录（包装脚本 execFileSync 指定 cwd）。
2. npm 11 **不**把裸 `NPM_TOKEN` 环境变量当凭据——需 `.npmrc-publish`
   （仓库根，已 gitignore）写 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`，
   发布时 `--userconfig .npmrc-publish`。
3. 新包首次发布成功后 registry 会先呈现 `0.0.0-stage`（占位 staged 包），
   `409 Cannot publish over previously staged version` 表示**已在审核/传播队列**，
   不是失败——官方 registry 新包要过 npm 的人工/自动审核窗口才对外可见。

发布前核对（contributing.md 硬性要求）：
- `package.json.repository` 必须指回被收录的 GitHub 仓库（npm ↔ GitHub 关联靠它，cycle-104 已补）；
- `files` 字段已含 `dist/ assets/skill/ assets/skills/ assets/index/ bin/ locale/ icon.svg cordis.patch.yml README.md LICENSE`；
- `engines.dsh` / peerDependencies 的预发布分支写法已是 explicit `||` 双分支形态（cycle-107）。

## 7. marketplace 收录（awesome-dsh-plugin）

规则来源：awesome-dsh-plugin contributing.md（cycle-107 全文核验，研究输入 I）。
要点：
- fork 后新增**一个文件** `data/plugins/xuanyuanchumo__dsh-anic.yml`（一个 PR 最多 3 条）；
- `url` 必须与仓库完全一致；`category: workflow`（合法 25 类之一）；
- **描述数字必须与代码核实一致**（夸大是唯一会被打回的原因——描述被视为声明并与源码核对）：

```sh
grep -rho "name: 'anic_[a-z_]*'" src/host/tools*.ts | sort -u | wc -l   # → 24（工具数）
```

- 含 `: ` 的英文描述必须整体加引号（否则 YAML 解析炸）；
- yml **手写 `npm:` 字段会被拒**——npm↔仓库关联从 registry 自动采集；
- 仓库需满 1 天 + topic `dsh-plugin`（本仓 2026-11-04 建仓 + 已加 topic）；
- CI 绿是前置条件不是结论，维护者会读源码核对描述；
- gate 显示 `—` = Submission gate 未跑（几乎总是分支与 main 冲突）——**只能等维护者
  rebase**，推空提交/自己重新生成 README 都无效；
- 被打 `held: author` 标签时：同分支推修复 + **只留一条**评论；"Held PRs" 跟踪 issue
  每日 06:19 UTC 刷新可自查；
- **engines.dsh 预发布陷阱**（cycle-107 修复）：node-semver 只放行与比较符同元组且带
  预发布标签的版本——`>=0.2.0-rc.2 <0.4.0-0` 单分支会**静默排除 0.2.1+/0.3.x 预发布
  宿主**，必须显式 `||` 双分支：`">=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-rc.1 <0.4.0-0"`
  （engines.dsh 与 peerDependencies 两处逐字相等，`dshConformance` 契约钉住形状）；
- 每个新 release 必须附稳定名 `dsh-anic.tgz`（release.yml 已保证——`latest/download/`
  链接 404 会让收录条目失效）；
- 工具/路由数变化时**只改自己的 yml** 条目描述。

**PR #12071 现状**（2026-11-06 核验）：七字段齐全、category/workflow、tarball 稳定名、
dsh.bundle.patch 已声明、仓库满 1 天、topic 已加、npm 0.56.0 已发布且 repository 指回、
24 工具/77 路由数字已附核验方式——全部合规；head commit 0 statuses（gate 未跑），
属维护者 rebase 范畴，作者侧无解，只需在 Checks 页与 Held issue 跟踪。

## 8. 回滚

| 场景 | 动作 |
|---|---|
| npm 某版本损坏 | `npm deprecate dsh-anic@X.Y.Z "reason"`；不能真删（npm 政策），发修复版 |
| Release 附件错误 | 删 release 重打 tag：`gh release delete vX.Y.Z --yes && git push origin :refs/tags/vX.Y.Z`，修好重推 |
| master 回退 | `git revert <bad-commit>`（保历史）；禁止 force-push 主干 |
| 宿主里插件损坏 | `anic_reload_self`（热重载）或重装插件包 |

## 9. Windows 本地网络注意（cycle-104 实测）

- github.com 443 直连可能被重置（git push 报 `Connection was reset` / timeout），
  而 `gh` API 与 SSH 443 通——**remote 用 SSH 形态**（`git@github.com:...`），
  `gh auth setup-git` 对 HTTPS 形态无效时这是唯一稳定通道。
- SSH 认证自检：`ssh -T git@github.com` → `Hi <user>!` 即通。

## 10. 发布状态（cycle-108 复核）

| 项 | 状态 |
|---|---|
| 远端 PR（awesome-dsh-plugin #12071） | **已提交**，`state: OPEN`，`mergeable_state: clean`，Submission gate `success @2026-11-06T00:58:55Z`；cycle-108 追加 `icon:` 提交 `4a2dd3a`，正文同步 npm/icon 状态 |
| GitHub Release `v0.57.0` | ✅ 已发布（历史） |
| **GitHub Release `v0.58.0`** | ✅ **2026-11-06 实测**：Release workflow `success`（run 42155819302），附件 `dsh-anic.tgz`（923229B，sha256 `533dfc44…`）+ `dsh-anic.tgz.sha256` |
| npm registry `dsh-anic@latest` | ✅ **0.58.0**（`https://registry.npmjs.org/dsh-anic/latest` 实测）；B4「registry 滞后」缺口关闭 |
| `engines.dsh` 双分支 | ✅ `package.json` 与 README 均已为 `>=0.2.0-rc.2 <0.3.0-0 \|\| >=0.3.0-rc.1 <0.4.0-0` |
| 市场条目 `icon:` | ✅ `assets/icon-180.png`（列表只收位图，SVG 会被拒收）；PR 分支已引用 |
| GitHub topics | ✅ 14 个（补 convergence-gate / hitl / autonomy / workflow-visualizer / sdlc / mcp-server） |
| `keywords` | ✅ 20 条（`package.json`） |

**数字同步纪律**：工具的 24 / 路由的 77 只有 README 侧有契约守卫
（`tests/contract/readmeNumbers.test.ts`）；列表条目 yml、PR 正文、本文档**无守卫**，
数量变动时必须手工同步这三处（本轮已同步）。

## 11. Actions 编写面

见 `assets/skills/ci-cd-release/references/actions-authoring.md`（cycle-108 新增）：
触发面/并发/权限/缓存/作业内定序/artifacts/reusable 取舍/action 版本钉法/tarball 稳定名/自检清单。
