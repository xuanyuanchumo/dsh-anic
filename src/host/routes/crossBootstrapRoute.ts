/**
 * 跨工作区自举路由（cycle-89 · 「举他」）—— `POST /anic/self/bootstrap-other`。
 *
 * ## 端点契约
 *
 * ```
 * POST /anic/self/bootstrap-other
 * { "targetWorkspace": "D:/projects/other", "action": "evaluate" | "gate-check" | "init" }
 * ```
 *
 * 响应包含 **源零写入凭据**：`sourceFingerprint`（调用前）与 `sourceFingerprintAfter`
 * （调用后）—— 两者相同即证明源工作区未被触碰。**不**返回「我保证没写」这种自述。
 *
 * ## cycle-96：本文件只做 HTTP 装配，动作实现在 `runtime/crossBootstrapExecute.ts`
 *
 * 为什么搬走（不是行数问题）：`anic_bootstrap_other` 工具（cycle-96 WS-B）要在
 * **同一个语义**上跑同一套动作。若工具另写一份，「HTTP 举他」与「工具举他」就会
 * 向坏方向漂移——而它们本应是同一件事。执行体移到 runtime/ 是因为工具与路由都是
 * 上层装配，两者都应向下依赖执行层（若执行体留在 routes/，工具就得反向依赖 routes）。
 *
 * 本文件**不再**持有任何动作逻辑：解析、指纹、三态解析、状态落盘全在执行体里。
 * 行为不变性由执行体直接产出 `{ status, body }`（原样的状态码与响应键）来保证——
 * 这里连键名都不用抄，所以这次重构**不可能**静默改变 HTTP 语义。
 *
 * ## 为什么指纹只覆盖 `.cycles/**`
 *
 * 见 `runtime/crossBootstrap.ts` 的说明：整个工作区指纹会把 `node_modules/`
 * 算进来，既慢又会被无关改动污染断言。而跨项目自举**只可能**写 `.cycles/**`，
 * 覆盖它就足够精确地证明「源没被写」。
 *
 * ## 三个动作
 *
 * - `init`：在目标上初始化 `.cycles/` 骨架（不跑评估）。目标没装技能时也能跑
 *   —— 这正是「先把流程搭起来」的语义。
 * - `evaluate`：在目标上跑一次 eval-runner。
 * - `gate-check`：在目标上跑一次 gate-check。
 *
 * 默认 `evaluate`。
 */
import type { SnapshotCtx } from '../snapshotRoute.ts';
import { resolveWorkspaceRoots } from '../snapshotRoute.ts';
import { readBody, type RouteReq } from './routeContext.ts';
import type { SendFn } from './selfBootstrapShared.ts';
import { runCrossBootstrap } from '../runtime/crossBootstrapExecute.ts';

/** 注册跨项目自举路由。 */
export function registerCrossBootstrapRoute(
  ctx: SnapshotCtx,
  send: SendFn,
): Array<(() => void) | null> {
  const ws = ctx.webServer;
  if (!ws?.register) return [];

  const reg = (p: string, handler: (req: RouteReq, res: unknown) => void) => {
    const d = ws.register!({ kind: 'exact', path: p, handler: handler as (req: unknown, res: unknown) => void });
    return typeof d === 'function' ? d : null;
  };

  return [
    reg('/anic/self/bootstrap-other', (req, res) => {
      void readBody(req).then((body) => {
        // 源工作区 = 宿主当前工作区（我们要证明「它没被写」）。
        let sourceRoot: string | null = null;
        try {
          sourceRoot = resolveWorkspaceRoots(ctx);
        } catch {
          // 解析不到源 ⇒ 指纹与断言退化为 null（如实降级，不伪造 true）。
          sourceRoot = null;
        }
        const targetWorkspace = typeof body['targetWorkspace'] === 'string' ? body['targetWorkspace'] : '';
        const action = typeof body['action'] === 'string' ? body['action'] : 'evaluate';
        const r = runCrossBootstrap({ sourceRoot, targetWorkspace, action });
        send(res, r.status, r.body);
      });
    }),
  ];
}
