# cycle-83 归档治理 · 需新增的 locale 键

> 纪律：本轮的实现**不修改** `locale/*.json`（该文件属 Lead 收口作用域）。
> 本档登记实现已经产生、但词表尚未收录的用户面文案，供收口时一次性并入 `locale/zh.json` + `locale/en.json`。
>
> 为什么要登记而不是"直接在节点 label 里写中文"：节点 `label` 由渲染层**逐字显示**，
> 既有 `G0 PASS` / `autonomy L2` 就是中性 ASCII 形态。中文用户面文案必须走 `t()`，
> 否则 i18n 闭环的"死键/幽灵键"两族都会漏掉这批文案。

## 1. 快照节点（`src/shared/snapshotProjection/`，label 为英文原文）

| 键名 | 中文 | 英文 | 来源 / 用途 |
| --- | --- | --- | --- |
| `archive.node.archivedSummary` | `已归档 {{count}} 轮（{{first}} … {{last}}）` | `archived {{count}} cycles ({{first}} … {{last}})` | 归档摘要节点 label（`summarizeArchived`）。**计数必须留在标签上**，不能只放 tooltip |
| `archive.node.archivedSummaryOne` | `已归档 1 轮（{{first}}）` | `archived 1 cycle ({{first}})` | 同上，单轮形态 |
| `archive.node.archivedDetail` | `可回溯：{{names}}` | `traceable: {{names}}` | 归档节点 detail 的前缀（后面接点名列表） |
| `archive.node.foldedGroups` | `已折叠 {{groups}} 组门禁记录（共 {{entries}} 条，账本 #{{start}}–{{end}}）` | `folded {{groups}} gate groups ({{entries}} records, ledger #{{start}}–{{end}})` | 账本折叠节点 label（`windowGateGroups`） |
| `archive.node.foldedGroupsDetail` | `这 {{groups}} 组（{{entries}} 条）不在主视图；账本本身未被改动（INV-9），历史可回溯。` | `these {{groups}} groups ({{entries}} records) are outside the main view; the ledger itself is untouched (INV-9) and remains traceable.` | 折叠节点 detail |
| `archive.node.gateBadge` | `{{gate}} {{verdict}}` | `{{gate}} {{verdict}}` | 门禁徽章（保持 ASCII，中英同形） |
| `archive.node.gateAbsent` | `未跑` | `—` | 徽章里"该门本轮没出现"的占位（注意：**中文不能省略成空**，否则"没跑"与"过了"视觉不可分） |

## 2. 快照窗口读数（`counts` / `window`，客户端显示用）

| 键名 | 中文 | 英文 |
| --- | --- | --- |
| `window.mode.windowed` | `窗口化视图` | `windowed view` |
| `window.mode.full` | `全量视图` | `full view` |
| `window.readout` | `最近 {{recent}} 轮 + 当前轮 · 折叠 {{windowedOut}} 项` | `last {{recent}} cycles + current · {{windowedOut}} folded` |
| `window.current` | `当前轮：{{current}}` | `current cycle: {{current}}` |
| `window.warning.illegal` | `窗口配置非法（{{raw}}），已回缺省 {{default}}` | `invalid snapshotWindow ({{raw}}), falling back to {{default}}` |
| `window.warning.illegalNotInteger` | `窗口配置不是整数（{{raw}}），已回缺省 {{default}}` | `snapshotWindow is not an integer ({{raw}}), falling back to {{default}}` |
| `window.warning.illegalTooSmall` | `窗口配置 {{value}} < 1（等于没有窗口），已回缺省 {{default}}` | `snapshotWindow {{value}} < 1 (empty window), falling back to {{default}}` |
| `window.warning.illegalTooLarge` | `窗口配置 {{value}} > {{max}}，已回缺省 {{default}}` | `snapshotWindow {{value}} > {{max}}, falling back to {{default}}` |
| `window.warning.declaredCurrentMissing` | `声明的当前轮 {{declared}} 不在活跃区，已回落 {{current}}` | `declared current cycle {{declared}} is not active — using {{current}}` |
| `window.warning.archivedOutranks` | `最新归档轮 {{name}} 比所有活跃轮都新，当前轮读数为 {{current}}` | `newest archived cycle {{name}} outranks every active cycle — current cycle is {{current}}` |

## 3. 归档路由（`src/host/routes/archiveResetRoute.ts` + `runtime/artifactArchive*.ts`）

| 键名 | 中文 | 英文 |
| --- | --- | --- |
| `archive.route.noWorkspace` | `未找到工作区` | `no workspace` |
| `archive.error.dryRunNotBoolean` | `dryRun 必须是布尔值（收到 {{received}}）` | `dryRun must be boolean (got {{received}})` |
| `archive.error.includeIncompleteNotBoolean` | `includeIncomplete 必须是布尔值（收到 {{received}}）` | `includeIncomplete must be boolean (got {{received}})` |
| `archive.error.actorNotString` | `actor 必须是字符串（收到 {{received}}）` | `actor must be string (got {{received}})` |
| `archive.keep.missingCycleDir` | `{{name}}：循环目录不存在` | `{{name}}: cycle directory not found` |
| `archive.keep.missingTaskList` | `{{name}}：任务清单.md 缺失（该轮未完成初始化）` | `{{name}}: 任务清单.md missing (cycle never finished init)` |
| `archive.keep.emptyTaskList` | `{{name}}：任务清单.md 有 0 条任务行（无法证明完成，但不阻塞基线重置）` | `{{name}}: 任务清单.md has 0 task rows (cannot prove completion; does not block baseline reset)` |
| `archive.keep.hasPending` | `{{name}}：{{pending}}/{{total}} 条任务未完成` | `{{name}}: {{pending}}/{{total}} task rows pending` |
| `archive.warn.concurrentDisappear` | `{{name}}：移动前已消失（可能是并发归档），已跳过` | `{{name}}: disappeared before move (concurrent archive?) — skipped` |
| `archive.warn.alreadyPresent` | `{{name}}：归档区已存在同名轮，活跃副本保留（不覆盖）` | `{{name}}: already present in archive — left in active area (no overwrite)` |
| `archive.warn.noCyclesAtAll` | `没有任何循环目录（活跃区与归档区都为空），无可执行动作` | `no cycle directories at all (neither .cycles/cycles nor .cycles/archive) — nothing to do` |
| `archive.warn.ledgerChanged` | `基线重置期间账本读数发生变化——检查是否有并发写入者（INV-9 要求只追加）` | `ledger facts changed during baseline reset — check for concurrent writers (INV-9 expects append-only)` |
| `archive.warn.noop` | `没有可归档的轮次——已归档（no-op）` | `nothing archivable — no-op (already archived)` |
| `archive.done.archived` | `已归档 {{count}} 轮` | `archived {{count}} cycles` |
| `archive.inventory.archivable` | `可归档 {{count}} 轮` | `{{count}} cycles archivable` |
| `archive.inventory.blocked` | `不可归档 {{count}} 轮` | `{{count}} cycles not archivable` |

## 4. 已实现但**故意不**进词表的文案（诚实说明）

| 文案 | 位置 | 为什么不进词表 |
| --- | --- | --- |
| `archived N cycles (… )` / `folded N gate groups (…)` | 节点 `label` | 与既有 `G0 PASS` / `autonomy L2` 同族：节点标签是**数据面中性 ASCII**，由客户端按 `node.type` + 键族二次本地化。词表键见 §1，但**不替换**数据面的英文原文（否则嵌入快照的静态工件也会变成中文，生成器产物就与测试语言耦合了）。 |
| `entries N–M (K records), last <ISO>` | 节点 `detail` | 同上：`detail` 是白盒证据面（供详情抽屉/排障），保留机器可读形态。 |
| `cycle-N` 目录名 | 节点 label | 结构身份（INV-21），不是文案。 |

## 5. 收口时的机器校验建议（给 Lead）

1. `locale/zh.json` 与 `locale/en.json` 键集必须对齐（既有 C7 门禁已覆盖）。
2. 本档 §1–§3 的键若并入词表，**必须在客户端有真实消费点**，否则会立刻计入
   `i18n` 族的未消费棘轮（`closureAuditContract` ②）——未消费基线只许降不许升。
   实现侧目前只输出英文原文，故本轮**不产生**新的未消费键；本档是给"要做本地化时"的清单。
3. 若只做 §2（窗口读数）的本地化，注意 `window.warning.*` 有四条对应
   `resolveSnapshotWindow` 的四种拒绝分支，逐条一一对应（不要合并成一句）。
