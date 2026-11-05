# superagent-patterns · scripts

本目录是 `superagent-patterns` 叶技能的确定性脚本层。

⚠️ **证据边界**：Superagent 事实来自外部研究报告 `.cycles/research-inputs/A-dsh-superagent-study.md`
（clone commit `8c32a9dc`，未运行 build/test），**不是 dsh-anic 本地源码**。脚本只做结构/语义校验，
不建立 SSH/网络连接，不运行 `dsh-superagent`。

## 位置参数契约（P1 铁律）

所有脚本的 **第一个位置参数是项目目录**（绝对或相对，脚本内 `resolve()`）：

```
node <script> <project-dir> [附加参数...]
```

- **绝不**在附加参数里再传项目目录，也不要用 `--project-dir` 之类旗标——调用方只认 `args._[0]`。
- 与主干技能的跨项目调用契约一致（`assets/skill/SKILL.md` 的「跨项目调用契约」段）。
- 脚本**只读**：不写盘、不联网、不执行 dsh-superagent。

## 脚本清单

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `superagent-status-probe.mjs` | 校验 `stateDir` 声明 + 把观测到的退出码归一为四档语义 | 0 通过 / 1 违规 / 2 用法错误 |
| `admission-table-check.mjs` | 校验准入表结构（4 列、默认值、CI 行「无发送者」） | 0 通过 / 1 违规 / 2 用法错误 |

## 用法

```sh
# 四档退出码归一 + stateDir 探测
node assets/skills/superagent-patterns/scripts/superagent-status-probe.mjs <project-dir> --exit 2
node assets/skills/superagent-patterns/scripts/superagent-status-probe.mjs <project-dir> --state-dir <abs>

# 准入表结构校验（默认校验本技能自带的 references/operations.md）
node assets/skills/superagent-patterns/scripts/admission-table-check.mjs <project-dir>
node assets/skills/superagent-patterns/scripts/admission-table-check.mjs <project-dir> --table <markdown-path>

# 经 dsh-anic 网关跨项目调用（workspace 即项目目录）
# anic_skill { script: 'superagent-status-probe.mjs', workspace: '<project-dir>' }
```

## superagent-status-probe.mjs 四档退出码

| 退出码 | 语义 | 处置 |
|---|---|---|
| 0 | 正常 | 静默 |
| 1 | 不运行 / 运行两次 / runtime 报错 | `--respect-stop restart`（重启可能修好） |
| 2 | 运行但某部件报错 | 只报告 errors，不重启（重启修不好） |
| 3 | 运行但等 setup | 只报告 setup，不重启 |

- 证据：研究报告 §8 L214-215。
- **本脚本的退出码语义不等同于** Superagent `status` 的退出码——它只做归一，不联网。

## admission-table-check.mjs 校验项

| # | 检查 | 证据 |
|---|---|---|
| ① | 表头含 `Scope` + `在名单未点名`，且为 4 列 | 研究报告 §3 L52 |
| ② | 每个数据行恰好 4 格，scope 非空 | 同上 |
| ③ | 单元格取值合法（`inferred`/`ignore`/`explicit`/`not admitted`，或含 `—` 的「无发送者」标记） | 同上 |
| ④ | 至少一行是默认值 `inferred`/`ignore`/`ignore` | 同上 |
| ⑤ | 含 `CI` 的行前两格必须是「无发送者」标记 | 同上 |

## 约束

- 只用 `node:fs` / `node:path`（外加 `process.argv`），零外部依赖，ESM。
- 不打印任何令牌或凭据；不建立网络连接。
- 校验失败**不自动修复**，只报告——修复走人类门/PR。
- 研究报告未运行 build/test，结论需经实证验证。
