/**
 * 归档治理 HTTP 面（cycle-83 · 产物治理）：基线重置 + 归档盘点。
 *
 *   POST /anic/api/archive/baseline    body `{dryRun?, includeIncomplete?, actor?}` → 预览或真写
 *   GET  /anic/api/archive/inventory   活跃/归档清单 + 体积 + 可归档判定
 *
 * ## 两段式（预览 == 执行）
 *
 * `dryRun` 与真写**共用同一条判据**（`runtime/artifactArchive.archiveBaseline` 的同一个
 * 函数，只差一个布尔）。预览说"要归档这 76 个、留下这 4 个（原因逐个点名）"，执行就
 * 必须完全照做——若两段各写一套判据，预览就退化成"看起来会发生什么"的装饰。
 *
 * ## 参数校验必须**先于**副作用（本文件最容易写错的一处）
 *
 * 写开关若给了非布尔值（`"true"` 字符串、数字 1），有两种可能的处置：
 *   a) 宽松解析成 true —— 一个拼错的客户端就能触发真写；
 *   b) 400 拒绝 —— 但**必须在** `archiveBaseline` 之前拒绝。
 * 本文件第一版把校验写在了执行之后：`dryRun: "yes"` 会被 `boolOf` 读成 false ⇒ 真写
 * 发生 ⇒ 然后才 400。响应说"参数错误"而磁盘已经动了，这是最坏的一种形态
 * （错误报告掩盖已生效的副作用）。现在校验是**纯前置**的。
 *
 * ## 为什么这两个端点必须显式声明"通道独占"
 *
 * 本仓闭环体检有**未声明棘轮**（`closureAuditContract` ③）：新增的未消费路由必须补
 * owner/docRef/reason 声明，否则红。这两条路由的消费者是运维/面板按钮，本仓代码里
 * 不会有自调点——所以它们是通道独占，声明表需同步补两条（见汇报）。
 *
 * ## 安全面
 *
 * 写动作只在**工作区自身**的 `.cycles/` 内移动目录（`cyclesDir` 由共享选择器解析：
 * X-ANIC-Workspace 头 / `?workspace=` 与 registry 同一校验）。路径绝不来自请求体
 * ——那会把请求体变成任意路径写入口。响应体不含绝对路径。
 */
import { join } from 'node:path';
import type { SnapshotCtx } from '../snapshotRoute.ts';
import { type RouteReq, readBody } from './routeContext.ts';
import {
  archiveBaseline,
  isCycleCompleteForArchive,
  listActiveCycles,
  listArchivedCycles,
  readManifest,
  type BaselineOptions,
} from '../runtime/artifactArchive.ts';

type SendFn = (res: unknown, status: number, body: unknown, requestId?: string) => void;

export const ARCHIVE_BASELINE_ROUTE = '/anic/api/archive/baseline';
export const ARCHIVE_INVENTORY_ROUTE = '/anic/api/archive/inventory';

export interface ArchiveRouteDeps {
  send: SendFn;
  /** 共享工作区解析（含 X-ANIC-Workspace 头；缺省 null = 无工作区）。 */
  getWorkspaceRoot: (req?: unknown) => string | null;
}

/** 严格的布尔读取：只认 `true`。其余一律 false（**宽松解析会打开写动作**）。 */
function boolOf(v: unknown): boolean {
  return v === true;
}

/** 前置参数校验：返回 null = 合法；否则一句人话（400 用）。 */
function validateBaselineBody(parsed: Record<string, unknown>): string | null {
  if (parsed.dryRun !== undefined && typeof parsed.dryRun !== 'boolean') {
    return `dryRun must be boolean (got ${typeof parsed.dryRun})`;
  }
  if (parsed.includeIncomplete !== undefined && typeof parsed.includeIncomplete !== 'boolean') {
    return `includeIncomplete must be boolean (got ${typeof parsed.includeIncomplete})`;
  }
  if (parsed.actor !== undefined && typeof parsed.actor !== 'string') {
    return `actor must be string (got ${typeof parsed.actor})`;
  }
  return null;
}

/** 盘点一条轮次的可归档判定（与归档执行**同一判据**，不另写一套）。 */
function inventoryOf(cyclesDir: string): {
  active: Array<{ name: string; files: number; bytes: number; complete: boolean; reason: string | null }>;
  archived: Array<{ name: string; files: number; bytes: number; archivedAt: string }>;
  sizes: { activeBytes: number; archivedBytes: number };
  archivable: number;
  blocked: number;
  manifest: ReturnType<typeof readManifest>;
} {
  const active = listActiveCycles(cyclesDir).map((c) => {
    const v = isCycleCompleteForArchive(cyclesDir, c.name);
    return { name: c.name, files: c.files, bytes: c.bytes, complete: v.complete, reason: v.reason ?? null };
  });
  const archived = listArchivedCycles(cyclesDir).map((c) => ({
    name: c.name, files: c.files, bytes: c.bytes, archivedAt: c.archivedAt,
  }));
  return {
    active,
    archived,
    sizes: {
      activeBytes: active.reduce((n, c) => n + c.bytes, 0),
      archivedBytes: archived.reduce((n, c) => n + c.bytes, 0),
    },
    archivable: active.filter((c) => c.complete).length,
    blocked: active.filter((c) => !c.complete).length,
    manifest: readManifest(cyclesDir),
  };
}

/** 注册两条归档路由（返回 disposer 数组，与既有路由注册形态一致）。 */
export function registerArchiveResetRoute(ctx: unknown, deps: ArchiveRouteDeps): Array<(() => void) | null> {
  const c = ctx as SnapshotCtx;
  if (!c.webServer || typeof c.webServer.register !== 'function') return [];
  const { send, getWorkspaceRoot } = deps;
  // register 的返回是 `void | (() => void)`（宿主可能不返回 disposer）：
  // 显式归一成 `(() => void) | null`，与聚合器的 disposal 数组类型一致。
  const keep = (d: void | (() => void)): (() => void) | null => (typeof d === 'function' ? d : null);

  const baselineDisposer = c.webServer.register({
    kind: 'exact',
    path: ARCHIVE_BASELINE_ROUTE,
    handler: (req: unknown, res: unknown) => {
      void readBody(req as RouteReq).then((parsed) => {
        const root = getWorkspaceRoot(req);
        if (!root) { send(res, 404, { error: 'no workspace' }); return; }
        // ★校验先于一切副作用（见文件头"参数校验必须先于副作用"）。
        const invalid = validateBaselineBody(parsed);
        if (invalid !== null) { send(res, 400, { error: invalid }); return; }
        const cyclesDir = join(root, '.cycles');
        const opts: BaselineOptions = {
          dryRun: boolOf(parsed.dryRun),
          includeIncomplete: boolOf(parsed.includeIncomplete),
          // 执行者标识进审计记录（谁按的按钮）；缺省走模块名。
          ...(typeof parsed.actor === 'string' && parsed.actor !== '' ? { actor: parsed.actor } : {}),
        };
        send(res, 200, archiveBaseline(cyclesDir, opts));
      });
    },
  });

  const inventoryDisposer = c.webServer.register({
    kind: 'exact',
    path: ARCHIVE_INVENTORY_ROUTE,
    handler: (req: unknown, res: unknown) => {
      const root = getWorkspaceRoot(req);
      if (!root) { send(res, 404, { error: 'no workspace' }); return; }
      send(res, 200, inventoryOf(join(root, '.cycles')));
    },
  });

  return [keep(baselineDisposer), keep(inventoryDisposer)];
}
