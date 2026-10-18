/**
 * 自主级仪表带渲染测试（cycle-20 P2 · ui-domain-plan 仪表带）。
 *
 * 与 orgStatusRender.test.ts 同纪律：renderToStaticMarkup 真渲染。
 * 契约面：L1-L4 刻度 + 当前/配置双指针 + 熔断徽标 + 性能带芯片 +
 * 建议档 + 火花线（band.recent 数据面）。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderAutonomyGauge } from '../../src/client/features/autonomy/renderAutonomyGauge.ts';
import type { OrgStatusJson } from '../../src/client/features/org/renderOrgStatus.ts';

/** 逐字段转录 org-status 路由响应形状（band.recent 为 cycle-20 新增可选字段）。 */
function status(over: Partial<OrgStatusJson> = {}): OrgStatusJson {
  return {
    cycles: { total: 78, latest: 'cycle-78', converged: 74, failed: 4 },
    ledger: { entries: 63, valid: true },
    trust: { scores: { G0: { score: 92, approve: 23, total: 25 } }, recommendedBand: 'L3' },
    autonomy: { currentBand: 'L3', breakers: [], action: 'allow' },
    band: { current: 'normal', trend: 'stable' },
    flows: { selfInit: true, agentsOrchestration: false },
    timestamp: '2026-10-18T00:00:00.000Z',
    ...over,
  };
}

describe('renderAutonomyGauge（自主级仪表带）', () => {
  it('渲染 L1-L4 刻度条：四段齐、当前档 data-current=true', () => {
    const html = renderToStaticMarkup(renderAutonomyGauge(status()));
    expect(html).toContain('data-anic-gauge="section"');
    expect(html).toContain('data-anic-gauge-seg="L1"');
    expect(html).toContain('data-anic-gauge-seg="L2"');
    expect(html).toContain('data-anic-gauge-seg="L3"');
    expect(html).toContain('data-anic-gauge-seg="L4"');
    expect(html).toContain('data-anic-gauge-scale="L3"');
    expect(html).toContain('data-current="true"');
  });

  it('配置档分歧：双指针 + 分歧说明行（降级一眼可辨）', () => {
    const html = renderToStaticMarkup(renderAutonomyGauge(status({
      autonomy: { currentBand: 'L2', configuredBand: 'L4', breakers: ['cost-budget'], action: 'degraded' },
    })));
    // 配置档段被标 data-configured=true；当前档也被标（同一段两属性并存）
    expect(html).toContain('data-anic-gauge-seg="L4"');
    expect(html).toContain('data-configured="true"');
    expect(html).toContain('data-anic-gauge-divergent');
    expect(html).toContain('实际运行 L2');
  });

  it('无分歧：不渲染分歧说明（不制造噪音）', () => {
    const html = renderToStaticMarkup(renderAutonomyGauge(status({
      autonomy: { currentBand: 'L3', configuredBand: 'L3', breakers: [], action: 'allow' },
    })));
    expect(html).not.toContain('data-anic-gauge-divergent');
  });

  it('熔断徽标：0 → ✓ 无熔断；>0 → ⚠ 计数（字形双通道）', () => {
    const ok = renderToStaticMarkup(renderAutonomyGauge(status()));
    expect(ok).toContain('data-anic-gauge-breakers="0"');
    expect(ok).toContain('✓ 无熔断');
    const tripped = renderToStaticMarkup(renderAutonomyGauge(status({
      autonomy: { currentBand: 'L3', breakers: ['cost-budget', 'failure-streak'], action: 'halt' },
    })));
    expect(tripped).toContain('data-anic-gauge-breakers="2"');
    expect(tripped).toContain('⚠ 2 处熔断');
  });

  it('性能带芯片：色点 + band/trend 文本', () => {
    const html = renderToStaticMarkup(renderAutonomyGauge(status({
      band: { current: 'warn', trend: 'improving' },
    })));
    expect(html).toContain('data-anic-gauge-band="warn"');
    expect(html).toContain('性能带 warn · improving');
  });

  it('建议档：recommended ≠ current 时显示；一致时不显示', () => {
    const diff = renderToStaticMarkup(renderAutonomyGauge(status({
      trust: { scores: {}, recommendedBand: 'L2' },
    })));
    expect(diff).toContain('data-anic-gauge-recommended="L2"');
    const same = renderToStaticMarkup(renderAutonomyGauge(status({
      trust: { scores: {}, recommendedBand: 'L3' },
    })));
    expect(same).not.toContain('data-anic-gauge-recommended');
  });

  it('火花线：≥2 点渲染 SVG polyline；<2 点不渲染（画不出线）', () => {
    const withSpark = renderToStaticMarkup(renderAutonomyGauge(status({
      band: { current: 'normal', trend: 'stable', recent: [40, 55, 70, 68] },
    })));
    expect(withSpark).toContain('data-anic-gauge-sparkline');
    expect(withSpark).toContain('polyline');
    expect(withSpark).toContain('points="');
    const tooFew = renderToStaticMarkup(renderAutonomyGauge(status({
      band: { current: 'normal', trend: 'stable', recent: [42] },
    })));
    expect(tooFew).not.toContain('data-anic-gauge-sparkline');
    const none = renderToStaticMarkup(renderAutonomyGauge(status()));
    expect(none).not.toContain('data-anic-gauge-sparkline');
  });

  it('火花线防御：band-history 无 score 字段时 recent=[null,null]（真机发现的代码质量带历史形状）——不画线不伪造平线', () => {
    // 宿主 band-history.json 是代码质量带历史（avgScore/totalScore/fileCount），
    // orgStatus map(e=>e.score) 产出 null 序列；火花线须逐点过滤非有限值。
    const nulls = renderToStaticMarkup(renderAutonomyGauge(status({
      band: { current: 'normal', trend: 'stable', recent: [null as unknown as number, null as unknown as number] },
    })));
    expect(nulls).not.toContain('data-anic-gauge-sparkline');
    const mixed = renderToStaticMarkup(renderAutonomyGauge(status({
      band: { current: 'normal', trend: 'stable', recent: [50, NaN as unknown as number, 70] },
    })));
    // 有效点 50/70 仍画线（NaN 跳过）
    expect(mixed).toContain('data-anic-gauge-sparkline');
  });

  it('刻度条整体 role=img + aria-label 全文描述（AT 单次播报，非逐段碎片）', () => {
    const html = renderToStaticMarkup(renderAutonomyGauge(status({
      autonomy: { currentBand: 'L3', configuredBand: 'L3', breakers: [], action: 'allow' },
      band: { current: 'normal', trend: 'stable' },
    })));
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label');
    expect(html).toContain('自主级：当前 L3');
  });
});
