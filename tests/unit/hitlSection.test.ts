// @vitest-environment jsdom
/**
 * renderHitl 渲染测试（B2 · HITL 审计队列分区，cycle-18）。
 *
 * 响应形状契约来源：src/host/routes/nativeRoute.ts:39-48（GET /anic/hitl-audit
 * → { checks[H1..H4], allPassed, anyCircuit }，语义与
 * assets/skill/scripts/hitl-audit.mjs 对齐）。
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderHitl, isHitlAudit, type HitlAuditJson } from '../../src/client/features/hitl/renderHitl.ts';

function audit(over: Partial<HitlAuditJson> = {}, checks?: HitlAuditJson['checks']): HitlAuditJson {
  return {
    checks: checks ?? [
      { check: 'H1', passed: true, circuit: false, detail: 'No security-sensitive operations detected' },
      { check: 'H2', passed: true, circuit: false, detail: 'Destructive ops detected (1 files), rollback available' },
      { check: 'H3', passed: false, circuit: true, detail: 'No audit log' },
      { check: 'H4', passed: true, circuit: false, detail: 'Gate evidence sufficient, no conflicts' },
    ],
    allPassed: false,
    anyCircuit: true,
    ...over,
  };
}

describe('isHitlAudit（形状守卫）', () => {
  it('合法响应通过；空 checks / 缺 passed 拒绝', () => {
    expect(isHitlAudit(audit())).toBe(true);
    expect(isHitlAudit({ checks: [] })).toBe(false);
    expect(isHitlAudit({ checks: [{ check: 'H1' }] })).toBe(false);
    expect(isHitlAudit('nope')).toBe(false);
  });
});

describe('renderHitl（HITL 审计队列分区）', () => {
  it('audit=null（未拉取）→ 整区不渲染（不伪造空态）', () => {
    expect(renderHitl(null)).toBe(null);
  });

  it('渲染 H1-H4 四检查行 + 域标签', () => {
    const html = renderToStaticMarkup(renderHitl(audit()));
    expect(html).toContain('data-anic-hitl-wrap');
    expect(html).toContain('data-anic-hitl-check="H1"');
    expect(html).toContain('data-anic-hitl-check="H4"');
    expect(html).toContain('敏感数据保护');
    expect(html).toContain('账本证据一致性');
  });

  it('circuit 优先于 passed：H3 passed=false+circuit=true → 熔断徽章（非 FAIL）', () => {
    const html = renderToStaticMarkup(renderHitl(audit()));
    expect(html).toContain('data-anic-hitl-badge="circuit"');
    // 熔断行的 detail 如实展示
    expect(html).toContain('No audit log');
  });

  it('passed=true → PASS 徽章；passed=false 无 circuit → FAIL 徽章', () => {
    const allPass = audit({ allPassed: true, anyCircuit: false }, [
      { check: 'H1', passed: true, circuit: false, detail: '' },
      { check: 'H2', passed: true, circuit: false, detail: '' },
    ]);
    const passHtml = renderToStaticMarkup(renderHitl(allPass));
    expect(passHtml).toContain('data-anic-hitl-badge="pass"');
    expect(passHtml).toContain('data-anic-hitl-summary="pass"');

    const fail = audit({ allPassed: false, anyCircuit: false }, [
      { check: 'H3', passed: false, circuit: false, detail: 'gate red' },
    ]);
    const failHtml = renderToStaticMarkup(renderHitl(fail));
    expect(failHtml).toContain('data-anic-hitl-badge="fail"');
    expect(failHtml).toContain('data-anic-hitl-summary="fail"');
  });

  it('anyCircuit=true → 总评行显示熔断待人工（琥珀语义，与 FAIL 区分）', () => {
    const html = renderToStaticMarkup(renderHitl(audit()));
    expect(html).toContain('data-anic-hitl-summary="circuit"');
    expect(html).toContain('等待人工');
  });

  it('只读边界提示常驻（H4 人工专属裁决 + CLI 指引——degradation 契约）', () => {
    const html = renderToStaticMarkup(renderHitl(audit()));
    expect(html).toContain('data-anic-hitl-cli-hint');
    expect(html).toContain('只读队列');
    expect(html).toContain('hitl-audit');
  });

  it('detail 空串不渲染空行', () => {
    const compact = audit({ allPassed: true, anyCircuit: false }, [
      { check: 'H1', passed: true, circuit: false, detail: '' },
    ]);
    const html = renderToStaticMarkup(renderHitl(compact));
    expect(html).toContain('data-anic-hitl-check="H1"');
  });
});
