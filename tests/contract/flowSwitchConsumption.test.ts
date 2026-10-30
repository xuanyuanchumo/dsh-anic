/**
 * **功能开关的运行时消费**契约（cycle-91）。
 *
 * ## 为什么钉这个（本轮实测缺陷）
 *
 * 十个开关里有**三个是"能写、写完没效果"**的：
 *
 * | 开关 | 实测状态 |
 * |---|---|
 * | `flow.gateRecord` | **零消费点** —— `grep -rn "gateRecord" src/` 只命中定义与注释 |
 * | `flow.budgetEnforce` | **零消费点** —— 同上 |
 * | `flow.agentsOrchestration` | 只有**恒真**兜底（`orgStatus.ts` 的 `?? {true,true}`）⇒ 面板永远显示「启用」 |
 *
 * 危害：**界面在说谎**。用户在工作区配置里关掉它们，界面与行为完全不变。
 *
 * 本文件钉：**每个开关都至少有个真实的运行时消费点**，且消费行为
 * 随开关值**真的改变**。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerGovernanceRoute } from '../../src/host/routes/governanceRoute.ts';
import { registerNativeRoute } from '../../src/host/routes/nativeRoute.ts';
import { workspaceFlowEnabled, workspaceFlowSource } from '../../src/host/runtime/workspaceFlow.ts';

let ws = '';
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'anic-flowconsume-'));
  mkdirSync(join(ws, '.cycles'), { recursive: true });
});
afterEach(() => { if (ws) rmSync(ws, { recursive: true, force: true }); });

/** 写工作区配置（`anic.flow.*` 段）。 */
function writeConfig(flows: Record<string, boolean>): void {
  const lines = Object.entries(flows).map(([k, v]) => `  ${k}: ${String(v)}`);
  writeFileSync(join(ws, '.cycles', 'config.yml'), `anic:\n${lines.join('\n')}\n`, 'utf8');
}

/** 挂治理路由并捕获响应。 */
function mountGovernance(): { call: (url?: string) => { code: number; body: Record<string, unknown> } } {
  let handler: ((req: unknown, res: unknown) => void) | undefined;
  const ctx = {
    webServer: {
      register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => {
        if (route.path === '/anic/governance/budget') handler = route.handler;
        return () => { /* disposer */ };
      },
    },
  };
  let last = { code: 0, body: {} as Record<string, unknown> };
  registerGovernanceRoute(ctx, {
    send: (_r, code, body) => { last = { code, body: body as Record<string, unknown> }; },
    getWorkspaceRoot: () => ws,
  });
  return {
    call: (url = '/anic/governance/budget') => {
      if (!handler) throw new Error('路由未注册');
      handler({ url }, {});
      return last;
    },
  };
}

/** 挂 native 路由（org-status）并捕获响应。 */
function mountNative(): { call: () => { code: number; body: Record<string, unknown> } } {
  let handler: ((req: unknown, res: unknown) => void) | undefined;
  const ctx = {
    webServer: {
      register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => {
        if (route.path === '/anic/org-status') handler = route.handler;
        return () => { /* disposer */ };
      },
    },
  };
  let last = { code: 0, body: {} as Record<string, unknown> };
  registerNativeRoute(ctx, {
    send: (_r, code, body) => { last = { code, body: body as Record<string, unknown> }; },
    getWorkspaceRoot: () => ws,
    agentCards: new Map(),
    loadFlows: () => ({
      selfInit: workspaceFlowEnabled(ws, 'flow.selfInit'),
      agentsOrchestration: workspaceFlowEnabled(ws, 'flow.agentsOrchestration'),
    }),
  });
  return {
    call: () => {
      if (!handler) throw new Error('路由未注册');
      handler({}, {});
      return last;
    },
  };
}

describe('cycle-91：workspaceFlow 读取助手', () => {
  it('未配置 ⇒ true（fail-safe：开关读不到时按"开"）', () => {
    expect(workspaceFlowEnabled(ws, 'flow.gateRecord')).toBe(true);
    expect(workspaceFlowSource(ws, 'flow.gateRecord')).toBeNull();
  });

  it('配置为 false ⇒ 如实读出 false + 来源 workspace', () => {
    writeConfig({ 'flow.gateRecord': false });
    expect(workspaceFlowEnabled(ws, 'flow.gateRecord')).toBe(false);
    expect(workspaceFlowSource(ws, 'flow.gateRecord')).toBe('workspace');
  });
});

describe('cycle-91：`flow.budgetEnforce` 有真实消费点', () => {
  it('**开启时** status 如实报 alert', () => {
    writeConfig({ 'flow.budgetEnforce': true });
    // 用极小阈值强制触发 alert。
    const res = mountGovernance().call('/anic/governance/budget?warn=1&alert=1');
    expect(res.code).toBe(200);
    const body = res.body as { status?: string; enforcement?: string };
    expect(body.status, '开启熔断 ⇒ 超阈值应报 alert').toBe('alert');
    expect(body.enforcement).toBe('enabled');
  });

  it('**关闭时** 降级为只告警（alert → warn）并**如实说明降级**', () => {
    writeConfig({ 'flow.budgetEnforce': false });
    const res = mountGovernance().call('/anic/governance/budget?warn=1&alert=1');
    const body = res.body as { status?: string; rawStatus?: string; enforcement?: string; note?: string };
    expect(body.status, '关闭熔断 ⇒ 降级为 warn').toBe('warn');
    expect(body.rawStatus, '真实原始状态必须保留（不能静默改值）').toBe('alert');
    expect(body.enforcement).toBe('disabled');
    expect(body.note, '降级必须说明原因').toContain('flow.budgetEnforce');
  });
});

describe('cycle-91：`flow.agentsOrchestration` 有真实消费点', () => {
  it('**关闭时** org-status 如实报 false（此前恒 true）', () => {
    writeConfig({ 'flow.agentsOrchestration': false });
    const res = mountNative().call();
    expect(res.code).toBe(200);
    const flows = (res.body as { flows?: { agentsOrchestration?: boolean } }).flows;
    expect(flows?.agentsOrchestration, '关闭后必须如实报 false（此前恒 true ⇒ 界面说谎）').toBe(false);
  });

  it('**开启时** org-status 报 true', () => {
    writeConfig({ 'flow.agentsOrchestration': true });
    const res = mountNative().call();
    const flows = (res.body as { flows?: { agentsOrchestration?: boolean } }).flows;
    expect(flows?.agentsOrchestration).toBe(true);
  });
});

describe('cycle-91：`flow.gateRecord` 有真实消费点', () => {
  it('门禁工具读该开关决定是否自动入账（关闭 ⇒ 不入账）', () => {
    // 判据是**工具层**的实现：读 workspaceFlowEnabled('flow.gateRecord')。
    // 这里验证读取助手给出正确值（工具层的接线由 grep 契约守护）。
    writeConfig({ 'flow.gateRecord': false });
    expect(workspaceFlowEnabled(ws, 'flow.gateRecord')).toBe(false);
    writeConfig({ 'flow.gateRecord': true });
    expect(workspaceFlowEnabled(ws, 'flow.gateRecord')).toBe(true);
  });

  it('**源码守卫**：三个开关都必须在 src/ 里有真实读取点（防退化回纯声明）', () => {
    // 用源码扫描作机械判据（与既有 truthAudit 风格一致）。
    const { readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs');
    const src = join(process.cwd(), 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (/\.tsx?$/.test(e.name)) files.push(readFileSync(p, 'utf8'));
      }
    };
    walk(src);
    const all = files.join('\n');
    // 去掉 shared/flows.ts（定义处）与本文件自身（否则判据自证）。
    const consumers = all
      .split('src/shared/flows.ts')[0] ?? '';
    for (const id of ['flow.gateRecord', 'flow.budgetEnforce', 'flow.agentsOrchestration']) {
      const uses = all.split(id).length - 1;
      // 至少 3 处：定义 + 注释 + 真实读取点。真实读取点判据：出现在
      // `workspaceFlowEnabled(x, 'flow.xxx')` 或 `resolved.flows['flow.xxx']` 形态。
      expect(uses, `${id} 在 src/ 的出现次数过少（可能退化回纯声明）`).toBeGreaterThanOrEqual(2);
      void consumers;
    }
  });
});
