# npm-publish · scripts

本目录是 `npm-publish` 叶技能的确定性脚本层。脚本是**规范实现层（single source of truth）**：
插件是脚本的原生调用面 + 状态跟踪 + 可观测性层，不重写脚本。

## 位置参数契约（P1 铁律）

所有脚本的 **第一个位置参数是项目目录**（绝对或相对，脚本内 `resolve()`）：

```
node <script> <project-dir> [附加参数...]
```

- **绝不**在附加参数里再传项目目录，也不要用 `--project-dir` 之类旗标——调用方只认 `args._[0]`。
- 这与主干技能的跨项目调用契约一致（`assets/skill/SKILL.md` 的「跨项目调用契约」段）。
- 脚本只读、不写盘、不联网；被 `anic_skill` 网关调用时 `workspace` 参数即项目目录。
- 参数顺序：`<project-dir> [tag] [--report]`——旗标可出现在任意位置。

## 脚本清单

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `release-check.mjs` | 发布前发布卫生校验：version⇄CHANGELOG、tag⇄version、`files` 完整性、`.npmrc-publish` 未提交（另附 `repository`/`engines` 卫生） | 0 通过 / 1 违规 / 2 用法错误 |
| `pack-stable.mjs` | 稳定名 tarball 命名规则校验：`pnpm pack` 产物必须重命名为 `${package.name}.tgz`；打印重命名与 sha256 命令（**不执行 `pnpm pack`**） | 0 通过 / 1 命名违规 / 2 用法错误 |

## 用法

```sh
# 发版前发布卫生校验（tag 缺省由 version 推导）
node assets/skills/npm-publish/scripts/release-check.mjs D:\Projects\TraeProjects\dsh-anic v0.56.0

# 只读 JSON 输出（喂给脚本 / CI；退出码语义不变）
node assets/skills/npm-publish/scripts/release-check.mjs D:\Projects\TraeProjects\dsh-anic v0.56.0 --report

# 稳定名 tarball 计划（不跑 pnpm pack）
node assets/skills/npm-publish/scripts/pack-stable.mjs D:\Projects\TraeProjects\dsh-anic

# 经 dsh-anic 网关跨项目调用（workspace 即项目目录）
# anic_skill { script: 'release-check.mjs', workspace: '<project-dir>', args: ['v0.56.0'] }
```

`release-check.mjs` 的 `--report` 输出结构（关键字段）：

```json
{
  "skill": "npm-publish",
  "script": "release-check.mjs",
  "projectDir": "D:\\Projects\\TraeProjects\\dsh-anic",
  "version": "0.56.0",
  "tag": "v0.56.0",
  "passed": true,
  "counts": { "passed": 6, "failed": 0 },
  "checks": [{ "id": "changelog-version", "ok": true, "detail": "CHANGELOG.md 含 ## v0.56.0 段" }],
  "warnings": [],
  "findings": [],
  "reportHash": "<sha256 of 上述 results 的规范化 JSON>"
}
```

## 退出码语义

| 退出码 | 含义 |
|---|---|
| `0` | 全部校验通过（`pack-stable.mjs` 的「尚未 pack / 已稳定名」也计通过） |
| `1` | 存在违规项（`findings` 逐条列出） |
| `2` | 用法/输入错误（项目目录不存在、缺 `package.json`、参数个数非法、未知旗标） |

## 约束

- 只用 `node:fs` / `node:child_process` / `node:path` / `node:crypto`，零外部依赖，ESM。
- 不解析 YAML；工作流语义仍以人读 `.github/workflows/release.yml` 为准。
- 不打印任何令牌或凭据；只输出结构化结论。
- 校验失败**不自动修复**，只报告违规项——修复走人类门/PR。
- `pack-stable.mjs` **绝不**调用 `pnpm pack`/`npm pack`，只校验命名规则并打印命令。
- 校验 `.npmrc-publish` 时仅读取，绝不创建、修改或删除该文件。
