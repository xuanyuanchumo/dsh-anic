# skill-library-evolution CHANGELOG

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
