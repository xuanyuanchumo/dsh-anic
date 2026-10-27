# cycle-82 配置编辑器 i18n 键（交 Lead 合并进 `locale/*.json`）

> 本文件是 **键名与文案的交付单**，不是运行期资源。代码里已按 `t('config.xxx')`
> 正常调用；`locale/zh.json` / `locale/en.json` 由 Lead 统一合并（本任务禁止改
> locale，避免三队并行时撞同一份 JSON）。
>
> 合并前 `i18nGhosts` 会把这些键报成「幽灵消费」（`closureAuditContract` ③ 变红），
> 这是**预期的交接信号**：合并后自动归零。合并要点：
> - 新增顶层命名空间 `config`，zh/en 键集必须完全一致（zh 单边新增 = 漏翻）；
> - `{...}` 占位符两端同名（en 侧改名会让失败信息静默丢参）。

## 1. 分区与动作

| key | zh | en |
| --- | --- | --- |
| `config.title` | 配置与路径 | Configuration & Paths |
| `config.ariaLabel` | ANIC 配置编辑器 | ANIC configuration editor |
| `config.hint` | 保存会原位改写 `.cycles/config.yml`：注释、空行与未知键原样保留；写后回读校验，不符自动回滚。 | Saving edits `.cycles/config.yml` in place: comments, blank lines and unknown keys are preserved; changes are re-read and rolled back on mismatch. |
| `config.dirty` | 已修改 | modified |
| `config.dirtyCount` | 待保存 {count} 项 | {count} pending |
| `config.save` | 保存 | Save |
| `config.saving` | 保存中… | Saving… |
| `config.savedAt` | 已保存（{at}） | Saved ({at}) |
| `config.preview` | 预览差异 | Preview diff |
| `config.discard` | 放弃修改 | Discard |
| `config.reset` | 还原 | Reset |
| `config.resetOne` | 还原字段：{field} | Reset field: {field} |

## 2. 结果反馈

| key | zh | en |
| --- | --- | --- |
| `config.previewSummary` | 预览：将改动 {count} 个字段（未写入磁盘） | Preview: {count} field(s) would change (nothing written) |
| `config.saveSummary` | 已写入 {count} 个字段 | {count} field(s) written |
| `config.saveFailed` | 保存失败：{error} | Save failed: {error} |
| `config.backupAt` | 备份：{path} | Backup: {path} |

## 3. 分组

| key | zh | en |
| --- | --- | --- |
| `config.group.project` | 项目 | Project |
| `config.group.commands` | 命令 | Commands |
| `config.group.macro` | 宏观循环 | Macro cycle |
| `config.group.anic` | 插件行为 | Plugin behavior |

## 4. 字段标签

| key | zh | en |
| --- | --- | --- |
| `config.field.projectName` | 项目名 | Project name |
| `config.field.techStack` | 技术栈（逗号分隔） | Tech stack (comma separated) |
| `config.field.buildCmd` | 构建命令 | Build command |
| `config.field.typecheckCmd` | 类型检查命令 | Typecheck command |
| `config.field.lintCmd` | 规范检查命令 | Lint command |
| `config.field.testCmd` | 测试命令 | Test command |
| `config.field.coverageCmd` | 覆盖率命令 | Coverage command |
| `config.field.e2eCmd` | 端到端命令 | E2E command |
| `config.field.hygieneCmd` | 卫生检查命令 | Hygiene command |
| `config.field.autonomyLevel` | 自主级（L1–L4） | Autonomy level (L1–L4) |
| `config.field.complexityBudget` | 复杂度预算 | Complexity budget |
| `config.field.allowedOrigins` | 允许来源（逗号分隔） | Allowed origins (comma separated) |
| `config.field.toolDisclosure` | 工具披露模式（full/indexed） | Tool disclosure (full/indexed) |

> `anic.flow.*` 的 10 个开关复用既有 `flows.*` 键（`shared/flows.ts` 的
> `labelKey`，已在 locale 中），**不新增**。

## 5. 路径表

| key | zh | en |
| --- | --- | --- |
| `config.path.title` | 路径 | Paths |
| `config.path.workspace` | 工作区 | Workspace |
| `config.path.cycles` | .cycles 目录 | .cycles directory |
| `config.path.config` | 配置文件 | Config file |
| `config.path.ledger` | 门禁账本 | Gate ledger |
| `config.path.workflowState` | 工作流状态 | Workflow state |
| `config.path.flowTracker` | 流程跟踪 | Flow tracker |
| `config.path.cyclesDocs` | 轮次文档 | Cycle documents |
| `config.path.evals` | 评估报告 | Evaluations |
| `config.path.techDebt` | 技术债 | Tech debt |
| `config.path.incidents` | 事故记录 | Incidents |
| `config.path.archive` | 归档 | Archive |
| `config.path.skillInstalled` | 已装技能 | Installed skill |
| `config.path.skillScripts` | 技能脚本目录 | Skill scripts |
| `config.path.skillInline` | 内联技能 | Inline skill |
| `config.path.pluginRoot` | 插件根 | Plugin root |
| `config.path.dist` | 构建产物 | Build output |
| `config.path.assets` | 随包资产 | Bundled assets |
| `config.path.agents` | Agent 卡 | Agent cards |
| `config.path.artifacts` | 工作区工件 | Workspace artifacts |
| `config.path.custom` | 自定义路径 | Custom path |
| `config.path.meta` | {bytes} · {mtime} | {bytes} · {mtime} |
| `config.path.dir` | 目录 | dir |
| `config.path.missing` | 不存在 | missing |
| `config.path.unresolved` | （无法解析） | (unresolved) |
| `config.path.copy` | 复制 | Copy |
| `config.path.copyLabel` | 复制路径：{label} | Copy path: {label} |
| `config.path.probeRejected` | 路径被拒：{reason} | Path rejected: {reason} |
| `config.path.probeAccepted` | 路径可用：{path} | Path accepted: {path} |
