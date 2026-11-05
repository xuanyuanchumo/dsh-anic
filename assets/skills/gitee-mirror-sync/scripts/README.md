# gitee-mirror-sync/scripts — 脚本契约

本目录脚本为 dsh-anic 叶技能 `gitee-mirror-sync` 的确定性工具。全部为 Node ESM（`.mjs`），
零外部依赖，仅用 `node:child_process` / `node:fs` / `node:path`。

> **重要**：本仓对 Gitee 零覆盖（`docs/anic/25-原生优化与内部技能库研究.md:330`）。
> 脚本只做 **git refs 层** 的确定性操作；Gitee API 端点/字段名属通用知识，由操作者按
> `references/operations.md` §9 实测校验后执行（脚本不做 API 调用，因此不接触令牌）。

## 位置参数契约（跨技能统一）

**第一位置参数 = 项目目录（workspace）**，绝不传 `--project-dir` 之类的旗标。

```sh
node <script> <workspace> [...args]
```

- 由 `dsh-anic` 的 `invokeSkillScript` 调用时，`args._[0]` 即项目目录
  （`src/host/skillInvoker.ts:199` 注释）。
- 脚本不写工作区外的任何文件；`mirror-sync.mjs` 不带 `--dry-run` 才会写**远端**。

## 脚本清单

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `mirror-sync.mjs` | fetch source 后推 branches+tags 到 target；`--mirror`/`--prune`/`--dry-run` | `0` 成功 / `1` git 失败 / `2` 用法或远端缺失 |
| `drift-check.mjs` | 比较 source/target 的 `refs/heads/*` SHA，输出漂移清单 | `0` 一致 / `1` 漂移 / `2` 用法或远端缺失 |

## 用法

### mirror-sync.mjs

```sh
node scripts/mirror-sync.mjs <workspace> [--source origin] [--target gitee] [--mirror] [--prune] [--dry-run] [--json]

# 示例（先预演）
node scripts/mirror-sync.mjs D:\Projects\TraeProjects\dsh-anic --dry-run
node scripts/mirror-sync.mjs . --dry-run --json
```

`--dry-run` 只打印将要执行的 `git fetch` / `git push` 命令，不执行。
默认推 `+refs/heads/*:refs/heads/* +refs/tags/*:refs/tags/*`（不删本地 refs）。
`--mirror` 会推全部 refs 并删除 target 上多余的 refs，**先 `--dry-run`**。

### drift-check.mjs

```sh
node scripts/drift-check.mjs <workspace> [--source origin] [--target gitee] [--json]

# 示例
node scripts/drift-check.mjs .
node scripts/drift-check.mjs . --json
```

只读：`git ls-remote --heads`，不写任何东西。

## 安全声明

- 无 shell 插值：全部 `spawnSync('git', argvArray, { cwd })`。
- 无令牌：Gitee 凭据由 git 凭据 helper / SSH agent 提供；脚本不读取、不打印凭据。
- `mirror-sync.mjs` 默认只推 branches+tags；`--prune`/`--mirror` 有删 refs 风险，
  先 `--dry-run` 预览（对应 `references/troubleshooting.md` T9）。
- 不越界写入：脚本只写远端 git refs（带 `--dry-run` 时完全不写）。

## 版本锚点

本技能 v0.1.0 的脚本版本串与 `SKILL.md` / `CHANGELOG.md` 顶层条目一致（三锚一致，
见 `_meta/skill-library-evolution` 的版本锚点守卫）。
