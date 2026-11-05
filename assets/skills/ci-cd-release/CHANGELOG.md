# CHANGELOG — ci-cd-release

本文件记录 `assets/skills/ci-cd-release/` 叶技能的变更。版本锚点三处一致：
`SKILL.md` frontmatter、`scripts/<primary>.mjs` 版本串、本文件顶层条目。

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
