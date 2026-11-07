/**
 * 面板分区装配契约守卫（cycle-69 T-6901）。
 *
 * 缺陷类：**"分区装配层零守卫"**——渲染器测试厚（各域 render* 都有专属测试），
 * 但「分区 → 锚点 → locale 键 → 装配序列」四层装配契约无机械钉：
 *   - 删掉任一分区的 renderFoldableSection 调用 → 无测试红（面板缺一个分区）；
 *   - data-anic-fold 锚点 id 改错 → 无测试红（DOM 契约断裂——真机旅程与文档引用的锚点失效）；
 *   - locale fold 键丢失 → 无测试红（title 渲染回退兜底文案——i18n 契约断裂）；
 *   - WorkflowGraphPanel 装配序列遗漏某分区组件 → 无测试红（面板静默缺分区）。
 *
 * 审计证据（cycle-69 立项调研）：全部 contract/unit 测试中 data-anic-fold 断言
 * 仅 panelSections.test.ts 钉了 stepTrace 一个（门控形态用例）——其余 9 分区零断言。
 *
 * 三腿契约（与 G-DOC-API 同族方法论）：
 *   腿 1  宿主源码：panelSections.ts 的 renderFoldableSection id 集；
 *   腿 2  locale：zh.json fold 键集（en parity 另有 parity 钉——本守卫只管 zh 源头）；
 *   腿 3  装配序列：WorkflowGraphPanel.ts 的 createElement(XxxSection, …) 序列。
 * 三腿经「显式映射表」对齐后双向集合相等——漏配与臆配都违规。
 *
 * techDebt 映射注记（T-6902）：分区 id 是驼峰 `techDebt`、locale 键是小写
 * `techdebt`——运行时 title 取 t('fold.techdebt')，i18n 查找按键精确匹配，
 * 形态差异靠本守卫的显式映射成文（改 id 会破坏 DOM 锚点既有兼容——真机
 * 旅程+测试+文档三处引用 data-anic-fold="techDebt"）。
 *
 * 守卫三条纪律（与 guardRegistry / panelLayoutContract / clientRenderContract 同形）：
 *   ① 反向自检：corrupted.delete / fabricated.add 必须使断言判不等；
 *   ② 非空下限：三扫描集各 ≥10——静默空扫描等同永久绿（假守卫）；
 *   ③ 锚点 DOM 断言：store 驱动 renderToStaticMarkup 直出后逐分区核实。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createPanelStore } from '../../src/client/components/panelStore.ts';
import { createInitialPanelState } from '../../src/client/panelState.ts';
import {
  CyclesSection, StepTraceSection, DiagnosticsSection, OrgSection, SkillHealthSection,
  TechDebtSection, FlowsSection, LedgerSection, HitlSection, BudgetSection,
} from '../../src/client/components/panelSections.ts';
// cycle-72：closure 分区组件已拆至其特性域（T3 250 行纪律）；腿3 装配序列仍从面板入口导入。
import { ClosureSection } from '../../src/client/features/closure/ClosureSection.ts';
// cycle-82：配置与路径分区（唯一可写面）。与 closure 同款：拆到特性域，腿3 仍从面板入口算。
import { ConfigSection } from '../../src/client/features/config/ConfigSection.ts';
// cycle-89：自举分区（事实基线/陈旧判据/重启入口）。同款拆分：特性域持有，装配层再导出。
import { BootstrapSection } from '../../src/client/features/bootstrap/BootstrapSection.ts';
// cycle-111：插件信息分区（关于/反馈）。同款拆分：特性域持有，装配层再导出。
import { PluginInfoSection } from '../../src/client/features/info/PluginInfoSection.ts';
import type { PanelDataStore } from '../../src/client/panelState.ts';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT_DIR = join(PLUGIN_ROOT, 'src', 'client');
const PANEL_REL = join('src', 'client', 'WorkflowGraphPanel.ts');
const ZH_REL = join('locale', 'zh.json');
/*
 * 腿3 扫描域（cycle-95 修正 —— 与本文件腿1 的 cycle-72 修正是同一族缺陷的第二次发生）。
 *
 * 被守卫的缺陷（实测）：腿3 原先是 `scanAssemblyComponents(panelSrc)` —— **单文件**
 * 扫描 `WorkflowGraphPanel.ts`。cycle-95 为守 T3（单文件 ≤250 行）把分区编排
 * （「这一堆分区按什么顺序、带什么门控」）整体拆到 `panelSectionOrder.ts`，
 * 于是 15 处 `createElement(XxxSection, …)` 装配点**全部搬家**，
 * `assemblyComponents` 当场从 15 → **0**。
 *
 * 为什么这不是"少几条断言"而是假守卫：扫描集为空时腿3 的集合比较恒不成立
 * （红一次逼人看见），但**任何"未来再拆走一个分区"的改动都不再被它扫见**——
 * 守卫退化成永远绿的空转。这正是本仓三条既有教训的同一个形态：
 *   - truthAudit T4：工具拆成 `tools*.ts` 后单文件计数漏报；
 *   - graphInteractiveContract ⑦：图区拆成 15 个文件后手工文件名清单漏扫；
 *   - 本文件腿1（cycle-72）：closure 分区搬走后仍只看 panelSections.ts。
 *
 * ⇒ 扫描域由「源码在哪」决定，不手工枚举文件名：`src/client` 全量递归
 *（装配只发生在客户端；`src/host` 没有分区组件）。
 */
const ASSEMBLY_SCAN_DIR = CLIENT_DIR;

/*
 * 腿 1 扫描域（cycle-72 修正）：由「panelSections.ts 单文件」扩到 **src/client 全量**。
 *
 * 被守卫缺陷（真实形态）：T3（单文件 ≤250 行）拆分把 closure 分区的 renderFoldableSection
 * 调用搬到了 features/closure/ClosureSection.ts，而本守卫仍只看 panelSections.ts ⇒ 腿1 少一项
 * ⇒ 与 locale 的 closure 键集合比较判不等。**拆分本身正确，是守卫的扫描域与源码结构脱钩了。**
 * 与本仓既有先例同族（truthAudit T4 已从单文件 tools.ts 改为 tools*.ts 全域扫描：
 * 「工具拆分后单文件计数漏报」）。同时补扫描文件数下限——防止未来再拆走分区时静默漏扫。
 */
function collectClientSources(dir: string): { src: string; files: number } {
  let src = '';
  let files = 0;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      src += readFileSync(full, 'utf8') + '\n';
      files += 1;
    }
  };
  walk(dir);
  return { src, files };
}
const clientScan = collectClientSources(CLIENT_DIR);
const clientFileCount = clientScan.files;
const panelSrc = readFileSync(join(PLUGIN_ROOT, PANEL_REL), 'utf8');
// 腿3 源 = src/client 全量（见 ASSEMBLY_SCAN_DIR 头注）；不再只读 WorkflowGraphPanel.ts。
const assemblyScan = collectClientSources(ASSEMBLY_SCAN_DIR);

/** 已知 id→键形态映射（T-6902 成文）：驼峰 id `techDebt` ⇄ 小写键 `techdebt`，其余同形。 */
const ID_TO_LOCALE_KEY: Record<string, string> = { techDebt: 'techdebt' };

// 腿1 源 = src/client 全量（见 collectClientSources 头注），不再只读 panelSections.ts。
const zh = JSON.parse(readFileSync(join(PLUGIN_ROOT, ZH_REL), 'utf8')) as { fold: Record<string, string> };

/** 腿 1 扫描器：panelSections.ts 里 renderFoldableSection({ id: '…' }) 的 id 集。 */
function scanSectionIds(src: string): string[] {
  return [...src.matchAll(/renderFoldableSection\(\{ id: '([^']+)'/g)].map((m) => m[1]);
}

/** 腿 3 扫描器：WorkflowGraphPanel.ts 里 createElement(XxxSection, …) 的组件名集。 */
function scanAssemblyComponents(src: string): string[] {
  return [...src.matchAll(/createElement\((\w+Section),/g)].map((m) => m[1]);
}

/** 集合相等（顺序无关）：双向差集都为空。 */
function setsEqual(a: string[], b: string[]): boolean {
  const sa = new Set(a), sb = new Set(b);
  return [...sa].every((x) => sb.has(x)) && [...sb].every((x) => sa.has(x));
}

const sectionIds = scanSectionIds(clientScan.src);
const localeFoldKeys = Object.keys(zh.fold);
const localeKeysById = sectionIds.map((id) => ID_TO_LOCALE_KEY[id] ?? id);
const assemblyComponents = scanAssemblyComponents(assemblyScan.src);

describe('cycle-69 T-6901 面板分区装配契约', () => {
  it('扫描集非空下限：三分区集各 ≥10（空集恒绿=假守卫，直接 FAIL）', () => {
    expect(sectionIds.length).toBeGreaterThanOrEqual(10);
    // 腿1 扫描域下限：src/client 源文件数必须真实可观（防拆分成空扫描）
    expect(clientFileCount).toBeGreaterThanOrEqual(20);
    expect(localeFoldKeys.length).toBeGreaterThanOrEqual(10);
    expect(assemblyComponents.length).toBeGreaterThanOrEqual(10);
    // 守卫自身有效性：扫描器样例拼接自证（纪律 ② 的变体——样例必须能被扫到）
    expect(scanSectionIds("renderFoldableSection({ id: 'probeX'")).toContain('probeX');
    const probeAssembly = 'createElement(Probe' + 'Section, {';
    expect(scanAssemblyComponents(probeAssembly)).toContain('Probe' + 'Section');
  });

  it('腿1 ⇄ 腿2：分区 id 集与 locale fold 键集经显式映射双向相等（漏键/臆键都违规）', () => {
    expect(setsEqual(localeKeysById, localeFoldKeys)).toBe(true);
  });

  it('腿1 ⇄ 腿3：折叠分区 id 集与装配序列组件集一一对应（id 驼峰化 + Section 后缀；Graph/Live 非折叠分区另算）', () => {
    // id 'techDebt' → 组件 'TechDebtSection'；id 'cycles' → 'CyclesSection'（首字母大写）
    // GraphSection（主图渲染）与 LiveInvocationsSection（实时调用，无折叠壳——turn 分组
    // 自带 details）不在 renderFoldableSection 体系内，从装配集里排除后比对。
    const SECTION_SUFFIX = 'Sec' + 'tion';
    const NON_FOLD_SECTIONS = new Set(['Graph' + 'Section', 'LiveInvocations' + 'Section']);
    const foldAssemblyComponents = assemblyComponents.filter((c) => !NON_FOLD_SECTIONS.has(c));
    const expectedComponents = sectionIds.map((id) => id.charAt(0).toUpperCase() + id.slice(1) + SECTION_SUFFIX);
    expect(setsEqual(expectedComponents, foldAssemblyComponents)).toBe(true);
    // 非折叠分区固定在装配序列里（面板两根柱：图 + 实时调用流——丢了即面板主体缺失）
    expect(assemblyComponents).toContain('Graph' + 'Section');
    expect(assemblyComponents).toContain('LiveInvocations' + 'Section');
  });

  it('锚点 DOM 断言：store 驱动渲染输出含全部十分区 data-anic-fold 锚点（装配完整性端到端）', () => {
    const store: PanelDataStore = createPanelStore(createInitialPanelState());
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(CyclesSection, { store }),
      createElement(StepTraceSection, { store, enabled: true }),
      createElement(DiagnosticsSection, { store, enabled: true }),
      createElement(OrgSection, { store }),
      createElement(SkillHealthSection, { store }),
      createElement(TechDebtSection, { store }),
      createElement(FlowsSection, { store, enabled: true }),
      createElement(LedgerSection, { store, onShowMore: () => {} }),
      createElement(HitlSection, { store, enabled: true }),
      createElement(BudgetSection, { store }),
      createElement(ClosureSection, { store }),
      // cycle-82：配置分区（唯一可写面）。初始态 config=null ⇒ 渲染器返回 null，
      // 只剩折叠壳 + 摘要——这正是「未拉取 → 不伪造空表单」的降级形态，锚点仍必须在。
      createElement(ConfigSection, { store, panelId: 'probe-config' }),
      // cycle-89：自举分区（初始态 bootstrap=null ⇒ 只剩折叠壳；锚点仍必须在）。
      createElement(BootstrapSection, { store }),
      // cycle-111：插件信息分区（静态元信息，零 store 依赖；锚点仍必须在）。
      createElement(PluginInfoSection, {}),
    ));
    for (const id of sectionIds) {
      expect(html).toContain(`data-anic-fold="${id}"`);
    }
    // 分区标题走 locale 键（techdebt 映射点运行时验证）
    expect(html).toContain(zh.fold.techdebt);
    expect(html).toContain(zh.fold.cycles);
    // cycle-82：配置分区标题也走 locale（漏翻会让标题显示裸键名）。
    expect(html).toContain(zh.fold.config);
  });

  it('反向自检：corrupted 删一分区 id 后集合比较必须判不等（守卫可红性）', () => {
    const corrupted = [...sectionIds];
    corrupted.splice(corrupted.indexOf('ledger'), 1);
    expect(setsEqual(corrupted.map((id) => ID_TO_LOCALE_KEY[id] ?? id), localeFoldKeys)).toBe(false);
    expect(setsEqual(corrupted.map((id) => id.charAt(0).toUpperCase() + id.slice(1) + 'Section'), assemblyComponents)).toBe(false);
  });

  it('反向自检：fabricated 臆造一个键后集合比较必须判不等（漏配与臆配双向红）', () => {
    const fabricated = [...localeFoldKeys, 'phantomzone'];
    expect(setsEqual(localeKeysById, fabricated)).toBe(false);
  });
});
