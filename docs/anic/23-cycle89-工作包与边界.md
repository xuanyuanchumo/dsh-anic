# cycle-89 工作包与并行边界（L4 自举迭代轮）

> 本文件是 cycle-89 的唯一并行分工权威。所有 agent 动手前先读本文件；
> 边界冲突时**以本文件为准**，不要靠"看别人怎么改"推断。

## 0. 起点事实（基线）

- 版本 `0.48.0`；基线提交 `0102d86`（cycle-83..88 未入库工作树快照）。
- 基线绿灯证据：`pnpm run typecheck` exit 0；`pnpm run test` 203 文件 / 2683 用例
  PASS + smoke PASS + trigger PASS；`pnpm run build` 出 `dist/client.js` + `dist/host.js`。
- 自举状态 **陈旧**：`.cycles/self-bootstrap.json` 停在 2026-10-28 `EXHAUSTED`（3 轮，
  evalScore 0），而 cycle-88 的 eval/gate 实际全 PASS —— 这正是本轮 P0 要修的
  「历史产物压过最新项目事实」。

## 1. 本轮八个目标（用户点名）

| # | 目标 | 验收面 |
|---|---|---|
| G1 | 自举可从**最新项目事实**重启；归档产物只作历史，不干扰判断 | 重启后 `self-bootstrap.json` 带 facts 基线（git HEAD / 轮号 / 账本链头 / 评估报告指纹），面板显示「陈旧」与「可重启」 |
| G2 | 「举他」：跨工作区自举（对外项目跑同一循环）且互不污染 | 目标工作区独立 `.cycles/`，源工作区零写入 |
| G3 | 注册→生产→消费三态连通性 + 流程↔循环↔相位↔门禁 **join key** | flow 记录带 cycle/phase/gate 归属；面板可按下钻 |
| G4 | `.cycles` 全生命周期可观测 + 配置/路径**自定义**可视化编辑 | 面板可增删改自定义路径覆盖并回滚 |
| G5 | 前端（尤其图谱）现代化 / 可交互 / 功能增强 | 图谱新交互有契约测试 + 截图证据 |
| G6 | 多项目隔离显示不污染 | 客户端拒绝跨工作区载荷；视图态按工作区分键 |
| G7 | 热更新重载插件 | 构建后 `anic_reload_self` 真机 reloaded 且 revision 变更 |
| G8 | 质量闭环 + 技术债清理 | eval-runner 16 维 PASS / G0-G3 PASS / 债务队列无新增 stale |

## 2. 并行写域（**硬边界**）

| 工作包 | 负责人 | 可写路径 | 只读路径 |
|---|---|---|---|
| WP-A 研究吸收 | `research-kb` | `docs/anic/23-外部研究吸收*.md`（新建）、`docs/anic/README.md` | 全部源码 |
| WP-B 图谱前端 | `graph-ui` | `src/client/features/graph/**`、`src/shared/panelCss.ts`、`src/shared/tokens.ts`、`tests/{unit,contract}/graph*.test.ts`、`scripts/graph-preview*.mjs`（新建） | 其余 client 模块 |
| WP-C 自举/归档/举他 | `bootstrap-facts` | `src/host/selfBootstrap.ts`、`src/host/runtime/bootstrap*.ts`、`src/host/runtime/artifactArchive*.ts`、`src/host/routes/selfBootstrap*.ts`、`src/host/routes/archiveResetRoute.ts`、`src/host/toolsBootstrapGateway.ts`、`tests/{unit,contract}/{selfBootstrap*,bootstrap*,artifactArchive,archiveReset}*.test.ts` | 其余 host 模块 |
| WP-D 可观测/隔离/配置 | `observability` | `src/host/runtime/flowTracker.ts`、`src/host/runtime/invocationAttribution.ts`、`src/host/flows/**`、`src/host/configEdit/**`、`src/host/routes/{configRoute*,flowsRoute}.ts`、`src/client/features/{flows,stepTrace,diagnostics,config}/**`、`src/client/panelLiveTargets.ts`、`tests/{unit,contract}/{flow*,invocation*,config*,stepTrace*,diagnostics*}*.test.ts` | 其余模块 |

**Lead 独占（任何人不得写）**：
`package.json`、`README.md`、`locale/*.json`、`scripts/generate-snapshot.mjs`、
`scripts/build-client.mjs`、`scripts/run-tests.mjs`、`src/client/WorkflowGraphPanel.ts`、
`src/client/components/**`、`src/shared/snapshotCore.ts`、`src/shared/snapshotProjection/**`、
`src/host/routes/index.ts`、`src/host/tools.ts`、`src/host/toolsSlot.ts`、`dist/**`、
`tests/contract/readmeNumbers.test.ts`、`tests/contract/snapshotRoute.test.ts`、
`tests/contract/coverageEvidenceContract.test.ts`、`.cycles/**`（评估/门禁产物）。

需要新增 i18n 文案时：**不要改 locale/\*.json**，在报告里给出 `key → zh/en` 三元组，
由 Lead 合并（i18n 死键契约会拦未使用键）。代码里直接 `t('your.key')` 即可。

需要新增路由/工具时：允许改自己写域内的注册表；**不要**动 `routes/index.ts` 与
`toolsSlot.ts` 的工具清单（Lead 合并），在报告里写明「新增 N 条路由 / N 个工具」。

## 3. 工程纪律（每一条都会被机器守卫）

1. **单文件 ≤ 250 行**（`truthAuditChecks` T3 机械守卫）；超了就按职责拆，不留超长文件。
2. **中文注释**：文件头必须说明「为什么这样做 / 反例是什么 / 边界在哪」，不是复述代码。
3. 纯函数优先：布局/筛选/追溯/分诊一律零 DOM、零 clock、零 random，可独立单测。
4. ESM only，import 带 `.ts` 扩展名；不新增运行时依赖。
5. 不允许 `console.*`，用 `scoped()` logger。
6. 失败要**响亮**（fail-closed），不要静默降级成"看起来通过"。
7. a11y：新交互必须有键盘通道与 `data-anic-*` 可断言锚点。
8. 破坏性/不可逆操作必须 dryRun 两段式（同一判据）。

## 4. 验证命令（按需跑，不要跑全量）

```bash
# 单文件
node node_modules/vitest/vitest.mjs run tests/unit/xxx.test.ts
# 只跑 vitest 层（约 55s，包内已含全量，慎用）
node scripts/run-tests.mjs --only=vitest
# 类型（各自跑，快）
node scripts/typecheck.mjs
```

**不要**运行 `pnpm run build`（Lead 独占 dist/），**不要**运行 `node scripts/run-tests.mjs`
全量（会与别的 agent 抢 CPU 且 smoke 读 dist 会看到中间态）。

## 5. 报告格式（交回 Lead）

```
## 交付
- 改动文件：<路径> —— 一句话职责
- 新增契约：<测试文件> —— N 用例，钉死什么
- 验证：<命令> → exit 0（贴关键行）
- i18n：key → zh / en（若有）
- 计数：新增路由 N / 工具 N（若有）
## 缺口（诚实清单）
- 未做/做不到的项 + 原因
## 证据
- 截图 / 命令输出 / 数据文件路径
```
