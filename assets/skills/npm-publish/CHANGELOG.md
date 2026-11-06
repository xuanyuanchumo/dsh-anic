# npm-publish CHANGELOG

## v0.2.0 — 2026-11-06（cycle-108：补 semver / registry 纪律 / provenance / files 白名单 / 回滚边界）

> 起点：v0.1.0（cycle-105）。本轮补的五块都能用一条命令当场复验，不是教科书泛论。

### 新增（`SKILL.md` 新增五节）

- **版本语义（0.x 阶段）**：本包仍是 `0.58.0`（`package.json:3`）⇒ 破坏性变更用**次版本位**表达
  （`0.x → 0.(x+1)`），新增能力同次版本位，纯修复走 patch，预发布 `0.59.0-rc.1`；
  判据写成「安装者会不会被迫改代码」。此前 SKILL 只有"改 version 同轮改 CHANGELOG"，无升位判据。
- **registry 与 `.npmrc` 纪律（本轮最重要的实测）**：仓库 `.npmrc` 里**没有** `registry=` 行
  （只有 `auto-install-peers=false`）⇒ 取机器级配置。实测两条命令给出相反结果：
  `npm config get registry` → `https://registry.npmmirror.com`（镜像）；
  `npm config get registry --userconfig .npmrc-publish` → `https://registry.npmjs.org/`（官方）。
  据此立 R13：发布必须 `--userconfig .npmrc-publish`；只查询版本也要显式 `--registry`，
  **否则镜像延迟会被当成"已发布/未发布"的证据**。
- **provenance / OIDC**：`--provenance` 只在 CI 成立（`release.yml:14-16` 的 `id-token: write`
  + `release.yml:163` 的调用）；本地手工发布**不带**。本地 `--provenance` 的报错形态标注
  「未验证」，给出 `npm publish --dry-run --provenance` 的验证方法。
- **`files` 白名单**：`package.json:44-54` 是**白名单**，未列目录不进 tarball（`assets/skills/` 在 `:47`）；
  给只读核对命令 `npm pack --dry-run --json` + 运行时目录计数。
- **回滚：deprecate vs unpublish**：deprecate 为首选（历史不可撤 ⇒ 必须发修复版）；unpublish 仅在
  泄露/不可用产物时，且 npm 政策（时间窗/下载量/依赖者）常使其不可行——**未在线上包实测**，
  验证方法写明「在测试包上试，别拿 0.58.0 试」。

### 变更

- **版本锚纠错**：SKILL.md 与 `references/operations.md` 里「当前 `0.56.0`」已过期（真实 `0.58.0`），
  且示例命令写死 `v0.56.0` ⇒ 改成**现算** `"v$(node -p 'require(\"./package.json\").version')"`，
  并把纪律写成「文档不写死版本号」；`engines.dsh` 单段写法与 `files` 清单/行号同步修正
  （`package.json:44-56,57-60,59`）。
- `SKILL.md`：新增 R13（registry 必须显式钉住）/ R14（provenance 只在 CI 成立）；
  frontmatter 补 `version: 0.2.0`（激活此前休眠的 `anchor:version` 锚）；行数 150 → 229（≤250）。
- `skills.index.json`：补显式 `dir` 字段。

### 依据（可复验）

```sh
npm config get registry                                   # https://registry.npmmirror.com
npm config get registry --userconfig .npmrc-publish       # https://registry.npmjs.org/
npm view dsh-anic dist-tags --registry https://registry.npmjs.org/   # { latest: '0.58.0' }
git ls-files .npmrc .npmrc-publish                        # 只有 .npmrc 被跟踪
node assets/skills/npm-publish/scripts/release-check.mjs . v0.58.0    # 6 项卫生全过
```

### 安全

- 令牌不进对话/日志：所有 npm/gh 调用经 `vault_run` 注入 `NPM_TOKEN`/`GH_TOKEN`；
  `.npmrc-publish` 的 `_authToken=` 值在阅读时已按占位符脱敏，未写入任何文件。
- 未改动 `.npmrc-publish` / `.npmrc`，未执行任何 `publish`/`deprecate`/`unpublish`。

## v0.1.0 — 2026-11-05（新建）

> 起点：cycle-105 技能库叶技能补齐。本技能把 dsh-anic 的 **npm registry 发布面**
> 操作知识固化为可复用叶技能，与 `ci-cd-release`（流水线骨架）分工。
> 终点：新建技能包 + 两个确定性校验脚本，全部依据仓库实证（`file:line`）。

### 新增

- **技能骨架**：`SKILL.md`（name/whenToUse/description 三件套 + 一句话定位 +
  硬规则表 R01-R12 + 三条实测坑位 + 快速启动 + 发布卫生清单 + 导航索引）。
- **确定性脚本 `scripts/release-check.mjs`**：发布前发布卫生校验——
  ① version ⇄ CHANGELOG 同步；② tag ⇄ `package.json.version` 逐字符一致；
  ③ `files` 字段完整性（含 `assets/skills/`）；④ `.npmrc-publish` 未提交且被 gitignore；
  另附 `repository`/`engines` 发布卫生检查。支持 `--report` 只读 JSON 输出。
  退出码 0/1/2，失败信息逐条列出。
- **确定性脚本 `scripts/pack-stable.mjs`**：稳定名 tarball 的命名规则校验器——
  校验 `pnpm pack` 产物应重命名为 `${package.name}.tgz`（非版本名），打印重命名与
  sha256 命令；**不执行 `pnpm pack`**，只读、不写盘。
- **操作手册 `references/operations.md`**：版本唯一事实源、tag 一致性、稳定名 tarball +
  sha256、发布四件套、npm publish 本地路径（`vault_run` + 包装脚本 cwd 钉死）、
  `.npmrc-publish` 用法、`npm deprecate` 回滚、`files`/`repository`/`engines` 发布卫生。
- **故障排查 `references/troubleshooting.md`**：14 条失败模式 → 根因 → 修复 → 复验。
- **脚本契约 `scripts/README.md`**：位置参数契约（第一个位置参数 = 项目目录）、
  退出码语义、`--report` 语义、安全约束。

### 依据

- `docs/agents/CI-CD与发布流程.md` §4（版本号与 tag 规范）、§5（发布流程）、
  §6（npm 发布实测坑位）、§8（回滚）。
- `.github/workflows/release.yml`（tag/CHANGELOG 两道硬校验、`pnpm pack` 稳定名、
  `gh release create`、可选 npm publish）。
- `package.json`（version/files/repository/engines/peerDependencies/scripts）。
- `.npmrc` / `.npmrc-publish` / `.gitignore`（发布凭据保护）。
- `.cycles/research-inputs/D-skill-library-design.md` §3.4（技能提纲）。

### 安全

- 脚本零外部依赖（仅 `node:fs`/`node:child_process`/`node:path`/`node:crypto`），ESM，
  只读、不写盘、不联网；`spawnSync` 全程 argv 数组，无 shell 插值。
- 不打印、不落盘任何令牌；`.npmrc-publish` 仅读取校验，绝不创建或修改。
- 本技能不改任何既有文件，仅在 `assets/skills/npm-publish/` 下新建文件。
