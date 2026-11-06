# CHANGELOG — ci-cd-release

本文件记录 `assets/skills/ci-cd-release/` 叶技能的变更。版本锚点三处一致：
`SKILL.md` frontmatter、`scripts/<primary>.mjs` 版本串、本文件顶层条目。

## v0.3.0 — 2026-11-06（cycle-108：补齐 workflow 语法面四处缺口 + 三项机械校验）

> 起点：v0.2.0（已有 `references/actions-authoring.md` §1-§12）。本轮只补**原文没有**、
> 且能对着本仓两份真实工作流逐条核对的缺口。

### 新增（`references/actions-authoring.md` §13-§16）

- **§13 matrix**：本仓实测**无 matrix**（`grep -n 'matrix\|strategy:' .github/workflows/*.yml` 无命中），
  写明不用的理由（单一 node 承诺 + 单一 OS）与真要加的写法（`fail-fast: false` + `matrix.node`），
  并给**验证方法**：matrix 会把 job 展开成多条，`gh run view <id> --json jobs --jq '.jobs[].name'`
  才能看到 `name (22)/(24)`；同时提醒 `workflow-lint` 的顺序检查只按第一个 job 走。
- **§14 secrets 三种落点**：job 级 `env`（`release.yml:34`，只用于 `if: env.NPM_TOKEN != ''` 判空）/
  step 级 `env`（`NODE_AUTH_TOKEN`，`release.yml:160`）/ `GH_TOKEN: secrets.GITHUB_TOKEN`
  （`release.yml:145`，自动签发无需自建）。反面形态：给 publish 加 `continue-on-error: true`
  会把真失败吞成绿——本仓该步显式写 `false`（`release.yml:164`）。
- **§15 OIDC 与 provenance**：`id-token: write` 只开在发布作业（`release.yml:14-16`），
  CI 只有 `contents: read`（`ci.yml:21-22`）；`pnpm publish --provenance`（`release.yml:163`）
  依赖 CI 身份源。**本地手工 `--provenance` 未验证**，给出 `npm publish --dry-run --provenance`
  的验证方法，未写成结论。
- **§16 失败重试与超时**：两份工作流都只有 **job 级** `timeout-minutes: 30`
  （`ci.yml:28`、`release.yml:26`），无 step 级超时；实测耗时 CI `3m14s`（run 42156424415）/
  Release `3m18s`（run 42155819302）⇒ 约 10 倍余量；无 retry action，重跑用
  `gh run rerun <id> --failed`（`--help` 实测），重跑幂等靠
  `gh release delete "$TAG" … || true`（`release.yml:148-149`）+ npm 步骤按 token 显式 skip。

### 变更（`scripts/workflow-lint.mjs` 新增三项机械校验，行数 132 → 145）

| # | 校验 | 为什么它是「守卫」而不是风格建议 |
|---|---|---|
| ⑩ | job 级 `timeout-minutes` 必须存在 | 挂死的 job 默认能烧 6 小时；量化门禁不该占满 |
| ⑪ | CI 严禁 `id-token: write`；Release 必须 `id-token: write` | OIDC 是签发能力，多给一个 job 就是把签名权白送；反之缺了 `--provenance` 拿不到凭据 |
| ⑫ | Release 必须 `cancel-in-progress: false` | 发布是原子动作，被新 push 取消会留下"tag 已建、附件/registry 未完成"的半发布态 |

**守卫必须能失败（E2）实测**：对一份故意残缺的工作流跑 lint → `exit=1`，8 项违规，
其中新增项逐条命中：

```text
- .github/workflows/ci.yml: 缺少 job 级 timeout-minutes
- .github/workflows/release.yml: 缺少 job 级 timeout-minutes
- .github/workflows/release.yml: Release 缺少 id-token: write（--provenance 需要 OIDC）
- .github/workflows/release.yml: Release 的 concurrency 必须 cancel-in-progress: false
```

对真实仓库跑 → `[workflow-lint] OK — 校验 2 个工作流，无结构违规`（exit 0）。

### 其他

- **版本锚与行号纠错**：本文件与 `references/operations.md` 里残留「当前 `0.56.0`」——真实版本已
  `0.58.0`（`package.json:3`）；同时 `engines.dsh` 被写成单段 `>=0.2.0-rc.2 <0.4.0-0`，
  实际是**两段** `>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-rc.1 <0.4.0-0`（`package.json:59`），
  发布文件清单也漏了 `assets/skills/` 与 `assets/icon-180.png`（`package.json:44-56`）。
  全部改为实测值，并加一条纪律：**文档里不要写死版本号**，读时现算
  `node -p "require('./package.json').version"`。
- `SKILL.md`：新增 R13（secrets 落点分级）/ R14（OIDC 最小权限）/ R15（超时与重跑幂等）；
  导航索引按 §区间指向 `actions-authoring.md` §1-§16；frontmatter 补 `version: 0.3.0`。
- `scripts/README.md`：脚本清单同步新增三项校验的说明。
- `skills.index.json`：补显式 `dir` 字段；`anchors` 增列 `scripts/release-check.mjs` 与
  `references/actions-authoring.md`（原先注册表里只看得到 workflow-lint 一个脚本）。

### 依据（可复验）

```sh
Select-String -Path .github/workflows/*.yml -Pattern 'timeout-minutes|matrix|continue-on-error|strategy:'
gh run list -R xuanyuanchumo/dsh-anic --limit 6      # 42156424415 CI 3m14s / 42155819302 Release 3m18s
gh run rerun --help                                  # --failed / -j
node assets/skills/ci-cd-release/scripts/workflow-lint.mjs .
```

### 安全

- 未引入任何令牌；`gh` 只读调用经 `vault_run` 注入 `GH_TOKEN`。
- `secrets.*` 只引用名称，CHANGELOG 与本技能正文**不含任何令牌值**。

## v0.2.0 — 2026-11-06（cycle-108）

**新增参考**：`references/actions-authoring.md` —— GitHub Actions **编写面**（此前本技能只有
发布流程与排障，没有"怎么写对 workflow"的一篇）。

- 12 节：触发面 / 并发 / 权限 / 依赖与缓存 / 作业内定序 / 自审计开关 / artifacts /
  reusable 的取舍 / action 版本钉法 / tarball 稳定名 / 可选步骤的正确形态 / 自检清单。
- 每条结论以本仓 `.github/workflows/{ci,release}.yml` 实测为锚，含三条**反直觉**定序结论
  （Build 最早 / 播种顺序敏感 / 播种后必须再 Build）。
- 明确两条**不做**：单仓不抽 reusable workflow（没有第二个消费者）；不用 `continue-on-error`
  吞发布失败。

## v0.1.0 — 2026-11-05

**新增**：从零创建 `ci-cd-release` 叶技能（`assets/skills/ci-cd-release/`）。

- **一句话定位**：GitHub Actions 工作流与发布流水线操作知识叶技能；流程脊柱仍由
  `ai-native-iteration-cycle` 主干技能承载。
- **硬规则表**：R01 四件套顺序、R02 主干只进验证过的提交、R03 版本号唯一事实源、
  R04 tag 硬校验、R05 CHANGELOG 版本段、R06 tarball 稳定名、R07 CI 不跑 `--live`、
  R08 冻结安装、R09 发布复跑四件套、R10 播种先于测试、R11 回滚矩阵、R12 marketplace 数字核实。
- **证据基座**：全部结论引用本仓实测 `file:line`（`.github/workflows/ci.yml`、
  `.github/workflows/release.yml`、`docs/agents/CI-CD与发布流程.md`、`package.json`、
  `.gitignore`、`CLAUDE.md`）。
- **脚本**：
  - `scripts/workflow-lint.mjs`（工作流结构校验）
  - `scripts/release-check.mjs`（发布前四项卫生校验）
  - `scripts/README.md`（位置参数契约与用法）
- **参考**：`references/operations.md`（操作手册）、`references/troubleshooting.md`（故障排查）。
- **安全**：脚本零外部依赖、只读、不写盘、不联网、不打印凭据；位置参数契约对齐主干跨项目调用铁律。
- **假设**：
  1. `assets/skills/skills.index.json` 已声明本技能（`ci-cd-release` 条目，tier=leaf，gates=G0-G3）。
  2. `package.json` 的 `files` 尚未包含 `assets/skills/`——按技能库路线图 M-LIB-0，
     待 `skillInvoker` 库根解析落地后同步 `files` 与 `readmeNumbers` 契约。
  3. workflow 结构校验为行级近似（不解析 YAML），不替代人工评审。
