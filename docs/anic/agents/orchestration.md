# 编排配方（Orchestration Recipes）

> 15 张 agent 资产卡（`assets/agents/{gate}-{role}.json`）的使用配方。
> doc 13 §1.3 的「路径 2」载体：人类/编排者如何组合 agent 卡完成五个人工门评估。

## 1. agent 卡事实

- 5 门 × 3 角色 = 15 张：`intent|spec|plan|pr|release` × `planner|implementer|reviewer`
- 每张卡是闭合 JSON 输出协议：`{ verdict: 'pass'|'fail'|'doubt', findings: [{severity, file, line?, evidence, suggestion}], evidenceIds: [...], doubt?: string }`
- `evidenceIds` 禁编造（INV-23）：引用必须指向真实存在的工件路径/账本事件 ID
- 卡由 `src/host/agents.ts` 装载并做闭合 schema 校验；消费方为
  `src/host/llm/multiAgentTier2.ts`（Tier-2 真模型逐门逐角色评审）

## 2. 三种编排配方

### 配方 A — 单门复核（最小）

```
输入：gate='pr'，变更范围（diff 文件列表）
派遣：3 张卡（pr-planner / pr-implementer / pr-reviewer）并行评审
聚合：2/3 通过 → 推荐通过；<2/3 → 不推进
记录：评估结果写审计日志 + 评估报告（multi-agent-gate 输出）
```

适用：PR 评审、单门存疑复核。工具面：`POST /anic/multi-agent-gate` 或
`anic_skill multi-agent-gate`。

### 配方 B — 全门禁链（发版前）

```
顺序：intent → spec → plan → pr → release（前向依赖，逐门 3 卡）
门间守卫：上一门 2/3 通过才进入下一门（PR 门与 release 门要求 3/3）
终止：任一门 <阈值 → 停链 + 记录到审计日志 + HITL 队列
```

适用：交付/发版前的全链质量门。与 G0-G3 收敛门互补（G 门是工件证据门，
agent 门是决策质量门）。

### 配方 C — 存疑升级（doubt 处理）

```
触发：任一卡产出 verdict='doubt'（证据不足/冲突）
动作：doubt 不计入通过数 → 该门降为「需人工审查」
    + doubt 理由进 HITL 队列（面板 hitl 分区可视化）
    + 可选：针对 doubt 点补证据后重跑该门（单门重入）
```

适用：Tier-2 评审中出现证据缺口时。doubt 是诚实终态，不是失败——
禁止把 doubt 当 pass 计数（fail-closed）。

## 3. 与既有机制的关系

| 机制 | 面向 | 关系 |
|---|---|---|
| G0-G3 收敛门 | 工件证据（评估报告/任务清单/测试报告/构建） | agent 门的前置：G 门不过不进 agent 门 |
| HITL 审计（H1-H4） | 操作风险 | 配方 C 的 doubt 升级目标 |
| 自主级授权带 | L1-L4 越界拒绝 | 授权带越界（SELF_REFUSAL）时整链停止 |
| 任务级派遣（auto-cycle.md） | 执行编排 | 派遣的两段评审（spec 合规/代码质量）可复用本配方 A |

## 4. 配置面

- 卡路径：`.cycles/agents/`（工作区覆盖）→ `assets/agents/`（出厂默认）
- 信任阈值：`--auto-approve` 时平均信任度 ≥70% 自动执行推荐动作
- 覆盖卡同样受闭合 schema 校验（agents.ts loader 不放松）
