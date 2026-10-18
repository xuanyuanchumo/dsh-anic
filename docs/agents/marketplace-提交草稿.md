# awesome-dsh-plugin 收录条目草稿（cycle-23 产出）

> 本文件是投稿素材，**不是**已提交的 PR。用户动作项见文末。
> 规则来源：awesome-dsh-plugin/awesome-dsh-plugin contributing.md（2026-10-18 快照）。

## 提交方式

向 github.com/awesome-dsh-plugin/awesome-dsh-plugin 提 PR，新增**一个文件**：
`data/plugins/<owner>__dsh-anic.yml`（README 由脚本生成，勿手编；一个 PR 最多 3 条）。

## 条目内容（描述数字已对照代码核实：19 工具 / 62 路由 / 白盒面板）

```yaml
url: https://github.com/<owner>/dsh-anic        # ← 建仓后替换 <owner>
name: <owner>/dsh-anic
category: workflow
description:
  en: 'AI-native iteration cycle: 19 anic_* tools and 62 HTTP routes that run evaluation, gate, and auto-fix loops, with a live white-box panel (workflow graph, invocation feed, autonomy gauge, gate ledger, HITL queue).'
  zh: 'AI 原生迭代循环：19 个 anic_* 工具与 62 个 HTTP 路由驱动评估、门禁与自动修复循环，附带实时白盒面板（工作流图、调用流、自主级仪表带、门禁账本、HITL 队列）。'
```

注意事项（来自 contributing.md）：
- 描述含 `: `（冒号+空格）必须整体加引号——上面 en 行已加单引号。
- 描述会被维护者对照代码核实：19 工具（`src/host/tools*.ts` grep `name: 'anic_'`）、
  62 路由（`src/host/routes/` 路径字面量去重）均已复核。**改动工具/路由数量后必须同步本条目。**
- category 备选：`workflow`（首选，迭代循环/门禁/流程状态机）；`skill` 次之。

## 用户动作项（agent 无法代做：本仓库当前无 git remote、无 GitHub 凭据）

1. 在 GitHub 创建 `<owner>/dsh-anic` 公开仓库并推送（仓库需满 1 天才能过 CI）。
2. 给仓库加 topic `dsh-plugin`（收录硬性要求）。
3. 可选：发 npm 包（预构建安装免 `allowBuilds` 构建授权）或在 GitHub Release 挂
   `dsh-anic.tgz` 预构建产物并在条目加 `tarball:` 字段——不发布也不影响收录，
   只是安装体验差异。
4. 提 PR：fork awesome-dsh-plugin → 新增 `data/plugins/<owner>__dsh-anic.yml`
   （内容见上）→ CI 绿后等维护者审。

## 已就绪的仓库侧物料（本仓库，cycle-23 已完成）

- `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`（可安装性硬性要求 ✓）
- `LICENSE`（MIT，contributing 惯例）
- `screenshots.json` → `docs/screenshots/` 三张真面板截图
  （workflow-graph 1440x960 / ledger-hitl 1154x499 / autonomy-gauge 1440x960，
  Playwright 真机 3080 测试宿主拍摄）
- `README.md` 顶部新增「安装」段（dsh plugin add / engines.dsh / 技能自动安装说明）
- peer 范围 `>=0.2.0-rc.2 <0.4.0-0` 已是显式预发布分支形态（contributing.md 推荐写法）
