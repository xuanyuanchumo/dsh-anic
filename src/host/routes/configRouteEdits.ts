/**
 * 两个新写面的响应体（cycle-83）：`POST /anic/api/config/paths` 与 `POST /anic/api/config/rollback`。
 *
 * ## 为什么都做成「预览-执行两段式」
 *
 * 写操作的正确交互是先让用户看见「将要发生什么」再执行（dsh-ops 的 plan → execute）。
 * config 端点已有 dryRun，这两个新写面必须同款——尤其回滚：它是**覆盖面最大的写**
 * （一次可能改十几个字段），不复用 dryRun 就等于让用户盲点。
 *
 * ## dryRun 与真写共用同一份 plan
 *
 * `planPathOverrides` / `planRollback` 各只有一份实现，dryRun 是它的输出、
 * 真写是它的执行。这样「预览说改 2 条」与「实际改了 2 条」不可能分家
 * （config 端点 cycle-82 已立此裁决，这里只是延续）。
 *
 * ## 回滚的响应必须带「安全备份」路径
 *
 * 回滚不是不可逆操作的前提是：回滚**前**的当前态也落成了 .bak。响应里带
 * `safetyBackupPath` 让用户能立刻回滚回去——这条事实不写出来，用户就永远
 * 不知道还有退路。
 */
import { anicError } from './envelope.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffStats, lineDiff } from '../configEdit/yamlDiff.ts';
import { planPathOverrides, applyPathOverrides, pathsFilePath, PATHS_VERSION } from '../configEdit/pathOverrides.ts';
import { planRollback, rollbackConfig, readbackAfterRollback, listBackupsWithDiff } from '../configEdit/configBackup.ts';
import { collectPaths } from '../configEdit/paths.ts';
import { loadPathOverrides } from '../configEdit/pathOverrides.ts';
import { rawHash } from './configRouteBody.ts';

interface RouteOut { status: number; payload: Record<string, unknown> | ReturnType<typeof anicError> }

/** patch 形状守卫（与 config 端点同款：非对象一律 400 且零写入）。 */
function readPatch(body: Record<string, unknown>): Record<string, unknown> | null {
  const patch = body['patch'];
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return null;
  return patch as Record<string, unknown>;
}

/** `POST /anic/api/config/paths` 响应体。 */
export function buildPathPostBody(root: string, body: Record<string, unknown>): RouteOut {
  const patch = readPatch(body);
  if (patch === null) {
    return { status: 400, payload: anicError('ANIC_CONFIG_BAD_PATCH', 'body.patch must be an object of {pathId: relativePath/null}') };
  }
  const dryRun = body['dryRun'] === true;
  const plan = planPathOverrides(root, patch);
  if (dryRun) {
    return {
      status: plan.ok ? 200 : 400,
      payload: {
        ok: plan.ok, dryRun: true, applied: false, error: plan.error,
        changedIds: plan.changedIds, removedIds: plan.removedIds, warnings: plan.warnings,
        // 预览的 diff 是**表本身**（JSON 一行一条），不是 YAML 行 diff：
        // 用户关心的单位是「evals: .cycles/evals → docs/evals」。
        diff: diffTableRows(plan.next),
        next: plan.next,
      },
    };
  }
  const out = applyPathOverrides(root, patch);
  return {
    status: out.ok ? 200 : out.applied ? 500 : 400,
    payload: {
      ok: out.ok, dryRun: false, applied: out.applied, error: out.error,
      changedIds: out.changedIds, removedIds: out.removedIds, warnings: out.warnings,
      overrides: out.overrides,
      // 写后重新解析整张表：用户要看到的是「现在解析到哪」，不是「我写了什么」。
      paths: collectPaths(root, loadPathOverrides(root)),
    },
  };
}

/** 表状 diff（`id: 旧 → 新`；撤销项标 `(默认)`）。 */
function diffTableRows(next: Record<string, string>): Array<{ id: string; rel: string }> {
  return Object.keys(next).sort().map((id) => ({ id, rel: next[id] as string }));
}

/** `POST /anic/api/config/rollback` 响应体。 */
export function buildRollbackPostBody(root: string, body: Record<string, unknown>): RouteOut {
  const cyclesDir = join(root, '.cycles');
  const backup = body['backup'];
  const dryRun = body['dryRun'] === true;
  const plan = planRollback(cyclesDir, backup);
  if (!plan.ok) return { status: 400, payload: { ok: false, dryRun, applied: false, error: plan.error } };
  const configPath = join(cyclesDir, 'config.yml');
  const current = readFileSync(configPath, 'utf-8');

  if (dryRun) {
    return {
      status: 200,
      payload: {
        ok: true, dryRun: true, applied: false, error: '', backup: plan.name,
        changedFields: plan.changedFields, warnings: plan.warnings,
        diff: lineDiff(current, plan.content).filter((d) => d.kind !== 'same'),
        stats: diffStats(current, plan.content),
        beforeHash: rawHash(current),
        afterHash: rawHash(plan.content),
        backups: listBackupsWithDiff(cyclesDir),
      },
    };
  }

  const out = rollbackConfig(cyclesDir, backup);
  const semantic = readbackAfterRollback(cyclesDir);
  const after = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  return {
    status: out.ok ? 200 : out.applied ? 500 : 400,
    payload: {
      ok: out.ok && semantic.ok, dryRun: false, applied: out.applied,
      error: out.ok ? semantic.error : out.error,
      backup: out.backup,
      changedFields: out.changedFields,
      warnings: [...out.warnings, ...(semantic.ok ? [] : [semantic.error])],
      // 回滚前的当前态落在哪 —— 用户据此能回滚回去（不可逆性的补救）。
      safetyBackupPath: out.safetyBackupPath,
      backupPath: out.backupPath,
      observed: out.observed,
      beforeHash: rawHash(current),
      afterHash: rawHash(after),
      stats: diffStats(current, after),
      backups: listBackupsWithDiff(cyclesDir),
      pathOverridesFile: pathsFilePath(root),
      version: PATHS_VERSION,
    },
  };
}
