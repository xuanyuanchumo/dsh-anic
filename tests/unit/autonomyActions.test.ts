/**
 * 自主级回退契约（R3 阶段 1 余量：autonomyActions.ts 对齐技能 org-status.mjs:549-660）。
 *
 * 钉死四条纪律：
 * 1. Post-Verify（技能 S-7 修复）：降级 = 写入 → 回读 → 按回读事实判定；
 *    事故记录只陈述回读到的真实级别，绝不声称未发生的降级。
 * 2. 无证据不动作：零熔断信号 → maintained，config 与 incidents 均零写入。
 * 3. 地板（技能 cmdAutoFallback:656-658）：L1/L2 触发熔断也拒绝进一步自动回退。
 * 4. 显式 breakersInput 覆盖采集信号（与 orgStatus 同款覆盖语义）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseConfiguredAutonomyLevel,
  applyAutonomyDowngrade,
  runAutonomyFallback,
} from '../../src/host/evolution/autonomyActions.ts';

let ws: string;

function makeWorkspace(configYml: string | null): void {
  ws = mkdtempSync(join(tmpdir(), 'anic-autonomy-'));
  mkdirSync(join(ws, '.cycles'), { recursive: true });
  if (configYml !== null) {
    writeFileSync(join(ws, '.cycles', 'config.yml'), configYml, 'utf-8');
  }
}

function incidentsDir(): string {
  return join(ws, '.cycles', 'incidents');
}

beforeEach(() => {
  ws = '';
});

afterEach(() => {
  if (ws) rmSync(ws, { recursive: true, force: true });
});

describe('parseConfiguredAutonomyLevel（引号容错，修 S-8）', () => {
  it('裸值 autonomy_level: L4', () => {
    expect(parseConfiguredAutonomyLevel('macro_cycle:\n  autonomy_level: L4\n')).toBe('L4');
  });

  it('双引号 autonomy_level: "L3"', () => {
    expect(parseConfiguredAutonomyLevel('autonomy_level: "L3"')).toBe('L3');
  });

  it('单引号 autonomy_level: \'L2\'', () => {
    expect(parseConfiguredAutonomyLevel("autonomy_level: 'L2'")).toBe('L2');
  });

  it('缺失 → null（不静默兜底）', () => {
    expect(parseConfiguredAutonomyLevel('other: 1')).toBeNull();
  });
});

describe('applyAutonomyDowngrade（S-7 Post-Verify 纪律）', () => {
  it('config 缺失 → ok:false + reason（绝不创建 config）', () => {
    makeWorkspace(null);
    const r = applyAutonomyDowngrade(join(ws, '.cycles', 'config.yml'), 'L4', 'L3');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('config file missing');
    expect(existsSync(join(ws, '.cycles', 'config.yml'))).toBe(false);
  });

  it('fromLevel 模式不匹配（config 是 L4，请求从 L3 降）→ ok:false + 观察到 L4', () => {
    makeWorkspace('autonomy_level: L4\n');
    const r = applyAutonomyDowngrade(join(ws, '.cycles', 'config.yml'), 'L3', 'L2');
    expect(r.ok).toBe(false);
    expect(r.observedLevel).toBe('L4');
    expect(r.reason).toContain('not found');
  });

  it('L4→L3 成功：文件被改写且回读为 L3', () => {
    makeWorkspace('project:\n  name: demo\nmacro_cycle:\n  autonomy_level: L4\n');
    const configPath = join(ws, '.cycles', 'config.yml');
    const r = applyAutonomyDowngrade(configPath, 'L4', 'L3');
    expect(r.ok).toBe(true);
    expect(r.observedLevel).toBe('L3');
    expect(r.reason).toBe('');
    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('autonomy_level: L3');
    expect(after).toContain('name: demo'); // 只动目标行，其余内容原样保留
    expect(after).not.toContain('L4');
  });

  it('带引号 "L4" 也能匹配并改写（S-7 根因之一）', () => {
    makeWorkspace('autonomy_level: "L4"\n');
    const configPath = join(ws, '.cycles', 'config.yml');
    const r = applyAutonomyDowngrade(configPath, 'L4', 'L3');
    expect(r.ok).toBe(true);
    expect(readFileSync(configPath, 'utf-8')).toContain('autonomy_level: L3');
  });
});

describe('runAutonomyFallback（完整流程）', () => {
  it('零熔断信号 → maintained，config 与 incidents 均零写入', () => {
    makeWorkspace('autonomy_level: L4\n');
    const r = runAutonomyFallback(ws);
    expect(r.action).toBe('maintained');
    expect(r.currentBand).toBe('L4');
    expect(r.targetBand).toBeNull();
    expect(r.observedBand).toBe('L4');
    expect(r.trippedBreakers).toEqual([]);
    expect(r.reason).toContain('maintained');
    expect(readFileSync(join(ws, '.cycles', 'config.yml'), 'utf-8')).toContain('L4');
    expect(existsSync(incidentsDir())).toBe(false); // 连目录都没建
  });

  it('CB6（human_override: true）+ L4 → downgraded L4→L3，config 改写 + 事故留痕', () => {
    makeWorkspace('autonomy_level: L4\nhuman_override: true\n');
    const r = runAutonomyFallback(ws);
    expect(r.action).toBe('downgraded');
    expect(r.currentBand).toBe('L4');
    expect(r.targetBand).toBe('L3');
    expect(r.observedBand).toBe('L3');
    expect(r.trippedBreakers.map((b) => b.id)).toContain('human_requests_l3');
    expect(readFileSync(join(ws, '.cycles', 'config.yml'), 'utf-8')).toContain('autonomy_level: L3');
    expect(r.incidentPath).not.toBeNull();
    expect(existsSync(r.incidentPath!)).toBe(true);
    // 事故记录只陈述回读事实（S-7）：必须写明已回读验证的 L4 → L3
    const incident = readFileSync(r.incidentPath!, 'utf-8');
    expect(incident).toContain('熔断自动回退 L4 → L3');
    expect(incident).toContain('已回读验证');
    expect(incident).toContain('human_requests_l3');
  });

  it('事故文件名对齐技能约定 incident-auto-fallback-<ts>.md', () => {
    makeWorkspace('autonomy_level: L4\nhuman_override: L3\n');
    const r = runAutonomyFallback(ws);
    expect(r.action).toBe('downgraded');
    const base = (r.incidentPath ?? '').split(/[\\/]/).pop() ?? '';
    expect(base).toMatch(/^incident-auto-fallback-\d{4}-\d{2}-\d{2}T/);
  });

  it('L2 地板：熔断触发也拒绝（技能 cmdAutoFallback:656-658 exit 1 对齐）', () => {
    makeWorkspace('autonomy_level: L2\nhuman_override: true\n');
    const r = runAutonomyFallback(ws);
    expect(r.action).toBe('refused');
    expect(r.reason).toContain('already at L2');
    expect(readFileSync(join(ws, '.cycles', 'config.yml'), 'utf-8')).toContain('L2');
    expect(r.incidentPath).toBeNull();
  });

  it('L1 地板同样拒绝', () => {
    makeWorkspace('autonomy_level: L1\nsession_timeout: 48\n');
    const r = runAutonomyFallback(ws);
    expect(r.action).toBe('refused');
    expect(r.reason).toContain('already at L1');
  });

  it('config 缺失 → refused（诚实拒绝，不静默兜底 L2）', () => {
    makeWorkspace(null);
    const r = runAutonomyFallback(ws);
    expect(r.action).toBe('refused');
    expect(r.reason).toBe('config file missing');
  });

  it('config 无 autonomy_level 行 → refused', () => {
    makeWorkspace('project:\n  name: demo\n');
    const r = runAutonomyFallback(ws);
    expect(r.action).toBe('refused');
    expect(r.reason).toBe('no autonomy_level in config');
  });

  it('CB1（3× auto-fix-fail incidents）+ L4 → downgraded（真实文件信号驱动）', () => {
    makeWorkspace('autonomy_level: L4\n');
    mkdirSync(incidentsDir(), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(incidentsDir(), `incident-auto-fix-fail-${i}.md`), 'x', 'utf-8');
    }
    const r = runAutonomyFallback(ws);
    // CB1 是非严重熔断，但 L4 + 任一熔断 → downgrade（decideAction:103）
    expect(r.action).toBe('downgraded');
    expect(r.trippedBreakers.map((b) => b.id)).toContain('consecutive_fix_fail');
    expect(r.observedBand).toBe('L3');
  });

  it('非严重熔断（CB5 性能带）+ L3 → pause → maintained（decideAction 只在 severe 或 L4 降级）', () => {
    makeWorkspace('autonomy_level: L3\n');
    writeFileSync(
      join(ws, '.cycles', 'band-history.json'),
      JSON.stringify([{ band: 'alarm' }, { band: 'alarm' }]),
      'utf-8',
    );
    const r = runAutonomyFallback(ws);
    expect(r.action).toBe('maintained');
    expect(r.reason).toContain('decision is pause');
    expect(readFileSync(join(ws, '.cycles', 'config.yml'), 'utf-8')).toContain('L3');
  });

  it('CB5（band-history 末 2 条 alarm）→ perfUnrecovered → L4 降级', () => {
    makeWorkspace('autonomy_level: L4\n');
    writeFileSync(
      join(ws, '.cycles', 'band-history.json'),
      JSON.stringify([{ band: 'normal' }, { band: 'alarm' }, { band: 'alarm' }]),
      'utf-8',
    );
    const r = runAutonomyFallback(ws);
    expect(r.trippedBreakers.map((b) => b.id)).toContain('perf_unrecovered');
    expect(r.action).toBe('downgraded');
  });

  it('显式 breakersInput 覆盖采集信号（humanRequestsL3 注入）', () => {
    makeWorkspace('autonomy_level: L3\n'); // 无任何文件信号
    const r = runAutonomyFallback(ws, { breakersInput: { humanRequestsL3: true } });
    expect(r.action).toBe('downgraded');
    expect(r.observedBand).toBe('L2');
  });

  it('降级后二跑（信号清零）→ maintained at L3（Post-Verify 一致性）', () => {
    makeWorkspace('autonomy_level: L4\nhuman_override: true\n');
    const first = runAutonomyFallback(ws);
    expect(first.action).toBe('downgraded');
    // 移除 human_override（人类要求已满足）→ 信号清零
    writeFileSync(join(ws, '.cycles', 'config.yml'), 'autonomy_level: L3\n', 'utf-8');
    const second = runAutonomyFallback(ws);
    expect(second.action).toBe('maintained');
    expect(second.observedBand).toBe('L3');
  });

  it('降级路径写的事故文件不会自我触发更多熔断（文件名不含 circuit/retry/auto-fix-fail）', () => {
    makeWorkspace('autonomy_level: L4\nhuman_override: true\n');
    const r = runAutonomyFallback(ws);
    expect(r.action).toBe('downgraded');
    const files = readdirSync(incidentsDir()).map((f) => f.toLowerCase());
    expect(files.some((f) => f.includes('circuit'))).toBe(false);
    expect(files.some((f) => f.includes('retry'))).toBe(false);
    expect(files.some((f) => f.includes('auto-fix-fail'))).toBe(false);
  });
});
