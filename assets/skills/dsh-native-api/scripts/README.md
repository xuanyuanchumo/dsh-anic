# dsh-native-api · scripts

本目录是 `dsh-native-api` 叶技能的确定性脚本层。该技能是其他叶技能的**事实基座**：
打包、安装、声明兼容前先跑这里的校验。

## 位置参数契约（P1 铁律）

所有脚本的 **第一个位置参数是项目目录**（绝对或相对，脚本内 `resolve()`）：

```
node <script> <project-dir> [附加参数...]
```

- **绝不**在附加参数里再传项目目录，也不要用 `--project-dir` 之类旗标——调用方只认 `args._[0]`。
- 与主干技能的跨项目调用契约一致（`assets/skill/SKILL.md` 的「跨项目调用契约」段）。
- 脚本**只读**：不写盘、不联网、不执行构建。

## 脚本清单

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `dsh-manifest-check.mjs` | 校验 `dsh` manifest：`bundle.patch` 存在且结构合法、`client.platform`、`engines.dsh` SemVer、`files`、peer | 0 通过 / 1 违规 / 2 用法错误 |
| `layer-order-check.mjs` | 校验 patch 文件结构 + 跨层重复行 + `dsh.bundle.patch` 解析；打印规范化层顺序 | 0 通过 / 1 违规 / 2 用法错误 |

## 用法

```sh
# 打包/安装前校验 manifest
node assets/skills/dsh-native-api/scripts/dsh-manifest-check.mjs D:\Projects\TraeProjects\dsh-anic

# 校验层顺序与 patch 结构
node assets/skills/dsh-native-api/scripts/layer-order-check.mjs D:\Projects\TraeProjects\dsh-anic

# 经 dsh-anic 网关跨项目调用（workspace 即项目目录）
# anic_skill { script: 'dsh-manifest-check.mjs', workspace: '<project-dir>' }
```

## dsh-manifest-check.mjs 校验项

| # | 检查 | 性质 | 证据 |
|---|---|---|---|
| ① | `dsh.bundle.patch` 存在且指向存在的 `.yml` | 硬失败 | KB `publish.md:45`；`package.json:80-82` |
| ② | patch 顶层是 `- ` 条目数组、insert 行有 `id` + `name` | 硬失败 | 本仓 `cordis.patch.yml:10-13` |
| ③ | `dsh.client.platform === 'web'` | 硬失败 | `package.json:83-89` |
| ④ | `engines.dsh` 存在且是 SemVer 范围 | 硬失败 / 警告 | `package.json:49` |
| ⑤ | `peerDependencies` 存在；旧名 `peers` 警告 | 硬失败 / 警告 | `kb/publish.md:69` |
| ⑥ | `files` 含 `dist/` 与 `cordis.patch.yml` | 硬失败 | `package.json:36-46` |

- `dsh.manifestVersion` 未声明只**警告**（KB 中无该字段文档，属实现字段，勿据此做版本分支）。
- YAML 用轻量结构校验（无 YAML 依赖），不替代人工评审。

## layer-order-check.mjs 层顺序

```
1. profile 的 dsh.profile.bundles 列表所列各 bundle patch（按列表顺序）
2. profile 自己的 cordis.patch.yml
3. home 级 $DSH_HOME/cordis.patch.yml
4. 每个 --patch <path> overlay（按 argv 顺序）
```

- 证据：`kb/site/develop/basic/publish.md:123-137`。
- 后应用的层按行胜出，patch **整行替换** config 而非深合并。
- 跨 patch 文件重复声明同一 `(kind, id, name)` 行 → 违规（层间冲突风险）。

## 约束

- 只用 `node:fs` / `node:path`，零外部依赖，ESM。
- 不打印任何令牌或凭据。
- 校验失败**不自动修复**，只报告——修复走人类门/PR。
- KB 快照与实际安装的 DSH 运行时可能不一致，**以实际安装包为准**。
