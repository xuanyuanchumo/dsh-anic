/**
 * 组织状态分区渲染契约（P0-ORG-STRING 回归）。
 *
 * 契约来源：`dsh-anic/src/client/features/org/renderOrgStatus.ts` 的导出签名
 * 与调用点 `dsh-anic/src/client/WorkflowGraphPanel.ts` 的
 * `createElement('div', {…}, renderOrgStatus(orgStatus))`。
 *
 * 原缺陷：renderOrgStatus 返回 HTML **字符串**，却被当作 React 子节点传入。
 * React 转义字符串子节点 ⇒ 整段 `<section class="anic-org-cycles">…`
 * 以**可见的字面标记文本**渲染，org 分区从未成为 UI。
 *
 * 本文件用 react-dom/server 真实渲染（而不是断言"函数返回了元素"），
 * 因为"返回类型对了"和"渲染出来是对的"是两件事：
 * 一个返回 ReactElement 但内部又塞了 HTML 串的实现同样会漏过去。
 */
import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderOrgStatus, type OrgStatusJson } from '../../src/client/features/org/renderOrgStatus.ts';

/** 逐字段转录 src/host/evolution/orgStatus.ts OrgStatus 的响应形状。 */
const STATUS: OrgStatusJson = {
  cycles: { total: 78, latest: 'cycle-78', converged: 74, failed: 4 },
  ledger: { entries: 63, valid: true },
  trust: { scores: { G0: { score: 92, approve: 23, total: 25 }, G2: { score: 48, approve: 12, total: 25 } }, recommendedBand: 'L3' },
  autonomy: { currentBand: 'L3', breakers: ['cost-budget'], action: 'allow-with-review' },
  band: { current: 'warn', trend: 'improving' },
  flows: { selfInit: true, agentsOrchestration: false },
  timestamp: '2026-10-05T00:00:00.000Z',
};

describe('renderOrgStatus (P0-ORG-STRING)', () => {
  it('returns a React element, not an HTML string', () => {
    const out = renderOrgStatus(STATUS);
    // 反向自检的锚点：字符串实现会让 isValidElement 为 false
    expect(typeof out).not.toBe('string');
    expect(isValidElement(out)).toBe(true);
  });

  it('renders real markup, NOT escaped literal tags', () => {
    const html = renderToStaticMarkup(renderOrgStatus(STATUS));
    // 正向：真的是元素树
    expect(html).toContain('<section class="anic-org-cycles">');
    expect(html).toContain('<section class="anic-org-autonomy">');
    expect(html).toContain('<section class="anic-org-band">');
    // 反向：原缺陷的可见症状——被转义的字面标记文本
    expect(html).not.toContain('&lt;section');
    expect(html).not.toContain('&lt;h4');
    expect(html).not.toContain('&lt;/');
  });

  it('carries every data field through to the rendered output', () => {
    const html = renderToStaticMarkup(renderOrgStatus(STATUS));
    expect(html).toContain('78'); // cycles.total
    expect(html).toContain('cycle-78'); // cycles.latest
    expect(html).toContain('74'); // converged
    expect(html).toContain('92%'); // G0 trust score
    expect(html).toContain('(23/25)');
    expect(html).toContain('L3'); // recommendedBand
    expect(html).toContain('allow-with-review');
    expect(html).toContain('warn'); // band.current
    expect(html).toContain('improving');
    expect(html).toContain('cost-budget'); // breaker
    expect(html).toContain('anic-breaker-tripped');
  });

  it('shows the empty-breakers branch instead of an empty list', () => {
    const html = renderToStaticMarkup(renderOrgStatus({ ...STATUS, autonomy: { ...STATUS.autonomy, breakers: [] } }));
    expect(html).toContain('无熔断');
    expect(html).not.toContain('anic-breakers');
  });

  it('omits the trust section entirely when no scores exist', () => {
    const html = renderToStaticMarkup(renderOrgStatus({ ...STATUS, trust: { scores: {}, recommendedBand: 'L1' } }));
    expect(html).not.toContain('anic-org-trust');
    // 空分区不得留下孤立标题（"渲染标题再过滤内容"会留一个空 h4）
    expect(html).not.toContain('信任分');
  });

  it('tolerates a null latest cycle without printing "null"', () => {
    const html = renderToStaticMarkup(renderOrgStatus({ ...STATUS, cycles: { ...STATUS.cycles, latest: null } }));
    expect(html).toContain('—');
    expect(html).not.toContain('null');
  });

  it('renders text content escaped by React, so no injection surface remains', () => {
    const html = renderToStaticMarkup(
      renderOrgStatus({ ...STATUS, trust: { scores: { '<img src=x onerror=alert(1)>': { score: 10, approve: 1, total: 1 } }, recommendedBand: 'L1' } }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('every colour comes from a token with a same-source fallback', () => {
    const html = renderToStaticMarkup(renderOrgStatus(STATUS));
    // 语义令牌必须带 fallback：裸 var(--anic-pass) 在宿主未注入时计算为无效值
    const vars = html.match(/var\(--anic-[a-z-]+[^)]*\)/g) ?? [];
    expect(vars.length).toBeGreaterThan(0);
    for (const v of vars) {
      expect(v).toMatch(/^var\(--anic-[a-z-]+, #[0-9a-f]{6}\)$/);
    }
  });
});

// ---------------------------------------------------------------------------
// cycle-78：自主级变更时间线（白盒可见）
//
// 缺口（本轮实测）：cycle-77 把「谁在何时把 L? 改成 L?」写进
// `.cycles/autonomy-history.json` 并由 org-status 投影（autonomy.history /
// historyCount / historyError），但面板只画「当前 L?」——L4 是谁授权的、信任
// 豁免是否发生，UI 上完全查不到。下面每条用例都钉一个**用户可见**事实，
// 而不是「函数没抛错」。
// ---------------------------------------------------------------------------

/** 1 条 system 授权变更 + 1 条 human 授权且带信任豁免的变更（时间递增）。 */
const HISTORY = [
  { from: 'L2', to: 'L3', at: '2026-10-01T09:15:00.000Z', actor: 'anic_autonomy_upgrade', authorization: 'system', reason: 'trust 82' },
  { from: 'L3', to: 'L4', at: '2026-10-05T18:42:00.000Z', actor: 'human@local', authorization: 'human', reason: 'manual authorize', trustExemption: { avg: 61, threshold: 75 } },
];

/** 以基础 STATUS 为底，只覆盖 autonomy 分区（其余字段保持真实形状）。 */
function withHistory(autonomy: Partial<OrgStatusJson['autonomy']>): OrgStatusJson {
  return { ...STATUS, autonomy: { ...STATUS.autonomy, ...autonomy } };
}

/** 渲染后的变更行标记集（计数即「可见条数」——不看 DOM 就等于没验）。 */
function rows(html: string): string[] {
  return html.match(/data-anic-autonomy-transition="[^"]*"/g) ?? [];
}

describe('renderOrgStatus 自主级变更时间线（cycle-78）', () => {
  it('① 无 history → 不渲染变更子区（不留空壳标题）', () => {
    const html = renderToStaticMarkup(renderOrgStatus(STATUS));
    expect(html).not.toContain('data-anic-org-autonomy-history');
    expect(html).not.toContain('自主级变更');
  });

  it('② 2 条变更 → 两行且 from/to、时间、actor、授权来源文本正确', () => {
    const html = renderToStaticMarkup(renderOrgStatus(withHistory({ history: HISTORY, historyCount: 2 })));
    expect(html).toContain('data-anic-org-autonomy-history');
    expect(rows(html)).toHaveLength(2);
    expect(html).toContain('L2 → L3');
    expect(html).toContain('L3 → L4');
    expect(html).toContain('2026-10-01 09:15'); // 行内压短，不塞完整 ISO
    expect(html).not.toContain('2026-10-01T09:15'); // 与上一条互为反向：短格式确实生效
    expect(html).toContain('anic_autonomy_upgrade');
    expect(html).toContain('人类授权');
    expect(html).toContain('系统授权');
    // 授权来源是行内的第二通道：人类授权更醒目（font-weight 600），系统授权弱化
    expect(html).toMatch(/color:var\(--anic-doubt[^)]*\);font-weight:600/);
  });

  it('③ 6 条变更 → 恰 5 行 + 「另有 1 条」，且时间倒序（最近在前）', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      from: i % 2 === 0 ? 'L2' : 'L3', to: i % 2 === 0 ? 'L3' : 'L4',
      at: `2026-10-0${String(i + 1)}T12:00:00.000Z`, actor: `actor-${String(i)}`,
      authorization: i % 2 === 0 ? 'system' : 'human', reason: 'r',
    }));
    const html = renderToStaticMarkup(renderOrgStatus(withHistory({ history: six, historyCount: 6 })));
    expect(rows(html)).toHaveLength(5);
    expect(html).toContain('另有 1 条变更未展示');
    // 倒序：最新（10-06）必须出现在次新（10-05）之前
    expect(html.indexOf('2026-10-06 12:00')).toBeLessThan(html.indexOf('2026-10-05 12:00'));
    // 被截掉的是最旧一条（10-01），不是最新一条
    expect(html).not.toContain('2026-10-01 12:00');
  });

  it('③b historyCount 反映账本全量 → 截限提示按真实总数计，不按投影条数计', () => {
    // host 只投影最近 5 条：history.length=2 但账里 9 条时必须显示还有 7 条
    const html = renderToStaticMarkup(renderOrgStatus(withHistory({ history: HISTORY, historyCount: 9 })));
    expect(rows(html)).toHaveLength(2);
    expect(html).toContain('另有 7 条变更未展示');
  });

  it('④ 含 trustExemption → 同行可见「人类授权豁免 avg/threshold」警示', () => {
    const html = renderToStaticMarkup(renderOrgStatus(withHistory({ history: HISTORY, historyCount: 2 })));
    expect(html).toContain('data-anic-autonomy-exempt="true"');
    expect(html).toContain('豁免信任阈值 61/75');
  });

  it('⑤ historyError → 错误行响亮出现（role=alert），空历史也不静默', () => {
    const html = renderToStaticMarkup(
      renderOrgStatus(withHistory({ history: [], historyCount: 0, historyError: 'autonomy-history.json is not valid JSON: x' })),
    );
    expect(html).toContain('data-anic-autonomy-history-error="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('变更账读取失败');
    expect(html).toContain('is not valid JSON'); // 根因原文透出，不糊成"无变更"
    expect(rows(html)).toHaveLength(0); // 坏账不得伪造出变更行
  });

  it('⑥ 反向自检：缺 actor 的坏 fixture 必须让 ② 的 actor 断言判红（含好 fixture 对照）', () => {
    const noActor = { from: 'L2', to: 'L3', at: '2026-10-01T09:15:00.000Z', authorization: 'system', reason: 'r' };
    const brokenHtml = renderToStaticMarkup(
      renderOrgStatus(withHistory({ history: [noActor] as unknown as NonNullable<OrgStatusJson['autonomy']['history']> })),
    );
    const goodHtml = renderToStaticMarkup(renderOrgStatus(withHistory({ history: [HISTORY[0]!] })));
    /** ② 中使用的可见性断言本体（同一谓词跑好/坏两份 fixture）。 */
    const actorVisible = (h: string): boolean => h.includes('anic_autonomy_upgrade');
    expect(actorVisible(goodHtml)).toBe(true); // 对照：谓词确实能命中
    expect(actorVisible(brokenHtml)).toBe(false); // 篡改后必须判红（否则 ② 是空转）
    expect(rows(brokenHtml)).toHaveLength(1); // 缺字段不崩：该行仍渲染
    expect(brokenHtml).toContain('由 undefined'); // 缺字段如实暴露，不静默成空白
  });

  it('⑦ 响应式：每行 flex-wrap（窄面板折行而非横向溢出），容器带 aria-label', () => {
    const html = renderToStaticMarkup(renderOrgStatus(withHistory({ history: HISTORY, historyCount: 2 })));
    // 行内 flex-wrap + baseline 是窄面板不溢出的唯一保证（无新 CSS 文件可依赖）
    expect(html).toMatch(/data-anic-autonomy-transition="[^"]*" style="[^"]*display:flex[^"]*flex-wrap:wrap/);
    expect(html).toContain('aria-label="自主级变更时间线：显示最近 2 条 / 共 2 条"');
  });
});
