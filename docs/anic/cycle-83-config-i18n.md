# cycle-83 配置编辑补全 i18n 键（交 Lead 合并进 `locale/*.json`）

> 本文件是 **键名与文案的交付单**，不是运行期资源。代码里已按 `t('config.' + suffix)`
> 正常调用；`locale/zh.json` / `locale/en.json` 由 Lead 统一合并（本任务禁止改
> locale，避免并行时撞同一份 JSON）。
>
> 合并前 `i18nGhosts` 会把这些键报成「幽灵消费」（`closureAuditContract` ③ 变红），
> 这是**预期的交接信号**：合并后自动归零。
>
> **前缀形态**：全部新键都在既有的 `config.` 命名空间下，由
> `dynamicKeyPrefixes` 以 `config.` 前缀统一认领（无需新增命名空间）。
> 合并要点：zh/en 键集必须完全一致；`{...}` 占位符两端同名
> （en 侧改名会让失败信息静默丢参）。

## 1. 路径行内编辑（cycle-83 新增 11 条）

| key | zh | en |
| --- | --- | --- |
| `config.pathEdit` | 编辑 | Edit |
| `config.pathEditSave` | 保存 | Save |
| `config.pathEditCancel` | 取消 | Cancel |
| `config.pathEditReset` | 撤销自定义 | Reset to default |
| `config.pathEditHint` | 相对工作区根（如 `docs/evals`） | Workspace-relative (e.g. `docs/evals`) |
| `config.pathEditInvalid` | 不能含 `..` 段 | must not contain `..` segments |
| `config.pathEditOutside` | 必须是相对工作区根的路径 | must be a workspace-relative path |
| `config.pathEditing` | 正在编辑路径 | Editing path |
| `config.pathDefault` | 默认 | default |
| `config.pathOverridden` | 自定义 | custom |
| `config.pathNotEditable` | 该项不可编辑 | not editable |

## 2. 覆盖表状态（cycle-83 新增 3 条）

| key | zh | en |
| --- | --- | --- |
| `config.pathOverridesActive` | 已自定义路径 | Custom paths |
| `config.pathOverridesNone` | 全部使用默认路径 | All paths at defaults |
| `config.pathOverridesIgnored` | 覆盖表整份被忽略（解析已回落到默认）： | Override table ignored entirely (resolved back to defaults): |

> `pathOverridesIgnored` 是 fail-closed 的**可见信号**：任何一条覆盖非法时整份忽略，
> 用户必须知道"你现在看到的都是默认路径"。文案末尾带冒号，后面拼 warnings 原文。

## 3. 草稿冲突条（cycle-83 新增 6 条）

| key | zh | en |
| --- | --- | --- |
| `config.conflictTitle` | 磁盘已改动，你的修改基于旧值 | Disk changed since you started editing |
| `config.conflictLine` | {field}：你改成 {draft}，磁盘已是 {server} | {field}: you set {draft}, disk now has {server} |
| `config.conflictOriginal` | 原基线： | was: |
| `config.conflictAdopt` | 采用磁盘 | Use disk value |
| `config.conflictKeep` | 保留我的 | Keep mine |
| `config.conflictDismiss` | 全部忽略 | Dismiss all |

> 冲突条是「告诉用户基线过期」，**不是**「阻止保存」——用户永远可以保留自己的值
> （`conflictKeep` 只是 acknowledge，不改草稿）。三态判据见
> `src/client/features/config/configConflict.ts` 文件头。

## 4. 备份与回滚（cycle-83 新增 8 条）

| key | zh | en |
| --- | --- | --- |
| `config.backupTitle` | 备份与恢复 | Backups & restore |
| `config.backupNone` | 暂无备份（首次保存后才会生成） | No backups yet (created on first save) |
| `config.backupRestore` | 恢复 | Restore |
| `config.backupPreviewRestore` | 预览恢复 | Preview restore |
| `config.backupRestoring` | 恢复中… | Restoring… |
| `config.backupRestored` | 已恢复，改动字段数 | Restored, fields changed |
| `config.backupRestoreFailed` | 恢复失败：{error} | Restore failed: {error} |
| `config.backupSafety` | 回滚前状态已备份到： | Pre-rollback state backed up to: |

> `config.backupChanged` **已存在**（cycle-82 交付单里有 `config.backupAt`，
> 本次新增的 `backupChanged` 用于「改了 N 个字段」摘要）：
>
> | key | zh | en |
> | --- | --- | --- |
> | `config.backupChanged` | 改动 {count} 个字段 | {count} field(s) changed |
>
> `backupSafety` 是「回滚可再回滚」的唯一线索（安全备份路径），
> 缺这条时用户会以为回滚是单向操作。

## 5. 无需新增的部分

- 路径表**只读**文案（`config.path.*` 的 19 项、meta/dir/missing/copy/probe*）
  全部沿用 cycle-82 已合并的键，本次不改；
- 表单字段标签（`config.field.*`）、分组（`config.group.*`）、
  动作与结果反馈（`config.title` / `save` / `preview` / `saveSummary` / `saveFailed` /
  `backupAt` 等）同样不改；
- 新端点的**错误信息**是服务端机器事实（`PATH_TRAVERSAL` 等 code + 中文原因），
  不经词表——理由见 `configPaths.ts` 文件头「事实与词条分开」。

## 6. 合并后自检

```bash
node scripts/merge-cycle82-locale-closure.mjs   # 若仍需合并入口，按 Lead 的流程走
node scripts/typecheck.mjs
npx vitest run tests/unit/clientI18n.test.ts tests/unit/configEditClient.test.ts
```

预期：`i18nGhosts` 归零（不再报 `config.pathEdit*` / `config.conflict*` / `config.backup*`），
`i18nClosure` 无新增死键（全部键都有真实消费点）。
