/**
 * 真实性审计路由：自举四目标（真实/准确/结构/逻辑）的 HTTP 查询面。
 *
 * GET /anic/api/truth-audit — 运行四维审计，返回逐项结果。
 *
 * P0-DIR-ROOT（cycle-15）：原 `resolve(file, '../../../')` 固定层级推导在
 * dist 单文件布局下解析到仓库父目录（真机 T1-T4 全 MISSING）、源码布局下落
 * 到 src/——两种布局全错。改 resolvePluginRoot() 标记驱动向上查找；解析失败
 * 显式 500，绝不静默审计错误目录。
 */
import { runTruthAudit } from '../evolution/truthAudit.ts';
import { resolvePluginRoot } from '../pluginRoot.ts';

const PLUGIN_DIR = resolvePluginRoot();

/** 注册真实性审计路由（GET /anic/api/truth-audit）。 */
export function registerTruthAuditRoute(
  c: { webServer?: { register(opts: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) | void } },
  send: (res: unknown, code: number, body: unknown, requestId?: string) => void,
): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];
  if (!c.webServer) return disposers;

  const d1 = c.webServer.register({ kind: 'exact', path: '/anic/api/truth-audit', handler: (_req, res) => {
    if (!PLUGIN_DIR) {
      // 根未解析（异常安装形态）——响亮失败，不返回错误目录的审计结果
      send(res, 500, { error: 'PLUGIN_ROOT_UNRESOLVED', message: 'dsh-anic plugin root not found (marker package.json missing)' });
      return;
    }
    const summary = runTruthAudit(PLUGIN_DIR);
    send(res, 200, summary);
  }});
  if (typeof d1 === 'function') disposers.push(d1);

  return disposers;
}
