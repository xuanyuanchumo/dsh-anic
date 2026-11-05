# token-ssh-security · 故障排查

> 失败模式 → 根因 → 修复。每条都标注证据出处。按「先止血、再定位、后复验」顺序执行。

## 0. 止血优先（泄露类）

**任何疑似令牌泄露，先吊销再排查**：

1. 立即吊销/轮换令牌（GitHub → Settings → Developer settings → Personal access tokens）。
2. 检查 audit log 确认泄露范围。
3. 轮换后重跑 `scripts/secret-scan.mjs` 确认无残留。
4. 若已进 git 历史，用 `git filter-repo` 清理（破坏性，需备份 + 人类批准）。

## 1. `vault_run npm publish` 报 `Cannot read properties of null (reading 'prerelease')`

**根因**：`vault_run` 默认 cwd 是 desktop profile，在那里跑 publish 读错 `package.json`。

**修复**：让 npm 进程 cwd 落在项目目录（包装脚本 `execFileSync` 指定 cwd），或直接在本目录执行。

证据：`docs/agents/CI-CD与发布流程.md:82-84`。

## 2. `npm publish` 401（环境里有 `NPM_TOKEN`）

**根因**：npm 11 不把裸 `NPM_TOKEN` 环境变量当凭据。

**修复**：仓库根放 `.npmrc-publish`（已 gitignore，`.gitignore:19-20`）写
`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`，发布时 `--userconfig .npmrc-publish`。

证据：`docs/agents/CI-CD与发布流程.md:85-87`。

## 3. `git push` 报 `Connection was reset` / timeout（Windows）

**根因**：github.com 443 直连被重置；`gh` API 与 SSH 443 通。

**修复**：改用 SSH remote：

```sh
git remote set-url origin git@github.com:xuanyuanchumo/dsh-anic.git
ssh -T git@github.com
```

证据：`docs/agents/CI-CD与发布流程.md:121-126`。

## 4. `gh auth setup-git` 无效

**根因**：它只配 HTTPS 形态的凭据助手；本仓 remote 是 SSH 形态。

**修复**：用 SSH 形态（`git@github.com:…`）；`ssh -T git@github.com` → `Hi <user>!` 即通。

## 5. `ssh -T git@github.com` 报 `Permission denied (publickey)`

**根因**：SSH key 未加到 GitHub，或私钥权限不对。

**修复**：

- 确认 `~/.ssh/id_ed25519`（或 `id_rsa`）存在且权限 600，`~/.ssh` 700。
- 把**公钥**（`.pub`）加到 GitHub → Settings → SSH and GPG keys。
- 用 `ssh-add -l` 确认 agent 里有 key；没有则 `ssh-add ~/.ssh/id_ed25519`。
- `ssh -vT git@github.com` 看握手细节（通用知识）。

## 6. `secret-scan.mjs` 报命中

**根因**：仓库里有疑似令牌/私钥。

**修复**：

1. 确认命中是否真实凭据（脚本只报位置不报值）。
2. 若是：吊销 → 轮换 → 删除该行 → 重跑扫描。
3. 若是误报（如测试里的假令牌）：在行内加注释标记 `false-positive`，或调整脚本的忽略规则。
4. 真实泄露必须登记 tech-debt 并走 H1 检查点。

## 7. `.npmrc-publish` 被提交

**根因**：忽略了 gitignore 规则，或手动 `git add -f`。

**修复**：

```sh
git rm --cached .npmrc-publish
# 确认 .gitignore:19-20 覆盖它
```

若令牌已随文件进入历史，按「止血优先」第 4 步清理历史。

## 8. PR 模板/Issue 里出现敏感信息

**根因**：开发者粘贴了令牌、凭据或本机绝对路径。

**修复**：

- 立即编辑 PR/Issue 正文删除敏感片段。
- 若令牌是真实的，按「止血优先」吊销轮换。
- 模板本身已声明禁止（`.github/PULL_REQUEST_TEMPLATE.md:70`；
  `.github/ISSUE_TEMPLATE/bug_report.yml:9`）——把该条作为评审 nit 点名。

## 9. `vault_show` 之后令牌出现在对话里

**根因**：用户明确要求展示明文，或误调用。

**修复**：

- 立即提醒用户该值已泄露到对话。
- 用完在「设置 → 凭证库」变更/轮换。
- 后续一律用 `vault_run`，不再 `vault_show`。

## 10. H1 检查点触发熔断（涉及真实凭据无隔离方案）

**根因**：涉及真实用户数据/明文凭据且无隔离方案。

**修复**：先诊断根因并尝试自动修复；只有修复失败才回退自主级（L3）。全部走账本。

证据：`assets/skill/SKILL.md` 熔断条件 3。

**H1 通过标准**：令牌只经 `vault_run` 注入；敏感文件在 `.gitignore`；模板无敏感信息；
secret-scan 零命中。

## 11. 定位纪律

- **先止血后定位**：泄露类先吊销，再排查来源。
- **先证据后结论**：每条结论引用 `file:line`，不凭印象。
- **不降级**：不为让扫描通过而放宽规则或删除测试。
- **不假绿**：secret-scan 有命中时不得宣称「安全」。
- **无证据 ≠ 通过**：未跑扫描时按 SKIP 处理，不当作 PASS。
