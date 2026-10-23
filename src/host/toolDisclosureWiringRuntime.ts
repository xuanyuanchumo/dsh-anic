/**
 * 按需加载接线的**运行时装配**（cycle-74 T-7406）。
 *
 * 职责边界：把「配置 → 索引制品 → 接线」三步串起来；判定与施加披露的**纯逻辑**
 * 在 toolDisclosureWiring.ts（可单测），本模块只做 IO 与降级。
 *
 * 失败面（全部 fail-closed 到 full，绝不半途遮蔽）：
 *   - 读不到配置 / 工作区 ⇒ full；
 *   - 索引制品缺失或不可解析 ⇒ full 并记日志（**不猜索引**，INV-27 宁缺勿猜）；
 *   - 加载器未注册 / 宿主无 restrict ⇒ full（见 toolDisclosureWiring 的判定）。
 */
import { join } from 'node:path';
import { createScoped } from './logger.ts';
import { pluginAssetDir } from './pluginRoot.ts';
import { loadWorkspaceConfig } from './config.ts';
import { loadInjectedIndex } from './capabilityIndexRuntime.ts';
import { captureRegisteredFaces } from './toolsFaceCapture.ts';
import { wireToolDisclosure } from './toolDisclosureWiring.ts';
import type { CapabilityIndexInjectable } from './capabilityIndex.ts';

const log = createScoped('anic:tool-disclosure');

/** 最小宿主面（本地窄化）。 */
interface CtxLike {
  get?: <T = unknown>(key: string, strict?: boolean) => T | undefined;
  workspaceRegistry?: { list?: () => Array<{ path?: string }> };
  on?: unknown;
}

/** 尽力解析工作区根（与 registerAnicTools 同口径的轻量版；失败返回 null）。 */
function firstWorkspace(ctx: CtxLike): string | null {
  try {
    const roots = ctx.get?.<{ list?: () => Array<{ path?: string }> }>('workspaceRegistry', false)?.list?.()
      ?? ctx.workspaceRegistry?.list?.()
      ?? [];
    const p = roots.find((r) => r && r.path)?.path;
    return typeof p === 'string' ? p : null;
  } catch { return null; }
}

/**
 * 依配置装配工具面披露接线。返回接线结果（调用方/探针可据此如实上报）。
 *
 * 默认（无配置或 mode≠indexed）**不注册任何监听器** —— 零行为变更。
 */
export function wireToolDisclosureFromConfig(ctx: unknown): { wired: boolean; reason: string; denyCount: number } {
  const c = ctx as CtxLike;
  const root = firstWorkspace(c);
  if (!root) return { wired: false, reason: 'no workspace resolvable — stay full', denyCount: 0 };
  let mode: unknown = 'full';
  try { mode = loadWorkspaceConfig(join(root, '.cycles')).values.toolDisclosure; } catch { mode = 'full'; }
  if (mode !== 'indexed') return { wired: false, reason: 'mode=full (default)', denyCount: 0 };
  const indexDir = pluginAssetDir('index');
  const index = indexDir ? (loadInjectedIndex(indexDir) as CapabilityIndexInjectable | null) : null;
  if (!index) {
    log.warn('indexed requested but capability-index.json missing/unparsable — staying full (no guessing)');
    return { wired: false, reason: 'index artifact missing — stay full', denyCount: 0 };
  }
  const ids = captureRegisteredFaces().map((f) => f.name);
  const out = wireToolDisclosure(ctx, { mode, index, allToolIds: ids });
  log[out.wired ? 'info' : 'warn']('tool disclosure: ' + out.reason);
  return out;
}
