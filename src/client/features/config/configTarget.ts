/**
 * 配置分区的数据腿（cycle-82）—— GET 轮询 target + POST 动作两半。
 *
 * ## 为什么 GET 进 4s 档而不是一次性档
 *
 * 配置是**别人也会改**的事实：技能脚本（`init-workflow` / `autonomy_upgrade`）
 * 会原地改写 `config.yml`。一次性拉取会让面板长期显示旧值，用户按下保存时
 * 覆盖掉脚本刚写的东西——「改回去了但没人知道」。
 * 4s 档 + `applyConfig` 的草稿合并不变量（见 panelActions.applyConfig）让：
 *   - 用户没动过的字段跟着新事实走；
 *   - 用户改了一半的字段不被擦掉；
 *   - 面板永远知道「磁盘现在是什么」。
 *
 * ETag 条件请求在 `usePanelFetch` 里统一处理：配置未变时 304 短路，
 * 每拍的成本只是一次空响应——这条让"4s 轮询一个配置文件"变得合理。
 *
 * ## 为什么 POST 不在 target 里
 *
 * target 是**只读轮询**的形状（url + guard + apply）；写是用户点按钮触发的一次性
 * 动作，语义与节奏都不同。硬塞进 target 会让它每次 tick 都带一个永远不会被调用的
 * method 分支。故写路径单独一个函数，由分区组件在点击时调用。
 *
 * ## dryRun 与真写共用 POST
 *
 * 预览差异 = `POST {patch, dryRun:true}`，保存 = `POST {patch}`。服务端两条走同一个
 * `planPatch`（见 configRoute 的注释），所以"预览说改 1 行"与实际"改了 1 行"不可能分家。
 */
import type { PanelFetchTarget } from '../../components/usePanelFetch.ts';
import {
  CONFIG_URL, isConfigJson, isConfigWriteJson,
  draftToPatchValue, type ConfigFieldJson, type ConfigJson, type ConfigWriteJson,
} from './configTypes.ts';

/** 一拍的配置 GET target（形状守卫不过 → malformed，分区显示失败行而非假表单）。 */
export function configTarget(
  onConfig: (v: ConfigJson) => void,
  onFail: (message: string) => void,
  onRecover: () => void,
): PanelFetchTarget {
  return {
    url: CONFIG_URL,
    guard: isConfigJson,
    apply: (v) => { onConfig(v as ConfigJson); },
    onFail: (f) => {
      // 三分类在这里不需要细分成三句文案：配置分区的失败行只需要"取不到/不可信"，
      // 具体是 HTTP 还是畸形，写进括号里就够（多三句文案换不来更多可操作性）。
      onFail(f.kind === 'http' ? `HTTP ${String(f.status)}` : f.kind === 'malformed' ? 'malformed' : f.message);
    },
    onRecover: onRecover,
  };
}

/** 草稿 → patch（只提交**真正改动过**的字段；未动字段不出现在 patch 里）。 */
export function draftsToPatch(
  schema: ConfigFieldJson[],
  values: Record<string, unknown>,
  drafts: Record<string, string | boolean>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of schema) {
    const draft = drafts[field.id];
    if (draft === undefined) continue;
    const next = draftToPatchValue(field, draft);
    const prev = values[field.id];
    // 与服务端值相同的草稿不进 patch：把"没改"提交上去会让 changedFields 虚高，
    // 用户在预览里看到一堆"要改"的行，实际一行都没变。
    if (JSON.stringify(next) === JSON.stringify(prev)) continue;
    patch[field.id] = next;
  }
  return patch;
}

/** POST 结果（网络失败也归一成 ConfigWriteJson，让渲染层只有一条形状）。 */
export interface ConfigSubmitResult {
  /** 形状合法的响应体；网络/解析失败时为 null。 */
  body: ConfigWriteJson | null;
  /** 非 null = 传输出错（与 body.ok=false 是两回事：一个是没谈到，一个是谈了被拒）。 */
  error: string | null;
}

/**
 * 提交 patch（dryRun=true 只预览）。
 *
 * 任何失败都返回 `{body:null, error}` 而**不抛**：调用方（动作层）要写的是
 * "写失败"这个状态，不是未捕获异常。抛出会让 React 事件处理器里的错误
 * 冒到全局，用户看到的是白屏而不是一句原因。
 */
export async function submitConfigPatch(
  patch: Record<string, unknown>,
  dryRun: boolean,
): Promise<ConfigSubmitResult> {
  try {
    const res = await fetch(CONFIG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ patch, dryRun }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (isConfigWriteJson(json)) {
      // 服务端在 4xx/5xx 时也回同形状（ok=false + error）——形状合法即采信。
      return { body: json, error: null };
    }
    return { body: null, error: `HTTP ${String(res.status)}` };
  } catch (e) {
    return { body: null, error: e instanceof Error ? e.message : String(e) };
  }
}
