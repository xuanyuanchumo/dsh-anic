/**
 * 会话工作区解析契约（anic_status 默认工作区缺陷修复的回归面）。
 *
 * 缺陷现场：多工作区宿主里 `anic_status`（无参）默认落到 `workspaceRegistry`
 * 首条（dsh-anic 自己），而非「当前对话会话」的工作区——工具路径没有会话身份。
 * 修复：wireGuard 出口从 `exec.agent` 解析会话工作区（workingDirectory 服务
 * 实时值 → session.header.cwd 降级），ALS scope 内 getRoot 优先消费。
 *
 * 宿主证据（app.asar 实测，见 sessionWorkspace.ts 头注）：
 * - dsh-tools `createExecution`：`tool.execute(exec.arguments, exec)`，exec 带 agent；
 * - dsh-working-directory `WorkingDirectoryService.get(session)` 实时投影值。
 *
 * 断言矩阵：
 * A. 解析降级三级（实时服务 → header.cwd → null）
 * B. wireGuard 出口注入（ALS scope 覆盖 execute 调用栈，getRoot 读到会话值）
 * C. 降级纪律（宁缺勿猜：服务抛错/字段类型不符 → 不可知，不猜、不断流）
 * D. 零行为变化（无 agent 的 exec → 原链语义不变）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveSessionWorkspace,
  runWithSessionWorkspace,
  sessionWorkspaceRoot,
  currentSessionWorkspace,
  type SessionWorkspaceScope,
} from '../../src/host/runtime/sessionWorkspace.ts';
import { wireGuard, type ToolRegistration, type ToolOutput } from '../../src/host/toolsSlot.ts';
// ctx 持有已上移 sessionWorkspace.ts（toolsSlot 守 T3 ≤250 行）
import { setSessionWorkspaceCtx } from '../../src/host/runtime/sessionWorkspace.ts';

afterEach(() => {
  setSessionWorkspaceCtx(null);
});

/** 最小合法 ToolRegistration fixture（wireGuard 只包 execute，其余字段透传）。 */
function makeTool(
  execute: ToolRegistration['execute'],
): ToolRegistration {
  const output: ToolOutput = {
    schema: { type: 'object' },
    render: () => [{ type: 'text', text: '{}' }],
  };
  return {
    name: 'probe_tool',
    description: 'probe',
    parameters: { type: 'object' },
    execute,
    output,
  };
}

describe('sessionWorkspace.resolveSessionWorkspace — 解析降级三级', () => {
  it('A1 workingDirectory 服务在场 → live 实时值优先', () => {
    const exec = { agent: { session: { header: { cwd: 'D:\\old\\dir' } } } };
    const ctx = { get: (k: string, s?: boolean) => (k === 'workingDirectory' && s === false ? { get: () => 'D:\\live\\dir' } : undefined) };
    const scope = resolveSessionWorkspace(exec, ctx);
    expect(scope).not.toBeNull();
    expect(scope!.live).toBe('D:\\live\\dir');
    expect(scope!.header).toBe('D:\\old\\dir');
  });

  it('A2 服务缺席（get 返回 undefined）→ 降级 header.cwd', () => {
    const exec = { agent: { session: { header: { cwd: 'D:\\proj\\x' } } } };
    const scope = resolveSessionWorkspace(exec, {});
    expect(scope).not.toBeNull();
    expect(scope!.live).toBeNull();
    expect(scope!.header).toBe('D:\\proj\\x');
  });

  it('A3 服务在场但会话无 header.cwd 且服务抛错 → 全 null → 不可知（null）', () => {
    const exec = { agent: { session: {} } };
    const ctx = { get: () => { throw new Error('service boom'); } };
    expect(resolveSessionWorkspace(exec, ctx)).toBeNull();
  });

  it('A4 无 agent 的 exec → null（零行为变化路径）', () => {
    expect(resolveSessionWorkspace(undefined, { get: () => undefined })).toBeNull();
    expect(resolveSessionWorkspace({}, {})).toBeNull();
    expect(resolveSessionWorkspace({ agent: null }, {})).toBeNull();
  });

  it('A5 相对路径 cwd 不采信（plausibleRoot 绝对路径校验）', () => {
    const exec = { agent: { session: { header: { cwd: 'relative/path' } } } };
    expect(resolveSessionWorkspace(exec, {})).toBeNull();
  });

  it('A6 POSIX 绝对路径与 Windows 盘符/UNC 均采信', () => {
    const mk = (cwd: string) => ({ agent: { session: { header: { cwd } } } });
    expect(resolveSessionWorkspace(mk('/home/user/proj'), {})!.header).toBe('/home/user/proj');
    expect(resolveSessionWorkspace(mk('D:/x/y'), {})!.header).toBe('D:/x/y');
    expect(resolveSessionWorkspace(mk('\\\\server\\share'), {})!.header).toBe('\\\\server\\share');
  });

  it('A7 cwd 非字符串（数字/对象）→ 不采信', () => {
    expect(resolveSessionWorkspace({ agent: { session: { header: { cwd: 123 } } } }, {})).toBeNull();
  });

  it('A8 服务的 get 返回 null/undefined（会话无记录）→ live=null 降级 header', () => {
    const exec = { agent: { session: { header: { cwd: 'D:\\h' } } } };
    const ctx = { get: () => ({ get: () => null }) };
    const scope = resolveSessionWorkspace(exec, ctx);
    expect(scope!.live).toBeNull();
    expect(scope!.header).toBe('D:\\h');
  });
});

describe('sessionWorkspace.runWithSessionWorkspace + sessionWorkspaceRoot — ALS scope', () => {
  it('B1 scope 内 sessionWorkspaceRoot 返回 live 优先', async () => {
    const scope: SessionWorkspaceScope = { live: 'D:\\live', header: 'D:\\h' };
    await runWithSessionWorkspace(scope, async () => {
      expect(sessionWorkspaceRoot()).toBe('D:\\live');
      expect(currentSessionWorkspace()).toBe(scope);
    });
  });

  it('B2 live 缺失 → header 兜底', async () => {
    await runWithSessionWorkspace({ live: null, header: 'D:\\h' }, async () => {
      expect(sessionWorkspaceRoot()).toBe('D:\\h');
    });
  });

  it('B3 scope 外 → null（调用方落原 resolveWorkspaceRoots 链）', async () => {
    expect(sessionWorkspaceRoot()).toBeNull();
    expect(currentSessionWorkspace()).toBeNull();
  });

  it('B4 null scope 直跑 = 零开销路径（语义等同）', async () => {
    const spy = vi.fn(async () => 'ok');
    await expect(runWithSessionWorkspace(null, spy)).resolves.toBe('ok');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('B5 异步跨 await 后 ALS 仍在（AsyncLocalStorage 传播）', async () => {
    await runWithSessionWorkspace({ live: 'D:\\x', header: null }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(sessionWorkspaceRoot()).toBe('D:\\x');
    });
  });
});

describe('wireGuard 出口注入（toolsSlot 集成）', () => {
  it('C1 execute 内 getRoot 语义：ALS 值可达（同栈分发）', async () => {
    let seen: string | null = 'unset';
    const tool = makeTool(async () => {
      seen = sessionWorkspaceRoot();
      return {};
    });
    const guarded = wireGuard(tool);
    // 模拟 wireGuard 的调用形态：宿主在 ALS scope 外调 execute（wireGuard 内部建 scope）
    const scope: SessionWorkspaceScope = { live: 'D:\\called\\ws', header: null };
    await runWithSessionWorkspace(scope, () => guarded.execute({}, { agent: { session: {} } }));
    // 注：wireGuard 自身会在 setSessionWorkspaceCtx 提供真实 ctx 后从 exec.agent 解析；
    // 这里直接用外部 scope 验证「execute 栈内 ALS 可达」这一机制前提。
    expect(seen).toBe('D:\\called\\ws');
  });

  it('C2 sanitize 语义保持：undefined 字段仍被出口防线收敛（回归）', async () => {
    const tool = makeTool(async () => ({ a: undefined, b: 1 }));
    const out = await wireGuard(tool).execute({}, undefined);
    expect('a' in out).toBe(false); // sanitizeForWire 删 undefined 键
    expect(out.b).toBe(1);
  });

  it('C3 异常沿 Promise 传播（错误边界语义不因 ALS 包装改变）', async () => {
    const tool = makeTool(async () => { throw new Error('boom'); });
    await expect(wireGuard(tool).execute({}, undefined)).rejects.toThrow('boom');
  });
});
