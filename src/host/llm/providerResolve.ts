/**
 * 宿主 provider / model 解析（cycle-9 从 reviewEngine.ts 拆出，T3 模块纪律）。
 *
 * 真机取证背景：宿主 LLM 注册表里没有 'default' 这个 provider id，模型目录里
 * 也没有 'default' 模型——字面兜底值只作为「显式失败」的诚实锚点，真正的默认
 * 应该来自宿主注册表（listProviders 首条）与模型目录（listModels 首条）。
 */

import type { LlmRuntime } from './reviewEngine.ts';

/**
 * 选默认 provider：显式指定 > 宿主注册表首条 > 字面 'default'。
 * （'default' 会让流静默返回空——真机上 22 个路由全是有名 id。）
 */
export function pickProvider(runtime: LlmRuntime | null, requested?: string): string {
  if (typeof requested === 'string' && requested.length > 0) return requested;
  try {
    const first = runtime?.listProviders()[0];
    if (first !== undefined && typeof first.id === 'string' && first.id.length > 0) return first.id;
  } catch { /* 探测失败走兜底 */ }
  return 'default';
}

/**
 * 解析默认模型：显式指定 > provider 模型目录首条 > 字面 'default'。
 * 目录不可得/为空 → 保持 'default'（由宿主给出诚实错误，ANIC 不猜）。
 */
export async function resolveModel(runtime: LlmRuntime | null, provider: string, requested?: string): Promise<string> {
  if (typeof requested === 'string' && requested.length > 0) return requested;
  try {
    if (runtime?.listModels !== undefined && provider !== 'default') {
      const models = await runtime.listModels(provider);
      const first = models.find((m) => typeof m?.id === 'string' && m.id.length > 0);
      if (first?.id) return first.id;
    }
  } catch { /* 目录不可得 → 走兜底 */ }
  return 'default';
}
