/**
 * 工作区层**功能开关**的宿主侧读取（cycle-91）。
 *
 * ## 为什么需要这个文件
 *
 * `src/shared/flows.ts` 的 `resolveFlows` 是**纯函数**（不碰磁盘）——
 * 它回答「给定三层输入，合并结果是什么」。但**读盘**（`.cycles/config.yml`
 * 的 `anic.flow.*` 段）是**宿主侧**的事（`src/host/config.ts` 的
 * `loadWorkspaceConfig` 是唯一入口）。
 *
 * 工具网关需要「按工作区读某个开关的生效值」，而它既不读盘也不该
 * 重复实现 YAML 解析 ⇒ 本文件是那层薄适配。
 *
 * ## 为什么是「读一次，不缓存」
 *
 * 开关值会在**运行期**被改（面板的配置分区可写 `.cycles/config.yml`）。
 * 缓存会让「改了配置但读数不变」——那正是本仓最反对的**陈旧读数**。
 * 每次读一次 YAML 的成本远低于「读到一个错的值」的代价。
 *
 * ## 边界
 *
 * 只读、不写；失败一律回落到 `true`（**fail-safe**：开关读不到时按"开"
 * 处理 ⇒ 功能可用，只是失去了关的能力 —— 与"关错了导致功能不可用"相比，
 * 前者危害更小）。
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveFlows } from '../../shared/flows.ts';
import { loadWorkspaceConfig } from '../config.ts';

/**
 * 读某个开关在**工作区层**的生效值。
 *
 * @param workspaceRoot 工作区根目录
 * @param flowId        开关 id（如 `flow.gateRecord`）
 * @returns 生效值；读不到 / 未配置 ⇒ `true`（fail-safe）
 */
export function workspaceFlowEnabled(workspaceRoot: string, flowId: string): boolean {
  try {
    const cyclesDir = join(workspaceRoot, '.cycles');
    if (!existsSync(cyclesDir)) return true;
    const cfg = loadWorkspaceConfig(cyclesDir);
    const resolved = resolveFlows({ workspace: cfg.values.flowOverrides });
    return resolved.flows[flowId]?.enabled ?? true;
  } catch {
    return true;
  }
}

/**
 * 读某开关的**来源层**（`user` / `workspace` / `deployment` / null）。
 *
 * 供「界面显示来源」用 —— 它回答「这个值是从哪来的」。
 */
export function workspaceFlowSource(workspaceRoot: string, flowId: string): string | null {
  try {
    const cyclesDir = join(workspaceRoot, '.cycles');
    if (!existsSync(cyclesDir)) return null;
    const cfg = loadWorkspaceConfig(cyclesDir);
    const resolved = resolveFlows({ workspace: cfg.values.flowOverrides });
    return resolved.flows[flowId]?.source ?? null;
  } catch {
    return null;
  }
}
