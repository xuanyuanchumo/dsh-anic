/**
 * 技能自动安装路由（方案 C）：POST /anic/skill/install + GET /anic/skill/status
 * + POST /anic/skill/repair（eco P0：分发完整性 doctor/repair）。
 *
 * 语义：将内联技能从 dsh-anic/assets/skill/ 复制到工作区 .dsh/skills/。
 * - install：幂等（版本一致 → alreadyInstalled）；安装后写清单并回报 integrity
 * - status：doctor 语义——installed/inline 双版本 + 完整性对比结果
 * - repair：只重装差异文件（缺失/尺寸/哈希），extras 只报告不删除
 * - 安装插件即用：resolveSkillScriptsDir 已有内联兜底，此路由是"显式安装到工作区"
 * - getWorkspaceRoot(req)（cycle-22）：X-ANIC-Workspace 头参与解析（多会话纠偏）——
 *   install/repair 是写侧路由，错工作区代价最高。
 */
import { join } from 'node:path';
import { createScoped, newRequestId } from '../logger.ts';
import { isSkillInstalled, autoInstallSkill, inlineSkillRoot, resolveSkillScriptsDir } from '../skillInvoker.ts';
import { readSkillVersion, verifySkillInstall, repairSkillInstall } from '../skillIntegrity.ts';

const log = createScoped('anic:route:skill-install');
export const SKILL_INSTALL_ROUTE = '/anic/skill/install';
export const SKILL_STATUS_ROUTE = '/anic/skill/status';
export const SKILL_REPAIR_ROUTE = '/anic/skill/repair';

interface SendFn {
  (res: unknown, status: number, body: unknown, requestId?: string): void;
}

/** 注册技能安装路由（install/status/repair）。 */
export function registerSkillInstallRoute(
  ctx: unknown,
  deps: { send: SendFn; getWorkspaceRoot: (req?: unknown) => string | null },
): Array<(() => void) | null> {
  const ws = (ctx as { webServer?: { register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => (() => void) | void } }).webServer;
  if (!ws || typeof ws.register !== 'function') return [];

  const disposers: Array<(() => void) | null> = [];

  // POST /anic/skill/install
  const d1 = ws.register({
    kind: 'exact',
    path: SKILL_INSTALL_ROUTE,
    handler: (req, res) => {
      const requestId = newRequestId();
      const r = req as { method?: string };
      if ((r?.method ?? 'GET') !== 'POST') {
        deps.send(res, 405, { error: 'POST only' }, requestId);
        return;
      }
      const root = deps.getWorkspaceRoot(req);
      if (!root) {
        deps.send(res, 404, { error: { code: 'ANIC_ROUTE_NO_WORKSPACE', message: 'no workspace resolvable' } }, requestId);
        return;
      }
      const alreadyInstalled = isSkillInstalled(root);
      const inlineDir = inlineSkillRoot();
      const inlineVersion = inlineDir ? readSkillVersion(inlineDir) : null;
      const installedVersion = alreadyInstalled ? readSkillVersion(join(root, '.dsh', 'skills', 'ai-native-iteration-cycle')) : null;

      if (alreadyInstalled && inlineVersion && installedVersion && inlineVersion === installedVersion) {
        deps.send(res, 200, {
          alreadyInstalled: true,
          version: installedVersion,
          path: join(root, '.dsh', 'skills', 'ai-native-iteration-cycle'),
          integrity: verifySkillInstall(join(root, '.dsh', 'skills', 'ai-native-iteration-cycle'), inlineDir),
        }, requestId);
        return;
      }

      const result = autoInstallSkill(root);
      if (!result.installed) {
        deps.send(res, 500, { error: { code: 'ANIC_ROUTE_SKILL_INSTALL_FAILED', message: result.error ?? 'unknown error' } }, requestId);
        return;
      }
      log.info(`skill auto-installed to ${result.path}`, requestId);
      deps.send(res, 200, {
        installed: true,
        version: inlineVersion,
        path: result.path,
        upgraded: alreadyInstalled,
        integrity: verifySkillInstall(result.path, inlineDir),
      }, requestId);
    },
  });
  if (typeof d1 === 'function') disposers.push(d1);

  // GET /anic/skill/status
  const d2 = ws.register({
    kind: 'exact',
    path: SKILL_STATUS_ROUTE,
    handler: (req, res) => {
      const requestId = newRequestId();
      const r = req as { method?: string };
      if ((r?.method ?? 'GET') !== 'GET') {
        deps.send(res, 405, { error: 'GET only' }, requestId);
        return;
      }
      const root = deps.getWorkspaceRoot(req);
      if (!root) {
        deps.send(res, 404, { error: { code: 'ANIC_ROUTE_NO_WORKSPACE', message: 'no workspace resolvable' } }, requestId);
        return;
      }
      const installed = isSkillInstalled(root);
      const scriptsDir = resolveSkillScriptsDir(root);
      const inlineDir = inlineSkillRoot();
      const installedDir = join(root, '.dsh', 'skills', 'ai-native-iteration-cycle');
      deps.send(res, 200, {
        installed,
        installedVersion: installed ? readSkillVersion(installedDir) : null,
        scriptsResolved: scriptsDir !== null,
        scriptsSource: scriptsDir,
        inlineAvailable: inlineDir !== null,
        inlineVersion: inlineDir ? readSkillVersion(inlineDir) : null,
        // eco P0：doctor 语义——status 即诊断（不另设 doctor 端点，避免动词通胀）
        integrity: installed ? verifySkillInstall(installedDir, inlineDir) : null,
      }, requestId);
    },
  });
  if (typeof d2 === 'function') disposers.push(d2);

  // POST /anic/skill/repair — eco P0：repair 语义（只重装差异文件）
  const d3 = ws.register({
    kind: 'exact',
    path: SKILL_REPAIR_ROUTE,
    handler: (req, res) => {
      const requestId = newRequestId();
      const r = req as { method?: string };
      if ((r?.method ?? 'GET') !== 'POST') {
        deps.send(res, 405, { error: 'POST only' }, requestId);
        return;
      }
      const root = deps.getWorkspaceRoot(req);
      if (!root) {
        deps.send(res, 404, { error: { code: 'ANIC_ROUTE_NO_WORKSPACE', message: 'no workspace resolvable' } }, requestId);
        return;
      }
      const installedDir = join(root, '.dsh', 'skills', 'ai-native-iteration-cycle');
      const inlineDir = inlineSkillRoot();
      if (!isSkillInstalled(root)) {
        deps.send(res, 404, { error: { code: 'ANIC_ROUTE_SKILL_NOT_INSTALLED', message: 'skill not installed (run install first)' } }, requestId);
        return;
      }
      const result = repairSkillInstall(installedDir, inlineDir);
      log.info(`skill repair: ${result.repaired.length} file(s) re-copied`, requestId);
      deps.send(res, 200, result, requestId);
    },
  });
  if (typeof d3 === 'function') disposers.push(d3);

  return disposers;
}
