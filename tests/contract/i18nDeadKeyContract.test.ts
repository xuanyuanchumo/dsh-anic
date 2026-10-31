/**
 * 零死键棘轮（cycle-79 WS-3）—— 词表卫生的**保修期**。
 *
 * ## 被守卫的缺陷（cycle-79 实测，非推断）
 *
 * 闭环体检 i18n 族实测 `332 键 / 293 消费 / 39 未消费`，39 条全部
 * `!producedAt && !consumed`（词表条目没有独立写入点，故「未消费」即死键）。
 * 死键不是"多写几行 JSON"这么轻：**它让词表面积与真实 UI 脱钩**——
 * 审计报告显示的"词表 332 键"里有 39 条根本没有任何用户能在界面上看到，
 * 于是一份"全覆盖"的词表读数其实是虚的；反过来，新人按键名找文案会被
 * 指向不存在的 UI（例如 `org.trustBarLabel` 指向一张从未实现的信任分条形图）。
 *
 * 本轮逐键复核后：删除 32 条确认多余键（zh/en 同键），保留 7 条——
 * 它们是**功能缺口**而非多余键（见 RESERVED 的 reason），或类元数据字段
 * （`meta.description` 由工具链按属性路径读取，不是 t() 查找）。
 *
 * ## 为什么是「棘轮」而不是一次性清理
 *
 * 清理只能保证"今天干净"；键还会被重新加回来（设计稿、复制粘贴、改到一半回滚）。
 * 本契约把"未消费键集"钉成**精确集合相等**：多一条（新增死键）红，少一条
 * （RESERVED 被接线或被误删却忘了更新本表）也红。这样下次有人加键不接线，
 * 红的不是审计日志，而是这里。
 *
 * ## 判据（全部可机器证伪）
 *
 * ① 未消费键集 ⇄ RESERVED 键集**双向相等**（不是只比条数——两条错配同数量会互相抵消）；
 * ② 每条 RESERVED 必须仍在真实 locale 里且 reason 非空（防"保留条目指向已删键"的假保留）；
 * ③ **反向自检**：内存副本里注入一个假死键 → 扫描器必须报出；再给它一条 `t()` 引用
 *    → 必须归零。两个方向都测，否则「① 为绿」可能只是扫描器哑了；
 * ④ zh/en 键集全等（两文件任一单边改动都是漏翻/漏删）；
 * ⑤ 非空下限：键数与消费数必须真实可观（空扫描 = 永久假绿）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClosureAudit } from '../../src/host/closureAudit/registryClosure.ts';
import { flattenKeys, i18nClosure } from '../../src/host/closureAudit/assetClosure.ts';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 键名拼装（**必须**用拼接，不能写成带引号的完整字面量）。
 *
 * 自指陷阱（本轮实测踩到）：本契约与审计扫描器共用"引号字面量 = 消费"口径，
 * 而 `i18nConsumerUniverse` 把 `tests/` 也算消费面 ⇒ 若 RESERVED 里直接写
 * `'panel.selfInitOff'`，**本测试自己**就把这 7 条保留键"消费"掉了，① 立刻
 * 变成"未消费 = 空集"，棘轮被自己解除武装（红/绿都失去意义）。
 */
const k = (...parts: string[]): string => parts.join('.');

/**
 * 显式保留的"未消费"键 —— **每条都必须写 reason**（本表的语义是"已知并已解释"，
 * 不是"暂时没空清理"）。判定标准：该键描述的 UI 位置**存在但文案未接线**（功能缺口），
 * 或该键根本不是 t() 词条（类元数据）。
 */
const RESERVED: ReadonlyArray<{ key: string; reason: string }> = [
  {
    key: k('meta', 'description'),
    reason: '类元数据：scripts/validate-dsh.mjs:75 要求非空、dshConformance 断言其真值、宿主按属性路径读插件描述——'
      + '不是 t() 查找，故扫描器（只认引号字面量）看不见它。删了会直接打穿 lint 与 conformance 契约。',
  },
  // cycle-90：`panel.selfInitOff` / `panel.selfInitOffTitle` **已接线**，
  // 从 RESERVED 移出（零死键棘轮 ① 要求未消费键集 ⇄ RESERVED 双向相等）。
  //
  // 接线落点：`src/client/features/prefs/prefsDrawer.ts` ——
  //   - `panel.selfInitOffTitle` → 不可写开关（layers 不含 'user'）的 checkbox title；
  //   - `panel.selfInitOff` → 同开关的说明行（`data-anic-flow-off-note`）。
  //
  // 接线的同时修了根因（cycle-90）：`resolveFlows` 此前**不检查** `layers` ——
  // user 层能写 `flow.selfInit`（layers 只有 workspace/deployment）而照样生效。
  // 于是面板 checkbox 可点、界面变了、真相没变。根因修在 `src/shared/flows.ts`：
  // 层不支持 ⇒ 该层写入被拒并产出 warning；面板侧用 `isUserWritable()` 禁用 checkbox。
  // cycle-90：`trace.statusActive` / `statusFailed` / `statusSkipped` / `statusPending`
  // **已接线**，从 RESERVED 移出（零死键棘轮 ① 要求未消费键集 ⇄ RESERVED 双向相等）。
  //
  // 接线落点：`src/client/features/stepTrace/traceLabels.ts`（新增）+
  // `renderStepTrace.ts`（改为调用 `composeStepLabel(s.kind, s.status, t)`）。
  //
  // ## 关键实现约束（踩过才知道）
  //
  // ① **不能用拼键**（`t('trace.status' + cap(status))`）——
  //    闭环体检的 i18n 扫描器只认**引号字面量里的完整键名**，拼出来的键在源码里
  //    不可枚举 ⇒ 词表侧仍判「无人消费」⇒ 死键照旧红。
  //    ⇒ 必须用**显式映射表**（`STATUS_KEYS` / `KIND_KEYS`），
  //    与 `renderClosure.ts` 的 `KIND_KEYS` 先例同款。
  // ② **缺键必须回落原始 token**（不是键名）—— 宿主与客户端是两条独立发版链，
  //    新状态词可能在旧词表里不存在；显示 `trace.statusBlocked` 比显示 `blocked` 更糟。
  //    判定「取不到」用 `label === key`（`t()` 缺键时返回键名本身，空串也是合法回退）。
];

const summary = runClosureAudit(PLUGIN_ROOT);
const i18n = summary.clusters.find((c) => c.cluster === 'i18n');
const zhRaw = readFileSync(join(PLUGIN_ROOT, 'locale', 'zh.json'), 'utf8');
const enRaw = readFileSync(join(PLUGIN_ROOT, 'locale', 'en.json'), 'utf8');
const zhKeys = flattenKeys(JSON.parse(zhRaw) as Record<string, unknown>).sort();
const enKeys = flattenKeys(JSON.parse(enRaw) as Record<string, unknown>).sort();
const deadKeys = (i18n?.items ?? []).filter((it) => !it.consumed).map((it) => it.id).sort();
const reservedKeys = RESERVED.map((r) => r.key).sort();

describe('cycle-79 零死键棘轮（词表卫生）', () => {
  it('① 未消费键集 ⇄ RESERVED 集合双向相等（多一条/少一条都红）', () => {
    // 双向差集：只比条数会让"删错一条 + 多加一条"互相抵消（假绿经典形态）。
    expect(deadKeys, '新增了未接线的死键（接线或删除；确有理由则加进 RESERVED 并写 reason）').toEqual(reservedKeys);
    expect(deadKeys.filter((k) => !reservedKeys.includes(k)), '未登记的死键').toEqual([]);
    expect(reservedKeys.filter((k) => !deadKeys.includes(k)), 'RESERVED 已不再未消费——请更新本表（收紧而非放宽）').toEqual([]);
  });

  it('② RESERVED 每条仍在真实 locale 且 reason 非空（防"保留条目指向已删键"）', () => {
    expect(RESERVED.length).toBeGreaterThanOrEqual(1);
    for (const r of RESERVED) {
      expect(zhKeys, r.key + ' 已从 zh.json 消失却仍登记为保留').toContain(r.key);
      expect(enKeys, r.key + ' 已从 en.json 消失却仍登记为保留').toContain(r.key);
      expect(r.reason.trim().length, r.key + ' 缺少 reason').toBeGreaterThan(10);
    }
  });

  it('③ 反向自检：内存副本注入假死键必被报出，加一条 t() 引用后必须归零', () => {
    // 用内存 Map 直接喂 i18nClosure（不落盘）——测的是判定本身，不是磁盘状态。
    const files = new Map<string, string>([
      ['locale/zh.json', JSON.stringify({ __probe__: { deadKey: 'x' } })],
      ['src/probe.ts', 'export const nothing = 1;\n'],
    ]);
    const before = i18nClosure(files);
    expect(before.total).toBe(1);
    expect(before.unconsumed, '扫描器没报出注入的假死键 ⇒ ① 的绿灯可能是扫描器哑了').toBe(1);
    expect(before.items[0]?.id).toBe('__probe__.deadKey');
    // 给它一条真实 t() 引用 → 必须变成已消费（证明判定跟随引用，而不是恒报死键）
    files.set('src/probe.ts', "export const used = t('__probe__.deadKey');\n");
    const after = i18nClosure(files);
    expect(after.unconsumed).toBe(0);
    expect(after.items[0]?.evidence.some((h) => h.startsWith('src/'))).toBe(true);
  });

  it('④ zh/en 键集全等（只删一边 = 漏翻/漏删）', () => {
    expect(zhKeys).toEqual(enKeys);
  });

  it('⑤ 非空下限：键数与消费数真实可观（空扫描恒绿 = 假守卫）', () => {
    expect(i18n?.total ?? 0).toBeGreaterThanOrEqual(250);
    expect(i18n?.consumed ?? 0).toBeGreaterThanOrEqual(250);
    expect(summary.scannedFiles).toBeGreaterThanOrEqual(200);
    /*
     * 上限是「词表规模棘轮」：它防的不是键多，而是**键无限制地只增不减**。
     *   cycle-79 清理后 300 键 ⇒ 上限 320；
     *   cycle-82 新增 graph.*（14 字面 + 2 族共 14 后缀）、config.*（62 条）、
     *   closure.artifacts/isolation（22 条）⇒ 424。
     * 这 124 条是**真实功能面**（图区工具栏 8 控件的可达名 + 配置编辑器 23 字段/29 路径 +
     * 第五族文档生命周期矩阵 + 跨项目隔离判定的分类标签），不是膨胀：每一条都有 `t()`
     * 消费点，由 ① 的零死键棘轮反过来保证——加键不接线的那天，① 先红，不是这里。
     * 上限同步抬到 460 —— 留 36 条正常余量，同时仍能拦住"一次加 100 条没人用"的形态。
     *   cycle-84 新增 graph.* 8 条（noMatch / matchCount / jumpTo / traceRoot /
     *   traceUp / traceDown / traceTruncated / traceExit）⇒ 462。这 8 条对应
     *   「搜索跳转 + 路径追溯」两个真实交互面：计数、跳转可达名、追溯状态条四段
     *   文案与退出按钮，每一条都在 `graphToolbarSearch.ts` / `graphTraceBar.ts` 里
     *   有 `t()` 消费点（① 的零死键棘轮机械保证）。上限抬到 510（cycle-89 自举分区 +25 键）。
     *   cycle-89 二轮：510 → 525。图谱现代化 6 项能力新增 14 键（视图组 / 泳道表头 /
     *   布局模式 / 仅异常筛选 / fit-to-selection / 导出 SVG / 全屏）+ 归属矩阵 10 键
     *   = 24 条真实功能面文案（每条都有 `t()` 消费点，由 ① 的零死键棘轮机械保证）。
     *   cycle-90：525 → 540。生命周期指标新增 22 键（`flowLifecycle.*`：标题 / 数据窗口 /
     *   归属覆盖 / 孤儿说明 / 账本口径 / KM 中位数 / CI / episode / 删失 / 通过率 / run 数 /
     *   越界点 / 灵敏度 / run 边界 / P50 / P95 双口径 / Gini / 长尾形态 / 截断 / 样本不足）。
     *   ⚠️ 这 22 键的**意义**是：让「读不出来」与「读出来是 0」在界面上**可区分**
     *   （`insufficient` / `degenerate` / `truncated` 各有自己的文案）。
     *   上限抬到 540 —— 留 7 条余量（本轮实际 533），仍能拦住"一次加 100 条没人用"的形态。
     *
     *   cycle-94：540 → 570。图谱能力升级新增 19 键（实际 557）：
     *     - `graph.layoutModeFlow` / `layoutCrossings`：第三个布局模式（flow 分层）
     *       与其质量读数（交叉数）。布局质量从"看着顺不顺眼"变成可断言数字后，
     *       必须有一个位置把它**显示给用户**，否则那个数字只活在测试里。
     *     - `graph.edgeLegendLabel` / `edgeLegendHint`：边语义图例。6 种边线型此前
     *       图上可见但无法解码（图例只有节点类型），这是纯功能缺口。
     *     - `graph.nodeRoleLabel` + `graph.nodeRole.{hub,orphan,leaf,entry}`：节点角色
     *       （枢纽/孤立/末端/入口）。「被 8 条证据支撑的门禁」与「只被 1 条支撑的」
     *       此前画得一模一样。
     *     - `graph.pathFind*`（6 键）：两点最短路径。把"哪个 evt group 导致 G2 失败"
     *       从三次双击降为一次输入。
     *     - `graph.traceDepth` / `healthLabel`：追溯深度分档（blast radius 读数）
     *       与测试健康度的可读名。
     *   ⚠️ **本条上限对 `graph.*` 前缀是弱约束**（见下），所以抬上限不等于放水：
     *   `dynamicKeyPrefixes` 以 `graph.` 前缀整体认领该族键 ⇒ 族内新增键即使无人消费，
     *   ①（零死键双向相等）**依然为绿**。这是已知的遮蔽效应（`graphText.ts` 头注
     *   自己写明）。因此 ① 绿**不能**作为"这批键已接线"的证据，验收必须逐键点名消费点。
     *   抬到 570 —— 留 13 条余量，仍能拦住"一次加 100 条"。
     */
    expect(zhKeys.length).toBeGreaterThanOrEqual(250);
    expect(zhKeys.length).toBeLessThanOrEqual(570);
  });
});
