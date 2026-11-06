---
name: skill-library-evolution
version: 0.1.1
whenToUse: >
   当 dsh-anic 的内部技能库需要制度化自我更新时使用：取证评估叶技能、生成/校验版本锚点、
   检测漂移、产出补丁提案并 keep/revert、跑聚合基准（with_skill vs without_skill）、做镜像同步。
   触发词：自进化、技能更新、版本锚点、漂移守卫、补丁回滚、聚合基准、镜像同步、
   skill evolution、self-evolving skill library、drift guard、patch keep/revert、
   aggregate benchmark、mirror sync。人类在涉及代码/发布/凭据的变更处保留判断权（R01/R02）。
description: >
   Triggers: 自进化、技能更新、版本锚点、漂移守卫、补丁回滚、聚合基准、镜像同步、
   skill evolution、self-evolving skill library、drift guard、patch keep/revert、
   aggregate benchmark、mirror sync. Use when a skill library needs institutional
   self-update: snapshot baseline → old eval → forensics → fix → contract dual-run
   → end-to-end A/B → aggregate benchmark + mirror sync. 三锚一致、信任分、8 熔断、
   先修复后降级（升级需人类、降级可自动）。
---

# skill-library-evolution（元技能）

> dsh-anic 内部技能库的**自进化引擎**。它不评审自己以外的流程，只负责一件事：
> 让叶技能（git/GitHub/Gitee/npm/CI-CD/Token/DSH-API/superagent）在**证据与门禁约束下自我更新**，
> 同时不违反 12 号宪章（不自我改写代码、升级需人类、降级可自动）。

## 一、定位与边界

| 项 | 内容 |
|---|---|
| 对象 | `assets/skills/` 下全部技能（**9 叶 + 1 元**，与 `skills.index.json` 的 `skills[].tier` 一致）+ 注册表 |
| 输入 | 库快照、调用历史、账本事件、漂移信号 |
| 输出 | 补丁提案 / 升级 / 回滚 / 基准报告 / 账本新条目 |
| 边界 | **不修改主干技能** `ai-native-iteration-cycle`（它是流程脊柱，由独立 cycle 治理） |
| 不做的事 | 不自我改码（R-31）；不放宽词表/门定义；不静默改写历史（H4 append-only） |

## 二、硬性规则

| # | 规则 | 说明 |
|---|---|---|
| E1 | 三锚一致 | SKILL.md / 脚本版本串 / CHANGELOG + 注册表 四处版本必须一致；找不齐即报错 |
| E2 | 守卫必须能失败 | 每个漂移守卫都要有反向自检 + 样例拼接构造 + 扫描集非空下限 |
| E3 | 无证据 ≠ 通过 | 叶技能证据映射 E1-E8/Q1-Q8，三态裁决 PASS/FAIL/SKIP |
| E4 | 补丁可回滚 | 补丁包自带 `rollbackHash`；revert = 原子还原 + 账本新条目（不改历史） |
| E5 | 升级需人类 | 涉及代码/发布/凭据的变更走 PR + 人类批准；参数与技能内容可自动修订 |
| E6 | 降级可自动 | 8 熔断触发后先修复后降级；修复失败才 L4→L3 |
| E7 | 账本留痕 | 所有写点走 `lib/ledger.mjs` canonical 载荷；归档不碰链（INV-9） |
| E8 | 镜像零差异 | `.dsh/skills/*` ↔ `assets/skills/*` 逐字节相等 |

## 三、自进化七步（skill-creator 式）

```
快照基线 → 旧评测基线 → 全文取证 → 抽取共享库→修技能 → 契约断言（新旧双跑）
→ 端到端 A/B → 聚合基准 + 镜像同步
```

| 步 | 动作 | 现状（2026-11-06 实测） | 命令 / 替代 |
|---|---|---|---|
| 1 快照基线 | 冻结旧版（含 sha256 清单）到 `.cycles/skill-snapshot/` | ✅ **可执行** | `skill-lib-manifest.mjs <ws> --snapshot` |
| 2 旧评测基线 | 跑旧版评测，记录通过率 | ⛔ **未实现**（无 `skill-lib-bench.mjs`） | 手工：`git stash`/`git switch` 到旧版 → 跑各叶技能 `scripts/*.mjs` → 把结果写进账本 `SKILL_EVIDENCE_LINK` |
| 3 全文取证 | 读全部 references/scripts，列证据 | ✅ **人可执行**（确定性脚本不代做） | 人工/subagent；要求 file:line 可查 |
| 4 修技能 | 抽取共享库 → 改 SKILL.md/scripts | ✅ **可执行** | 编辑；单文件 ≤250 行 |
| 5 契约双跑 | 新版 vs 快照的"旧版必须复现缺陷" | ⚠️ **半实现**：无 `--contract` 旗标；反向证明由两个 `--selftest` 承担 | `skill-lib-manifest.mjs --selftest` + `skill-lib-drift.mjs --selftest`（守卫必须能失败） |
| 6 端到端 A/B | 两个独立 subagent 走完整流程 | ⛔ **未实现**（无 `bench --ab`） | 手工 A/B + 账本 `SKILL_EVIDENCE_LINK` |
| 7 聚合基准 + 镜像 | with/without 对照 + 双副本逐字节比对 | ⛔ **未实现**（无 `--aggregate`；本仓无 `.dsh/skills/` 镜像目录） | 手工：`diff -r assets/skills .dsh/skills`（镜像存在时）；差值写入账本 |

> **诚实修正（v0.1.1）**：v0.1.0 的此表曾引用三个**从未存在**的脚本
> （`skill-lib-bench.mjs --old/--ab/--aggregate` 与 `skill-lib-manifest.mjs --contract`），
> 使七步看起来"全自动可跑"。实际只有第 1、3、4 步有可直接执行的载体，第 5 步靠自检，
> 第 2/6/7 步仍是**人工程序**。这是"文档承诺 > 实现"的典型缺口，本轮改成如实标注，
> 并把「未实现」写成可验证状态（跑给定命令会怎样）而不是含糊的"未来支持"。

### 已实现的确定性能力（只有这三个脚本，别再引用别的）

```sh
S=assets/skills/_meta/skill-library-evolution/scripts
node $S/skill-lib-manifest.mjs <ws> --check       # 三锚 + dir 字段（错误级 exit 1）
node $S/skill-lib-manifest.mjs <ws> --report      # 只读报告（exit 0）
node $S/skill-lib-manifest.mjs <ws> --snapshot    # 冻结 sha256 清单
node $S/skill-lib-manifest.mjs --selftest         # 反向自检：缺 dir/形状不符必须红
node $S/skill-lib-drift.mjs <ws> --check          # 漂移守卫（错误级 exit 1）
node $S/skill-lib-drift.mjs --selftest            # 反向自检：三类违规必须红
node $S/skill-lib-ledger.mjs <ws> --record <EVENT> --skill <name> [--detail "…"] [--extra-json '{}']
node $S/skill-lib-ledger.mjs <ws> --verify        # 哈希链校验
node $S/skill-lib-ledger.mjs <ws> --list          # 全部条目
```

## 四、三锚一致（版本锚点）

每个技能四处版本必须一致：

1. `SKILL.md` frontmatter 或正文的版本标注；
2. `scripts/<primary>.mjs` 的 Server/工具版本串；
3. `CHANGELOG.md` 顶层条目；
4. `skills.index.json` 的 `version`。

```sh
# 校验（错误级 exit 1）
node assets/skills/_meta/skill-library-evolution/scripts/skill-lib-manifest.mjs <workspace> --check
# 只读报告（exit 0）
node assets/skills/_meta/skill-library-evolution/scripts/skill-lib-manifest.mjs <workspace> --report
```

## 五、漂移守卫（四类声明，实际实现三类 + 一项未实现）

| 守卫 | 检查 | 实现状态 |
|---|---|---|
| 注册表字段 | `dir` 必填（缺字段曾让 9 条叶技能在机器面隐身） | ✅ `registry:dir` |
| 版本锚 | SKILL.md frontmatter 版本 == 注册表版本 | ✅ `anchor:version` |
| 词表绑定 | 用 A 族维度词，无 B 族残留 | ✅ `vocabulary:B-family` |
| 原子写 | 写 `.cycles/**` 必须 `atomicWriteFileSync` 或 temp+rename | ✅ `atomic-write` |
| 配置入口 | `.cycles/config.yml` 唯一入口，禁第二入口 | ⛔ **未实现**（无可机械判定的形态，不假装有） |

**失败动作的真相**：`--check` 违规只做 `exit 1` + 点名技能与文件名，**不会**自动写
`SKILL_DRIFT_ALARM`（脚本里没有这个动作）。要入账由人执行
`skill-lib-ledger.mjs <ws> --record SKILL_DRIFT_ALARM --skill <name> --detail "…"`。
把"自动入账"写成既有能力就是第二个假守卫。

## 六、补丁生命周期

```
proposed → human-approved → applied → benchmarked → kept | reverted
```

| 状态 | 含义 | 写入 |
|---|---|---|
| `proposed` | 元技能产出补丁包 `{proposed, reason, evidenceIds, riskScore, rollbackHash}` | `.cycles/tech-debt/` + 账本 |
| `human-approved` | 人类批准 | 账本 `SKILL_PATCH_KEPT` 前置 |
| `applied` | 应用（原子） | 账本 |
| `benchmarked` | 聚合基准达标 | 账本 + 基准报告 |
| `kept` | 保留 | 账本 `SKILL_PATCH_KEPT` |
| `reverted` | 回滚（原子还原 + 账本新条目） | 账本 `SKILL_PATCH_REVERTED`（不改历史） |

**关键**：`rollbackHash` 是应用前快照的 sha256；revert 必须原子还原，**不得**原地改写已落账的条目
（那会毁哈希链，即 H4 违规）。

## 七、信任分与熔断

- **信任分**（0-100）：`契约通过率 × 基准 delta × 账本完整率 × 漂移守卫清洁度`。
- **阈值**：L2→L3 ≥ 70；L3→L4 ≥ 85（与主干 `multi-agent-gate`/`org-status` 同源）。
- **8 熔断**：同技能连续 3 次修复失败 / 门禁判定存疑 / 真实凭据无隔离 / 破坏性不可回滚 /
  性能超预警 / 人类要求审计 / 会话超时或上下文 >85% / 累计重试 >10 或熔断 >3。
- **先修复后降级**：Phase1 诊断 → Phase2 修复（`auto-fix-loop`）→ 仍失败才 Phase3 降级（L4→L3）。

## 八、与主干技能的闭环对接

| 主干环节 | 技能库输入 | 技能库输出 | 对接点 |
|---|---|---|---|
| 评估 E1-E8/Q1-Q8 | 操作手册 + 脚本 | 证据工件 + 评估行 | `eval-runner` 消费叶技能 `evals/` |
| 门禁 G0-G3 | 叶技能检查结果 | 门禁判定 | `gate-check --record` 入账本 |
| 修复 auto-fix-loop | 叶技能故障手册 | 修复步骤 + 补丁提案 | `skill-lib-patch` + tech-debt |
| 复盘 retrospective | 账本事件 | 量化指标 + 新 eval | `skill-lib-bench` 基准报告 |
| 熔断/自主级 | 信任分 + 8 CB | 降级/升级提案 | `org-status` / `anic_autonomy_*` |
| 跨项目调用 | 主干跨项目契约 | 目标工作区技能安装 | `anic_install {library:true}` |

## 九、导航索引

| 需要了解 | 读取 |
|---|---|
| 七步方法学细则 | `references/evolution-model.md` |
| 漂移守卫实现 | `scripts/skill-lib-manifest.mjs` / `skill-lib-drift.mjs` |
| 账本 canonical 载荷 | 主干 `assets/skill/scripts/lib/ledger.mjs` |
| 词表唯一来源 | 主干 `assets/skill/scripts/lib/dimensions.mjs` |
| 叶技能清单 | `assets/skills/skills.index.json` |
