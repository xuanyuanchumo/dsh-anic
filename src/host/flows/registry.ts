/**
 * FlowRegistry —— 流程描述子注册表（L3，模块级单例）。
 *
 * 约定（对齐 DSH 宿主注册表行为 + KB R12 HMR 安全）：
 *  - 同 id 重复注册：首个胜出 + warn + 返回 no-op disposer（与 ctx.skills.register
 *    同款裁决——胜者无法被后来者顶替，卸载序也不受影响）。
 *  - 注册返回 disposer；插件重载（HMR/热卸载）时旧 fiber 先 dispose 再注册新描述子。
 *  - 注册即静态校验（validateDescriptor）：非法描述子直接拒绝，不让坏描述子
 *    进入运行期（「结构缺陷在加载期爆炸，不在使用期静默漂移」）。
 */
import { createScoped } from '../logger.ts';
import { validateDescriptor } from './machine.ts';
import type { FlowDescriptor, FlowState } from './contracts.ts';

const log = createScoped('anic:flow-registry');

const registry = new Map<string, FlowDescriptor>();

/** 注册流程描述子；返回 disposer（幂等卸载）。非法描述子拒绝注册并返回 null。 */
export function registerFlow<S extends FlowState>(descriptor: FlowDescriptor<S>): (() => void) | null {
  const problems = validateDescriptor(descriptor);
  if (problems.length > 0) {
    log.warn(`流程 ${descriptor.id} 描述子非法，拒绝注册：${problems.join('; ')}`);
    return null;
  }
  if (registry.has(descriptor.id)) {
    log.warn(`流程 ${descriptor.id} 已注册（首个胜出），本次注册为 no-op`);
    return () => undefined;
  }
  registry.set(descriptor.id, descriptor as FlowDescriptor);
  return () => {
    // 只有仍是自己注册的那个实例才移除（防 disposer 误删后注册的同 id 新描述子）
    if (registry.get(descriptor.id) === (descriptor as FlowDescriptor)) registry.delete(descriptor.id);
  };
}

/** 取描述子（未知 id → undefined）。 */
export function getFlow(id: string): FlowDescriptor | undefined {
  return registry.get(id);
}

/** 全部已注册描述子（观测面：GET /anic/flows 消费）。 */
export function listFlows(): FlowDescriptor[] {
  return [...registry.values()];
}

/** 测试专用：清空注册表（生产代码禁用——注册表生命周期跟随插件 fiber）。 */
export function __resetFlowRegistryForTests(): void {
  registry.clear();
}
