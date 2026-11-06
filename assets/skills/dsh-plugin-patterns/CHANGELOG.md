# dsh-plugin-patterns CHANGELOG

格式遵循仓库纪律：版本锚点 + 起点/终点 + 证据。本技能由 cycle-107（v0.57.0）创建。

## v0.1.0 — 2026-11-06（cycle-107：dsh-ops/dsh-context 源码研究沉淀 + 命令窗口修复锚点）

> 起点：两个研究子代理的源码研究报告（dsh-ops v0.4.4 / dsh-context v0.81.0）+
> cycle-107 命令窗口显示修复实战。
> 终点：14 条工程模式（P01-P14）+ 实战锚点 + 排错速查（6 条）。

### 新增

- **A 工具注册面**：P01 能力目录表 / P02 description 密集契约 / P03 渐进披露 / P04 toolview 席位注册。
- **B Client UI 纪律**：P05 稳定组件+epoch 守卫 / P06 CSS 命名空间+主题令牌 / P07 XSS 惰性旁路。
- **C 生命周期**：P08 safeDispose / P09 effect 带标签 / P10 mountResultLifecycle。
- **D 防御式与失败契约**：P11 失败为值+nextAction / P12 断言未知键。
- **E 持久化与可观测**：P13 分层持久化+显式 bounds / P14 读官方投影不自算。
- **实战锚点**：cycle-107 命令窗口显示修复三步链 + 冒烟契约演进纪律。
- **排错速查**：6 条症状→根因→处方（含沙箱 pipe EPERM 边界与块注释 glob 陷阱——本次实锤）。
