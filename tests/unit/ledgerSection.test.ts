// @vitest-environment jsdom
/**
 * renderLedger 渲染测试（B2 · 账本事件流分区，cycle-18）。
 *
 * 与 renderFlows.test.ts / cyclesTimeline.test.ts 同纪律：renderToStaticMarkup
 * 真渲染。响应形状契约来源：src/host/routes/ledgerRoute.ts:38-46（GET
 * /anic/api/ledger → { total, entries }）与 ledgerRoute.ts:67（GET
 * /anic/api/ledger/verify → { ok, total, brokenAt, reason }）。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderLedger, isLedgerList, isLedgerVerify, type LedgerListJson, type LedgerVerifyJson } from '../../src/client/features/ledger/renderLedger.ts';

function entry(over: Partial<LedgerListJson['entries'][number]> = {}): LedgerListJson['entries'][number] {
  return {
    gate: 'G2', gateName: '测试收敛门', result: 'PASS', detail: '940 passed',
    timestamp: '2026-10-17T07:41:33.538Z',
    previousHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ...over,
  };
}

function list(entries: LedgerListJson['entries'], total?: number): LedgerListJson {
  return { total: total ?? entries.length, entries };
}

describe('isLedgerList / isLedgerVerify（形状守卫）', () => {
  it('合法 list/verify 通过；缺 entries / 缺 ok 拒绝', () => {
    expect(isLedgerList(list([entry()]))).toBe(true);
    expect(isLedgerList({ total: 3 })).toBe(false);
    expect(isLedgerList({ entries: [{ noGate: true }] })).toBe(false);
    expect(isLedgerVerify({ ok: true, total: 84, brokenAt: null, reason: null })).toBe(true);
    expect(isLedgerVerify({ total: 84 })).toBe(false);
  });
});

describe('renderLedger（账本事件流分区）', () => {
  it('list=null（未拉取）→ 整区不渲染（不伪造空态）', () => {
    expect(renderLedger(null, null)).toBe(null);
  });

  it('空 entries → 不渲染（诚实：无条目不画流）', () => {
    expect(renderLedger(list([]), null)).toBe(null);
  });

  it('渲染条目 + 标题计数（shown/total）', () => {
    const html = renderToStaticMarkup(renderLedger(list([entry(), entry({ gate: 'G0', gateName: '评估收敛门' })], 84), null));
    expect(html).toContain('data-anic-ledger-wrap');
    expect(html).toContain('data-anic-ledger-entry="PASS"');
    expect(html).toContain('测试收敛门');
    expect(html).toContain('评估收敛门');
    expect(html).toContain('/ 84');
  });

  it('FAIL 条目带 FAIL 语义标记（红行第二通道）', () => {
    const html = renderToStaticMarkup(renderLedger(list([entry({ result: 'FAIL', detail: 'task incomplete' })]), null));
    expect(html).toContain('data-anic-ledger-entry="FAIL"');
    expect(html).toContain('FAIL');
  });

  it('verify.ok=true → 链完整徽章；verify=null → 如实显示未验证', () => {
    const ok: LedgerVerifyJson = { ok: true, total: 84, brokenAt: null, reason: null };
    const okHtml = renderToStaticMarkup(renderLedger(list([entry()]), ok));
    expect(okHtml).toContain('data-anic-ledger-chain="ok"');
    const nullHtml = renderToStaticMarkup(renderLedger(list([entry()]), null));
    expect(nullHtml).toContain('data-anic-ledger-chain="unknown"');
  });

  it('断链（ok=false）→ broken 徽章 + 断点序号', () => {
    const broken: LedgerVerifyJson = { ok: false, total: 84, brokenAt: 41, reason: 'hash mismatch' };
    const html = renderToStaticMarkup(renderLedger(list([entry()]), broken));
    expect(html).toContain('data-anic-ledger-chain="broken"');
    expect(html).toContain('41');
  });

  it('首条（previousHash=null）→ genesis 标记（不伪造前驱哈希）', () => {
    const html = renderToStaticMarkup(renderLedger(list([entry({ previousHash: null })]), null));
    expect(html).toContain('genesis');
  });

  it('哈希行内显示 8 位短哈希；64 位全长恰出现 1 次（title 悬停给完整值）', () => {
    const html = renderToStaticMarkup(renderLedger(list([entry()]), null));
    expect(html).toContain('bbbbbbbb');
    const full = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // 64 位
    const occurrences = html.split(full).length - 1;
    expect(occurrences).toBe(1); // 仅 title 属性；行内文本只有 8 位
    expect(html).toContain(`title="aaaaaaaa`);
  });

  it('detail 非空才渲染详情行（空串不渲染空行）', () => {
    const withDetail = renderToStaticMarkup(renderLedger(list([entry({ detail: 'x' })]), null));
    expect(withDetail).toContain('x');
    const noDetail = renderToStaticMarkup(renderLedger(list([entry({ detail: '' })]), null));
    expect(noDetail).not.toContain('flex-basis');
  });
});
