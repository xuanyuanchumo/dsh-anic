# ci-cd-release · scripts

本目录是 `ci-cd-release` 叶技能的确定性脚本层。脚本是**规范实现层（single source of truth）**：
插件是脚本的原生调用面 + 状态跟踪 + 可观测性层，不重写脚本。

## 位置参数契约（P1 铁律）

所有脚本的 **第一个位置参数是项目目录**（绝对或相对，脚本内 `resolve()`）：

```
node <script> <project-dir> [附加参数...]
```

- **绝不**在附加参数里再传项目目录，也不要用 `--project-dir` 之类旗标——调用方只认 `args._[0]`。
- 这与主干技能的跨项目调用契约一致（`assets/skill/SKILL.md` 的「跨项目调用契约」段）。
- 脚本只读、不写盘、不联网；被 `anic_skill` 网关调用时 `workspace` 参数即项目目录。

## 脚本清单

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `workflow-lint.mjs` | 校验 `.github/workflows/*.yml`：触发面、`permissions: contents: read`、四件套顺序、`--frozen-lockfile`、无 `--live`、job 级 `ANIC_SELF_AUDIT: '0'`、job 级 `timeout-minutes`、OIDC 最小权限（CI 禁 `id-token: write`／Release 必须有）、Release 的 `cancel-in-progress: false` 与 tag/CHANGELOG/pack 校验步 | 0 通过 / 1 违规 / 2 用法错误 |
| `release-check.mjs` | 发布前四项卫生：tag↔`package.json.version`、CHANGELOG `## vX.Y.Z` 段、`files` 发布清单、`repository` 指向 GitHub | 0 通过 / 1 违规 / 2 用法错误 |

## 用法

```sh
# 改完 CI 后校验工作流结构
node assets/skills/ci-cd-release/scripts/workflow-lint.mjs D:\Projects\TraeProjects\dsh-anic

# 发版前校验（tag 缺省由 version 推导）
node assets/skills/ci-cd-release/scripts/release-check.mjs D:\Projects\TraeProjects\dsh-anic v0.56.0

# 经 dsh-anic 网关跨项目调用（workspace 即项目目录）
# anic_skill { script: 'workflow-lint.mjs', workspace: '<project-dir>' }
```

## 约束

- 只用 `node:fs` / `node:child_process` / `node:path`，零外部依赖，ESM。
- 不解析 YAML（无依赖），只做行级结构检查；复杂语义仍以人读工作流为准。
- 不打印任何令牌或凭据；只输出结构化结论。
- 校验失败**不自动修复**，只报告违规项——修复走人类门/PR。
