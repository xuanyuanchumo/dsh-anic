# 自进化模型（evolution-model.md）

> 元技能 `skill-library-evolution` 的方法学细则。七步流程、信任分合成、熔断语义、账本留痕。

## 1. 为什么需要元技能

叶技能（git/GitHub/Gitee/npm/CI-CD/Token/DSH-API/superagent）承载的是**操作知识**。
知识会过期：Gitee API 变、npm 政策变、DSH 原生 seam 变、本仓 CI 顺序变。
没有制度化自我更新，技能库就会变成**第二份文档**——比没有更糟（它看起来可执行，实际会误导）。

元技能的职责不是"让技能自动改代码"，而是：

1. **让变化被证据捕获**（取证 → 评估 → 基准）；
2. **让变化可审计**（账本留痕 + 三锚一致）；
3. **让变化可回滚**（rollbackHash + keep/revert）；
4. **让变化受人类门约束**（升级需人类、降级可自动）。

## 2. 七步流程详解

### 第 1 步：快照基线

冻结旧版到 `.cycles/skill-snapshot/<skill>/`，含 sha256 清单。**为什么**：
没有快照就无法做"新旧双跑"，也无法证明"这次改动真的改变了行为"。

```sh
node scripts/skill-lib-manifest.mjs <workspace> --snapshot
```

### 第 2 步：旧评测基线

跑旧版的契约/端到端评测，记录通过率。**为什么**：
`with_skill` vs `without_skill` 的 delta 需要基线。基线为零会掩盖退化。

### 第 3 步：全文取证

读全部 `references/` 与 `scripts/`，逐条列证据（`file:line`）。
**为什么**：技能的可信度来自证据接地，不是来自"我觉得对"。

### 第 4 步：修技能

抽取共享库 → 改 SKILL.md/scripts。**纪律**：

- 单文件 ≤250 行（沿用主干模块化纪律）；
- 一域一文件；
- 新增脚本必须入 `SKILL_SCRIPTS` 白名单（若需要被插件调用）；
- 零外部依赖（除非有充分理由）；
- 绝不写明文凭据。

### 第 5 步：契约双跑

`skill-lib-manifest.mjs --contract` 场景化双跑（新版 vs 快照）。
**关键**：旧版必须复现缺陷——如果旧版也通过，说明**场景无效**，必须换场景。
这是"守卫必须能失败"的实例。

### 第 6 步：端到端 A/B

两个**独立** subagent 分别用新旧版在 toy 项目走完整流程（R12 命名可见 + 有界报告）。
**为什么**：契约断言抓不到"模型实际怎么用"的问题。

### 第 7 步：聚合基准 + 镜像同步

`with_skill` vs `without_skill` 通过率 delta 作为**升级门槛**（delta 不得下降）。
`.dsh/skills/*` ↔ `assets/skills/*` 逐字节相等（0 差异）。

## 3. 信任分合成

```
trust = w1 * contractPassRate          // 契约通过率（0-1）
      + w2 * benchmarkDelta            // 聚合基准相对基线的变化（-1..1，归一到 0-1）
      + w3 * ledgerIntegrity           // 账本完整率（0-1，verify 通过即 1）
      + w4 * driftGuardCleanliness     // 漂移守卫清洁度（0-1，四类全过即 1）
```

权重建议：`w1=0.35, w2=0.25, w3=0.2, w4=0.2`（契约优先，因为它是可机器判定的硬证据）。

阈值：L2→L3 ≥ 70；L3→L4 ≥ 85（与主干 `multi-agent-gate`/`org-status` 同源，避免两套标准）。

## 4. 熔断语义（先修复后降级）

| 阶段 | 动作 | 失败时 |
|---|---|---|
| Phase 1 诊断 | 定位根因（失败模式分类：repeating/cascading/transient） | 记录 incident |
| Phase 2 修复 | 自动修复（仅限非破坏性面） | 记 `SKILL_DRIFT_ALARM` |
| Phase 3 降级 | 连续 3 次修复失败才 L4→L3 | 账本 `SKILL_LIB_AUTONOMY_CHANGE` |

**关键**：降级可自动，**升级必须人类**（12 号宪章）。

## 5. 账本留痕（append-only）

事件类型：

| 事件 | 含义 |
|---|---|
| `SKILL_PATCH_PROPOSED` | 补丁提案落 tech-debt |
| `SKILL_PATCH_KEPT` | 补丁通过基准，保留 |
| `SKILL_PATCH_REVERTED` | 补丁回滚（原子还原 + 新条目） |
| `SKILL_VERSION_BUMP` | 技能版本变更 |
| `SKILL_DRIFT_ALARM` | 漂移守卫报警 |
| `SKILL_LIB_AUTONOMY_CHANGE` | 技能库自主级变更 |
| `SKILL_EVIDENCE_LINK` | 证据工件与账本关联 |

**不可变纪律**：

- `archive-cycle` 只移动目录不碰账本（INV-9）；
- H4 不原地改写 `entry.detail`（改历史即 HASH_MISMATCH）；
- revert 的语义是**追加新条目 + 还原工作区文件**，不是改历史。

## 6. 与 ANIC 主干闭环的对接点

| ANIC 主干环节 | 元技能输入 | 元技能输出 |
|---|---|---|
| 评估 E1-E8/Q1-Q8 | 技能操作手册 | 证据工件 + 评估行 |
| 门禁 G0-G3 | 叶技能检查结果 | 门禁判定（入账本） |
| 修复 auto-fix-loop | 叶技能故障手册 | 修复步骤 + 补丁提案 |
| 复盘 retrospective | 账本事件 | 量化指标 + 新 eval |
| 熔断/自主级 | 信任分 + 8 CB | 降级/升级提案 |

## 7. 明确不做的事（防漂移）

- **不做五注册表**（FlowRegistry 单注册表已验证，扩展面失控风险高）。
- **不自我改写代码**（R-31：代码进化 = 评估缺口 → tech-debt → 下一轮 cycle 任务清单）。
- **不放宽词表/门定义**（评审器只允许 Tier-1 确定性断言 + 人类门改词表/门定义）。
- **不让叶技能 import 父工程 `src/`**（G-IND 守卫扩展）。
- **任何技能不打印/写入明文令牌**（一律 `vault_run` 注入，H1 熔断）。
