# skill-library-evolution CHANGELOG

## v0.1.1 — 2026-11-06（cycle-108：把"声称的守卫"改回"存在的守卫"）

> 起点：v0.1.0（cycle-106）。本轮做的**不是加功能**，而是把三处「文档承诺 > 实现」的地方
> 改成如实状态，并补上一个真实的口子。

### 修正 1：注册表 `dir` 必填（真缺口，本轮首次被抓到）

`skills.index.json` 的 10 条技能里**只有 1 条有 `dir`**（meta 技能），9 条叶技能全缺 ⇒
任何「按注册表遍历」的机器只能识别 1 个技能，其余 9 条在机器面等于不存在，且静默无告警。
两个脚本都因 `skillDir()` 的 `dir ?? name` 兜底而**照旧全绿**——典型的守卫休眠。

- `skill-lib-manifest.mjs`：`REQUIRED_FIELDS` 加入 `dir`；新增 `field:dir-shape`
  （leaf 必须 `dir === name`，meta 必须 `_meta/<name>`）；新增 **`--selftest`**
  （缺 dir → exit 1；形状不符 → exit 1；合规 → exit 0）。
- `skill-lib-drift.mjs`：新增 `registry:dir` 守卫；`--selftest` 由 2 例扩到 3 例。
- 注册表：9 条叶技能补显式 `dir`（**补表，不派生**——派生会让"表缺字段"永久隐身）。

### 修正 2：七步表引用了三个不存在的脚本

原文第 2/5/6/7 步写 `skill-lib-bench.mjs --old/--ab/--aggregate` 与
`skill-lib-manifest.mjs --contract`——**这四个调用一个都不存在**，等于把七步包装成全自动。
本轮改为逐行标注 ✅可执行 / ⚠️半实现 / ⛔未实现，并给出每一步的**替代做法**与验证方法；
另附「已实现的确定性能力（只有三个脚本）」清单，防止再被引用错。

### 修正 3：第四类守卫「配置入口」从未实现

`skill-lib-drift.mjs` 头部注释列了四类守卫，第 4 类「配置入口（INV-25）」**只有一行注释、
没有代码**；`SKILL.md` 却写着它的失败动作是"拒绝并记 `SKILL_DRIFT_ALARM`"——而**没有任何
脚本会写这个事件**。本轮把两处都改成如实状态：守卫标 ⛔未实现（并说明为什么"无判据硬写
只会变成误报源"），入账改为**人工** `--record SKILL_DRIFT_ALARM`。

### 其他

- `SKILL.md`：对象数「8 叶 + 1 元」→「**9 叶 + 1 元**」（与注册表 `tier` 对齐）；
  frontmatter 补 `version: 0.1.1`。
- `skills.index.json`：meta 技能的 `anchors` 补 `scripts/skill-lib-drift.mjs` 与
  `scripts/skill-lib-ledger.mjs`（原表只列 manifest，另两个脚本在注册表里不可见）。

### 自进化能力证据（本轮真实跑通，可复跑）

```sh
S=assets/skills/_meta/skill-library-evolution/scripts
node $S/skill-lib-manifest.mjs . --check        # → registryVersion 0.4.0, skillCount 10, passed true
node $S/skill-lib-manifest.mjs --selftest       # → PASS（缺 dir / 形状不符均 exit 1）
node $S/skill-lib-drift.mjs . --check           # → skillCount 10, failed 0, passed true
node $S/skill-lib-drift.mjs --selftest          # → PASS（B 族词 / 裸写 / 缺 dir 三类均红）
node $S/skill-lib-manifest.mjs . --snapshot     # → 写出 .cycles/skill-snapshot/skills-manifest.json（10 skills）
node $S/skill-lib-ledger.mjs . --record SKILL_PATCH_PROPOSED --skill skill-library-evolution --detail "…"
node $S/skill-lib-ledger.mjs . --record SKILL_VERSION_BUMP  --skill skill-library-evolution --detail "库 0.3.0->0.4.0；10 技能 dir 补表 + 版本同步"
node $S/skill-lib-ledger.mjs . --record SKILL_PATCH_KEPT    --skill skill-library-evolution --detail "manifest --check + drift --check 双绿；两个 --selftest PASS"
node $S/skill-lib-ledger.mjs . --record SKILL_EVIDENCE_LINK --skill git-branch-workflow --detail "master protection=404/rulesets=[]; gh 2.92.0 (2026-11-06)"
node $S/skill-lib-ledger.mjs . --verify         # → {"valid":true,"totalEntries":343,"issues":[]}
```

⇒ 「取证 → 评估 → 补丁 → 基准 → 留痕」中，**留痕（账本）与评估（两道 --check + 反向自检）
是本轮真实跑通的**；「基准（A/B、聚合）」仍属未实现，已在 SKILL.md 标注，不再假装。

### 安全

- 账本写入走主干 `lib/ledger.mjs` canonical 载荷（append-only 哈希链），本轮 4 条新条目
  追加后 `--verify` 仍 `valid: true`（343 条），未改写任何历史条目。
- 无令牌操作。

## v0.1.0 — 2026-11-05（cycle-106）

- **初版元技能**：`SKILL.md` + `references/evolution-model.md` + 3 个确定性脚本
  （`skill-lib-manifest.mjs` / `skill-lib-drift.mjs` / `skill-lib-ledger.mjs`）。
- **七步自进化流程**：快照基线 → 旧评测基线 → 全文取证 → 修技能 → 契约双跑 → 端到端 A/B
  → 聚合基准 + 镜像同步。
- **四类漂移守卫**：版本锚 / 词表绑定 / 原子写 / 配置入口（`skill-lib-drift.mjs --check` 错误级 exit 1）。
- **账本留痕**：复用主干 `lib/ledger.mjs` canonical 载荷，新增 `SKILL_PATCH_*` / `SKILL_DRIFT_ALARM`
  / `SKILL_LIB_AUTONOMY_CHANGE` / `SKILL_EVIDENCE_LINK` 事件类型。
- **信任分合成**：契约通过率 × 基准 delta × 账本完整率 × 漂移守卫清洁度；阈值 L2→L3 ≥ 70、L3→L4 ≥ 85。
- **不做的事**：不自我改码（R-31）；不做五注册表；不放宽词表/门定义；叶技能不 import 父工程 `src/`（G-IND）；
  不打印/写入明文令牌（一律 `vault_run` 注入，H1 熔断）。
- **证据来源**：`docs/anic/12-自进化插件标准与六自能力架构.md`、`docs/anic/18-L4自主性原生化评估与生态对照研究.md`、
  `docs/anic/25-原生优化与内部技能库研究.md`、`.cycles/research-inputs/D-skill-library-design.md`。
