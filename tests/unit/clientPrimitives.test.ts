/**
 * 客户端数据层原语覆盖（cycle-33 测试深挖第二轮）。
 *
 * 覆盖零直接测试的纯原语：dataRow tone 表 / statusDot 脉冲契约 /
 * sectionIds 实例序号 / sectionShell 分区壳 / governanceTargets +
 * panelLiveTargets 两个 target 工厂（URL/守卫/apply/onFail 三分类）。
 * usePanelFetch 钩子生命周期在 usePanelFetch.test.ts（jsdom 专用文件）。
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { toneColor, DataRow, type ToneName } from '../../src/client/components/dataRow.ts';
import { StatusDot, FAIL_PULSE_STYLE, LIVE_PULSE_STYLE, PULSE_STYLES } from '../../src/client/components/statusDot.ts';
import { idOf, usePanelInstanceSeq } from '../../src/client/components/sectionIds.ts';
import { renderSectionWrap, renderSectionDisabled } from '../../src/client/components/sectionShell.ts';
import { governanceTargets } from '../../src/client/governanceTargets.ts';
import { panelLiveTargets, SNAPSHOT_URL, STEP_TRACE_URL, SELF_CHECK_URL } from '../../src/client/panelLiveTargets.ts';
import { ledgerListUrl, LEDGER_VERIFY_URL } from '../../src/client/features/ledger/renderLedger.ts';
import { HITL_AUDIT_URL } from '../../src/client/features/hitl/renderHitl.ts';
import type { FetchFailure } from '../../src/client/components/usePanelFetch.ts';

describe('toneColor —— 语义色调到令牌的唯一跳', () => {
  const cases: Array<[ToneName, string]> = [
    ['pass', 'anic-pass'], ['fail', 'anic-fail'], ['doubt', 'anic-doubt'], ['warn', 'anic-warn-text'],
    ['ok', 'anic-ok-text'], ['bad', 'anic-bad-text'], ['ledger', 'anic-ledger-text'],
    ['text', 'anic-text'], ['strong', 'anic-text-strong'], ['dim', 'anic-text-dim'], ['faint', 'anic-text-faint'],
    ['active', 'anic-status-active'], ['done', 'anic-status-done'], ['failed', 'anic-status-failed'],
    ['skipped', 'anic-status-skipped'], ['pending', 'anic-status-pending'],
  ];
  it.each(cases)('tone %s → var(--%s,…) 同源引用（带 PALETTE fallback）', (tone, tokenName) => {
    expect(toneColor(tone)).toContain(`var(--${tokenName}`);
    expect(toneColor(tone)).toMatch(/\)$/);
  });
});

describe('DataRow —— flex 基线行原语', () => {
  it('锚点 + tone 色 + 基线 flex 形状（数组 children，与 renderDiagnostics 调用同构）', () => {
    const html = renderToStaticMarkup(
      createElement('div', null,
        DataRow({ anchorKey: 'data-anic-probe', anchor: 'p1', tone: 'fail', children: [createElement('span', null, 'x')] }),
      ),
    );
    expect(html).toContain('data-anic-probe="p1"');
    expect(html).toContain('display:flex');
    expect(html).toContain('align-items:baseline');
    expect(html).toContain('var(--anic-fail');
  });
  it('缺省 tone=正文色；行级样式可覆盖（fontSize 域特有）', () => {
    const html = renderToStaticMarkup(
      createElement('div', null,
        DataRow({ style: { fontSize: 10 }, children: [createElement('span', null, 'y')] }),
      ),
    );
    expect(html).toContain('var(--anic-text,');
    expect(html).toContain('font-size:10px');
  });
});

describe('StatusDot / 脉冲样式 —— 逐字迁移契约', () => {
  it('FAIL_PULSE_STYLE 含键帧名/reduced-motion 逃逸/animation:none', () => {
    expect(FAIL_PULSE_STYLE).toContain('@keyframes anic-fail-pulse');
    expect(FAIL_PULSE_STYLE).toContain('prefers-reduced-motion: reduce');
    expect(FAIL_PULSE_STYLE).toContain('animation: none');
  });
  it('LIVE_PULSE_STYLE 含 anic-live-dot 契约（invocationsRender 断言的同名锚）', () => {
    expect(LIVE_PULSE_STYLE).toContain('@keyframes anic-live-pulse');
    expect(LIVE_PULSE_STYLE).toContain('.anic-live-dot');
    expect(LIVE_PULSE_STYLE).toContain('animation:none');
  });
  it('PULSE_STYLES 是两块的拼接（一次 <style> 注入）', () => {
    expect(PULSE_STYLES).toBe(`${FAIL_PULSE_STYLE}\n${LIVE_PULSE_STYLE}`);
  });
  it('圆点默认 10px 圆形；pulse 挂类；border 走令牌描边；锚点透传', () => {
    const base = renderToStaticMarkup(createElement(StatusDot, { color: 'red' }));
    expect(base).toContain('width:10px');
    expect(base).toContain('border-radius:50%');
    expect(base).not.toContain('anic-live-dot');
    const live = renderToStaticMarkup(createElement(StatusDot, { color: 'red', size: 7, pulse: true, border: true, anchorKey: 'data-anic-dot', anchor: 'd1' }));
    expect(live).toContain('class="anic-live-dot"');
    expect(live).toContain('width:7px');
    expect(live).toContain('border:1px solid var(--anic-border-strong,');
    expect(live).toContain('data-anic-dot="d1"');
  });
});

describe('sectionIds —— 实例唯一 id（aria-controls 不静默错位）', () => {
  it('usePanelInstanceSeq 每次挂载 +1（模块级递增）', () => {
    function Probe(): string {
      return String(usePanelInstanceSeq());
    }
    const first = renderToStaticMarkup(createElement(() => createElement('span', null, Probe())));
    const second = renderToStaticMarkup(createElement(() => createElement('span', null, Probe())));
    const a = Number(first.replace(/\D/g, ''));
    const b = Number(second.replace(/\D/g, ''));
    expect(b).toBe(a + 1);
  });
  it('idOf 基础名 + 序号', () => {
    expect(idOf('anic-prefs', 3)).toBe('anic-prefs-3');
  });
});

describe('sectionShell —— 分区壳与关闭形态（INV-30）', () => {
  it('body null → 不可用行兜底（默认 notLoaded）', () => {
    const html = renderToStaticMarkup(renderSectionWrap({ anchorKey: 'data-anic-x-wrap', body: null }));
    expect(html).toContain('data-anic-x-wrap="true"');
    expect(html).toContain('border-top:1px solid');
  });
  it('dataLine 提供 → 数据行渲染；body 提供 → 主体渲染', () => {
    const html = renderToStaticMarkup(renderSectionWrap({
      anchorKey: 'data-anic-x-wrap', dataLine: '快照 10 点',
      body: createElement('div', { 'data-x': 'body' }, '主体'),
    }));
    expect(html).toContain('快照 10 点');
    expect(html).toContain('主体');
  });
  it('关闭形态一行文：锚点 + warn 色 + 传入文案', () => {
    const html = renderToStaticMarkup(renderSectionDisabled({ anchorKey: 'data-anic-x-disabled', text: '已关闭' }));
    expect(html).toContain('data-anic-x-disabled="true"');
    expect(html).toContain('已关闭');
    expect(html).toContain('var(--anic-warn-text');
  });
});

describe('governanceTargets —— 治理证据簇三 target 工厂', () => {
  it('三 target 的 URL 接线（分页 limit 透传）', () => {
    const applied: unknown[] = [];
    const targets = governanceTargets({
      setLedgerList: (v) => { applied.push(['list', v]); },
      setLedgerVerify: (v) => { applied.push(['verify', v]); },
      setHitlAudit: (v) => { applied.push(['hitl', v]); },
    }, 24);
    expect(targets.map((t) => t.url)).toEqual([ledgerListUrl(24), LEDGER_VERIFY_URL, HITL_AUDIT_URL]);
    expect(ledgerListUrl(24)).toBe('/anic/api/ledger?limit=24');
  });
  it('guard 语义：合法形状过 / 非法形状静默（不 apply）', () => {
    const applied: unknown[] = [];
    const targets = governanceTargets({
      setLedgerList: (v) => { applied.push(v); },
      setLedgerVerify: () => {}, setHitlAudit: () => {},
    }, 12);
    const listT = targets[0]!;
    expect(listT.guard({ total: 1, entries: [] })).toBe(true);
    expect(listT.guard({ total: 'x' })).toBe(false);
  });
});

describe('panelLiveTargets —— 一次性拉取三 target 工厂', () => {
  interface Sink { calls: Array<[string, unknown]>; }
  function makeSetters(sink: Sink) {
    return {
      setData: (d: unknown) => { sink.calls.push(['data', d]); },
      setState: (u: (s: { source: string; line: string }) => { source: string; line: string }) => { sink.calls.push(['state', u({ source: 'embedded', line: '' })]); },
      setTrace: (v: unknown) => { sink.calls.push(['trace', v]); },
      setTraceLine: (v: string) => { sink.calls.push(['traceLine', v]); },
      setCheck: (v: unknown) => { sink.calls.push(['check', v]); },
      setCheckLine: (v: string) => { sink.calls.push(['checkLine', v]); },
      learnWorkspace: (r: string) => { sink.calls.push(['learn', r]); },
      workspaceKnown: () => null,
    };
  }
  it('URL 契约与快照守卫（nodes+edges 双数组）', () => {
    const sink: Sink = { calls: [] };
    const targets = panelLiveTargets(makeSetters(sink));
    expect(targets.map((t) => t.url)).toEqual([SNAPSHOT_URL, STEP_TRACE_URL, SELF_CHECK_URL]);
    expect(SNAPSHOT_URL).toBe('/anic/api/workflow-snapshot');
    const snap = targets[0]!;
    expect(snap.guard({ nodes: [], edges: [] })).toBe(true);
    expect(snap.guard({ nodes: [] })).toBe(false);
    expect(snap.guard([1, 2])).toBe(false);
  });
  it('快照 apply：setData + 遥测同步 + live 来源行', () => {
    const spike = { nodes: 0, edges: 0 };
    (globalThis as { window?: unknown }).window = { __ANIC_TAB_SPIKE__: spike };
    const sink: Sink = { calls: [] };
    const targets = panelLiveTargets(makeSetters(sink));
    targets[0]!.apply({ nodes: [1, 2, 3], edges: [4, 5], generatedAt: 'T0', counts: { nodes: 3, edges: 2 } });
    expect(spike).toEqual({ nodes: 3, edges: 2 });
    expect(sink.calls.some(([k, v]) => k === 'data' && JSON.stringify(v) === '{"nodes":[1,2,3],"edges":[4,5]}')).toBe(true);
    expect(sink.calls.some(([k, v]) => k === 'state' && (v as { source: string }).source === 'live')).toBe(true);
  });
  it('onFail 三分类 → 三种降级文案路径（http/malformed/network）', () => {
    const sink: Sink = { calls: [] };
    const targets = panelLiveTargets(makeSetters(sink));
    const trace = targets[1]!;
    trace.onFail?.({ kind: 'http', status: 404 } as FetchFailure);
    trace.onFail?.({ kind: 'malformed' } as FetchFailure);
    trace.onFail?.({ kind: 'network', message: 'boom' } as FetchFailure);
    const lines = sink.calls.filter(([k]) => k === 'traceLine').map(([, v]) => v as string);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('404');
    expect(lines[2]).toContain('boom');
    // trace 数据通道被清空（null）——降级不保留旧形状
    expect(sink.calls.filter(([k]) => k === 'trace').every(([, v]) => v === null)).toBe(true);
  });
  it('onResponse 学头：encodeURIComponent 形态解码回写，只学一次', () => {
    const sink: Sink = { calls: [] };
    const setters = makeSetters(sink);
    const targets = panelLiveTargets(setters);
    const res = { headers: { get: (k: string) => (k === 'X-ANIC-Workspace' ? encodeURIComponent('D:/ws/proj') : null) } };
    targets[0]!.onResponse?.(res);
    expect(sink.calls.some(([k, v]) => k === 'learn' && v === 'D:/ws/proj')).toBe(true);
  });
});
