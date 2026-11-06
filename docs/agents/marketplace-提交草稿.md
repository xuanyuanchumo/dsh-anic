# awesome-dsh-plugin 收录条目（cycle-109 校准版）

> 本文件是**投稿素材与状态记录**。PR 已提交：**#12071**
> （`state: OPEN` / `mergeable: MERGEABLE` / `mergeStateStatus: CLEAN` / `changedFiles: 1`；
> cycle-109 实取复核：`gh pr view 12071`）。
> 规则来源：`awesome-dsh-plugin/awesome-dsh-plugin` 的 `contributing.md`（cycle-108 实取原文核对）。

## 0. cycle-109 复核结论（数字未变）

| 项 | 状态 |
|---|---|
| PR #12071 | OPEN / CLEAN / 1 file（**无需改动**——工具数 24 与路由数 77 本轮均未变） |
| npm `dsh-anic@latest` | ✅ **0.59.0**（`npm view dsh-anic version --registry https://registry.npmjs.org` 实测） |
| GitHub Release | ✅ **v0.59.0**（资产 `dsh-anic.tgz` 968,245 B + `dsh-anic.tgz.sha256`；`releases/latest/download/dsh-anic.tgz` HTTP 200） |
| 条目描述里的 24/77 | 仍与源码一致（`tests/contract/readmeNumbers.test.ts` 机器复算） |
| CI | ✅ run `42191384145` success（含 cycle-109 新增三条图谱契约的 CI 排除族修复） |

本轮新增能力**不改变**条目里的数字契约：`disclosureVerdict` / `skillVisibility` /
`skillLibrary` 三个读数是**既有路由与既有工具的字段扩展**，没有新增工具或路由。

## 1. 提交方式

向 `github.com/awesome-dsh-plugin/awesome-dsh-plugin` 提 PR，**只新增一个文件**：
`data/plugins/xuanyuanchumo__dsh-anic.yml`（列表 README 由脚本生成，勿手编；一个 PR 最多 3 条）。

## 2. 条目内容（数字已对照代码核实：**24 工具 / 77 路由**）

```yaml
url: https://github.com/xuanyuanchumo/dsh-anic
name: xuanyuanchumo/dsh-anic
category: workflow
tarball: https://github.com/xuanyuanchumo/dsh-anic/releases/latest/download/dsh-anic.tgz
icon: https://github.com/xuanyuanchumo/dsh-anic/raw/master/assets/icon-180.png
description:
  en: 'AI-native iteration cycle: 24 anic_* tools and 77 HTTP routes that run evaluation, convergence gates (G0-G3), HITL audits and auto-fix loops, with a live white-box panel (workflow graph, invocation feed, autonomy gauge, gate ledger).'
  zh: 'AI 原生迭代循环：24 个 anic_* 工具与 77 个 HTTP 路由驱动评估、收敛门禁（G0-G3）、HITL 审计与自动修复循环，附带实时白盒面板（工作流图、调用流、自主级仪表带、门禁账本）。'
```

## 3. contributing.md 的实际硬门槛（复核结论：只有这些）

| # | 要求 | 本仓状态 |
|---|---|---|
| 1 | 一个 PR 只动自己的条目（`changed_files` ≤3） | ✅ 1 |
| 2 | 条目文件名 `<owner>__<repo>.yml` | ✅ |
| 3 | `description.en` 以句号结尾；含 `: ` 时整体加引号 | ✅ |
| 4 | 无营销词、数字须与代码一致 | ✅ 24/77 双向可复算 |
| 5 | `package.json` 声明 `dsh.bundle.patch` | ✅ `cordis.patch.yml` |
| 6 | 仓库有 topic `dsh-plugin` | ✅（另加 8 个检索 topic） |
| 7 | 仓库创建满 1 天 | ✅ 2026-11-04 建仓 |

**规范里不存在、旧稿误当门槛**：README 必备小节 / 安装命令 / LICENSE / badge / 星数 / 测试门槛 /
PR 模板。`awesome-lint` 只检查**列表仓**，不检查投稿仓库。

## 4. 本轮修复的收录面缺陷（cycle-108）

| # | 缺陷（旧稿形态） | 现状 |
|---|---|---|
| M1 | 安装命令是占位 `github:<owner>/dsh-anic` | README 改为 `github:xuanyuanchumo/dsh-anic` + npm + tarball 三入口 |
| M2 | README 两处 `engines.dsh` 是**旧单分支** `>=0.2.0-rc.2 <0.4.0-0`（预发布陷阱） | 逐字改为 `>=0.2.0-rc.2 <0.3.0-0 \|\| >=0.3.0-rc.1 <0.4.0-0`（与 `package.json` 一致） |
| M3 | README 的 `../docs/anic/` 跳仓 404 | 改仓内相对链接 |
| M4 | 无 PNG 图标（列表只收位图，SVG 被拒收 → 回退仓库头像） | `assets/icon-180.png`（几何/配色由 `icon.svg` 按 32→180 派生） |
| M5 | `keywords` 12 条，缺 SDLC/HITL/autonomy/graph 检索词 | 20 条；GitHub topics 建议补 `convergence-gate, hitl, autonomy, workflow-visualizer, sdlc, mcp-server` |

## 5. 数字契约（**两份都无自动守卫**）

- 仓内有守卫：`tests/contract/readmeNumbers.test.ts`（钉 README 的 24/77，按源码 glob 复算）。
- **无守卫**：列表条目 yml、PR 正文、`docs/agents/CI-CD与发布流程.md`、本文件。
  ⇒ 工具数/路由数变动时这四处必须**手工同步**（本轮已同步本文件与 CI-CD 册）。

复算口径：

```sh
# 工具数：src/host/tools*.ts 里 name: 'anic_*' 去重
grep -rho "name: 'anic_[a-z_]*'" src/host/tools*.ts | sort -u | wc -l   # → 24
# 路由数：src/host/routes/ 的路径字面量（四种注册形态）去重
```

## 6. 用户动作项（agent 不可代做）

1. **npm 发布**：`dsh-anic@0.58.0` 发布后，确认 `npm view dsh-anic version` 与 GitHub Release 一致
   （历史缺口：registry 停在 0.56.0 直到 cycle-108 收口）。
2. 给仓库补 topics（`gh repo edit --add-topic ...`）。
3. PR #12071 维护者合并后，确认列表页出现条目；若维护者要求补图，`icon:` 已指向 PNG。
4. 发布后把 `tarball:` 指向的资产更新说明写进 release notes（稳定名 `dsh-anic.tgz` 由
   `release.yml` 每次覆盖，URL 不变）。

## 7. 仓库侧物料清单

- `package.json`：`dsh.bundle.patch: ./cordis.patch.yml`、双分支 `engines.dsh`、20 keywords、`files` 含 `assets/icon-180.png`
- `LICENSE`（MIT）、`screenshots.json`（3 张真面板截图）、`assets/icon-180.png`
- `README.md` 顶部安装段（DSH 版本范围 / 三入口 / 技能自动安装 / 24 工具 / 77 路由）
- `docs/anic/25、26、27`：技能库研究 / 闭环审计 / 本轮落地记录