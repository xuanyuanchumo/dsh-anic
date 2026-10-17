/**
 * 跨项目调用 → 自举历史回写（G-C5 闭环，docs/anic/15 §5.2）。
 *
 * 设计裁决（cycle-16）：
 * - 跨项目（anic_evaluate /anic/evaluate /anic/iterate）与自举（/anic/self/*）
 *   在 15 号评审里被列为割裂域（G-C5：跨项目结果只随响应返回不落自举状态）。
 * - 本模块是接线层：跨项目评估完成后，把摘要写入插件工作区
 *   `.cycles/self-bootstrap.json` 的 `crossProjectHistory` 数组——
 *   与自举历史（history）并列但**不混入**（自举历史语义是"自我迭代轮次"，
 *   跨项目调用不是轮次，混入会污染轮次计数与 CONVERGED 判定）。
 * - 写入失败响亮降级（响应带 bootstrapSync:'failed' + reason），绝不阻断
 *   主调用结果——接线是增强不是依赖（G-C5 的原始建议也只要求"回写摘要"）。
 * - 单一实现：读/写都走 selfBootstrap.ts 的 load/save（状态文件形状的唯一权威），
 *   本模块只追加 crossProjectHistory 字段（向后兼容：旧文件无此字段时补 []）。
 */

import { join } from 'node:path';
import { loadBootstrapState, saveBootstrapState, type BootstrapState } from './selfBootstrap.ts';

/** 跨项目调用历史条目（摘要形态，非全量 stdout）。 */
export interface CrossProjectEntry {
  timestamp: string;
  /** 触发来源（'evaluate' | 'iterate'，对应两条路由）。 */
  kind: 'evaluate' | 'iterate';
  /** 目标工作区绝对路径（审计可见）。 */
  workspace: string;
  evalScore: number | null;
  gateVerdict: string | null;
}

/** 扩展态：官方 BootstrapState + 跨项目历史（向后兼容可选字段）。 */
export interface BootstrapStateWithCross extends BootstrapState {
  crossProjectHistory?: CrossProjectEntry[];
}

const MAX_CROSS_ENTRIES = 50;

/** 追加一条跨项目历史（滚动保留最近 MAX_CROSS_ENTRIES 条；失败返回原因字符串）。 */
export function appendCrossProjectHistory(
  cyclesDir: string,
  entry: CrossProjectEntry,
): { ok: true } | { ok: false; reason: string } {
  try {
    const state = loadBootstrapState(cyclesDir) as BootstrapStateWithCross;
    const history = Array.isArray(state.crossProjectHistory) ? state.crossProjectHistory : [];
    history.push(entry);
    const next: BootstrapStateWithCross = {
      ...state,
      crossProjectHistory: history.slice(Math.max(0, history.length - MAX_CROSS_ENTRIES)),
    };
    saveBootstrapState(cyclesDir, next);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 读跨项目历史（读侧投影；无字段 = 空数组，不伪造）。 */
export function readCrossProjectHistory(cyclesDir: string): CrossProjectEntry[] {
  try {
    const state = loadBootstrapState(cyclesDir) as BootstrapStateWithCross;
    return Array.isArray(state.crossProjectHistory) ? state.crossProjectHistory : [];
  } catch {
    return [];
  }
}

/** 从跨项目工作区根解析其 .cycles 目录（与路由层 cyclesDir 约定一致）。 */
export function crossCyclesDirOf(workspaceRoot: string): string {
  return join(workspaceRoot, '.cycles');
}
