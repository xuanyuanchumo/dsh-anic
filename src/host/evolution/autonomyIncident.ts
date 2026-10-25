/**
 * 回退事故记录（cycle-77 T4 拆分自 autonomyActions.ts —— 加 history 留痕后
 * 该文件将超 250 行 T3 上限，故把纯渲染/落盘的 incident 写入器按一域一文件拆出）。
 *
 * 内容纪律与拆分前逐字一致（R3 阶段 1，技能 S-7 修复）：事故记录只陈述**回读到的
 * 真实级别**，绝不声称未发生的降级——记录与效果不得解耦。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import type { BreakerResult } from './autonomyGovernor.ts';
import type { AutonomyBand } from './trustModel.ts';

export interface FallbackIncidentInput {
  currentBand: AutonomyBand;
  targetBand: AutonomyBand;
  ok: boolean;
  observedBand: AutonomyBand | null;
  reason: string;
  tripped: BreakerResult[];
}

/** 写一份熔断回退事故记录，返回文件路径。 */
export function writeFallbackIncident(workspaceRoot: string, result: FallbackIncidentInput): string {
  const incidentsDir = join(workspaceRoot, '.cycles', 'incidents');
  if (!existsSync(incidentsDir)) mkdirSync(incidentsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const incidentPath = join(incidentsDir, `incident-auto-fallback-${timestamp}.md`);
  const triggeredStr = result.tripped
    .map((b) => `- ${b.id}: ${b.detail}`)
    .join('\n');
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
