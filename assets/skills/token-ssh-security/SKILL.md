---
name: token-ssh-security
whenToUse: >
   在 dsh-anic（或任何 DSH 插件）仓库里需要配置/使用 GitHub 与 npm 凭据、
   设置 `gh auth` 或 SSH remote、保护 `.npmrc-publish` / `.env`、清理 PR 与 Issue
   模板中的敏感信息、跑 secret scanning，或在 Windows 443 被重置时切换到 SSH 通道时使用。
   触发词（中文）：token、凭据、SSH、gh auth、secret、脱敏、凭证库、vault、
   令牌、密钥、泄露、secret scanning。
   Trigger words (EN): token, credential, SSH, gh auth, secret, redaction,
   vault, token leak, secret scanning, SSH remote, auth.
description: >
   Triggers: token, credential, SSH, gh auth, secret, redaction, vault,
   token leak, secret scanning, SSH remote, auth. Use when setting up or
   rotating GitHub/npm credentials, configuring gh auth or an SSH remote,
   protecting .npmrc-publish/.env, redacting PR/Issue templates, running
   secret scanning, or switching to an SSH channel when Windows resets 443.
---

# 令牌与 SSH 安全（token-ssh-security）

## 一句话定位

dsh-anic 的 **凭据/令牌/SSH 安全操作叶技能**：把「DSH 凭证库注入、`gh auth`、SSH remote、
`.npmrc-publish` 保护、模板脱敏、secret scanning、H1 检查点、Windows 443 重置」固化为
九条纪律，并提供两个确定性自检脚本。横切所有其他叶技能——任何涉及真实凭据的动作都先加载本技能。

> 本技能只提供**操作知识与确定性脚本**，不改变流程脊柱。涉及真实凭据的隔离方案是
> 主干技能熔断条件 CB3（`assets/skill/SKILL.md` 的熔断清单）的前置检查点。

## 硬性规则

| # | 规则 | 说明 | 证据 |
|---|---|---|---|
| R01 | 明文令牌永不出 Host | `vault_set` 只入库不回显；`vault_run` 把令牌注入子进程环境变量，绝不进对话/日志/shell 历史 | 工具契约（见下方「DSH 凭证库」）；`docs/agents/CI-CD与发布流程.md:74-79` |
| R02 | 令牌名用小写连字符 | `github` / `npm`；env 映射 `GH_TOKEN` / `NPM_TOKEN` | 工具契约 |
| R03 | 命令白名单 | 只许 `gh` / `npm` / `npx` / `node` / `git`（参数任意，无 shell 注入面） | 工具契约 |
| R04 | npm 11 需 `.npmrc-publish` | 裸 `NPM_TOKEN` 不生效；必须 `--userconfig .npmrc-publish` | `docs/agents/CI-CD与发布流程.md:85-87`；`.gitignore:19-20` |
| R05 | 发布 cwd 必须落项目目录 | `vault_run` 默认 cwd 是 desktop profile，在那里 publish 会读错 package.json | `docs/agents/CI-CD与发布流程.md:82-84` |
| R06 | remote 用 SSH 形态 | `git@github.com:xuanyuanchumo/dsh-anic.git`；HTTPS 形态在 Windows 443 重置时不稳 | `docs/agents/CI-CD与发布流程.md:121-126`；本仓 `git remote -v` |
| R07 | 敏感文件必须 gitignore | `.npmrc-publish` 含 token 占位符，值经 `vault_run` 注入，禁止提交 | `.gitignore:19-20` |
| R08 | PR/Issue 模板必须脱敏 | 不贴令牌/绝对本机路径/内部主机名；PR 必须贴命令输出才算证据 | `.github/PULL_REQUEST_TEMPLATE.md:20-31,70` |
| R09 | 涉及真实凭据须有隔离方案 | H1 检查点：无隔离方案则熔断，先修复后降级 | `assets/skill/SKILL.md` 熔断条件 3 |

### DSH 凭证库（vault）

| 能力 | 用法 | 安全语义 |
|---|---|---|
| 存 | `vault_set(name, value, description?)` | 明文只在 Host 侧存储，**绝不回显** |
| 查状态 | `vault_list()` / `vault_has(name)` | 只返回名称，绝不返回令牌值 |
| 用 | `vault_run(name, command, args?, env_name?)` | 令牌只注入子进程环境变量（`GH_TOKEN`/`NPM_TOKEN`），不进对话/日志 |
| 展示 | `vault_show(name, confirm: true)` | **仅当用户明确要求**；调用后提醒已泄露到对话，用完轮换 |

**禁止**：把令牌值打印/贴进回复、写入工作区文件、把 `vault_show` 结果转述给用户。

## 快速启动

1. **入库**：`vault_set github <token> "dsh-anic GitHub"`；`vault_set npm <token> "npm publish"`。
2. **gh auth**：`gh auth login`（或 `gh auth setup-git` 让 git 走 HTTPS 凭据助手）。
3. **SSH remote**：确认 `git remote -v` 是 `git@github.com:xuanyuanchumo/dsh-anic.git`；
   自检 `ssh -T git@github.com` → `Hi <user>!` 即通。
4. **npm publish**：`vault_run npm publish --access public`（cwd 已在项目目录），
   或经 `--userconfig .npmrc-publish`。
5. **跑自检**：
   - `node assets/skills/token-ssh-security/scripts/secret-scan.mjs <project-dir>`
   - `node assets/skills/token-ssh-security/scripts/ssh-selfcheck.mjs <project-dir>`
6. **提交前**：确认 `.npmrc-publish`、`dist/`、`.cycles/` 在 `.gitignore` 内；
   建议同时补一行 `.env`（本仓当前未显式忽略 `.env`）。

## Windows 443 重置 → SSH 通道

| 现象 | 根因 | 修复 |
|---|---|---|
| `git push` 报 `Connection was reset` / timeout | github.com 443 直连被重置 | 改用 SSH remote：`git remote set-url origin git@github.com:xuanyuanchumo/dsh-anic.git` |
| `gh` API 正常但 `git` 不行 | `gh` 走 API 域名，git 走 443 | SSH 443 通，SSH 是唯一稳定通道 |
| `gh auth setup-git` 无效 | 它只配 HTTPS 形态的凭据助手 | 用 SSH 形态，或 `ssh -T git@github.com` 自检 |

证据：`docs/agents/CI-CD与发布流程.md:121-126`。

## 本仓实际 remote（引用基座）

```
origin	git@github.com:xuanyuanchumo/dsh-anic.git (fetch)
origin	git@github.com:xuanyuanchumo/dsh-anic.git (push)
```

（`git remote -v` 实测，写作时点 commit `75e8602`）

## 导航索引

按需加载——只在需要时读取对应参考文档：

| 需要了解 | 读取 |
|---|---|
| 完整操作手册（vault、gh auth、SSH、npm、模板脱敏、secret scanning、H1） | `references/operations.md` |
| 凭据泄露、SSH 失败、npm 401、H1 熔断的分诊与修复 | `references/troubleshooting.md` |
| 硬编码扫描 + SSH 自检脚本用法 | `scripts/README.md` |

## 与主干技能的对接

- 涉及真实凭据且无隔离方案 → 触发主干熔断 CB3，先诊断根因并尝试自动修复，只有修复失败才回退 L3
  （`assets/skill/SKILL.md` 熔断条件 3）。
- 本技能产出的安全扫描证据 → 主干 `eval-runner` / `gate-check --record`。
- 不自我改码；发现问题走 tech-debt + 下一轮 cycle 任务清单（人类门）。

## 相关文档

- 主手册：`docs/agents/CI-CD与发布流程.md` §6（npm 发布）、§9（Windows 网络）
- 忽略清单：`.gitignore:19-20`
- 模板：`.github/PULL_REQUEST_TEMPLATE.md`、`.github/ISSUE_TEMPLATE/*.yml`
- 熔断条件：`assets/skill/SKILL.md`（熔断清单第 3 条）
