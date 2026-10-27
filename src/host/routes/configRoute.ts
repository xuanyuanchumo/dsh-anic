/**
 * 配置与路径的 HTTP 面（cycle-82）：GET /anic/api/config + POST /anic/api/config。
 *
 * ## 为什么 GET 也返回 schema
 *
 * 客户端只做纯渲染（不引 hooks、不自带字段表）。字段表若在客户端手抄一份，
 * 加了 host 校验忘了改客户端，或反过来，就会出现「表单允许的值被后端拒绝」。
 * 所以 schema 随 values 一起下发——**同一张表**既驱动渲染又驱动校验。
 *
 * ## rawHash 的用途
 *
 * 响应带原文 sha256 前 16 位。客户端保存时可带上它做「基于哪个版本改的」
 * 证据；本轮不做乐观锁（并发写配置是罕见动作，且回读断言已保证最终一致），
 * 但哈希进响应让「你以为改的和实际改的不是同一份」这件事**可被发现**。
 *
 * ## 写侧语义
 *
 * dryRun=true → 只算不写，返回 diff；否则备份 → 原子写 → 回读断言 → 不符回滚。
 * 任何非法字段值一律 400 且**零写入**（半套配置比没改更危险）。
 *
 * ## 自定义路径为什么挂在同一个端点上
 *
 * `GET /anic/api/config?probePath=<相对路径>` 在响应里多带一个 `probe` 字段。
 * 为「校验一条路径」再开第二个路由，等于让零成本动作多一个接线点、多一处
 * 「Lead 忘了接」的风险；而它本来就是同一份路径表的同一类事实。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createScoped, newRequestId } from '../logger.ts';
import { loadWorkspaceConfig } from '../config.ts';
import { configFieldViews, CONFIG_FIELDS } from '../configEdit/configSchema.ts';
import { readFieldValue } from '../configEdit/configRead.ts';
import { planPatch } from '../configEdit/yamlPatch.ts';
import { diffStats, lineDiff } from '../configEdit/yamlDiff.ts';
import { applyConfigPatch, configFileStat, listBackups } from '../configEdit/configWriter.ts';
import { collectPaths, resolveCustomPath } from '../configEdit/paths.ts';
import { readBody, type RouteReq } from './routeContext.ts';

const log = createScoped('anic:route:config');

export const CONFIG_ROUTE = '/anic/api/config';

interface SendFn { (res: unknown, status: number, body: unknown, requestId?: string): void }

/** 读当前值表：字段表逐项回读（缺键 = null，如实标注而不是填默认值）。 */
export function readConfigValues(content: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const def of CONFIG_FIELDS) values[def.id] = readFieldValue(content, def);
  return values;
}

function rawHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
}

/** GET 响应体（客户端 isConfigJson 的形状契约）。 */
function buildGetBody(root: string, probeRaw: string | null) {
  const cyclesDir = join(root, '.cycles');
  const configPath = join(cyclesDir, 'config.yml');
  const probe = probeRaw === null ? null : resolveCustomPath(root, probeRaw);
  const base = {
    workspace: root,
    schema: configFieldViews(),
    paths: collectPaths(root),
    probe,
  };
  if (probeRaw !== null && probe !== null && !probe.ok) {
    // 自定义路径被拒：只回原因，不回任何文件内容（边界即边界）。
    return { ...base, values: {}, warnings: [probe.reason], rawHash: null, configFile: configFileStat(configPath), backups: [] };
  }
  const stat = configFileStat(configPath);
  const warnings: string[] = [];
  if (!stat.exists) {
    warnings.push('.cycles/config.yml 不存在（先跑 init-workflow / 自举）');
    return { ...base, values: {}, warnings, rawHash: null, configFile: stat, backups: [] };
  }
  const content = readFileSync(configPath, 'utf-8');
  // 唯一 loader 的告警（legacy 文件并存 / 未知键）一并透出——写侧与读侧看到同一份事实。
  try {
    const cfg = loadWorkspaceConfig(cyclesDir);
    warnings.push(...cfg.warnings);
    if (cfg.source === 'legacy') warnings.push('当前只有 legacy 的 cycle-config.yml；写侧会拒绝（canonical 缺失）');
  } catch (e) {
    warnings.push(`loader threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    ...base,
    values: readConfigValues(content),
    warnings,
    rawHash: rawHash(content),
    configFile: stat,
    backups: listBackups(cyclesDir),
  };
}

/**
 * POST 响应体。
 *
 * dryRun 的 diff 与真写走**同一个** planPatch：预览不是另一条实现，
 * 而是同一条实现的输出——否则「预览说只改一行」与「实际改了五行」会分家。
 */
function buildPostBody(root: string, body: Record<string, unknown>) {
  const cyclesDir = join(root, '.cycles');
  const configPath = join(cyclesDir, 'config.yml');
  const patch = body.patch;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { status: 400, payload: { error: 'ANIC_CONFIG_BAD_PATCH', message: 'body.patch must be an object of {fieldId: value}' } };
  }
  const dryRun = body.dryRun === true;
  if (!existsSync(configPath)) {
    return { status: 404, payload: { error: 'ANIC_CONFIG_MISSING', message: 'no .cycles/config.yml in this workspace' } };
  }
  const before = readFileSync(configPath, 'utf-8');

  if (dryRun) {
    const plan = planPatch(before, patch as Record<string, unknown>);
    return {
      status: plan.ok ? 200 : 400,
      payload: {
        ok: plan.ok,
        dryRun: true,
        applied: false,
        error: plan.error,
        changedFields: plan.changedFields,
        insertedFields: plan.insertedFields,
        warnings: plan.warnings,
        diff: lineDiff(plan.before, plan.after).filter((d) => d.kind !== 'same'),
        stats: diffStats(plan.before, plan.after),
        beforeHash: rawHash(plan.before),
      },
    };
  }

  const outcome = applyConfigPatch(cyclesDir, patch as Record<string, unknown>);
  const afterContent = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const changed = outcome.changedFields;
  return {
    status: outcome.ok ? 200 : outcome.applied ? 500 : 400,
    payload: {
      ok: outcome.ok,
      dryRun: false,
      applied: outcome.applied,
      error: outcome.error,
      changedFields: changed,
      insertedFields: outcome.insertedFields,
      warnings: outcome.warnings,
      backupPath: outcome.backupPath,
      observed: outcome.observed,
      stats: diffStats(before, afterContent),
      beforeHash: rawHash(before),
      afterHash: outcome.ok ? rawHash(afterContent) : rawHash(before),
    },
  };
}

/** 注册配置路由（GET /anic/api/config、POST /anic/api/config、POST /anic/api/config/path）。 */
export function registerConfigRoute(
  ctx: unknown,
  deps: { send: SendFn; getWorkspaceRoot: (req?: unknown) => string | null },
): Array<(() => void) | null> {
  const ws = (ctx as { webServer?: { register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => (() => void) | void } }).webServer;
  if (!ws || typeof ws.register !== 'function') return [];
  const disposers: Array<(() => void) | null> = [];

  const dispose = ws.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    handler: (req, res) => {
      const requestId = newRequestId();
      const method = (req as { method?: string }).method ?? 'GET';
      const root = deps.getWorkspaceRoot(req);
      if (!root) {
        deps.send(res, 404, { error: { code: 'ANIC_ROUTE_NO_WORKSPACE', message: 'no workspace resolvable' } }, requestId);
        return;
      }
      if (method === 'GET') {
        try {
          const url = (req as { url?: string }).url ?? '';
          const query = new URLSearchParams(url.split('?')[1] ?? '');
          const probeRaw = query.get('probePath');
          deps.send(res, 200, buildGetBody(root, probeRaw), requestId);
        } catch (e) {
          log.error(`config GET failed: ${e instanceof Error ? e.message : String(e)}`, requestId);
          deps.send(res, 500, { error: { code: 'ANIC_CONFIG_READ_FAILED', message: e instanceof Error ? e.message : String(e) } }, requestId);
        }
        return;
      }
      if (method !== 'POST') {
        deps.send(res, 405, { error: 'GET or POST only' }, requestId);
        return;
      }
      // 真实宿主 body 是流式的（P0-BODY）——必须 readBody，直接读 req.body 会静默丢参数。
      void readBody(req as RouteReq).then((body) => {
        try {
          const out = buildPostBody(root, body);
          if (out.status >= 400) log.warn(`config POST rejected: ${out.status}`, requestId);
          deps.send(res, out.status, out.payload, requestId);
        } catch (e) {
          log.error(`config POST failed: ${e instanceof Error ? e.message : String(e)}`, requestId);
          deps.send(res, 500, { error: { code: 'ANIC_CONFIG_WRITE_FAILED', message: e instanceof Error ? e.message : String(e) } }, requestId);
        }
      });
    },
  });
  if (typeof dispose === 'function') disposers.push(dispose);
  return disposers;
}
