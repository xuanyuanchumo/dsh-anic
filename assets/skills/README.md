# dsh-anic 内部技能库（Internal Skill Library）

> dsh-anic 的自进化操作知识库。研究与裁决见
> [`docs/anic/25-原生优化与内部技能库研究.md`](../../docs/anic/25-原生优化与内部技能库研究.md)（cycle-106）。

## 定位

把 git / GitHub / Gitee / npm / CI-CD / Token-SSH / DSH 原生面 / 插件工程模式的操作知识整理为
**可自进化的技能库**：9 个叶技能 + 1 个元技能。

| 层 | 数量 | 职责 |
|---|---|---|
| **主干** `ai-native-iteration-cycle` | 1（既有） | 流程脊柱：六阶段 / 七步 / G0-G3 / L1-L4 |
| **叶技能** | 9 | 操作知识与确定性脚本 |
| **元技能** `skill-library-evolution` | 1 | 自进化：取证→评估→补丁→基准→留痕 |

叶技能与主干**不互相 import**，只通过四类契约咬合：词表契约、账本契约、脚本契约、路径契约。

## 目录

```
assets/skills/
├── skills.index.json          # 注册表（唯一事实源）
├── _meta/skill-library-evolution/   # 元技能（自进化引擎）
│   ├── SKILL.md
│   ├── references/evolution-model.md
│   ├── scripts/skill-lib-manifest.mjs   # 注册表生成/校验 + 三锚一致
│   ├── scripts/skill-lib-drift.mjs      # 四类漂移守卫
│   ├── scripts/skill-lib-ledger.mjs     # 补丁生命周期账本
│   └── CHANGELOG.md
├── git-branch-workflow/       # 分支策略与提交规范（含 references/branch-protection.md）
├── github-pr-actions/         # PR 生命周期与 CI 门禁
├── gitee-mirror-sync/         # GitHub↔Gitee 镜像与 MR 同步
├── npm-publish/               # npm 版本/打包/发布/回滚
├── ci-cd-release/             # GitHub Actions 与发布流水线（含 references/actions-authoring.md）
├── token-ssh-security/        # 凭据/令牌/SSH 安全
├── dsh-native-api/            # DSH 打包/安装/插件原生面（含 references/runtime-registration.md）
├── superagent-patterns/       # Superagent 部署/授权/执行模式
└── dsh-plugin-patterns/       # 插件工程模式 P01-P14（toolview/席位/safeDispose/失败为值）
```

## 叶技能清单

| # | name | 一句话 |
|---|---|---|
| 1 | `git-branch-workflow` | 分支策略/提交规范 + **保护分支·required checks·rebase vs merge·冲突处理** |
| 2 | `github-pr-actions` | PR 生命周期（draft→ready→review→merge）、review 语义、合并三法与合并队列边界 |
| 3 | `gitee-mirror-sync` | GitHub↔Gitee 镜像与 MR 同步 |
| 4 | `npm-publish` | npm 版本语义/打包/发布/回滚 + **registry 与 `.npmrc` 纪律·provenance·files 白名单** |
| 5 | `ci-cd-release` | GitHub Actions 与发布流水线（含 `references/actions-authoring.md`：触发器/matrix/权限/OIDC/重试超时） |
| 6 | `token-ssh-security` | 凭据/令牌/SSH 安全操作 |
| 7 | `dsh-native-api` | DSH 打包/安装/插件原生面 + **运行时注册面**（工具/技能/路由三面） |
| 8 | `superagent-patterns` | Superagent 部署/授权/执行模式 |
| 9 | `dsh-plugin-patterns` | DSH 插件工程模式 P01-P14（toolview 席位 / safeDispose / 失败为值 / 分层持久化） |

> 版本锚：注册表 `skills.index.json`（库版本 **0.4.0**，cycle-108）。叶技能与主干**不互相 import**。
> 注册表纪律：每条技能**必须显式声明 `dir`**（`leaf` 与 `name` 同名，`meta` 为 `_meta/<name>`）——
> 派生 `dir ?? name` 会让「表缺字段」永久隐身（cycle-108 就因此让 9 条叶技能在机器面隐身）。
> 10 条技能的 `SKILL.md` 均声明 `version`，与注册表版本由 `--check` 机械比对。

## 自进化（元技能）

七步流程：快照基线 → 旧评测基线 → 全文取证 → 修技能 → 契约双跑 → 端到端 A/B → 聚合基准 + 镜像同步。

> **实现状态（如实）**：第 1/3/4 步有可直接执行的载体；第 5 步靠两个 `--selftest` 反向证明；
> 第 2/6/7 步（旧评测基线 / A/B / 聚合基准）**尚未实现脚本**，仍是人工程序。
> 详见 `_meta/skill-library-evolution/SKILL.md` §三。

```sh
# 三锚 + dir 字段校验（错误级 exit 1）
node assets/skills/_meta/skill-library-evolution/scripts/skill-lib-manifest.mjs <workspace> --check
# 冻结库快照（sha256 清单）
node assets/skills/_meta/skill-library-evolution/scripts/skill-lib-manifest.mjs <workspace> --snapshot
# 反向自检：守卫必须能失败（缺 dir / 形状不符必须 exit 1）
node assets/skills/_meta/skill-library-evolution/scripts/skill-lib-manifest.mjs --selftest
# 四类漂移守卫（错误级 exit 1）
node assets/skills/_meta/skill-library-evolution/scripts/skill-lib-drift.mjs <workspace> --check
# 反向自检（守卫必须能失败）
node assets/skills/_meta/skill-library-evolution/scripts/skill-lib-drift.mjs --selftest
# 补丁生命周期账本（append-only 哈希链）
node assets/skills/_meta/skill-library-evolution/scripts/skill-lib-ledger.mjs <workspace> --record SKILL_PATCH_PROPOSED --skill <name>
node assets/skills/_meta/skill-library-evolution/scripts/skill-lib-ledger.mjs <workspace> --verify
```

## 位置参数铁律

`invokeSkillScript` 把**项目目录作为第一个位置参数**（`node <script> <workspace> ...args`）。
**绝不**传 `--project-dir` 旗标——脚本只认 `args._[0]`。

## 安全纪律

- 零外部依赖（`node:fs` / `node:path` / `node:crypto`）。
- 绝不写明文凭据；令牌一律经 DSH 凭证库 `vault_run` 注入。
- 绝不越出项目目录写文件。
- 脚本是确定性实现层；插件是调用面 + 状态 + 可观测性层。
