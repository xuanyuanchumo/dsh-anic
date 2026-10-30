# cycle-83 图区 i18n 键（V 战线交付给 Lead 合并）

> 状态：**待 Lead 合并进 `locale/zh.json` + `locale/en.json`**（两文件键集必须全等，
> `tests/contract/i18nDeadKeyContract.test.ts` ④ 会双向校验）。
>
> 与 cycle-82 的差别：cycle-82 用**整串字面量**（`t('graph.toolbarLabel')`），cycle-83
> 的新键一律走 `gt('短名')`（内部 `t('graph.' + suffix)`），原因见 §四。

## 一、消费点总览

| 文件 | 用途 | 键族 |
| --- | --- | --- |
| `src/client/features/graph/graphText.ts` | **唯一**取用入口（`gt`） | 下列全部新键 |
| `src/client/features/graph/graphTooltip.ts` | 悬浮预览卡 | `graph.tooltipDegree` |
| `src/client/features/graph/graphMiniMap.ts` | 小地图可访问名 | `graph.minimapLabel` |
| `src/client/features/graph/graphBreadcrumb.ts` | 面包屑五段 | `graph.crumb*` |
| `src/client/features/graph/graphToolbarGroups.ts` | 工具栏分组标签 | `graph.group*` |
| `src/client/features/graph/graphToolbarRender.ts` | 类型/裁决动态键族 | `graph.lane.<type>` / `graph.verdict.<k>` |

## 二、新增字面键（12 条，`graph.group*` 5 条 + `graph.tooltipDegree` 1 条 + `minimapLabel` 1 条 + `crumb*` 6 条 → 共 13）

| 键 | 中文 | 英文 | 插值 |
| --- | --- | --- | --- |
| `graph.tooltipDegree` | 一跳邻居 {degree} 个 | {degree} one-hop neighbors | `{degree}` |
| `graph.minimapLabel` | 图谱小地图（{nodes} 个节点），点击可跳转视口 | Graph minimap ({nodes} nodes); click to jump | `{nodes}` |
| `graph.crumbRoot` | ANIC | ANIC | — |
| `graph.crumbCycle` | 当前轮 {cycle} | Current cycle {cycle} | `{cycle}` |
| `graph.crumbPhase` | 阶段 {phase} | Phase {phase} | `{phase}` |
| `graph.crumbWindow` | 窗口 {total} 个节点（折叠 {hidden} 个） | Window of {total} nodes ({hidden} folded) | `{total}` `{hidden}` |
| `graph.crumbAll` | 全量 {total} 个节点 | All {total} nodes | `{total}` |
| `graph.crumbLabel` | 图区位置面包屑 | Graph location breadcrumb | — |
| `graph.groupSearch` | 搜索 | Search | — |
| `graph.groupType` | 节点类型 | Node type | — |
| `graph.groupVerdict` | 裁决 | Verdict | — |
| `graph.groupZoom` | 缩放 | Zoom | — |
| `graph.groupA11y` | 辅助 | Assistance | — |

> 说明：`graph.crumbCycle` 的插值参数名是 `cycle`（与 `panel.nodeAriaLabel` 的 `{label}`/`{id}`
> 同一约定：参数名 = 语义名，不用泛化的 `{value}`）。

## 三、动态键族（cycle-82 已登记，cycle-83 继续消费，**不新增**）

- `graph.lane.<type>`：8 个类型（phase / micro-step / gate / human-gate / cycle /
  gate-event / incident / autonomy）；
- `graph.verdict.<key>`：6 个规范键（pass / fail / doubt / pending / skip / none）。

cycle-83 新增消费点：**节点卡片的次标签**（`graphNodeCard.metaLabelOf`）与
**tooltip 的类型/裁决行**都走这两个键族。它们已存在于 locale，故不重复登记。

## 四、为什么新键不写整串字面量（合并前后都干净）

闭环体检有两条机械判据同时生效：

1. `i18nGhosts`：源码里出现 `t('graph.crumbRoot')` 这种**整串字面量** ⇒ 立刻被报成
   「幽灵消费」（键不存在），`closureAuditContract ③` 变红；
2. `i18nClosure`：键进 locale 之后若无人消费 ⇒ 「死键」，`i18nDeadKeyContract` 红。

前缀形态 `t('graph.' + suffix)` 两头都安全：合并前键不存在（无幽灵、无死键），
合并后 `dynamicKeyPrefixes` 以 `graph.` 前缀认领全部 `graph.*` 键。

**注意既有 14 条 `graph.*` 键仍是整串字面量消费**（cycle-82 形态），它们走 literal
证据优先于动态前缀，所以新键引入前缀不会掩盖它们的真实状态。

代价是拼错不再有幽灵提示 ⇒ `graphText.ts` 用字面量联合 `GraphTextSuffix`
把拼错挡在**编译期**（与 `configTypes.ts` 的 `ConfigTextSuffix` 同一手法）。

## 五、合并时容易踩的两处

1. **`graph.crumbWindow` / `graph.crumbAll` 必须成对存在**：`crumbsOf` 按
   `windowedOut > 0` 二选一。只加一条会让另一条在真实数据下渲染成键名本身
   （`t()` 的缺省回落是键名，可见的漏翻而不是空白）。
2. **`graph.minimapLabel` 的 `{nodes}` 是数字**：`t()` 的插值用 `String(v)`，
   与 `panel.graphLabel` 的 `{nodes}` 同形，不要写成 `{count}`。

## 六、合并后必须复跑

```
npx vitest run tests/contract/closureAuditContract.test.ts tests/contract/i18nDeadKeyContract.test.ts
```

两条契约分别守「无幽灵消费」与「无死键」。合并前它们对本文件登记的新键应保持
**现状**（不因为新增 `gt()` 调用而变红——`gt` 内部是 `t('graph.' + suffix)`，
扫描器认得 `graph.` 前缀族）。
