# token-ssh-security · scripts

本目录是 `token-ssh-security` 叶技能的确定性脚本层。横切所有其他叶技能——任何涉及真实凭据的
动作都先跑这里的自检。

## 位置参数契约（P1 铁律）

所有脚本的 **第一个位置参数是项目目录**（绝对或相对，脚本内 `resolve()`）：

```
node <script> <project-dir> [附加参数...]
```

- **绝不**在附加参数里再传项目目录，也不要用 `--project-dir` 之类旗标——调用方只认 `args._[0]`。
- 与主干技能的跨项目调用契约一致（`assets/skill/SKILL.md` 的「跨项目调用契约」段）。
- 脚本**只读**：不写盘、不改动 git 配置、不联网。

## 脚本清单

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `secret-scan.mjs` | 扫描硬编码令牌/私钥模式；**只报位置，绝不报值** | 0 无命中 / 1 有命中 / 2 用法错误 |
| `ssh-selfcheck.mjs` | 检查 origin 是 SSH 形态 + `.gitignore` 覆盖 `.npmrc-publish` | 0 通过 / 1 违规 / 2 用法错误 |

## 用法

```sh
# 提交前 / CI 里跑硬编码扫描
node assets/skills/token-ssh-security/scripts/secret-scan.mjs D:\Projects\TraeProjects\dsh-anic

# 只扫指定规则
node assets/skills/token-ssh-security/scripts/secret-scan.mjs D:\Projects\TraeProjects\dsh-anic --rules github-pat-classic,npm-token

# SSH remote 形态 + 敏感文件保护自检
node assets/skills/token-ssh-security/scripts/ssh-selfcheck.mjs D:\Projects\TraeProjects\dsh-anic

# 经 dsh-anic 网关跨项目调用（workspace 即项目目录）
# anic_skill { script: 'secret-scan.mjs', workspace: '<project-dir>' }
```

## secret-scan.mjs 规则表

| 规则名 | 匹配 |
|---|---|
| `github-pat-classic` | `ghp_`/`gho_`/`ghs_`/`ghr_`/`ghu_` + 36+ 字符 |
| `github-pat-fine` | `github_pat_` + 22+ 字符 |
| `npm-token` | `npm_` + 36+ 字符 |
| `gitlab-token` | `glpat-` + 20+ 字符 |
| `slack-token` | `xox[baprs]-` + 10+ 字符 |
| `google-api-key` | `AIza` + 35 字符 |
| `aws-access-key` | `AKIA` + 16 大写字母数字 |
| `private-key-header` | `-----BEGIN … PRIVATE KEY-----` |

- 忽略目录：`node_modules/ .git/ dist/ artifacts/ .cycles/ .dsh/ .agents/ coverage/ test-results/ .preview/ .codegraph-visualizer/`。
- 扫描扩展名：`.ts .tsx .js .jsx .mjs .cjs .json .yml .yaml .md .txt .sh .ps1 .cmd .bat .env`。
- 文档说明行（`token: xxx` / `<placeholder>` 等）跳过，减少误报。
- **命中只输出 `文件:行号 [规则名]`，绝不输出匹配文本**——因此脚本输出可以安全贴进 CI 日志或 PR。

## ssh-selfcheck.mjs 检查项

| 检查 | 性质 | 证据 |
|---|---|---|
| origin URL 是 SSH 形态 | 硬失败 | `git remote -v`；`docs/agents/CI-CD与发布流程.md:121-126` |
| `.gitignore` 覆盖 `.npmrc-publish` | 硬失败 | `.gitignore:19-20` |
| `.gitignore` 覆盖 `.env` | **建议**（不影响退出码） | 本仓当前未显式忽略 |

- git 查询用 `spawnSync('git', argv, { cwd })`——argv 数组，**无 shell 注入面**。
- 不做 SSH 连接；SSH 可达性用 `ssh -T git@github.com` 单独自检（见 `references/operations.md` §3）。

## 约束

- 只用 `node:fs` / `node:child_process` / `node:path`，零外部依赖，ESM。
- 不打印任何令牌或凭据；输出可安全入库/入日志。
- 校验失败**不自动修复**，只报告——修复走人类门/PR，泄露类先吊销再排查。
