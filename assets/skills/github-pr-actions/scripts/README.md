# github-pr-actions/scripts — 脚本契约

本目录脚本为 dsh-anic 叶技能 `github-pr-actions` 的确定性守卫。全部为 Node ESM（`.mjs`），
零外部依赖，仅用 `node:child_process` / `node:fs` / `node:path`。

## 位置参数契约（跨技能统一）

**第一位置参数 = 项目目录（workspace）**，绝不传 `--project-dir` 之类的旗标。

```sh
node <script> <workspace> [...args]
```

- 由 `dsh-anic` 的 `invokeSkillScript` 调用时，`args._[0]` 即项目目录
  （`src/host/skillInvoker.ts:199` 注释）。
- 脚本**绝不**写工作区外的任何文件；默认只读。

## 脚本清单

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `pr-check.mjs` | 校验 PR 模板必填小节 + `gh` 可用性；`--pr N` 读 PR 状态 | `0` 通过 / `1` 缺失或非 OPEN / `2` 用法或环境错误 |
| `evidence-collect.mjs` | 采集 dist 新鲜度 / 测试报告 / 覆盖率 / 工作区证据，输出 Markdown 清单 | `0` 证据齐 / `1` 缺证据 / `2` 用法错误 |

## 用法

### pr-check.mjs

```sh
node scripts/pr-check.mjs <workspace> [--pr N] [--offline] [--json]

# 示例
node scripts/pr-check.mjs D:\Projects\TraeProjects\dsh-anic
node scripts/pr-check.mjs . --pr 12 --offline
```

`--offline` 时只校验 `.github/PULL_REQUEST_TEMPLATE.md` 的必填小节，不调用 `gh`。
`--pr N` 需要 `gh auth login` 或 DSH 凭证库注入（脚本不接触明文令牌）。

### evidence-collect.mjs

```sh
node scripts/evidence-collect.mjs <workspace> [--out <workspace-relative>] [--json] [--no-write]

# 示例
node scripts/evidence-collect.mjs .
node scripts/evidence-collect.mjs . --out .cycles/evidence.md
node scripts/evidence-collect.mjs . --json
```

`--out` 路径必须在 workspace 内（脚本会拒绝越界路径）。默认不落盘，只打印。

## 安全声明

- 无 shell 插值：全部 `spawnSync('gh'|'git', argvArray, { cwd })`。
- 无令牌：`gh` 认证由 `gh auth login` 或 DSH 凭证库负责；脚本不读取、不打印凭据。
- 只读优先：`pr-check.mjs` 全程只读；`evidence-collect.mjs` 默认只读，`--out` 才写
  workspace 内的 Markdown。
- 工具数采集用 `git grep -rho "name: 'anic_[a-z_]*'" -- src/host/tools*.ts`，对齐
  `docs/agents/CI-CD与发布流程.md:105`。

## 版本锚点

本技能 v0.1.0 的脚本版本串与 `SKILL.md` / `CHANGELOG.md` 顶层条目一致（三锚一致，
见 `_meta/skill-library-evolution` 的版本锚点守卫）。
