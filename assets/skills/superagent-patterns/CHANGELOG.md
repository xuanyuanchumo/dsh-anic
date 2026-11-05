# CHANGELOG — superagent-patterns

本文件记录 `assets/skills/superagent-patterns/` 叶技能的变更。版本锚点三处一致：
`SKILL.md` frontmatter、`scripts/<primary>.mjs` 版本串、本文件顶层条目。

## v0.1.0 — 2026-11-05

**新增**：从零创建 `superagent-patterns` 叶技能（`assets/skills/superagent-patterns/`）。

- **一句话定位**：Superagent 部署/授权/执行模式对标叶技能。
- **⚠️ 证据边界（重要）**：Superagent 事实**全部来自外部研究报告**
  `.cycles/research-inputs/A-dsh-superagent-study.md`（`deepseek-ai/dsh-superagent-prototype`，
  commit `8c32a9dc`，**未运行 build/test**），**不是 dsh-anic 本地源码**。
  研究原型自述「研究原型仅供参考，非 DeepSeek 官方产品」，部分方向未实现。
- **硬规则表**：R01 独立 profile 隔离；R02 `stateDir` 唯一必填且不可经面板改；
  R03 hourly check 建在日常 profile；R04 四类退出码分档处置；R05 Source/Policy/Executor 三块；
  R06 准入三级（explicit/inferred/not admitted）；R07 Mandate 不可变 + Policy version；
  R08 Management API 是面板唯一写入口；R09 setup 剥离 `KEY`/`PASSWORD`/`SECRET`/`TOKEN`；
  R10 升级先备份再回滚；R11 agent preset 不可缺。
- **内容覆盖**（按任务要求逐项落位）：
  - 独立 profile（`§8 L210`）、`stateDir`（`§8 L212-213`）
  - hourly check（`§8 L215`）
  - 四类退出码 0/1/2/3（`§8 L214`）
  - Source/Policy/Executor（`§2 L25-37`、`§4 L70`）
  - 准入表 explicit/inferred/not admitted（`§3 L51-52`）
  - Mandate + Policy version（`§2 L34`、`§3 L60-61`）
  - Management API（`§7 L199-201`）
  - setup 环境变量剥离（`§8 L218`）
  - 升级备份/回滚（`§8 L216`）
  - agent preset 非可选（`§5 L96`、`§4 L71`）
- **dsh-anic 对照**：单列一节并明确标注「非 Superagent 事实」，只引用本仓实测行号
  （`CLAUDE.md:10`、`docs/agents/工具面参考.md:43,84`）。
- **脚本**：
  - `scripts/superagent-status-probe.mjs`（四档退出码归一 + stateDir 探测）
  - `scripts/admission-table-check.mjs`（准入表结构校验）
  - `scripts/README.md`（位置参数契约与四档退出码表）
- **参考**：`references/operations.md`（操作手册）、`references/troubleshooting.md`（故障排查）。
- **安全**：脚本零外部依赖、只读、不写盘、不联网、不打印凭据。
- **假设**：
  1. `assets/skills/skills.index.json` 已声明本技能（`superagent-patterns` 条目，tier=leaf，gates=[])。
  2. 研究报告未运行 build/test，所有 API 签名以源码声明为准；本技能不执行 `pnpm` 或真实宿主探针。
  3. 研究报告 §10 的「dsh-anic 已有/缺失」判断基于推断，非实测源码，不构成权威结论。
  4. 准入表默认值与 CI 行处理依据研究报告 §3 L51-52；CI 行的具体单元格取值在报告中未逐字给出，
     本技能按「无发送者」标记如实呈现，不臆造具体取值。
  5. `scripts/admission-table-check.mjs` 缺省校验本技能自带的 `references/operations.md`，
     可用 `--table` 指向外部准入表。
