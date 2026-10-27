# cycle-82 闭环面（第五族 + 隔离判定）i18n 键交付

> 本文件交 Lead 合并进 `locale/zh.json` 与 `locale/en.json`（本任务**禁改** `locale/*.json`）。
> 键集必须 zh/en **双向相等**（`tests/contract/i18nDeadKeyContract.test.ts` ⑤ 判红）。
> 合并后请跑 `pnpm run test -- --only=vitest` 确认零死键棘轮仍绿。

## 背景

`src/client/features/closure/closureArtifacts.ts` 与 `closureIsolation.ts` 渲染两个新分区，
其文案全部经 `t()` 取键。两文件已按本仓纪律写好**显式映射表**（`SCOPE_KEYS` / `KIND_KEYS`），
不拼接键名 —— 这样静态提取器能枚举，合并后不会产生悬空前缀。

在合并前：缺键回退链是 `当前语言 → zh → 键名本身`，即面板上会显示
`closure.artifacts.title` 这样的**裸键名**（可见的漏翻，不是空白）。这是刻意的：
静默隐藏一整块白盒面，比露出一个待翻译的键名糟得多。

## 需要的键（19 条）

| 键 | zh | en |
|---|---|---|
| `closure.artifacts.title` | `.cycles 文档生命周期（第五族）：模板 {reg}/{total} 已注册，{cons} 个有消费者` | `.cycles document lifecycle (5th cluster): {reg}/{total} templates registered, {cons} consumed` |
| `closure.artifacts.window` | `矩阵窗口：最近 {n} 个循环（更早的是历史，不逐条列）` | `Matrix window: last {n} cycles (older ones are history, not listed)` |
| `closure.artifacts.missingTotal` | `缺失点名 {n} 条（按 `cycle-N/文件` 可逐条核对）` | `{n} missing, named by `cycle-N/file`` |
| `closure.artifacts.noneMissing` | `零缺失——本窗口内每个循环的该模板都在` | `None missing in this window` |
| `closure.artifacts.coverage` | `覆盖 {pct}%` | `{pct}% covered` |
| `closure.artifacts.present` | `项目级：已就位` | `Project-level: present` |
| `closure.artifacts.absent` | `项目级：缺失` | `Project-level: absent` |
| `closure.artifacts.occurrences` | `按需触发：累计 {n} 次（0 次是健康的）` | `On-demand: {n} occurrences (0 is healthy)` |
| `closure.artifacts.moreMissing` | `（还有 {n} 条）` | `(+{n} more)` |
| `closure.artifacts.scopeCycle` | `每循环应有` | `per-cycle` |
| `closure.artifacts.scopeProject` | `项目级单份` | `project-level` |
| `closure.artifacts.scopeOnDemand` | `按需触发` | `on-demand` |
| `closure.artifacts.hint` | `判定口径：方格 = 该循环该模板是否存在（右新左旧）；只有「每循环应有」类点名缺失。事故/复盘零发生不算缺失。` | `Legend: a square = whether that template exists in that cycle (oldest→newest). Only per-cycle templates are named as missing; zero incidents/retrospectives is healthy.` |
| `closure.isolation.ok` | `跨项目隔离：{n} 条持久化路径全部落在工作区内（零越界 / 零 cwd 兜底）` | `Cross-project isolation: all {n} persistence paths stay inside the workspace` |
| `closure.isolation.broken` | `跨项目隔离**未通过**：{v} 条污染违规 / {d} 条死登记——先修这里，再看下面任何数字` | `Cross-project isolation FAILED: {v} contamination violations / {d} dangling entries — fix this before trusting any number below` |
| `closure.isolation.scanned` | `扫描源码 {n} 个文件` | `{n} source files scanned` |
| `closure.isolation.dangling` | `死登记（登记表有、源码无锚点）：{list}` | `Dangling registrations (registered but no source anchor): {list}` |
| `closure.isolation.moreViolations` | `（还有 {n} 条违规未列出）` | `(+{n} more violations not listed)` |
| `closure.isolation.hint` | `判定只看路径来源：每条读写路径必须能由 workspace 根 + 相对段推导出来。`..` 逃逸 / `process.cwd()` 兜底 / 写死绝对路径都会被点名。` | `Judgement reads path provenance only: every read/write path must derive from the workspace root. `..` escapes, `process.cwd()` fallbacks and hardcoded absolute paths are all flagged.` |
| `closure.isolation.kind.escape` | `路径越界` | `path escape` |
| `closure.isolation.kind.cwdFallback` | `cwd 兜底` | `cwd fallback` |
| `closure.isolation.kind.absolute` | `写死绝对路径` | `hardcoded absolute path` |

> 实际条数 = 22（上表逐行）。`kind.*` 三条是违规类别标签（`KIND_KEYS` 映射）。

## 合并注意

1. **zh/en 必须同时加**（`i18nDeadKeyContract` ④ 断言两文件键集全等）。
2. 键必须真的被 `t('…')` 引用，否则**立刻变死键**（同一契约 ① 会把未消费键集钉成
   精确集合相等）。本文件的键由 `closureArtifacts.ts` / `closureIsolation.ts` 引用，
   `SCOPE_KEYS` / `KIND_KEYS` 是显式映射表，静态可枚举。
3. 占位符用 `{name}` 形态（与既有 `closure.*` 键同风格）；`t()` 用正则逐个替换，
   缺参时保留原文（不会抛错）。

## 相关测试

- `tests/unit/closureArtifacts.test.ts` —— 矩阵/点名/作用域三态渲染 + 反向自检
- `tests/unit/closureIsolation.test.ts` —— 隔离行两态 + 违规点名 + 死登记分开显示
- `tests/contract/isolationContract.test.ts` —— 注入 workspace 外绝对路径必须被点名
- `tests/contract/i18nDeadKeyContract.test.ts` —— 合并后零死键棘轮（Lead 合并时跑）
