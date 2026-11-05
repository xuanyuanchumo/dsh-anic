# npm-publish CHANGELOG

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
