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
  {
    key: k('panel', 'selfInitOff'),
    reason: '功能缺口：flow.selfInit 关闭态在工具栏**零说明**（自举按钮仍可点，点了只会拿到失败反馈）。'
      + '该文案正是关闭态说明，待接线而非多余。',
  },
  {
    key: k('panel', 'selfInitOffTitle'),
    reason: '功能缺口：同上关闭态的 title 提示（解释该开关只支持工作区/部署层）。与 selfInitOff 成对，保留成对。',
  },
  {
    key: k('trace', 'statusActive'),
    reason: '功能缺口：renderStepTrace.ts:60 直接把裸英文 token 拼进用户面（kind + status 两段），'
      + '四个状态词的中文键存在却未接线——用户看到的是 done/active/failed，不是"完成/进行中"。',
  },
  {
    key: k('trace', 'statusFailed'),
    reason: '功能缺口：同 trace.statusActive（步骤状态文本未本地化，当前显示裸 token）。',
  },
  {
    key: k('trace', 'statusSkipped'),
    reason: '功能缺口：同 trace.statusActive（步骤状态文本未本地化，当前显示裸 token）。',
  },
  {
    key: k('trace', 'statusPending'),
    reason: '功能缺口：同 trace.statusActive（步骤状态文本未本地化，当前显示裸 token）。',
  },
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
    // 清理前 332 键，本轮删 32 条确认多余键 ⇒ 300；下限设 250 留出正常增删余量。
    expect(zhKeys.length).toBeGreaterThanOrEqual(250);
    expect(zhKeys.length).toBeLessThanOrEqual(320);
  });
});
