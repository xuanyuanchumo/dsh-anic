# CHANGELOG — token-ssh-security

本文件记录 `assets/skills/token-ssh-security/` 叶技能的变更。版本锚点三处一致：
`SKILL.md` frontmatter、`scripts/<primary>.mjs` 版本串、本文件顶层条目。

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
