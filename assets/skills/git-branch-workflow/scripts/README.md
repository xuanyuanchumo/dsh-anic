# git-branch-workflow/scripts — 脚本契约

本目录脚本为 dsh-anic 叶技能 `git-branch-workflow` 的确定性守卫。全部为 Node ESM
（`.mjs`），零外部依赖，仅用 `node:child_process` / `node:fs` / `node:path`。

## 位置参数契约（跨技能统一）

**第一位置参数 = 项目目录（workspace）**，绝不传 `--project-dir` 之类的旗标。

```sh
node <script> <workspace> [...args]
```

- `<workspace>` 必须是项目根目录，脚本内部会 `path.resolve` 后再使用。
- 由 `dsh-anic` 的 `invokeSkillScript` 调用时，`args._[0]` 即项目目录（`src/host/skillInvoker.ts:199` 注释）。
- 脚本**绝不**写工作区外的任何文件；默认只读。

## 脚本清单

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `branch-lint.mjs` | 校验当前分支名 + 最近 N 条 commit 类型/格式 | `0` 全过 / `1` 违规 / `2` 用法或环境错误 |
| `pre-push-verify.mjs` | 主干 push 前门禁（三件套脚本存在性 + 分支守卫 + 可选真实 gate） | `0` 过 / `1` 门禁失败 / `2` 用法或环境错误 |

## 用法

### branch-lint.mjs

```sh
node scripts/branch-lint.mjs <workspace> [--limit N] [--json]

# 示例
node scripts/branch-lint.mjs D:\Projects\TraeProjects\dsh-anic
node scripts/branch-lint.mjs . --limit 10 --json
```

输出：分支名合规性 + 逐条 commit 的 `OK/VIOLATION` 标注。

### pre-push-verify.mjs

```sh
node scripts/pre-push-verify.mjs <workspace> [--allow-master] [--run-gates] [--json]

# 示例
node scripts/pre-push-verify.mjs .            # 只读预检
node scripts/pre-push-verify.mjs . --allow-master   # 单人仓库允许直接推 master
node scripts/pre-push-verify.mjs . --run-gates      # 真正跑 typecheck && test && build
```

`--run-gates` 会按 `ci.yml:60-73` 的依赖顺序依次执行
`pnpm run typecheck` → `pnpm run test` → `pnpm run build`；任一步非 0 立即停止并返回该码。

## 安全声明

- 无 shell 插值：全部 `spawnSync('git'|'pnpm', argvArray, { cwd })`，参数不拼接字符串。
- 无令牌：脚本不读取、不打印、不写入任何凭据；远端凭据由 DSH 凭证库或本机 SSH agent 提供。
- 只读优先：`branch-lint.mjs` 全程只读；`pre-push-verify.mjs` 默认只读，仅 `--run-gates` 执行 pnpm。
- 不越界写入：所有潜在写入（`--out`、临时目录）都落在 `<workspace>` 内。

## 版本锚点

本技能 v0.1.0 的脚本版本串与 `SKILL.md` / `CHANGELOG.md` 顶层条目一致（三锚一致，
见 `_meta/skill-library-evolution` 的版本锚点守卫）。
