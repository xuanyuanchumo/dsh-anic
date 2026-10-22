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
 * 技能目录缺失在本层就报 404（而非留给前置守卫报 412）：它是**安装问题**，
 * 与「装了但缺 .cycles 配置」是两类不同修复动作，混在同一个码里会让调用方
 * 分不清该去装技能还是该去跑 init-workflow。
 */
export function resolveSelfTarget(ctx: SnapshotCtx, send: SendFn, res: unknown): SelfTarget | null {
  const roots = resolveWorkspaceRoots(ctx);
  if (!roots) {
    send(res, 500, { error: { code: 'ANIC_ROUTE_NO_WORKSPACE', message: 'no workspace' } });
    return null;
  }
  const cyclesDir = path.join(roots, '.cycles');
  const scriptsDir = resolveSkillScriptsDir(roots);
  if (!scriptsDir) {
    send(res, 404, { error: { code: 'ANIC_SKILL_NOT_INSTALLED', message: 'skill scripts not found' } });
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
