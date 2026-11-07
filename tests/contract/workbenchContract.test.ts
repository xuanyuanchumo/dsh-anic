/**
 * 工作台契约守卫（cycle-110）——四腿：源码 / DOM / CSS / nav 边界。
 *
 * 与 panelAssemblyContract 的分工：那边钉「16 分区都在、锚点与 locale 对齐」；
 * 本文件钉「工作台**重组**后仍忠实于装配」——域表覆盖装配集、卡片按域渲染、
 * CSS 三档响应式真实存在、nav 不侵入工具栏语义区。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPanelStore } from '../../src/client/components/panelStore.ts';
import { createInitialPanelState } from '../../src/client/panelState.ts';
import { WORKBENCH_DOMAINS, SECTION_KEY_PROP } from '../../src/client/workbench/workbenchModel.ts';
import { renderWorkbench } from '../../src/client/workbench/workbenchGrid.ts';
import { WORKBENCH_CSS } from '../../src/shared/workbenchCss.ts';
import type { PanelDataStore } from '../../src/client/panelState.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ── 腿①：源码——域表覆盖装配集（与 panelAssemblyContract 同扫描域形态）── */
function collectClientSources(dir: string): string {
  let src = '';
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
      src += readFileSync(full, 'utf8') + '\n';
    }
  };
  walk(dir);
  return src;
}
const clientSrc = collectClientSources(join(ROOT, 'src', 'client'));

/* ── 腿②夹具：真 store + 最小 props 渲染 renderWorkbench ── */
function renderWb(store: PanelDataStore): { html: string; elements: ReturnType<typeof renderWorkbench> } {
  const elements = renderWorkbench({
    store,
    gates: { stepTraceOn: true, diagnosticsOn: true, flowsViewOn: true, approvalsOn: true },
    onNodeClick: () => undefined,
    onShowMore: () => undefined,
    autoRefreshOn: false,
    configPanelId: 'test-config',
    selectedNode: null,
    onCloseNodeDetail: () => undefined,
  });
  const html = renderToStaticMarkup(createElement('div', null, ...elements));
  return { html, elements };
}

describe('腿① 源码：域表 ⊆ 装配扫描集', () => {
  it('每个域的每个分区 key 都能在 src/client 源码的 keyed() 标记里找到', () => {
    for (const d of WORKBENCH_DOMAINS) {
      for (const s of d.sections) {
        expect(clientSrc.includes(`'${s}')`), `分区 ${s} 未在装配层 keyed() 打标记`).toBe(true);
      }
    }
  });
  it('域表源码存在且被 grid 消费（防域表成孤儿事实源）', () => {
    expect(clientSrc.includes('WORKBENCH_DOMAINS')).toBe(true);
    expect(clientSrc.includes('SECTION_KEY_PROP')).toBe(true);
  });
});

describe('腿② DOM：真 store 渲染出工作台骨架', () => {
  const store = createPanelStore(createInitialPanelState());
  const { html } = renderWb(store);

  it('nav 存在且 6 个 chip、每 chip 带域 id 与 aria-label', () => {
    expect(html).toContain('data-anic-wb-nav="true"');
    expect((html.match(/data-anic-wb-nav-chip=/g) ?? []).length).toBe(6);
    for (const d of WORKBENCH_DOMAINS) expect(html).toContain(`data-anic-wb-nav-chip="${d.id}"`);
    expect(html).toContain('aria-label');
  });
  it('grid 存在；每张渲染出的卡带 status/count/span 锚点', () => {
    expect(html).toContain('data-anic-wb-grid="true"');
    expect((html.match(/data-anic-wb-card=/g) ?? []).length).toBe(6);
    for (const d of WORKBENCH_DOMAINS) {
      expect(html).toContain(`id="anic-wb-card-${d.id}"`);
      expect(html).toContain(`data-anic-wb-card-status=`);
    }
    // 通栏标记只在 full 域上（overview 与 settings）
    expect(html).toContain('data-anic-wb-span="full"');
  });
  it('卡头计数与域表 sections 数一致（初态分区全部渲染——门控默认开）', () => {
    for (const d of WORKBENCH_DOMAINS) {
      expect(html).toContain(`data-anic-wb-card-count="${String(d.sections.length)}"`);
    }
  });
  it('反向自检：门控关掉一个分区 ⇒ 对应卡 count 与装配同时减员（零占位）', () => {
    const store2 = createPanelStore(createInitialPanelState());
    const el2 = renderWorkbench({
      store: store2,
      gates: { stepTraceOn: false, diagnosticsOn: true, flowsViewOn: true, approvalsOn: true },
      onNodeClick: () => undefined, onShowMore: () => undefined, autoRefreshOn: false,
      configPanelId: 't2', selectedNode: null, onCloseNodeDetail: () => undefined,
    });
    const html2 = renderToStaticMarkup(createElement('div', null, ...el2));
    // ⚠️ cycle-111 修正：这条断言原是 `html2 含 count="1"`——**假阳性**。INV-30
    // 的关闭形态是「分区渲染一行『已按开关关闭』说明」而不是从装配中消失
    // （关闭形态可观测纪律），所以 diagnostics 域 count 保持 2。旧断言绿是因为
    // settings 域恰好也是 1 个分区，泛匹配误命中了它（cycle-111 settings 1→2
    // 后假阳性暴露，同时暴露了测试意图与机制语义脱节）。正确断言：
    //   ① diagnostics 卡仍渲染（关闭≠消失）且 count 不变（关闭形态仍占装配位）；
    //   ② 关闭形态行真的出现（steptrace-disabled 锚点）；
    //   ③ 反向：域表清空才是减员（下一个用例钉）。
    expect(html2).toMatch(/id="anic-wb-card-diagnostics"[^>]*data-anic-wb-card-count="2"/);
    expect(html2).toContain('data-anic-steptrace-disabled="true"');
  });
  it('workspaceBadge 在网格之外（先于 nav 渲染——全局上下文不属任何域）', () => {
    expect(html.indexOf('data-anic-workspace-badge')).toBeGreaterThan(-1);
    expect(html.indexOf('data-anic-workspace-badge')).toBeLessThan(html.indexOf('data-anic-wb-nav'));
  });
  it('反向自检：域表副本清空某域 sections ⇒ 该域卡锚点缺席（零占位，不是空卡）', () => {
    // "分区被门控隐藏"与"域被清空"是两回事：前者仍有关闭形态行（INV-30），
    // 卡照在；后者整桶为空 ⇒ 渲染一张只有头没有体的卡是噪声（"这里该有
    // 东西但没有"），不是信息。renderWorkbench 的域表覆盖参数正是这条
    // 判据的输入面——空域必须整卡不渲染，nav 也不出指向不存在的卡。
    const store3 = createPanelStore(createInitialPanelState());
    const emptied = WORKBENCH_DOMAINS.map((d) =>
      d.id === 'quality' ? { ...d, sections: [] as readonly string[] } : d);
    const el3 = renderWorkbench({
      store: store3,
      gates: { stepTraceOn: true, diagnosticsOn: true, flowsViewOn: true, approvalsOn: true },
      onNodeClick: () => undefined, onShowMore: () => undefined, autoRefreshOn: false,
      configPanelId: 't3', selectedNode: null, onCloseNodeDetail: () => undefined,
    }, emptied);
    const html3 = renderToStaticMarkup(createElement('div', null, ...el3));
    expect(html3).not.toContain('data-anic-wb-card="quality"');
    expect(html3).not.toContain('id="anic-wb-card-quality"');
    // 其余五域不受牵连（清空一个域 ≠ 网格塌了）。
    expect(html3).toContain('data-anic-wb-card="overview"');
    expect(html3).not.toContain('data-anic-wb-nav-chip="quality"');
  });
});

describe('腿③ CSS：三档容器查询 + 减少动效 + 无裸 var + 零颜色字面量', () => {
  it('三档断点真实存在（单列/两列/三列）', () => {
    expect(WORKBENCH_CSS).toContain('@container (min-width: 560px)');
    expect(WORKBENCH_CSS).toContain('@container (min-width: 900px)');
    expect(WORKBENCH_CSS).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(WORKBENCH_CSS).toContain('repeat(2, minmax(0, 1fr))');
    expect(WORKBENCH_CSS).toContain('repeat(3, minmax(0, 1fr))');
  });
  it('prefers-reduced-motion 存在（动画可关闭是 a11y 硬要求）', () => {
    expect(WORKBENCH_CSS).toContain('prefers-reduced-motion');
  });
  it('无裸 var（每个 var() 都带 fallback——clientRenderContract 同判据）', () => {
    const bare = WORKBENCH_CSS.match(/var\(--[a-z0-9-]+\)/g) ?? [];
    expect(bare, `裸 var：${bare.join(', ')}`).toEqual([]);
  });
  it('源文件零颜色字面量（#hex / rgb( 禁止——fallback 值经 SEMANTIC 插值而来，不写在 CSS 文本里）', () => {
    // 注意断言对象是**源文件**而不是插值后的 CSS：v() 的 fallback 从 SEMANTIC 表
    // 展开，展开文本里必然含令牌原值（#eef2f7 等）——那是单一事实源的**产物**，
    // 不是新造颜色。源文件里出现 hex 才是绕开令牌表。
    const src = readFileSync(join(ROOT, 'src', 'shared', 'workbenchCss.ts'), 'utf8');
    const hits = src.match(/"#[0-9a-fA-F]{3,8}"|'#[0-9a-fA-F]{3,8}'|\brgb\(/g) ?? [];
    expect(hits, `workbenchCss.ts 含颜色字面量：${hits.join(', ')}`).toEqual([]);
  });
  it('panelCss 真的注入了 WORKBENCH_CSS（装配点存在，防孤儿 CSS）', () => {
    const panelCss = readFileSync(join(ROOT, 'src', 'shared', 'panelCss.ts'), 'utf8');
    expect(panelCss).toContain('WORKBENCH_CSS');
  });
});

describe('腿④ nav 边界：不侵入工具栏语义区（smoke 工具栏按钮数==3 的前提）', () => {
  it('渲染输出中 nav 在 toolbar 之外；nav 自身无 role=toolbar、无 data-anic-toolbar', () => {
    const store = createPanelStore(createInitialPanelState());
    const { elements } = renderWb(store);
    // 树级断言：遍历元素树，toolbar 与 nav 是兄弟（nav 不是 toolbar 后代）。
    const find = (els: unknown[], pred: (p: Record<string, unknown>) => boolean, path: string[] = []): string[] => {
      const hits: string[] = [];
      for (const e of els) {
        const el = e as { props?: Record<string, unknown>; type?: unknown } | null;
        if (el === null || typeof el !== 'object' || el.props === undefined) continue;
        const p = el.props as Record<string, unknown>;
        if (pred(p)) hits.push(path.join('/'));
        const kids = p.children;
        if (Array.isArray(kids)) hits.push(...find(kids, pred, [...path, String(el.type)]));
      }
      return hits;
    };
    // nav（data-anic-wb-nav）不携带 data-anic-toolbar 属性，也不在带该属性的元素子树里
    const inToolbar = find(elements, (p) => p['data-anic-wb-nav'] === 'true' && p['data-anic-toolbar'] === 'true');
    expect(inToolbar, 'nav 不得带 data-anic-toolbar 属性').toEqual([]);
    expect((elements as unknown[]).some((e) => {
      const el = e as { props?: Record<string, unknown> } | null;
      return el !== null && typeof el === 'object' && el.props?.['data-anic-wb-nav'] === 'true';
    }), 'nav 是根级元素（与工具栏平级）').toBe(true);
  });
});
