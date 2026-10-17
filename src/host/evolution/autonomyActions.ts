/**
 * R3 阶段 1 余量：自主级决策落盘（对齐技能 org-status.mjs cmdAutoFallback:549-660）。
 *
 * 此前插件侧 decideAction/downgradeBand 是纯函数且无调用点写回——熔断触发后
 * 决策只出现在 API 响应里，工作区事实（config.yml autonomy_level）从不变化。
 * 本模块移植技能侧两条关键纪律：
 *   1. Post-Verify（技能 S-7 修复，org-status.mjs:117-134）：降级 = 写入 → 回读 →
 *      按回读到的实际级别判定；绝不无条件声称「已降级」（记录与效果不得解耦）。
 *   2. 事故记录只陈述回读到的真实级别，不声称未发生的降级。
 *
 * 刻意不做（边界，登记于交付清单）：
 *   - 不把自主级事件写进 gates/ledger.json——混入 AUTONOMY 条目会污染 H3 的
 *     slice(-4) 门窗口（技能同款缺陷「两载体」，修复属 R3 阶段 2 FlowRegistry）。
 *   - 技能 Phase 1/2 的 diagnose/attemptAutoFix（技能侧自身实现是坏的：
 *     org-status.mjs:511 execSync 未 import）——R3 阶段 4 再补。
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import { collectBreakerSignals } from './breakerSignals.ts';
import {
  checkBreakers,
  decideAction,
  downgradeBand,
  type BreakerInput,
  type BreakerResult,
} from './autonomyGovernor.ts';
import type { AutonomyBand } from './trustModel.ts';

/** 自主级回退结局（对齐技能 exit 码语义：downgrade 系 = exit 2，floor = exit 1） */
export type FallbackAction = 'maintained' | 'downgraded' | 'downgrade-failed' | 'refused';

export interface AutonomyFallbackResult {
  action: FallbackAction;
  /** config.yml 中实际解析到的当前级别（写入前事实） */
  currentBand: AutonomyBand;
  /** 决策目标级别（L4→L3 / L3→L2）；未进入降级路径时为 null */
  targetBand: AutonomyBand | null;
  /** 回读到的实际级别（Post-Verify 事实）；未写入时为 null */
  observedBand: AutonomyBand | null;
  /** 当前触发的熔断条件（无论是否降级都如实返回） */
  trippedBreakers: Array<{ id: string; detail: string }>;
  /** 事故记录落盘路径；未写降级路径时为 null */
  incidentPath: string | null;
  reason: string;
}

/** 引号容错解析 config 中的 autonomy_level（技能 lib/config.mjs 同款，修 S-8）。 */
export function parseConfiguredAutonomyLevel(content: string): AutonomyBand | null {
  const m = content.match(/autonomy_level:\s*["']?(L[1-4])["']?/);
  return m ? (m[1] as AutonomyBand) : null;
}

/**
 * 降级一步：L4→L3 或 L3→L2（对齐技能 applyAutonomyDowngrade:120-134）。
 * 只接受 L4/L3 起点——L2/L1 是技能同款地板（cmdAutoFallback:656-658 exit 1）。
 */
export function applyAutonomyDowngrade(
  configPath: string,
  fromLevel: AutonomyBand,
  toLevel: AutonomyBand,
): { ok: boolean; observedLevel: AutonomyBand | null; reason: string } {
  if (!existsSync(configPath)) {
    return { ok: false, observedLevel: null, reason: 'config file missing' };
  }
  const content = readFileSync(configPath, 'utf-8');
  // 引号容错：autonomy_level: "L4" / 'L4' / L4 都要能匹配（S-7 根因之一）
  const rewrite = new RegExp(`autonomy_level:\\s*["']?${fromLevel}["']?`);
  if (!rewrite.test(content)) {
    return {
      ok: false,
      observedLevel: parseConfiguredAutonomyLevel(content),
      reason: `autonomy_level pattern for ${fromLevel} not found in config`,
    };
  }
  atomicWriteFileSync(configPath, content.replace(rewrite, `autonomy_level: ${toLevel}`));
  // Post-Verify：回读并按实际解析结果判定，不信任写入意图
  const observedLevel = parseConfiguredAutonomyLevel(readFileSync(configPath, 'utf-8'));
  return {
    ok: observedLevel === toLevel,
    observedLevel,
    reason: observedLevel === toLevel ? '' : `re-read got ${observedLevel ?? 'none'}, expected ${toLevel}`,
  };
}

function writeFallbackIncident(
  workspaceRoot: string,
  result: {
    currentBand: AutonomyBand;
    targetBand: AutonomyBand;
    ok: boolean;
    observedBand: AutonomyBand | null;
    reason: string;
    tripped: BreakerResult[];
  },
): string {
  const incidentsDir = join(workspaceRoot, '.cycles', 'incidents');
  if (!existsSync(incidentsDir)) mkdirSync(incidentsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const incidentPath = join(incidentsDir, `incident-auto-fallback-${timestamp}.md`);
  const triggeredStr = result.tripped
    .map((b) => `- ${b.id}: ${b.detail}`)
    .join('\n');
  // 事故记录只陈述回读到的真实级别（修 S-7：不再声称未发生的降级）
  const eventLine = result.ok
    ? `熔断自动回退 ${result.currentBand} → ${result.observedBand}`
    : '熔断触发，但自动回退未生效（config 未按预期改写）';
  const downgradeLine = result.ok
    ? `自主级别回退：${result.currentBand} → ${result.observedBand}（已回读验证）`
    : `自主级别回退失败：期望 ${result.targetBand}，实际仍为 ${result.observedBand ?? 'none'}（${result.reason}）`;
  const incidentContent = [
    '# 事故记录：熔断自动回退（插件 anic autonomy-fallback）',
    '',
    '## 基本信息',
    '| 字段 | 值 |',
    '|---|---|',
    `| 时间 | ${timestamp} |`,
    `| 事件 | ${eventLine} |`,
    `| 触发条件 | ${result.tripped.length} 个 |`,
    '',
    '## 触发条件',
    triggeredStr,
    '',
    '## 影响范围',
    `- ${downgradeLine}`,
    '- 需要人类介入诊断',
    '',
    '## 恢复条件',
    '- 根因已定位且修复已验证',
    '- 人类确认问题已修复',
    `- 手动恢复 autonomy_level 为 ${result.currentBand}`,
    '',
  ].join('\n');
  atomicWriteFileSync(incidentPath, incidentContent);
  return incidentPath;
}

/**
 * 完整回退流程：采集熔断信号 → 决策 → （证据支持时）写入 → 回读 → 事故留痕。
 *
 * 信号源：collectBreakerSignals 读工作区真实文件（cycle-4 八熔断采集层），
 * opts.breakersInput 提供的显式字段优先（与 orgStatus 同款覆盖语义）。
 *
 * 无证据不动作：没有任何熔断触发时返回 maintained，绝不写任何文件
 * （INV-28 精神——无证据的自主动作在 L≥3 被拒绝）。
 */
export function runAutonomyFallback(
  workspaceRoot: string,
  opts?: { breakersInput?: Partial<BreakerInput> },
): AutonomyFallbackResult {
  const configPath = join(workspaceRoot, '.cycles', 'config.yml');
  if (!existsSync(configPath)) {
    return {
      action: 'refused',
      currentBand: 'L2',
      targetBand: null,
      observedBand: null,
      trippedBreakers: [],
      incidentPath: null,
      reason: 'config file missing',
    };
  }
  const content = readFileSync(configPath, 'utf-8');
  const currentBand = parseConfiguredAutonomyLevel(content);
  if (!currentBand) {
    return {
      action: 'refused',
      currentBand: 'L2',
      targetBand: null,
      observedBand: null,
      trippedBreakers: [],
      incidentPath: null,
      reason: 'no autonomy_level in config',
    };
  }

  const signals = collectBreakerSignals(workspaceRoot);
  const merged: BreakerInput = { ...signals, ...opts?.breakersInput };
  const breakers = checkBreakers(merged);
  const tripped = breakers.filter((b) => b.tripped);
  const trippedView = tripped.map((b) => ({ id: b.id, detail: b.detail }));

  // 无熔断 → 维持不动，零写入（INV-28 精神：无证据不动作）
  if (tripped.length === 0) {
    return {
      action: 'maintained',
      currentBand,
      targetBand: null,
      observedBand: currentBand,
      trippedBreakers: trippedView,
      incidentPath: null,
      reason: `no breakers tripped, autonomy level ${currentBand} maintained`,
    };
  }

  // 地板（技能 cmdAutoFallback:656-658）：L1/L2 已无进一步自动回退空间。
  // 判定在 decideAction 之前——技能语义是「熔断触发 + 已在地板」就 exit 1，
  // 而不是把非严重熔断在 L1/L2 上误报成 pause/maintained。
  if (currentBand === 'L1' || currentBand === 'L2') {
    return {
      action: 'refused',
      currentBand,
      targetBand: null,
      observedBand: currentBand,
      trippedBreakers: trippedView,
      incidentPath: null,
      reason: `circuit breakers detected but already at ${currentBand}, no further auto-fallback`,
    };
  }

  const action = decideAction(currentBand, breakers);

  // 非严重熔断 + L3 → pause → 维持不动（decideAction 只在 severe 或 L4 时降级）
  if (action !== 'downgrade') {
    return {
      action: 'maintained',
      currentBand,
      targetBand: null,
      observedBand: currentBand,
      trippedBreakers: trippedView,
      incidentPath: null,
      reason: `breakers tripped but decision is ${action} (non-severe, below L4), level ${currentBand} maintained`,
    };
  }

  const targetBand = downgradeBand(currentBand); // L4→L3 / L3→L2
  const applied = applyAutonomyDowngrade(configPath, currentBand, targetBand);
  const incidentPath = writeFallbackIncident(workspaceRoot, {
    currentBand,
    targetBand,
    ok: applied.ok,
    observedBand: applied.observedLevel,
    reason: applied.reason,
    tripped,
  });

  return {
    action: applied.ok ? 'downgraded' : 'downgrade-failed',
    currentBand,
    targetBand,
    observedBand: applied.observedLevel,
    trippedBreakers: trippedView,
    incidentPath,
    reason: applied.ok ? '' : applied.reason,
  };
}
