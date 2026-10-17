/**
 * 流程投影持久化（L2 store）—— 唯一写者模式。
 *
 * 投影纪律（R3 架构契约，INV-22）：
 *  - 投影文件 .cycles/flows/<flowId>.json 是**可丢弃缓存**：删除后由 replay(events)
 *    完整重建（gateFlow 测试钉死 replay === online）。
 *  - 禁止读投影当真相：加载方必须能随时用事件序列覆盖投影结果。
 *  - 唯一写者：saveFlowProjection 是本插件内唯一写投影的函数（原子写，
 *    write-then-rename，shared/fs-safe）。
 *  - 写入时盖 ledgerHead 指纹：下游可用 isProjectionStale 检测「账本已推进、
 *    投影落后」的窗口（提示重算，而非信任旧值）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../shared/fs-safe.ts';
import type { FlowRuntimeState, FlowState } from './contracts.ts';

/** 投影目录（相对 .cycles/）。 */
export const FLOWS_PROJECTION_DIR = 'flows';

/** 投影文件路径：.cycles/flows/<flowId>.json（flowId 含非法路径字符时由调用方保证）。 */
export function flowProjectionPath(cyclesDir: string, flowId: string): string {
  return join(cyclesDir, FLOWS_PROJECTION_DIR, `${flowId}.json`);
}

/** 读投影（缺失/损坏 → null，不 throw —— 投影本来就是可丢弃的）。 */
export function loadFlowProjection<S extends FlowState>(
  cyclesDir: string,
  flowId: string,
): FlowRuntimeState<S> | null {
  const p = flowProjectionPath(cyclesDir, flowId);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as FlowRuntimeState<S>;
    if (raw?.flowId !== flowId || typeof raw.current !== 'string' || !Array.isArray(raw.history)) {
      return null; // 形状不对 = 当作不存在（fail-safe，绝不部分采信）
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * 写投影（唯一写者；原子写）。目录不存在时创建。
 * 注意：只写完整运行态 —— 不做增量合并（合并 = 第二份真相逻辑）。
 */
export function saveFlowProjection<S extends FlowState>(cyclesDir: string, state: FlowRuntimeState<S>): void {
  const p = flowProjectionPath(cyclesDir, state.flowId);
  const dir = join(p, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(p, JSON.stringify(state, null, 2));
}

/** 投影是否落后于账本链头（落后 = 应 replay 重建，而不是采信旧投影）。 */
export function isProjectionStale(
  projection: FlowRuntimeState | null,
  currentLedgerHead: string | null,
): boolean {
  if (!projection) return false; // 没有投影不存在「落后」
  if (currentLedgerHead === null) return false; // 无账本流程（persistence none/projection-only）
  return projection.ledgerHead !== currentLedgerHead;
}
