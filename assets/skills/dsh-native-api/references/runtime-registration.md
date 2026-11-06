# 运行时注册面（runtime-registration）

> 归属：`dsh-native-api` 叶技能的参考文件（cycle-108）。**只讲"插件在运行时把能力挂进宿主"**
> 这条链路；打包/安装/`engines.dsh` 见 `SKILL.md`，模式清单见 `dsh-plugin-patterns`。
> 事实源：官方文档镜像 `dsh-plugin-dev-kb`（引用格式 `kb/...`）+ 本仓实测 `src/host/`。

## 1. 三个注册面（官方 seam）

| 面 | 官方锚点 | 语义 | 本仓用法 |
|---|---|---|---|
| `ctx.tools` | `kb/site/reference/capability-seams.md`（`svc_tools` 节点）；`kb/site/reference/cookbook/adding-a-tool.md:18-25` | 工具注册表 + 受控执行管道 | `src/host/tools*.ts` 注册 24 个 `anic_*` |
| `ctx.skills` | `kb/site/reference/capability-seams.md:683` | **Skill provider 注册表**（合并提供方目录） | `src/host/skillRegistration.ts` 注册运行时技能 |
| `ctx.webServer` | 同 seams 文档（host 面） | HTTP 路由注册（`{kind:'exact', path, handler}`） | `src/host/routes/*.ts` 77 条 |

**纪律**：声明依赖用 `inject = ['tools']` / `ctx.inject = [...]`（官方骨架）；
**探测可选服务**一律 `ctx.get(name, false)` —— 默认 `strict=true` 会在 provider 仍在
loading 时抛错并杀死它（本仓 CLAUDE.md 明确列为"agent 常犯错误"）。

## 2. 工具注册的完整形状

```ts
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'my_tool',
    description: '…',                 // 模型可见；触发词前置
    parameters: { … },                // JSON Schema
    async execute(args) { … },
  }))                                  // 返回**精确 disposer**
}
```

四条工程纪律（本仓血泪）：

1. **注册必须返回 disposer 并纳入 `safeDisposeAll`**——否则热重载/禁用后路由或工具会重复注册
   （本仓 `tests/unit/safeDispose.test.ts` + `graphInteractive*` 的"刷新按钮唯一"断言同源）。
2. **工具名是契约**：本仓 `src/shared/anicToolIds.ts` 与注册处**双向对账**
   （`tests/contract/toolIdsContract.test.ts`），数量由 `tests/contract/readmeNumbers.test.ts` 钉进 README。
3. **参数未知键拒绝**：`assertKnownArguments`（`src/host/toolsArgGuard.ts`）——宿主会把模型
   幻觉的键原样传进来，不拒绝就会"静默忽略"。
4. **失败是值**：工具失败返回结构化错误（`nextAction` / `effectState`），不靠抛异常表达
   （`src/host/routes/envelope.ts`）。抛异常在不同宿主版本下会被折叠成"工具崩了"，用户读不到原因。

## 3.  Skill 运行时注册：官方链路 vs 本仓现状（cycle-108 研究结论）

官方链路（`kb/site/reference/subsystems/skills.md` 语义 + 输入 L 报告校正）：

```
register(scope 层, 层内 first-wins, 返回精确 disposer)
  → skills/change 事件（无 diff，消费方自行重取）
  → snapshot{skills, complete}（全局层 + scope 链合并；complete=false 永不缓存）
  → dsh-tool-skill 首个 pre-step 注入 <available_skills>
      （只 name + XML 转义 description，description 截 500 字符）
  → 后续每步 digest 比对，变化则整目录替换
  → skill({name}) 载入前 isModelInvocable 拒绝 / 返回前再查 / ctx.skills.get 重读
```

**关键事实**：注册表**永不缓存定义**；`project` 层同名条目**直接赢得** runtime 条目。

本仓现状（`src/host/skillRegistration.ts`）：只走到 `register`，形状正确
（`name/description/whenToUse/source:'runtime'/content/resourceBase`），但存在四个缺口：

| # | 缺口 | 后果 | 修法（进 cycle-109 裁决） |
|---|---|---|---|
| 1 | 不传 `invocation` | frontmatter 的 `disable-model-invocation` / `user-invocable` 被静默丢弃 | 解析两键并透传 |
| 2 | 注册后不回读 `snapshot()` | 同一工作区放一个同名 `.dsh/skills/<name>.md` 会**静默压制** runtime 条目，而日志仍打"已注册" | 回读 + `classifySkillVisibility`；`complete:false`/无 snapshot 一律 `unknown`，**绝不判 absent** |
| 3 | 不订阅 `skills/change` | 退役/替换后本仓计数不可见 | 复用 `toolsChangeCounter` 模板加计数器 |
| 4 | 不用 `registerProvider` | `assets/skills/` 的内部技能库只能靠落盘安装，运行时不可挂 | 先评估 provider 契约再动 |

## 4. 渐进披露：官方面与本仓自定义的边界

- 官方工具 schema **没有** `availability: 'resident' | 'discoverable'` 字段——
  那是 dsh-ops 自己的目录表字段（`registry.js:16-19`），**宿主不读**。
  本仓**不要**给 `ToolRegistration` 加这个字段（无消费方的声明 = 假能力）。
- 官方有 `ctx.tools.schemas(scope)`（KB `subsystems/tools.md` 关于 schemas 的段）；
  本仓 `runtime/disclosureReadout.ts` 自己写明"不证明 restrict 真生效，那要读宿主工具视图"。
  ⇒ 落地前必须先做**真机探针**（scoped schemas 是否真按 deny 过滤），否则 verdict 会在
  正确宿主上恒报 partial（把"取证不到"误报成"没生效"）。

## 5. 生命周期与反复挂载

- **每个注册返回 disposer，全部进 `safeDisposeAll`**（本仓 `src/host/runtime/safeDispose.ts`，
  语义照搬 dsh-ops）；
- **禁止模块级可变单例存挂载状态**（hot reload 会保留模块图）——用 `ctx` 上的状态或
  WeakMap + 显式 dispose；
- **重复注册的检测**：注册前查已存在（本仓 `indexActivation` 用 `registered` 标志），
  测试里断言"刷新按钮唯一/路由只注册一次"（重复注册会翻倍 DOM 与路由表）。

## 6. 自检清单

- [ ] 新注册面都有 disposer，且被 `safeDisposeAll` 收集
- [ ] 可选服务用 `ctx.get(name, false)`，不用 `ctx.get(name)`
- [ ] 新增工具名同步 `anicToolIds` + README 数字（两侧都有契约守卫）
- [ ] 新增路由同步 `.cycles/config.yml`?（否）但必须同步 `docs/agents/API参考*.md` 与 `auditWiring` 的声明表
- [ ] 未使用官方 seam 时，注释里写明**为什么**（防"看起来漏了"）
- [ ] 别把 dsh-ops 私有字段当官方 API（`availability` 是典型反例）