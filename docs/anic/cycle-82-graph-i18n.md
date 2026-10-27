# cycle-82 图区 i18n 键（G 战线交付给 Lead 合并）

> 状态：**待 Lead 合并进 `locale/zh.json` + `locale/en.json`**（两文件键集必须全等，
> `tests/contract/i18nDeadKeyContract.test.ts` ④ 会双向校验）。
>
> 合并前，`GraphInteractive`/`graphToolbar` 里的 `t('graph.*')` 调用会被
> `closureAudit` 的 `i18nGhosts` 报为**幽灵消费**（引用了未定义的键）——
> 这是已知过渡态，合并后归零。

## 一、消费点总览（谁在用）

| 文件 | 用途 | 键 |
| --- | --- | --- |
| `src/client/features/graph/graphToolbar.ts` | 工具栏全部文案 | 下列全部 |
| `src/client/features/graph/GraphInteractive.ts` | 视口说明 | `graph.keyHint` |
| `src/client/features/graph/graphToolbar.ts` | 类型 chip / 图例（动态键族） | `graph.lane.<type>` |
| `src/client/features/graph/graphToolbar.ts` | 裁决选项（动态键族） | `graph.verdict.<verdict>` |

## 二、字面键（12 条）

| 键 | 中文 | 英文 |
| --- | --- | --- |
| `graph.toolbarLabel` | 工作流图工具栏 | Workflow graph toolbar |
| `graph.searchPlaceholder` | 搜索节点（名称或 id） | Search nodes (label or id) |
| `graph.searchLabel` | 搜索工作流节点 | Search workflow nodes |
| `graph.typeGroupLabel` | 按节点类型筛选 | Filter by node type |
| `graph.verdictLabel` | 按裁决筛选 | Filter by verdict |
| `graph.zoomIn` | 放大 | Zoom in |
| `graph.zoomOut` | 缩小 | Zoom out |
| `graph.zoomFit` | 适配视图 | Fit to view |
| `graph.zoomFitHint` | 让整张图回到视口内（也可双击图或按 0） | Fit the whole graph into the viewport (or double-click the graph / press 0) |
| `graph.zoomReadout` | 当前缩放比例 | Current zoom level |
| `graph.adjacency` | 高亮邻居 | Highlight neighbors |
| `graph.adjacencyLabel` | 悬停或聚焦节点时高亮其一跳邻居 | Highlight one-hop neighbors when hovering or focusing a node |
| `graph.clearFilter` | 清空筛选 | Clear filters |
| `graph.keyHint` | 图区键盘操作：方向键在节点间移动，Home/End 跳到首尾，Enter 或空格打开详情，加号减号缩放，0 适配视图，Escape 清空筛选。滚轮缩放，拖拽平移，双击适配视图。 | Graph keyboard controls: arrow keys move between nodes, Home/End jump to first/last, Enter or Space opens details, plus/minus zoom, 0 fits to view, Escape clears filters. Wheel zooms, drag pans, double-click fits to view. |

> 注：上表 14 行——`graph.zoomFitHint` 是 `graph.zoomFit` 按钮的 `title`（悬停提示），
> 两者文案不同（前者是动作名，后者是"还有什么办法"），故分别登记。

## 三、动态键族（必须一并登记，否则闭包扫描报幽灵）

闭包扫描器 `i18nClosure.dynamicKeyPrefixes` 认得 `t('graph.lane.' + type)` 这种
**拼接前缀**（`graph.lane.` / `graph.verdict.` 都以 `.` 结尾 ⇒ 构成合法前缀族，
见 `endsWithSeparator`）。因此：

- 前缀本身不需要 key，但**每个实际会出现的后缀**都必须有对应键，
  否则用户看到的是键名本身（`t()` 的缺省回落是键名，可见的漏翻而不是空白）。

### 3.1 `graph.lane.<type>`（8 个类型，与 `LANE_ORDER` 一一对应）

`LANE_ORDER` = `phase, micro-step, gate, human-gate, cycle, gate-event, incident, autonomy`

| 键 | 中文 | 英文 |
| --- | --- | --- |
| `graph.lane.phase` | 阶段 | Phase |
| `graph.lane.micro-step` | 微步骤 | Micro-step |
| `graph.lane.gate` | 门禁 | Gate |
| `graph.lane.human-gate` | 人工门 | Human gate |
| `graph.lane.cycle` | 循环 | Cycle |
| `graph.lane.gate-event` | 门禁事件 | Gate event |
| `graph.lane.incident` | 事故 | Incident |
| `graph.lane.autonomy` | 自主级 | Autonomy |

### 3.2 `graph.verdict.<key>`（6 个规范键，含 `none`）

| 键 | 中文 | 英文 |
| --- | --- | --- |
| `graph.verdict.pass` | 通过 | Pass |
| `graph.verdict.fail` | 失败 | Fail |
| `graph.verdict.doubt` | 存疑 | Doubt |
| `graph.verdict.pending` | 待定 | Pending |
| `graph.verdict.skip` | 跳过 | Skip |
| `graph.verdict.none` | 未裁决 | No verdict |

## 四、需要 Lead 注意的两处（合并时容易踩）

1. **`graph.*` 必须是 `locale` 顶层新命名空间**（与 `panel` / `live` / `trace` 平级）。
   不要塞进 `panel.*` 下——`panel.graphLabel` / `panel.graphDesc` 已是既有键，
   混进同一个前缀会让"图区"与"面板工具栏"的词表边界消失，下一轮清理会误删。

2. **JSON 里 `graph.lane.micro-step` 这类带连字符的键必须写成嵌套对象的两层**：

   ```json
   "graph": { "lane": { "micro-step": "微步骤", "gate-event": "门禁事件" }, "verdict": { "none": "未裁决" } }
   ```

   `flattenKeys` 会展开成 `graph.lane.micro-step`，与代码里的拼接一致。

## 五、合并后的自检命令（Lead 侧）

```bash
cd /d/Projects/TraeProjects/dsh-anic
npx vitest run tests/contract/i18nDeadKeyContract.test.ts tests/contract/closureAuditContract.test.ts
```

- `i18nDeadKeyContract` ①：未消费键集 ⇄ RESERVED 必须双向相等（新增 20 条键若**全部**被
  上面两处消费点引用，则不会进 deadKeys）；
- `closureAuditContract` ③：`CLOSURE_GHOSTS` 必须为 `[]`（合并前 `graph.*` 会出现在这里）。

> 若某条 `graph.lane.*` 在真实数据里从未出现（如 `incident` 当前 0 个节点），
> 它仍被 `countTypes` 的**类型全集**消费？否——`countTypes` 只遍历实际出现的类型。
> 因此 `graph.lane.incident` 在 incidents=0 的快照下会**未被消费**，进 deadKeys。
> 两个可选收口：① Lead 把它加进 `i18nDeadKeyContract` 的 RESERVED 并写 reason
> （"类型全集键，当前数据无该类型节点"）；② 我在 `graphToolbar` 里改成
> `t(\`graph.lane.${type}\`)` 模板字面量形式——那样 `dynamicKeyPrefixes` 认得它，
> 视为"计算键认领"而非死键。**我倾向 ②**（不动你的 RESERVED 棘轮），
> 若你选 ②请在合并后告知，我改成模板形式。（当前 `graphToolbar.ts` 用的是
> `'graph.lane.' + type` 拼接，闭包扫描器认得这种形态，见第三节。）
