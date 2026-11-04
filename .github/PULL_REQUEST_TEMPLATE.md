## 变更摘要

<!-- 一到三句话说清：改了什么、为什么改。不要复述 diff。 -->

### 关联循环 / 议题
- 循环编号: cycle-{N}（如不涉及迭代循环，填 `—`）
- 关联 Issue: #{N}（无则填 `—`）
- 阶段: [Plan / Design / Build / Test / Deploy / Maintain]

### 变更类型
- [ ] 功能（feat）
- [ ] 修复（fix）
- [ ] 重构（refactor，行为不变）
- [ ] 文档（docs）
- [ ] CI / 构建 / 工程化（chore）
- [ ] 破坏性变更（BREAKING CHANGE，需在下方「破坏性变更」小节说明）

## 验证证据

> 纪律：**没有粘输出的「已通过」不算证据。** 请把命令与关键输出贴进来。

```text
$ pnpm run typecheck
（粘贴输出）

$ pnpm run lint
（粘贴输出）

$ pnpm run test
（粘贴输出，含最后的 === 测试汇总 === 表）
```

- [ ] `pnpm run build` 已执行（CI 会重建 dist/，但本地提交前需确认构建通过）
- [ ] `pnpm run typecheck` 通过
- [ ] `pnpm run lint` 通过（DSH 规范符合性门）
- [ ] `pnpm run test` 全绿（离线四层；`--live` 需真实宿主，本地可选）

### 门禁状态（涉及循环迭代时填写）

| 门禁 | 结果 | 备注 |
|------|------|------|
| G0 评估收敛门 | [PASS / FAIL / N/A] | |
| G1 任务收敛门 | [PASS / FAIL / N/A] | |
| G2 测试收敛门 | [PASS / FAIL / N/A] | |
| G3 构建收敛门 | [PASS / FAIL / N/A] | |

## 变更范围

- 修改文件数: {N}
- 新增文件数: {N}
- 删除文件数: {N}
- 是否触碰 `src/**`、`assets/skill/**`、`package.json`: [是 / 否]

> 若同时改动了工具注册面或 HTTP 路由数量，必须同步 `README.md` 的数字与
> `docs/agents/marketplace-提交草稿.md` 的收录条目——`tests/contract/readmeNumbers.test.ts`
> 会把不一致判红。

## 破坏性变更

<!-- 无则写「无」。有则写清：影响了谁、旧行为是什么、迁移方式是什么。 -->

无

## 自查清单

- [ ] 未引入父工程 `src/` 的 import（独立性守卫 G-IND: `tests/contract/independenceGuard.test.ts`）
- [ ] 单文件 ≤ ~250 行（T3 复杂度带）
- [ ] 用户面文本经 `t()`，未硬编码中文/英文字符串
- [ ] `dist/` 未被提交（`.gitignore` 已覆盖）
- [ ] 未提交任何令牌 / 凭据 / 本机绝对路径

## 人类判断门

- [ ] 规格意图符合
- [ ] 用户体验达标
- [ ] 业务约束满足
- [ ] 伦理合规通过

---

> 本仓遵循 [CI-CD 与发布流程](../docs/agents/CI-CD与发布流程.md)：`master` 是主干，
> 功能分支经 PR 合入；PR 必须 CI 全绿方可合并。
