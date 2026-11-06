# CHANGELOG — dsh-native-api

本文件记录 `assets/skills/dsh-native-api/` 叶技能的变更。版本锚点三处一致：
`SKILL.md` frontmatter、`scripts/<primary>.mjs` 版本串、本文件顶层条目。

## v0.2.2 — 2026-11-06（cycle-108：`engines.dsh` 范围写错 + 行号漂移，据 package.json 改正）

> 起点：v0.2.1（同轮）。本轮只修**事实错误**，不扩写内容。

### 修正（三处同源错误）

本技能四份文档把本仓 `engines.dsh` 写成单段 `>=0.2.0-rc.2 <0.4.0-0`，与 `package.json:59`
实际值不符——真实值是**两段显式**范围：

```text
>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-rc.1 <0.4.0-0
```

单段写法会漏掉 `0.3.0-rc.*` 这一支（本仓正在 0.3 rc 线上跑），是本技能最核心的兼容性判据，
写错等于把「能不能装」的判断依据搞错。同时修正引用行号（`package.json:47-50/49/51-59` → `:59` / `:61-64`）。

- `SKILL.md:132` — 补两段形态与理由（单段会把 rc 分支挡在外面）。
- `references/operations.md:15,107-109` — 表格值 + 现状段。
- `references/troubleshooting.md:39` — 修复步骤里的范围。

### 变更

- `SKILL.md`：frontmatter 补 `version: 0.2.2`（激活 `anchor:version` 锚）。
- `skills.index.json`：补显式 `dir` 字段（此前 9 条叶技能全缺 ⇒ 机器面只剩 1 个技能可见）。

### 依据（可复验）

```sh
node -p "require('./package.json').engines.dsh"
# >=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-rc.1 <0.4.0-0
Select-String -Path package.json -Pattern '"engines"|"dsh":' | ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
# 57: "engines": {   59: "dsh": ">=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-rc.1 <0.4.0-0"
```

### 安全

- 无令牌操作；未改 `package.json`（只读引用）。

## v0.2.0 — 2026-11-06（cycle-108）

**新增参考**：`references/runtime-registration.md` —— 运行时注册面（工具 / 技能 / 路由三面 +
官方 skill 链路 + 本仓四处缺口）。

- 官方 seam 锚点：`ctx.tools`（`kb/site/reference/capability-seams.md` 的 `svc_tools` 节点、
  `cookbook/adding-a-tool.md:18-25`）、`ctx.skills`（`capability-seams.md:683`）、`ctx.webServer`。
- 官方 skill 注册链路完整数据流（register → skills/change → snapshot{complete} →
  tool-skill 注入 → 每步 digest → skill() 载入前 isModelInvocable 拒绝）。
- **校正**：`availability: 'resident'|'discoverable'` **不是**官方字段（dsh-ops 私有），
  本仓不得给 `ToolRegistration` 加该字段。
- 本仓四处缺口（invocation 丢弃 / 不回读 snapshot / 不订阅 skills/change / 不用
  registerProvider）与修法，进 cycle-109 裁决表。

## v0.1.0 — 2026-11-05

**新增**：从零创建 `dsh-native-api` 叶技能（`assets/skills/dsh-native-api/`）。

- **一句话定位**：DSH 打包/安装/插件原生面操作叶技能；是其他叶技能的**事实基座**。
- **硬规则表**：R01 bundle vs profile；R02 `dsh.bundle.patch`→`cordis.patch.yml`；
  R03 `engines.dsh` SemVer；R04 缺 engines 才回退 peer；R05 层顺序（bundles→profile patch→home patch→overlay）；
  R06 git 安装 `prepare` + `allowBuilds`；R07 `ctx.get(name, false)` 探测纪律；R08 `deferLoading` 字段。
- **内容覆盖**（按任务要求逐项落位）：
  - bundle vs profile manifest（`kb/site/develop/basic/publish.md:14-19,71-77`）
  - `dsh.bundle.patch` → `cordis.patch.yml`（`package.json:80-82`；`cordis.patch.yml:10-13`）
  - `engines.dsh` SemVer + `peers`→`requirements` 改名（`kb/publish.md:69`；
    `kb/extra/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.zh.md:12-21`）
  - 安装命令 `dsh plugin --profile <name> add`（`kb/publish.md:82-121`）
  - 层顺序与「整行覆盖」（`kb/publish.md:123-139`）
  - git 安装 `prepare` + `allowBuilds`（`kb/publish.md:164-190`）
  - `ctx.get(name, false)` 探测纪律（`CLAUDE.md:28`；`src/index.ts:125`；
    `kb/site/develop/framework/service.md:92-103`）
  - `deferLoading` 字段（`src/host/toolsSlot.ts:140-152`；
    `kb/site/reference/subsystems/llm-streaming.md:77,704`）
- **脚本**：
  - `scripts/dsh-manifest-check.mjs`（manifest 结构校验）
  - `scripts/layer-order-check.mjs`（层顺序 + patch 结构校验）
  - `scripts/README.md`（位置参数契约与校验项表）
- **参考**：`references/operations.md`（操作手册）、`references/troubleshooting.md`（故障排查）。
- **安全**：脚本零外部依赖、只读、不写盘、不联网、不打印凭据。
- **假设**：
  1. `assets/skills/skills.index.json` 已声明本技能（`dsh-native-api` 条目，tier=leaf，gates=[]）。
  2. KB 引用为 2026-10-21 快照（commit `687f282`）；与实际安装的 DSH 运行时可能不一致——以实际安装包为准。
  3. `dsh.manifestVersion` 在 KB 中无文档，属实现字段；脚本只警告不据此做版本分支。
  4. 「原生化机会」是文档契约层面的可行性判断，需经类型检查与冒烟验证（未在本技能执行）。
  5. YAML 用轻量结构校验（无 YAML 依赖），不替代人工评审。
