# CHANGELOG — dsh-native-api

本文件记录 `assets/skills/dsh-native-api/` 叶技能的变更。版本锚点三处一致：
`SKILL.md` frontmatter、`scripts/<primary>.mjs` 版本串、本文件顶层条目。

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
