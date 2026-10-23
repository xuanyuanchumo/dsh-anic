/**
 * 按需加载接线的**运行时装配**（cycle-74 T-7406 / T-7408）。
 *
 * 职责边界：把「agent 工作区 → 配置 → 索引制品 → 接线」串起来；判定与施加披露的
 * **纯逻辑**在 toolDisclosureWiring.ts（可单测），本模块只做 IO 与降级。
 *
 * **为什么按 agent 解析（cycle-74 实测修正）**：本插件单实例服务**多工作区**，
 * 且 `apply` 时可能尚无会话。若在 apply 时解析一次，会把 A 项目的模式误施加到
 * B 项目的 agent，或直接解析失败使 indexed 永不激活（注册了但没人消费）。
 * 故改为：每个 `agent/created` 用**该 agent 自己的** `session.header.cwd` 解析。
 *
 * 失败面（全部 fail-closed 到 full，**绝不错配、绝不半途遮蔽**）：
 *   - agent 无 cwd ⇒ full；
 *   - 读不到配置 ⇒ full；
 *   - 索引制品缺失 / 不可解析 ⇒ full 并记日志（不猜索引，INV-27 宁缺勿猜）；
 *   - 加载器未注册 / 宿主无 scoped restrict ⇒ full（见 toolDisclosureWiring 判定）。
 */
import { join } from 'node:path';
import { createScoped } from './logger.ts';
import { pluginAssetDir } from './pluginRoot.ts';
import { loadWorkspaceConfig } from './config.ts';
import { loadInjectedIndex } from './capabilityIndexRuntime.ts';
import { captureRegisteredFaces } from './toolsFaceCapture.ts';
import { wireToolDisclosure, rootOfAgent } from './toolDisclosureWiring.ts';
import type { AgentDisclosure } from './toolDisclosureWiring.ts';
import type { CapabilityIndexInjectable } from './capabilityIndex.ts';

const log = createScoped('anic:tool-disclosure');

/** 按工作区解析披露（带进程内缓存：索引制品是静态资产，同一工作区只读一次）。 */
function makeResolver() {
  const byRoot = new Map<string, AgentDisclosure>();
  const indexDir = pluginAssetDir('index');
  let indexCache: CapabilityIndexInjectable | null | undefined;
  const loadIndex = (): CapabilityIndexInjectable | null => {
    if (indexCache !== undefined) return indexCache;
    indexCache = indexDir ? (loadInjectedIndex(indexDir) as CapabilityIndexInjectable | null) : null;
    if (!indexCache) log.warn('capability-index.json missing/unparsable — indexed unavailable, staying full');
    return indexCache;
  };
  return (agent: unknown): AgentDisclosure => {
    const root = rootOfAgent(agent);
    if (!root) return { mode: 'full', index: null };
    const cached = byRoot.get(root);
    if (cached) return cached;
    let mode: 'full' | 'indexed' = 'full';
    try { mode = loadWorkspaceConfig(join(root, '.cycles')).values.toolDisclosure; } catch { mode = 'full'; }
    const decision: AgentDisclosure = mode === 'indexed'
      ? { mode: 'indexed', index: loadIndex() }
      : { mode: 'full', index: null };
    byRoot.set(root, decision);
    return decision;
  };
}

/**
 * 装配工具面披露接线。**总是**注册 per-agent 解析器（各 agent 按其工作区决定 full/indexed）。
 *
 * 返回接线结果供探针/日志如实上报。注意：本函数在 apply 时被调，
 * 但**真正的 mode 判定发生在每个 agent 创建时**（见上）。
 */
export function wireToolDisclosureFromConfig(ctx: unknown): { wired: boolean; reason: string; denyCount: number } {
  const ids = captureRegisteredFaces().map((f) => f.name);
  const out = wireToolDisclosure(ctx, {
    mode: 'full', // 全局默认；真实模式由 resolveForAgent 按 agent 工作区给出
    index: null,
    allToolIds: ids,
    resolveForAgent: makeResolver(),
  });
  log[out.wired ? 'info' : 'warn']('tool disclosure wiring: ' + out.reason);
  return out;
}
