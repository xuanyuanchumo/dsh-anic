# dsh-anic CHANGELOG

## v0.4.0 — 2026-10-17

深度研究驱动的优化迭代：三路研究（docs/anic 差距矩阵 / DSH 官方规范取证 / context7 UI 规划）落地为 10 项 P0 修复 + 7 项 P1 + 文档体系 + 双端真实验证。测试 380→465 用例（+6 文件）。

### P0 修复（全部带回归测试）

- **P0-1 `purpose:'review'` 违反宿主闭合枚举**：`GenerateOptions.purpose` 收紧为 `'compaction'|'session-title'`（`dsh-llm types.d.ts:530`），评审传输不再传 purpose；归因走 ANIC 自有通道 `buildAttribution`（provider/model/promptDigest/evidenceIds，调用前可得）。
- **P0-2 多门评审恒 doubt**：`nativeRoute` 原空证据 map → 新建 `host/llm/gateEvidence.ts` 从真实账本（G0-G3 按 timestamp 取最新）+ 工件（intent/spec/plan 两代路径容差）+ 哈希链校验装配证据；fix-loop 的 verifyFn 从 `existsSync` 伪自信改为 `verifyLedger` + 收敛门全绿判定。真实工作区五门裁决：intent/spec/plan/pr approve、release 真实 FAIL（cycle-99 缺审计日志/非功能验证报告）。
- **P0-7 中文关键词判 PASS/FAIL**：`multiAgentGate` 删 `['通过','失败']`；`EvidenceItem.result` 结构化通道优先 + 语言中立标记（❌✗FAIL / ✅✓PASS）兜底；纯中文输入落 SKIP→doubt。
- **P0-8（工具）pr 门阈值**：`GATE_THRESHOLDS{intent:2,spec:2,plan:2,pr:3,release:3}` 对齐技能侧 `GATE_AGENTS`（原 pr 错为 2）。
- **P0-9（工具）空裁决集 NaN**：`aggregateVerdicts` 空集显式返回 `{verdict:'doubt',trustScore:0,passed:false}`（原 `0/0*100`=NaN 污染升降级、序列化成 null）。
- **P0-8（安全）CORS 通配符**：新建 `host/cors.ts` 默认拒绝+显式放行（回环正则锚定/环境变量 `ANIC_ALLOWED_ORIGINS`/工作区 `anic.allowedOrigins`）；配置 `*` 不重开通配符；绝不返回 `*`；17 用例含 13 种伪装来源攻击面。
- **P0（工程）typecheck 覆盖漏洞**：adapters/errors 从未被任何 tsconfig 覆盖 + 7 个类型错误潜伏 → include 修正（shared→client；host+adapters→host）+ `tests/contract/typecheckCoverage.test.ts` 穷举守卫（每个 src 文件恰好落一个 tsconfig）+ 证伪演练两条。
- **P0（i18n）客户端零 t()**：新建 `client/i18n.ts` 零依赖（JSON import + 回退链 当前语言→zh→键名 + {param} 插值）；locale 双语 +133 键。
- **P0（反馈）自举按钮零反馈**：四态（idle/running/ok/failed）+ aria-live 播报 + 409 已初始化语义修正（原误报失败）+ `features/selfinit/useSelfInit.ts` 特性模块。
- **P0（兼容）DSH 宿主下限真正生效**：`engines.dsh` 不被任何代码读取（兼容性门只读 peerDependencies 的 `@deepseek-ai/dsh*` 条目，`dsh-app-boot/lib/index.js:286-313`）→ peerDependencies 补 `"@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.4.0"`（semver 实测：写 `>=0.2.0` 会误杀 rc.2 宿主）。

### P1 修复

- **autonomy 双投影矛盾**（图 L4 vs org L2 硬编码）：`orgStatus` 读 `.cycles/config.yml`（INV-25 唯一 loader）+ `configuredBand` 字段；真实宿主复验 L4/L4 一致。
- **F39 错误码分派**：可重试码（CONTEXT_WINDOW_EXCEEDED 族）缩证据重试恰一次；不可重试码（QUOTA 族）标注；notes 记录重试轨迹。
- **T3 守卫真实拦人两次**：`reviewEngine` 303→196+134 行（拆 `reviewTransport.ts` 传输层）——「拆分而非放宽」。
- **SKILL.md 补 `whenToUse`**（`dsh-skill types.d.ts:52` 目录条目路由提示）。
- **交互态令牌**：`anic-surface-hover/active`（DECORATIVE）+ `anic-focus-ring`（NON_TEXT_ROLES，双档对比度实测 4.94/3.454）；contrastContract 穷举分类登记。

### 文档

- 新增三篇：`docs/agents/DSH多代兼容与双端适配.md`（兼容性门真实现/探测矩阵 D1-D8/双端差异实测/B1-B6）、`可观测性与轨迹可见性.md`（三通道/双相配对/诊断计数/验证记录）、`质量属性与全生命周期评审体系.md`（E/Q 维度/G0-G3/六项质量属性/五层金字塔）。
- `docs/agents/README.md` 文档地图 +3；G-IND 过时表述修正（机械守卫已存在）。
- `docs/anic/` 22 篇研究文档族入库；README 工具数 9→12 修正。

### 真实宿主验证（网页端 3080 + 桌面端 19387）

- 动态白盒三通道 PASS：宿主「轨迹」标签 + ANIC 面板实时调用 + feed API（anic_status 31ms t13/s1；diagnostics sessionEvents:14/anicCalls:1）。
- 裁决记录：`sessionEvents:0` ≠ scope 过滤问题（普通 `ctx.on` 正常收事件，勿加 `{global:true}`）。
- 桌面端：12 工具 + 路由 200 + ANIC 标签（用户确认）；新发现 P2——多会话宿主工作区解析取 sessions 首条 cwd。
- G0-G3 全过（gate-check --record 记账 `.cycles/gates/ledger.json`）。

### 验证

typecheck exit 0 · vitest **37 文件 465/465** · smoke 19/19 · validate 12/12 · build OK · 双端真实验证 PASS。

## v0.3.0 — 2025-01-30

技能内联 + 7 脚本原生插件化 + 双向自举 + 9 DSH 工具 + 透明性连通性增强 + 数据结构优化 + 适配器层 + 真实性审计（自举目标）。

### 真实性审计（T1-T4）
- `host/evolution/truthAudit.ts` + `truthAuditChecks.ts`：T1 真实性（22 必需目录/文件存在性检查）/ T2 准确性（src/test/agent/skill 文件计数 + 版本）/ T3 结构性（250 行模块限制 + 域分离）/ T4 逻辑性（路由注册 + index 导入 + 工具数 ≥9）。
- `dualBootstrap.ts` 评估权重 60% 基线 + 40% 审计分（真实性作为自举目标，用户 m04764）。
- GET `/anic/api/truth-audit` 路由 + 6 单元测试。
- vitest 147→153。

### 新增

- **技能内联**：`assets/skill/` 63 文件全量内联；`POST /anic/skill/install` 自动安装/更新（幂等版本比对）；`GET /anic/skill/status` 查询来源（workspace/repo/inline）；`resolveSkillScriptsDir` 三层混合查找。
- **7 原生等价物**：hitlAudit (H1-H4) / bandDetector / orgStatus / factBaseVerify / planSync / multiAgentGate (5门×3角色) / fixLoop (verify→diagnose→fix→re-verify)。7 路由注册。
- **双向自举**：`dualBootstrap.ts` DualBootstrapState {plugin, skill, crossProposals}；evaluatePluginSelf + evaluateSkillSelf + advanceDualBootstrap（不互相改码 R-31）。3 路由。
- **9 DSH 工具**：原 6 + anic_hitl + anic_install + anic_status。
- **透明性连通性**：面板新增 org status 全景区（cycle 列表 + 信任分 + 自主级 + 熔断 + 带检测 + 警告），并行 fetch 四数据源。
- **测试**：`tests/unit/native.test.ts` 20 例（bandDetector 2 + multiAgentGate 7 + fixLoop 3 + hitlAudit 2 + factBaseVerify 1 + planSync 1 + orgStatus 1 + skillInvoker 3）。
- **数据结构优化**：`snapshotCore.ts` cycleDirs.find O(n)→Map.get O(1) + nodes.some O(n)→Set.has O(1)（消除两处 O(n²) 热点）；`stateMachine.ts` parseWorkflowGraph 直接引用替代 find O(n)→O(1) + buildGraphIndex(nodeMap+predecessors) advance 热路径 O(n)+O(e)→O(1)。
- **适配器层**：`adapters/index.ts` FsAdapter/ExecAdapter/HttpAdapter 三接口 + createNodeAdapters 生产实现（Q5 架构约束：外部服务隔离，eval-runner PASS）。
- **模块化**：WorkflowGraphPanel.ts 303→~140 行，纯渲染提取至 `features/graph/renderGraph.ts`（155 行，12 §3.1 特性模块制）。
- **lint 脚本**：package.json scripts.lint = validate-dsh.mjs（Q7 修复）。

### 变更

- `package.json` version 0.2.0→0.3.0。
- `routes/index.ts` 注册 nativeRoute + skillInstallRoute + dualBootstrapRoute。
- `tools.ts` 6→9 工具。
- `WorkflowGraphPanel.ts` 新增 org status fetch + 渲染区。

### 验证

typecheck 0/0 · vitest 147/147 · smoke 19/19 · validate 12/12 · build OK。

## v0.2.0 — 2025-01-30

自举闭环 + 跨项目技能调用 + DSH 工具注册 + 结构优化。

### 新增

- **M7 自举闭环**：`host/selfBootstrap.ts` 状态机（IDLE→EVALUATING→GATE_CHECKING→FIXING→VERIFYING→CONVERGED/EXHAUSTED）+ `host/skillInvoker.ts` 15 脚本白名单 + 路径遍历防护 + 4 路由（self/evaluate + gate-check + iterate + status）。不自我改码（R-31），只产 tech-debt 提案。
- **M8 跨项目+DSH 工具**：`host/tools.ts` 6 DSH 工具注册（anic_evaluate / iterate / gate_check / bootstrap / snapshot / self_check），inject 扩展为 ['tools','webServer','sessions']；skillRoute 4 路由（skill/list + invoke + evaluate + iterate），支持 workspace 参数跨项目调用。
- **M9 结构优化**：routes/index.ts 从 135 行瘦身至 ~75 行纯组合层；提取 routeContext.ts（makeSend + getWorkspaceRoot + loadFlows 单一职责）；六域分区（data/cycle/review/evolution/governance/self）。

### 路由清单（34 条）

| 域 | 路由 | 数 |
|---|---|---|
| data | workflow-snapshot / step-trace / self-check / self-init | 4 |
| cycle | cycle/init+advance+close+state+list / ledger+append+verify / stack-probe / seg-ledger+init+append+verify | 13 |
| review | review | 1 |
| evolution | trust / autonomy / breakers / tech-debt | 4 |
| governance | archive / budget / sweep / prune | 4 |
| self | self/evaluate+gate-check+iterate+status / skill/list+invoke / evaluate / iterate | 8 |

### 验证

- typecheck 0/0 · vitest 127/127 · smoke 19/19 · validate-dsh 12/12 · build OK

---

## v0.1.0 — 2025-01-30

首个里程碑版本。从 v0.0.1（M0-① spike）演进至全功能面实现。

### 新增

- **M1 全功能面**：四路由（workflow-snapshot / step-trace / self-check / self-init）+ 三面板（图 / 步骤追踪 / 诊断）+ 九开关（三层：用户 prefs > 工作区 config.yml > 部署 bundle）+ 十五 agent 卡（5 门 × 3 角色）+ 配置唯一 loader + scoped logger + 四域错误码。
- **M2-a 运行时接管**：工作流状态机（前驱检查 + gate 需 approved）+ 哈希链账本（sha256 canonical 六字段键序 + 原子写 + 幂等查重）+ 多栈探测（node/cargo/python/go/generic）+ cycle 生命周期（init/advance/close）+ 9 路由。
- **M2-b 规模地基**：分段账本（head.json + seg-NNNNNN.jsonl 只追加，O(1) append）+ 4 路由。
- **M3 可视化完整版**：门禁三态色（PASS 绿 / FAIL 红 / doubt 黄 / pending 灰）+ FAIL 脉冲动画（prefers-reduced-motion 禁用）+ 控制带 2σ3σ 边框 + 节点点击详情抽屉。
- **M4 LLM 评审引擎（条件）**：ctx.get('llm', false) 探测（INV-24 不进 inject）+ 闭合 JSON 协议校验（INV-23 fail-closed → doubt）+ Tier-1 启发式降级（诚实标注「非模型评审」）+ POST /anic/review 路由。
- **M5 动态自主进化引擎**：TrustModel（信任度累积 → 自主级别推荐）+ AutonomyGovernor（8 熔断条件，先修复后降级）+ PatchEngine（技术债务提案，不自我改码）+ 4 路由。
- **M5-a 规模治理**：Archiver（归档旧 cycle，移动不删除）+ Budget（三级阈值预算检查）+ Sweep（清空目录与过期 .tmp）+ Prune（孤儿工件识别）+ 4 路由。
- **M6 通用性收口**：i18n 双语（zh + en）+ 版本升至 v0.1.0 + CHANGELOG。

### 路由清单（26 条）

| 方法 | 路径 | 里程碑 |
|------|------|--------|
| GET | /anic/api/workflow-snapshot | M1 |
| GET | /anic/api/step-trace | M1 |
| GET | /anic/api/self-check | M1 |
| POST | /anic/self/init | M1 |
| POST | /anic/cycle/init | M2-a |
| POST | /anic/cycle/advance | M2-a |
| POST | /anic/cycle/close | M2-a |
| GET | /anic/cycle/state | M2-a |
| GET | /anic/cycle/list | M2-a |
| GET | /anic/api/ledger | M2-a |
| POST | /anic/api/ledger/append | M2-a |
| GET | /anic/api/ledger/verify | M2-a |
| GET | /anic/api/stack-probe | M2-a |
| GET | /anic/api/seg-ledger | M2-b |
| POST | /anic/api/seg-ledger/init | M2-b |
| POST | /anic/api/seg-ledger/append | M2-b |
| GET | /anic/api/seg-ledger/verify | M2-b |
| POST | /anic/review | M4 |
| GET | /anic/api/trust | M5 |
| GET | /anic/api/autonomy | M5 |
| POST | /anic/api/breakers | M5 |
| POST | /anic/api/tech-debt | M5 |
| POST | /anic/governance/archive | M5-a |
| GET | /anic/governance/budget | M5-a |
| POST | /anic/governance/sweep | M5-a |
| GET | /anic/governance/prune | M5-a |

### 测试

- validate-dsh：12/12 PASS
- vitest：115/115 PASS（8 文件）
- offline-smoke：19/19 PASS
- typecheck：client 0 / host 0
- build：dist/client.js + dist/host.js OK
