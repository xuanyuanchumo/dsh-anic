# CHANGELOG — token-ssh-security

本文件记录 `assets/skills/token-ssh-security/` 叶技能的变更。版本锚点三处一致：
`SKILL.md` frontmatter、`scripts/<primary>.mjs` 版本串、本文件顶层条目。

## v0.1.1 — 2026-11-06（cycle-108：补令牌→env 映射表两条硬边界 + `.env` 裸奔确证）

> 起点：v0.1.0（cycle-105）。本轮补的是**实测出来的机制缺口**，不是措辞修订。

### 新增

- **令牌 ↔ 环境变量映射表（`SKILL.md`「DSH 凭证库」节）**：凭证库现役 **三个**令牌
  （`github` / `npm` / `gitee`，`vault_list` 只回名称），逐个写清默认注入的 env 与复验命令。
- **两条硬边界**：
  1. **`gitee` 没有默认 env 映射**——`vault_run` 只自动映射 `github→GH_TOKEN`、`npm→NPM_TOKEN`。
     用 Gitee 令牌必须显式 `env_name: 'GITEE_TOKEN'`，否则子进程拿不到令牌而报 401，
     **且不会提示"映射缺失"**（这是静默失败面）。
  2. **命令白名单只有 `gh`/`npm`/`npx`/`node`/`git`** ⇒ 不能用 `vault_run` 跑 `curl` 打 Gitee API。
     Gitee 侧要么走 MCP 连接器（账号态已实测），要么用 `node` 脚本读 `process.env.GITEE_TOKEN`。
     附反例：`vault_run(... command:'curl')` 被拒是白名单问题、不是令牌问题。
- **`.env` 裸奔确证**：原句是"建议补一行 `.env`"，本轮把它变成实测结论——`.gitignore` 共 21 行、
  `grep '.env'` **零命中**（只有 `.npmrc-publish` 命中"npmrc"）⇒ 现在没 `.env` 文件所以无风险，
  **一旦引入就裸奔**；给出复验命令与补法，并标注 `.gitignore` 属其他写域（人工门）。

### 变更

- `SKILL.md`：frontmatter 补 `version: 0.1.1`（激活此前休眠的 `anchor:version` 锚）；
  R02 由「github/npm 两个」改为「现役三个 + 见映射表」。
- `skills.index.json`：补显式 `dir` 字段。

### 依据（可复验）

```sh
vault_list                                                    # 只回名称：gitee / github / npm
Select-String -Path .gitignore -Pattern '\.env'                # 零命中
(Get-Content .gitignore).Count                                 # 21
git ls-files .npmrc .npmrc-publish                             # 只有 .npmrc 被跟踪
vault_run(name:'github', command:'gh', args:['run','list','-R','xuanyuanchumo/dsh-anic'])   # 映射可用实证
```

### 安全

- 未 `vault_show` 任何令牌、未打印任何令牌值；表中只有**名称**与 env 变量名。
- 未修改 `.gitignore`（属其他写域）；只记录缺口与补法。

## v0.1.0 — 2026-11-05

**新增**：从零创建 `token-ssh-security` 叶技能（`assets/skills/token-ssh-security/`）。

- **一句话定位**：凭据/令牌/SSH 安全操作叶技能；横切所有其他叶技能，任何涉及真实凭据的动作先加载。
- **硬规则表**：R01 明文令牌永不出 Host；R02 令牌名小写连字符；R03 命令白名单；
  R04 npm 11 需 `.npmrc-publish`；R05 发布 cwd 必须落项目目录；R06 remote 用 SSH 形态；
  R07 敏感文件必须 gitignore；R08 PR/Issue 模板必须脱敏；R09 涉及真实凭据须有隔离方案（H1）。
- **DSH 凭证库**：`vault_set`/`vault_run`（明文永不出 Host、env 注入 `GH_TOKEN`/`NPM_TOKEN`）、
  `vault_list`/`vault_has`（只返回名称）、`vault_show`（仅用户明确要求，调用后提醒轮换）。
- **证据基座**：全部本仓结论引用实测 `file:line`——
  `docs/agents/CI-CD与发布流程.md` §6/§9、`.gitignore:19-20`、`.github/PULL_REQUEST_TEMPLATE.md:70`、
  `.github/ISSUE_TEMPLATE/bug_report.yml:9`、`assets/skill/SKILL.md`（熔断条件 3）；
  本仓实际 remote `git@github.com:xuanyuanchumo/dsh-anic.git`（`git remote -v` 实测）。
- **脚本**：
  - `scripts/secret-scan.mjs`（硬编码令牌/私钥扫描，只报位置不报值）
  - `scripts/ssh-selfcheck.mjs`（SSH remote 形态 + `.npmrc-publish` 保护自检）
  - `scripts/README.md`（位置参数契约与规则表）
- **参考**：`references/operations.md`（操作手册）、`references/troubleshooting.md`（故障排查）。
- **安全**：脚本零外部依赖、只读、不写盘、不联网、不打印凭据；git 查询用 argv 数组无 shell 注入面。
- **假设**：
  1. `assets/skills/skills.index.json` 已声明本技能（`token-ssh-security` 条目，tier=leaf，gates=G3）。
  2. `.env` 当前**未**被本仓 `.gitignore` 覆盖——脚本如实报为「建议」，不作为硬失败。
  3. secret scanning 的平台层（GitHub push protection）属通用知识，本仓未接入 Advanced Security；
     `secret-scan.mjs` 是本地补充层。
  4. `vault_*` 工具来自 DSH 凭证库插件，其语义为工具契约描述，未在本仓源码中实现。
