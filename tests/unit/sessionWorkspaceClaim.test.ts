/**
 * 会话证据链契约（cycle-99 工作区隔离）——「技能面板只看所属会话的工作区」。
 *
 * 三块判据：
 * ① sessionOfReq：X-ANIC-Session 头读取（多值取首、URL 解码容错、缺失 null）；
 * ② workspaceOfSessionClaim：sessions.list() 条目含 id 时按 id 精确映射 cwd，
 *    cwd 过 acceptWorkspace；无 id（宿主代际差异）/无匹配/无 cwd → null 回落；
 * ③ resolveWorkspaceRoots 集成：sessionId 层插在头/查询之后、registry 之前。
 */
import { describe, it, expect } from 'vitest';
import { sessionOfReq, workspaceOfSessionClaim, claimAcceptable } from '../../src/host/runtime/sessionWorkspaceClaim.ts';
import { resolveWorkspaceRoots, type SnapshotCtx } from '../../src/host/snapshotRoute.ts';

/** cycle-99 缓存指纹参与行（期望修正后内容变化 ⇒ Merkle 根变化 ⇒ 缓存必 miss）。 */
const CLAIM_REVISION = 'r2';

void CLAIM_REVISION;

function reqWith(headers: Record<string, string>): unknown {
  return { headers, url: '/anic/api/workflow-snapshot' };
}

describe('cycle-99 会话证据链', () => {
  it('① sessionOfReq：头读取 + 多值取首 + 解码容错', () => {
    expect(sessionOfReq(reqWith({ 'x-anic-session': 's-1' }))).toBe('s-1');
    expect(sessionOfReq(reqWith({ 'x-anic-session': ['s-1', 's-2'] }))).toBe('s-1');
    expect(sessionOfReq(reqWith({}))).toBeNull();
    expect(sessionOfReq(null)).toBeNull();
    expect(sessionOfReq(undefined)).toBeNull();
  });

  it('② 精确映射：id 命中 → cwd 过 accept → 返回；无 id 条目 → null 回落', () => {
    const deps = {
      sessions: {
        list: (): unknown[] => [
          { id: 's-A', header: { cwd: 'D:/proj/a' } },
          { id: 's-B', header: { cwd: 'D:/proj/b' } },
        ],
      },
      acceptWorkspace: (c: string | null): string | null => c, // 测试直通
    };
    expect(workspaceOfSessionClaim(deps, 's-B')).toBe('D:/proj/b');
    // 宿主代际差异：条目无 id → 宁缺勿猜
    const legacy = { sessions: { list: (): unknown[] => [{ header: { cwd: 'D:/proj/a' } }] }, acceptWorkspace: (c: string | null): string | null => c };
    expect(workspaceOfSessionClaim(legacy, 's-A')).toBeNull();
    // 无匹配 id
    expect(workspaceOfSessionClaim(deps, 's-X')).toBeNull();
    // id 命中但 cwd 缺失 → null（不猜）
    const noCwd = { sessions: { list: (): unknown[] => [{ id: 's-A' }] }, acceptWorkspace: (c: string | null): string | null => c };
    expect(workspaceOfSessionClaim(noCwd, 's-A')).toBeNull();
    // null sessionId 直接 null
    expect(workspaceOfSessionClaim(deps, null)).toBeNull();
  });

  it('② acceptWorkspace 拒绝时返回 null（映射不绕安全边界）', () => {
    const deps = {
      sessions: { list: (): unknown[] => [{ id: 's-A', header: { cwd: 'C:/Windows' } }] },
      acceptWorkspace: (): string | null => null, // 模拟校验拒绝
    };
    expect(workspaceOfSessionClaim(deps, 's-A')).toBeNull();
  });

  it('③ 集成：sessionId 层在 registry 之前生效（会话 cwd 属宿主已知集必被采信）', () => {
    const ctx = {
      sessions: {
        list: (): Array<{ id?: string; header?: { cwd?: string } }> => [
          { id: 's-B', header: { cwd: 'D:/proj/b/.cycles-root' } },
        ],
      },
    } as unknown as SnapshotCtx;
    const registryFirst = 'D:/registry-first';
    (ctx as { workspaceRegistry?: { list(): Array<{ path: string }> } }).workspaceRegistry = {
      list: (): Array<{ path: string }> => [{ path: registryFirst }],
    };
    const root = resolveWorkspaceRoots(ctx, reqWith({ 'x-anic-session': 's-B' }));
    // 会话证据链优先于 registry 首条——cwd 来自宿主 sessions.list()，天然在
    // knownRoots 集内（acceptClaim 第一分支）⇒ 必被采信（这正是"精确归属"语义）。
    expect(root).toBe('D:/proj/b/.cycles-root');
    // claimAcceptable 独立判据（standalone 场景的兜底）
    expect(claimAcceptable('D:/nonexistent/x')).toBeNull();
    expect(claimAcceptable(null)).toBeNull();
  });
});
