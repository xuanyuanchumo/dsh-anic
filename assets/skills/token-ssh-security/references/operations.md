# token-ssh-security · 操作手册

> 本文是 `token-ssh-security` 叶技能的详细操作手册。所有命令与行号指向 dsh-anic 仓库实测事实；
> DSH 凭证库与 secret scanning 的通用语义标注为通用知识。
> 读取时机：配置凭据、设置 SSH、发布 npm、清理模板、被 H1 熔断时。

## 0. 仓库事实基座（抽验）

| 事实 | 值 | 证据 |
|---|---|---|
| 远端（实际） | `git@github.com:xuanyuanchumo/dsh-anic.git` | `git remote -v` |
| 远端形态 | SSH（非 HTTPS） | 同上 |
| 忽略 `.npmrc-publish` | 是 | `.gitignore:19-20` |
| 忽略 `.env` | **否**（本仓当前未显式忽略；建议补一行） | `.gitignore` 全文无 `.env` |
| 忽略 `.dsh/` / `.preview/` / `dist/` | 是 | `.gitignore:2,8-11` |
| 忽略 `.cycles/`（白名单 `config.yml`、`workflow-graph.yaml`） | 是 | `.gitignore:5-6,21` |
| PR 模板脱敏要求 | 不贴令牌/凭据/本机绝对路径 | `.github/PULL_REQUEST_TEMPLATE.md:70` |
| Issue 模板脱敏要求 | 不要粘贴令牌、凭据或本机绝对路径 | `.github/ISSUE_TEMPLATE/bug_report.yml:9` |

## 1. DSH 凭证库（vault）—— 首选注入通道

**原则：明文令牌永不出 Host。** 令牌安全保存在 DSH 凭证库；列表/状态只返回名称，绝不返回令牌值。

### 1.1 存入

```
vault_set <name> <value> ["备注"]
```

- `name` 用小写连字符：`github` / `npm`（也可 `gh` / `npmjs`）。
- 值只在 Host 侧存储，**绝不回显**。

### 1.2 查看状态（不回显值）

```
vault_list()       # 列出已保存的令牌名称与状态
vault_has(name)    # 是否存在
```

### 1.3 用令牌执行命令（推荐）

```
vault_run <name> <command> [args...]
```

- `command` 白名单：`gh` / `npm` / `npx` / `node` / `git`（参数任意，无 shell 注入面）。
- 令牌只注入子进程环境变量，不进对话/日志/shell 历史。
- env 名映射：`github`/`gh` → `GH_TOKEN`；`npm`/`node` → `NPM_TOKEN`。
- `env_name` 可覆盖默认映射。

### 1.4 展示明文（仅限用户明确要求）

```
vault_show <name> confirm: true
```

- 必须传 `confirm: true`，否则拒绝。
- 调用后**提醒用户该值已泄露到对话**，用完可在「设置 → 凭证库」变更/轮换。

### 1.5 禁止事项

1. 把令牌值打印/贴进回复。
2. 把令牌写入工作区文件（含 `.env`、`.npmrc`、脚本常量）。
3. 把 `vault_show` 的结果转述给用户。
4. 在 CI 日志里 echo 令牌（GitHub Actions secret 也不会回显，但仍要避免 `set -x`）。

## 2. `gh auth`

```sh
gh auth login                      # 交互式登录（选 GitHub.com + HTTPS）
gh auth status                     # 查看当前认证状态
gh auth setup-git                  # 让 git 走 HTTPS 凭据助手
ssh -T git@github.com              # SSH 自检 → "Hi <user>!" 即通
```

**要点**：`gh auth setup-git` 只对 **HTTPS 形态**的 remote 生效。本仓 remote 是 SSH 形态，
所以 `gh auth setup-git` 对本仓无效——SSH 认证由 `~/.ssh` 的 key 承担
（`docs/agents/CI-CD与发布流程.md:121-126`）。

**命令白名单内执行 gh**：

```
vault_run github gh repo view xuanyuanchumo/dsh-anic
```

## 3. SSH remote 与 Windows 443 重置

### 3.1 本仓实际 remote

```
origin	git@github.com:xuanyuanchumo/dsh-anic.git (fetch)
origin	git@github.com:xuanyuanchumo/dsh-anic.git (push)
```

（`git remote -v` 实测）

### 3.2 为什么用 SSH

Windows 上 github.com **443 直连可能被重置**（`git push` 报 `Connection was reset` / timeout），
而 `gh` API 与 SSH 443 通。SSH 形态是唯一稳定通道
（`docs/agents/CI-CD与发布流程.md:121-126`）。

### 3.3 切换到 SSH

```sh
git remote set-url origin git@github.com:xuanyuanchumo/dsh-anic.git
ssh -T git@github.com          # 期望: Hi <user>!
git ls-remote origin           # 期望: 列出 refs 且无认证错误
```

### 3.4 SSH key 管理（通用知识）

- 私钥 `~/.ssh/id_ed25519` 权限 600；`~/.ssh` 700。
- `ssh-agent` 避免重复输入 passphrase。
- 公钥只加到 GitHub 账户的 SSH keys，**不要**贴进仓库或 Issue。

## 4. npm 发布（令牌注入）

### 4.1 为什么需要 `.npmrc-publish`

npm 11 **不**把裸 `NPM_TOKEN` 环境变量当凭据。需要仓库根的 `.npmrc-publish`（已 gitignore）
写：

```
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

发布时 `--userconfig .npmrc-publish`（`docs/agents/CI-CD与发布流程.md:85-87`）。

### 4.2 cwd 必须落项目目录

`vault_run` 默认 cwd 是 desktop profile，在那里跑 publish 会读错 `package.json`，
报 `Cannot read properties of null (reading 'prerelease')`。必须让 npm 进程 cwd 落在项目目录
（`docs/agents/CI-CD与发布流程.md:82-84`）。

### 4.3 发布命令

```sh
# 经凭证库注入（推荐）
vault_run npm publish --access public

# 或本地 .npmrc-publish
npm publish --access public --userconfig .npmrc-publish
```

发布前核对：

- `package.json.repository` 指回 GitHub 仓库（npm ↔ GitHub 关联靠它）；
- `files` 含发布必需项；
- `.npmrc-publish` 未被提交（`.gitignore:19-20`）。

### 4.4 新包 `0.0.0-stage` / 409 语义

新包首次发布成功后 registry 先呈现 `0.0.0-stage`（占位 staged 包）；
`409 Cannot publish over previously staged version` 表示**已在审核/传播队列**，不是失败
（`docs/agents/CI-CD与发布流程.md:88-90`）。

## 5. PR / Issue 模板脱敏

### 5.1 现有模板的硬性要求

- PR 模板：「未提交任何令牌 / 凭据 / 本机绝对路径」（`.github/PULL_REQUEST_TEMPLATE.md:70`）；
  验证证据必须贴命令输出（`:20-31`）。
- Issue 模板：「不要在 Issue 里粘贴令牌、凭据或本机绝对路径」（`.github/ISSUE_TEMPLATE/bug_report.yml:9`）。

### 5.2 提交前脱敏清单

| 禁止出现 | 替代 |
|---|---|
| `ghp_…` / `github_pat_…` / `npm_…` 等令牌 | `<token>` / 环境变量名 |
| `C:\Users\…` / `D:\…` 本机绝对路径 | 相对路径 / `<project-dir>` |
| 内网主机名 / IP | 脱敏占位 |
| `Authorization: Bearer …` 头 | 头名 + `<redacted>` |
| 完整私钥 | 只留 `-----BEGIN … PRIVATE KEY-----` 标题 |

### 5.3 PR 证据纪律

「没有粘输出的『已通过』不算证据」（`.github/PULL_REQUEST_TEMPLATE.md:20`）。
贴命令与关键输出，但输出里若含凭据必须先脱敏。

## 6. Secret scanning

### 6.1 GitHub 平台层（通用知识）

- GitHub 对 push 做默认 secret scanning；命中会告警并可阻断合并（depends on repo settings）。
- GitHub Advanced Security 提供 push protection。
- 仓库级可配置 `.github/codeql` 或第三方 action。

### 6.2 本仓脚本层

`scripts/secret-scan.mjs` 是确定性、零依赖的本地扫描器：

- 扫描常见令牌前缀（GitHub PAT、npm、GitLab、Slack、Google API key）与私钥标题。
- 只输出命中**文件:行号 + 规则名**，**绝不输出令牌值**。
- 忽略 `node_modules/`、`.git/`、`dist/`、`artifacts/`、`.cycles/`。

用法见 `scripts/README.md`。

### 6.3 已泄露令牌的处置（通用知识）

1. 立即吊销/轮换（GitHub → Settings → Developer settings → Personal access tokens）。
2. 检查 audit log 确认泄露范围。
3. 轮换后重跑 secret-scan 确认无残留。
4. 若已进 git 历史，用 `git filter-repo` 清理历史（破坏性，需备份 + 人类批准）。

## 7. H1 检查点（敏感数据保护）

主干技能的 H1 检查点审计「敏感数据保护」。**涉及真实凭据且无隔离方案**时触发熔断 CB3：

- 先诊断根因并尝试自动修复；
- 只有修复失败才回退自主级（L3）；
- 全部走账本（`.cycles/gates/ledger.json`）。

证据：`assets/skill/SKILL.md` 熔断条件 3（「涉及真实用户数据/明文凭据且无隔离方案」）。

**H1 通过标准**：

- 令牌只经 `vault_run` 注入，无明文落盘；
- 敏感文件在 `.gitignore` 内；
- PR/Issue 模板无敏感信息；
- secret-scan 零命中（或命中已登记为 tech-debt 并修复）。

## 8. 脚本接口

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `scripts/secret-scan.mjs <project-dir>` | 扫描硬编码令牌/私钥模式；只报位置不报值 | 0 无命中 / 1 有命中 / 2 用法错误 |
| `scripts/ssh-selfcheck.mjs <project-dir>` | 检查 remote 形态与 `.npmrc-publish` 保护 | 0 通过 / 1 违规 / 2 用法错误 |

详细契约见 `scripts/README.md`。

## 9. 证据边界

- 本文引用的行号均为 dsh-anic 仓库实测行号（写作时点 commit `75e8602`）。
- DSH 凭证库、GitHub secret scanning、SSH key 权限的通用语义为通用知识，非本仓源码。
- 本仓未接入 GitHub Advanced Security；secret-scan 是本地补充层。
