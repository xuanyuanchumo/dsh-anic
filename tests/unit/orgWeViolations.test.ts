/**
 * orgStatus band.weViolations 接线测试（cycle-9）。
 *
 * WE 8 规则在 cycle-7 已移植（bandDetector.applyWesternElectricRules），
 * 但 org 面板此前只显示 current/trend —— 违例事实被采集却不可见。
 * 本套件钉死：真实 band-history 分数序列 → orgStatus 响应携带 weViolations
 * → renderOrgStatus 渲染违例条目（动态白盒：warn/alarm 的「为什么」可见）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runOrgStatus } from '../../src/host/evolution/orgStatus.ts';
import { renderOrgStatus, type OrgStatusJson } from '../../src/client/features/org/renderOrgStatus.ts';
import { renderToStaticMarkup } from 'react-dom/server';

const TMP = join(tmpdir(), `anic-orgwe-${Date.now()}`);

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, '.cycles'), { recursive: true });
});

// F-T2（cycle-13）：收尾清理——原先只清 beforeEach，最后一组用例的目录泄漏。
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function writeBandHistory(scores: number[]): void {
  writeFileSync(
    join(TMP, '.cycles', 'band-history.json'),
    JSON.stringify(scores.map((score, i) => ({ cycle: i + 1, score, timestamp: '2026-01-01', band: 'warn' as const }))),
    'utf-8',
  );
}

describe('orgStatus band.weViolations（WE 8 规则可观测面）', () => {
  it('无模式异常序列（绕中心线交替）→ weViolations 为空数组', () => {
    // 注意不能用恒定序列：浮点累计让 mean 可能略小于 0.8，恒 0.8 会触发
    // 规则 4「连续 8 点同侧」（技能同款行为，忠实移植，不"修复"）。
    writeBandHistory([0.9, 0.7, 0.9, 0.7, 0.9, 0.7, 0.9, 0.7]);
    const result = runOrgStatus(TMP, {});
    expect(result.band.weViolations).toEqual([]);
  });

  it('单调下滑序列（连续 6 点递减，WE 规则 5）→ weViolations 非空且带规则号', () => {
    writeBandHistory([0.9, 0.89, 0.88, 0.87, 0.86, 0.85, 0.84, 0.83]);
    const result = runOrgStatus(TMP, {});
    expect(result.band.weViolations.length).toBeGreaterThan(0);
    expect(result.band.weViolations[0]?.rule).toBe(5);
    expect(result.band.weViolations[0]?.desc).toContain('递减');
  });

  it('响应形状：band 携带 weViolations 字段（客户端消费契约）', () => {
    writeBandHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = runOrgStatus(TMP, {});
    expect(result.band).toHaveProperty('weViolations');
    expect(Array.isArray(result.band.weViolations)).toBe(true);
  });

  it('renderOrgStatus：有违例时渲染违例列表（data-anic-we-count 可测钩子）', () => {
    const json: OrgStatusJson = {
      cycles: { total: 1, latest: 'cycle-1', converged: 1, failed: 0 },
      ledger: { entries: 3, valid: true },
      trust: { scores: {}, recommendedBand: 'L3' },
      autonomy: { currentBand: 'L4', breakers: [], action: 'proceed' },
      band: {
        current: 'warn', trend: 'degrading',
        weViolations: [
          { rule: 5, index: 5, value: 0.85, desc: '连续 6 点持续递增或递减' },
          { rule: 1, index: 7, value: 0.2, desc: '单点超出 3σ 控制带' },
        ],
      },
      flows: { selfInit: true, agentsOrchestration: true },
      timestamp: '2026-10-17T00:00:00.000Z',
    };
    const html = renderToStaticMarkup(renderOrgStatus(json));
    expect(html).toContain('data-anic-we-count="2"');
    expect(html).toContain('连续 6 点持续递增或递减');
    expect(html).toContain('单点超出 3σ 控制带');
  });

  it('renderOrgStatus：无违例或字段缺失 → 不渲染违例列表（向后兼容）', () => {
    const base: OrgStatusJson = {
      cycles: { total: 1, latest: 'cycle-1', converged: 1, failed: 0 },
      ledger: { entries: 3, valid: true },
      trust: { scores: {}, recommendedBand: 'L3' },
      autonomy: { currentBand: 'L4', breakers: [], action: 'proceed' },
      band: { current: 'normal', trend: 'stable' },
      flows: { selfInit: true, agentsOrchestration: true },
      timestamp: '2026-10-17T00:00:00.000Z',
    };
    const html = renderToStaticMarkup(renderOrgStatus(base));
    expect(html).not.toContain('data-anic-we-count');
    // 带检测分区本身仍在（current/trend 不受影响）
    expect(html).toContain('normal');
  });
});
