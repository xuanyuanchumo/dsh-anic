/**
 * 自举路由共享上下文（cycle-72 T3 拆分：四条端点共用同一份「解析 + 前置守卫」）。
 *
 * 为什么单独成模块：三个自举端点（evaluate / gate-check / iterate）此前各自复制
 * 了同一段「解析工作区 → 找技能目录 → 缺失即报错」代码。加入前置守卫后这段变成
 * 五步，再复制三份就是 CLAUDE.md 明令禁止的「同一语义多条数据路径」。这里收成
 * 唯一实现，端点只按「拿到 target → 干活」写。
 */
import path from 'node:path';
import type { SnapshotCtx } from '../snapshotRoute.ts';
import { anicError } from './envelope.ts';
import { resolveWorkspaceRoots } from '../snapshotRoute.ts';
import { resolveSkillScriptsDir } from '../skillInvoker.ts';
import { checkBootstrapPreconditions } from '../runtime/bootstrapPreflight.ts';

export type SendFn = (res: unknown, code: number, body: unknown, requestId?: string) => void;

/** 已就绪的自举靶标：工作区、状态目录、技能脚本目录。 */
export interface SelfTarget {
  roots: string;
  cyclesDir: string;
  scriptsDir: string;
}

/**
 * 解析靶标；任一步失败即**自行**发送错误响应并返回 null（调用方直接 return）。
 *
 * ## cycle-112 修复：`req` 必须透传（跨项目污染实测）
 *
 * 被守卫缺陷：本函数此前只收 `(ctx, send, res)`，内部调
 * `resolveWorkspaceRoots(ctx)` **不带请求** ⇒ 头/查询/会话三种工作区选择器
 * （快照路由头注钉死的优先级链）全部失效，回落 registry/sessions/cwd 的第一个
 * 工作区。真机实证：`GET /anic/self/status?workspace=<本仓>` 返回 `cycle-9 /
 * archived 7 / stale=true`——那是**另一个项目**的自举状态；面板「闭环与自举」
 * 域因此长期误报，且属于用户明令禁止的「不同项目隔离显示不能污染」形态。
 *
 * 修法：`req` 作为可选第四参透传（旧调用面零变更），由调用方把请求对象递进来。
 * 头/查询/会话链**只保留一份实现**（resolveWorkspaceRoots），本层不另算。
 *
 * 技能目录缺失在本层就报 404（而非留给前置守卫报 412）：它是**安装问题**，
 * 与「装了但缺 .cycles 配置」是两类不同修复动作，混在同一个码里会让调用方
 * 分不清该去装技能还是该去跑 init-workflow。
 */
export function resolveSelfTarget(ctx: SnapshotCtx, send: SendFn, res: unknown, req?: unknown): SelfTarget | null {
  const roots = resolveWorkspaceRoots(ctx, req);
  if (!roots) {
    send(res, 500, anicError('ANIC_ROUTE_NO_WORKSPACE', 'no workspace'));
    return null;
  }
  const cyclesDir = path.join(roots, '.cycles');
  const scriptsDir = resolveSkillScriptsDir(roots);
  if (!scriptsDir) {
    send(res, 404, anicError('ANIC_SKILL_UNKNOWN_SCRIPT', 'skill scripts not found (run anic_install first)'));
    return null;
  }
  return { roots, cyclesDir, scriptsDir };
}

/**
 * 前置守卫；未就绪即发送 412 并返回 false。
 *
 * 用 412 Precondition Failed 而不是 200 + evalScore 0：本修复的要点正是
 * **不得**把「环境未就绪」折叠成「评估未过」。HTTP 码是调用方最先看到的事实，
 * 若这里也返回 200，折叠就从脚本层上移到了路由层，问题原样保留。
 */
export function guardPreconditions(target: SelfTarget, send: SendFn, res: unknown): boolean {
  const pre = checkBootstrapPreconditions(target.scriptsDir, target.cyclesDir);
  if (pre.ok) return true;
  send(res, 412, {
    error: {
      code: 'ANIC_BOOTSTRAP_PRECONDITION',
      preconditionCode: pre.code,
      message: pre.message,
      remedy: pre.remedy,
    },
  });
  return false;
}
