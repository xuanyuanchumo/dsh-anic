/**
 * **开关解析态**契约（cycle-91）—— `GET /anic/api/flows/resolved`。
 *
 * ## 为什么钉这个（本轮实测缺陷）
 *
 * `resolveFlows` 的**三层合并**（user > workspace > deployment）此前**只在
 * 宿主侧**被读（`routeContext.ts` 的 `loadFlows()`），客户端抽屉只读
 * **user 层**（`renderPrefsDrawer({}, ...)` 传空对象）。
 *
 * **实测反例**：工作区 `.cycles/config.yml` 写 `anic: flow.selfInit: false`
 * ⇒ 抽屉显示「☑ 自举命令」⇒ 用户点「自举」⇒ 宿主返回 **403
 * `ANIC_ROUTE_SELF_INIT_DISABLED`** ⇒ **界面与真相相反**。
 *
 * 本文件钉：端点如实返回**服务端才知道的层**（workspace + deployment），
 * 且客户端抽屉**优先采信服务端**（服务端读磁盘，是真相源）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerResolvedFlowsRoute } from '../../src/host/routes/resolvedFlowsRoute.ts';
import { isResolvedFlows, resolvedFlowState, resolvedUserWritable } from '../../src/client/components/resolvedFlowsTypes.ts';
import { renderPrefsDrawer } from '../../src/client/features/prefs/prefsDrawer.ts';

let ws = '';
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'anic-resolvedflows-'));
  mkdirSync(join(ws, '.cycles'), { recursive: true });
});
afterEach(() => { if (ws) rmSync(ws, { recursive: true, force: true }); });

/** 写工作区配置（`anic.flow.*` 段）。 */
function writeConfig(flows: Record<string, boolean>): void {
  const lines = Object.entries(flows).map(([k, v]) => `  ${k}: ${String(v)}`);
  writeFileSync(join(ws, '.cycles', 'config.yml'), `anic:\n${lines.join('\n')}\n`, 'utf8');
}

/** 注册路由并捕获响应。 */
function mount(): { call: () => { code: number; body: Record<string, unknown> } } {
  let handler: ((req: unknown, res: unknown) => void) | undefined;
  const ctx = {
    webServer: {
      register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => {
        handler = route.handler;
        return () => { /* disposer */ };
      },
    },
  };
  let last = { code: 0, body: {} as Record<string, unknown> };
  registerResolvedFlowsRoute(ctx, (_r, code, body) => { last = { code, body: body as Record<string, unknown> }; }, {
    getWorkspaceRoot: () => ws,
  });
  return {
    call: () => {
      if (!handler) throw new Error('路由未注册');
      handler({}, {});
      return last;
    },
  };
}

describe('cycle-91：GET /anic/api/flows/resolved', () => {
  it('拿不到工作区 ⇒ 404（fail-closed；cycle-101 信封归一 NO_WORKSPACE→404）', () => {
    let handler: ((req: unknown, res: unknown) => void) | undefined;
    const ctx = { webServer: { register: (r: { handler: (q: unknown, s: unknown) => void }) => { handler = r.handler; return () => { /* d */ }; } } };
    let last = { code: 0, body: {} as Record<string, unknown> };
    registerResolvedFlowsRoute(ctx, (_r, code, body) => { last = { code, body: body as Record<string, unknown> }; }, {
      getWorkspaceRoot: () => null,
    });
    handler?.({}, {});
    expect(last.code).toBe(404);
    expect((last.body as { ok: boolean; error: { code: string } }).ok).toBe(false);
    expect((last.body as { error: { code: string } }).error.code).toBe('ANIC_ROUTE_NO_WORKSPACE');
  });

  it('工作区关闭 `flow.selfInit` ⇒ 端点如实返回 enabled=false + source=workspace', () => {
    writeConfig({ 'flow.selfInit': false });
    const res = mount().call();
    expect(res.code).toBe(200);
    const flows = res.body['flows'] as Record<string, { enabled: boolean; source: string | null }>;
    expect(flows['flow.selfInit']?.enabled, '工作区关掉了 selfInit，端点必须如实说 false').toBe(false);
    expect(flows['flow.selfInit']?.source, '来源层应是 workspace').toBe('workspace');
  });

  it('未配置时全部开关 enabled=true + source=null（默认）', () => {
    const res = mount().call();
    const flows = res.body['flows'] as Record<string, { enabled: boolean; source: string | null }>;
    expect(flows['flow.selfInit']?.enabled).toBe(true);
    expect(flows['flow.selfInit']?.source).toBeNull();
  });

  it('**userWritable 逐项给出**（面板据此禁用 checkbox）', () => {
    const res = mount().call();
    const uw = res.body['userWritable'] as Record<string, boolean>;
    // `flow.selfInit` 的 layers 不含 'user' ⇒ 用户层不可写。
    expect(uw['flow.selfInit'], 'selfInit 不支持 user 层 ⇒ 不可写').toBe(false);
    // `flow.workflowTab` 支持 user 层 ⇒ 可写。
    expect(uw['flow.workflowTab'], 'workflowTab 支持 user 层 ⇒ 可写').toBe(true);
  });

  it('端点返回 `total`（客户端可校验是否漏渲染）', () => {
    const res = mount().call();
    expect(typeof res.body['total']).toBe('number');
    expect(res.body['total'] as number).toBeGreaterThanOrEqual(10);
  });
});

describe('cycle-91：客户端抽屉消费服务端解析态', () => {
  /** 收集抽屉文本。 */
  function textsOf(node: unknown): string {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textsOf).join(' ');
    const el = node as { props?: Record<string, unknown> };
    if (el.props === undefined) return '';
    return textsOf(el.props['children']);
  }

  it('**服务端说关 ⇒ 抽屉显示关**（界面不再与真相相反）', () => {
    const drawer = renderPrefsDrawer({
      resolved: { flows: { 'flow.selfInit': { enabled: false, source: 'workspace' } } },
    }, () => { /* noop */ }, 'anic-prefs-drawer-0');
    // checkbox 的 checked 必须为 false。
    const found = JSON.stringify(drawer).includes('"flow.selfInit"');
    expect(found, '抽屉应渲染 selfInit 行').toBe(true);
    const el = drawer as unknown as { props: Record<string, unknown> };
    const children = el.props['children'] as unknown[];
    const selfInitRow = (Array.isArray(children) ? children : [children]).find((c) => {
      const props = (c as { props?: Record<string, unknown> }).props;
      return props?.['data-anic-flow-row'] === 'flow.selfInit';
    });
    expect(selfInitRow, '应找到 selfInit 行').toBeDefined();
    const rowProps = (selfInitRow as { props: Record<string, unknown> }).props;
    const rowChildren = rowProps['children'] as unknown[];
    const input = (Array.isArray(rowChildren) ? rowChildren : [rowChildren]).find((c) => {
      const props = (c as { props?: Record<string, unknown> }).props;
      return props?.['data-anic-flow-toggle'] === 'flow.selfInit';
    });
    const inputProps = (input as { props: Record<string, unknown> }).props;
    expect(inputProps['checked'], '服务端说关 ⇒ 抽屉必须显示关（此前恒显示开）').toBe(false);
  });

  it('端点不可用 ⇒ 落回客户端本地合并（诚实降级，不假装知道）', () => {
    const drawer = renderPrefsDrawer({ resolved: null }, () => { /* noop */ }, 'anic-prefs-drawer-0');
    expect(drawer).toBeDefined();
    const text = textsOf(drawer);
    expect(text.length).toBeGreaterThan(0);
  });

  it('客户端契约守卫：形状守卫与取值函数', () => {
    expect(isResolvedFlows({ flows: {} })).toBe(true);
    expect(isResolvedFlows({})).toBe(false);
    expect(isResolvedFlows(null)).toBe(false);
    expect(resolvedFlowState({ flows: { a: { enabled: false, source: 'workspace' } } }, 'a')?.enabled).toBe(false);
    expect(resolvedFlowState({ flows: {} }, 'a')).toBeNull();
    expect(resolvedUserWritable({ userWritable: { a: false } }, 'a', true)).toBe(false);
    // 端点不可用 ⇒ 回落值。
    expect(resolvedUserWritable(null, 'a', true)).toBe(true);
  });
});
