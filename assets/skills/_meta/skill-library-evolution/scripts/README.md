# skill-lib-*.mjs 脚本说明

> 位置参数铁律：**第一个位置参数 = 项目目录**（`node <script> <projectDir> ...args`）。
> 与主干技能 `invokeSkillScript` 的约定一致——**绝不**在 args 里再传项目目录或 `--project-dir` 旗标。

## skill-lib-manifest.mjs

技能库注册表生成/校验 + 三锚一致守卫。

```sh
node skill-lib-manifest.mjs <projectDir> --check       # 错误级 exit 1（CI 硬门）
node skill-lib-manifest.mjs <projectDir> --report      # 只读报告 exit 0
node skill-lib-manifest.mjs <projectDir> --snapshot    # 冻结库快照（sha256 清单 → .cycles/skill-snapshot/）
```

检查：注册表字段完整性、技能目录/SKILL.md 存在性、frontmatter name 与注册表一致、
锚点文件存在、SKILL.md 推断版本与注册表版本一致、元技能自身脚本锚点存在。

## skill-lib-drift.mjs

四类漂移守卫。

```sh
node skill-lib-drift.mjs <projectDir> --check          # 错误级 exit 1
node skill-lib-drift.mjs <projectDir> --report         # 只读报告 exit 0
node skill-lib-drift.mjs --selftest                    # 反向自检（守卫必须能失败）
```

守卫：

1. **版本锚** —— SKILL.md 推断版本 == 注册表版本；
2. **词表绑定** —— 只许 A 族维度词（`dimensions.mjs`），禁 B 族旧称；
3. **原子写** —— scripts 里写 `.cycles/**` 必须经 `atomicWriteFileSync`，禁裸 `writeFileSync`；
4. **配置入口** —— `.cycles/config.yml` 是唯一规范入口。

## skill-lib-ledger.mjs

技能库补丁生命周期账本（复用主干 `lib/ledger.mjs` canonical 载荷）。

```sh
node skill-lib-ledger.mjs <projectDir> --record SKILL_PATCH_PROPOSED --skill <name> [--detail "..."] [--extra-json '{}']
node skill-lib-ledger.mjs <projectDir> --verify
node skill-lib-ledger.mjs <projectDir> --list
```

事件类型：`SKILL_PATCH_PROPOSED` / `SKILL_PATCH_KEPT` / `SKILL_PATCH_REVERTED` /
`SKILL_VERSION_BUMP` / `SKILL_DRIFT_ALARM` / `SKILL_LIB_AUTONOMY_CHANGE` / `SKILL_EVIDENCE_LINK`。

## 安全纪律

- 零外部依赖（`node:fs` / `node:path` / `node:crypto`）。
- 绝不写明文凭据；令牌一律经 DSH 凭证库 `vault_run` 注入。
- 绝不越出项目目录写文件（快照只写 `<projectDir>/.cycles/skill-snapshot/`）。
- 脚本是确定性实现层；插件是调用面 + 状态 + 可观测性层（17 号结论）。
