# dsh-native-api · 故障排查

> 失败模式 → 根因 → 修复。每条都标注证据出处（KB 路径:行号或本仓 file:line）。

## 1. `dsh plugin add` 后插件不激活（无层）

**症状**：`dsh --profile demo --dump-config` 里没有 `# == dsh-hello-plugin` 层。

**根因**：包没有声明 `dsh.bundle`。

**修复**：`package.json` 的 `dsh` 键加 `"bundle": { "patch": "./cordis.patch.yml" }`。
没有该声明的包仍可安装，但只作普通依赖，`dsh plugin` 会打印警告且不激活任何层
（`kb/site/develop/basic/publish.md:67`）。

## 2. client 半部不出现在 Loader entries

**症状**：客户端标签不渲染，`window.__DSH_BOOT__` 里没有本插件 client。

**根因**：`cordis.patch.yml` 缺少 `insert` entry——每个插件必须在此声明 insert，
否则 `dsh.profile.bundles` 只加载 host 半部，client 半部永不出现在 Loader entries。

**修复**：对照 `cordis.patch.yml` 加 `- insert:`（本仓 `cordis.patch.yml:10-13`）。

## 3. 双挂载（同包被加载两次）

**症状**：插件注册出现重复，或行为异常。

**根因**：patch 里 `insert` 没有防双挂载守卫。

**修复**：加 `disabled: !!js "[...ctx.loader.entries()].some((e) => e.options.name === '<pkg>' && e.options.id !== '<id>' && !e.disabled)"`
（本仓 `cordis.patch.yml:13`）。

## 4. 安装/启动被拒绝：DSH 版本不兼容

**症状**：`dsh plugin add` 或 profile 启动报 engines 不满足。

**根因**：`engines.dsh` SemVer 范围与运行中 DSH 不符。

**修复**：核对 `engines.dsh` 范围（本仓 `>=0.2.0-rc.2 <0.4.0-0`，`package.json:49`）；
上界过窄会阻塞后续 DSH——逐版本核对，建立升级 checklist（`B-dsh-native-api-baseline.md` §2.1）。

## 5. `peers` 字段在新规则下无效

**症状**：peer 声明了但兼容性判定不生效。

**根因**：`peers` 字段已改名为 `requirements`。

**修复**：改用 `requirements`（`kb/publish.md:69`；`kb/extra/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.zh.md:12-21`）。
只在**缺 `engines.dsh`** 时才回退检查 peer/requirements。

## 6. git 安装后加载失败（无 `lib/`）

**症状**：`dsh plugin add github:you/hello-plugin` 后插件加载失败，报找不到入口。

**根因**：git 安装拉源码不拉构建产物，没有环节运行 `build`，TS 包无 `lib/`。

**修复**（两条路）：
- 作者提供 `prepare` 脚本（pnpm 在 git 安装后运行，自包含，不假设 monorepo checkout）；
- 或改为分发构建产物（npm 发布 / tarball），免构建授权。

证据：`kb/publish.md:164-190`。

## 7. pnpm ≥10 拒绝运行 git 依赖的 `prepare`

**症状**：第一次 `add` 失败，提示需要授权。

**根因**：pnpm ≥10 在显式允许前拒绝运行 git 依赖的 `prepare`。

**修复**：把 pnpm 打印的**确切包键**复制进该 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

然后重新执行 `add`。**视为允许该包代码在安装时于你的机器上执行**，且不在 agent 沙箱内；
只对源码可信的包授权，并锁定 commit（`github:you/hello-plugin#<sha>`）。

证据：`kb/publish.md:172-184`。

## 8. 配置改动不生效 / 插件热替换异常

**症状**：改 `cordis.yml` 的 config 后行为没变。

**根因**：配置变更会触发插件热替换（卸载旧实例加载新实例）；若注册不是 effect 则可能残留旧注册。

**修复**：确保所有注册都是 effect（自动清理）；配置 schema 在加载时校验，非法配置会响亮失败
（`kb/site/develop/basic/config.md:97-103`）。

## 9. `ctx.get(name)` 把正在 loading 的 provider 杀死

**症状**：插件激活后服务莫名消失 / fiber pending。

**根因**：`ctx.get(name)` 默认 `strict=true`，加载期 strict 会杀死正在 loading 的服务。

**修复**：探测存在性一律 `ctx.get(key, false)`（`CLAUDE.md:28`；
`kb/site/develop/framework/service.md:92-103`）。本仓对 `webServer`/`workspaceRegistry` 用探测，
路由走独立子 fiber（`src/index.ts:4-28,125,142`）。

## 10. headless 下整条 fiber pending

**症状**：`pending (waiting for service: webServer)`，工具/索引/自举链一并失效。

**根因**：在 headless 下强 inject `webServer`/`pluginManager`——它们属 Web 组合，headless 无之。

**修复**：不硬依赖；用 `ctx.get(name, false)` 探测并降级（本仓 `src/index.ts:9-28`）。

## 11. `deferLoading` 设置了但模型仍能看见工具

**症状**：本想延迟加载，工具仍常驻模型上下文。

**根因**：`deferLoading` 只适合「所有场景一律延迟」的静态选择；宿主投影时仅当
`deferLoading === true` 才放进模型 schema。

**修复**：确认字段值是字面 `true`（`src/host/toolsSlot.ts:152`）；per-workspace 场景改用
`restrict` + loader 工具方案（`docs/agents/渐进式披露与轻量索引设计.md:471-480`）。

## 12. 路由重复注册抛异常

**症状**：`register` 抛「重复 `(kind, path)`」。

**根因**：路由模式是组合层约定，冲突即配置错误（`kb/site/reference/subsystems/web-server.md:196-204`）。

**修复**：检查是否有两个插件/层注册了相同 `(kind, path)`；fallback 唯一（第二次注册抛错）。
本仓全部端点 `kind: 'exact'`（`docs/agents/API参考.md:25`）。

## 13. 条件请求不生效（永远 200）

**症状**：`If-None-Match` 带了但总是 200。

**根因**：WebServer 不自动加 ETag，插件需自实现；且指纹若覆盖 `generatedAt` 则永远不等。

**修复**：插件自实现语义 ETag（排除易变字段）；本仓 `snapshotRoute.ts` 已做
（`src/host/snapshotRoute.ts:175-241`）。

## 14. 定位纪律

- **先证据后结论**：每条结论引用 `kb/路径:行号` 或 `file:line`，不凭印象。
- **以实际安装包为准**：KB 快照可能与运行时不一致。
- **不降级**：不为让安装通过而放宽 `engines.dsh` 上界或跳过校验。
- **不假绿**：`allowBuilds` 授权要记录在案；不静默授权未知包。
- **无证据 ≠ 通过**：未跑 manifest 校验时按 SKIP 处理。
