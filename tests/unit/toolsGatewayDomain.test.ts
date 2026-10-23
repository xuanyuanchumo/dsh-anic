/**
 * 工具网关域直测（cycle-34 第一部分）：指针型 / 进化域 / 自举域网关。
 *
 * 覆盖 27 零直测审计残留的 gateway 文件（cycle-33 终局建议 ①）：
 * presentCall/presentResult 形状、execute 错误路径、disposer 聚合、
 * registerAnicTools 全量 19 工具契约。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerPointerTools } from '../../src/host/toolsPointerGateway.ts';
import { registerEvolutionTools } from '../../src/host/toolsEvolutionGateway.ts';
import { registerBootstrapGatewayTools } from '../../src/host/toolsBootstrapGateway.ts';
import { registerAnicTools } from '../../src/host/tools.ts';
import type { ToolsSlot } from '../../src/host/toolsSlot.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, 'tmp-gateway-domain');
const WS_EMPTY = join(TMP, 'ws-empty');
const WS_CYCLES = join(TMP, 'ws-cycles');

mkdirSync(WS_EMPTY, { recursive: true });
mkdirSync(join(WS_CYCLES, '.cycles'), { recursive: true });
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 并发清理容忍 */ } });

type Tool = { name: string; execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> };
/** stub 槽位：捕获注册 + 计数 disposer（skillToolNative 同款手法）。 */
function makeSlot(root: string | null) {
  const tools: Tool[] = [];
  const disposers = Array.from({ length: 24 }, () => vi.fn());
  let call = 0;
  const register = (t: Tool) => { tools.push(t); return disposers[call++] ?? vi.fn(); };
  const slot = { register } as unknown as ToolsSlot;
  return { tools, disposers, slot, register, getRoot: () => root };
}
const find = (tools: Tool[], name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

describe('PointerGateway：anic_snapshot / anic_self_check / anic_hitl', () => {
  it('三工具各注册一次；disposer 数组长度 3，逐个调用各一次', () => {
    const h = makeSlot(WS_EMPTY);
    const out = registerPointerTools(h.register, h.getRoot);
    expect(out).toHaveLength(3);
    expect(h.tools.map((t) => t.name).sort()).toEqual(['anic_hitl', 'anic_self_check', 'anic_snapshot']);
    out.forEach((d) => d?.());
    h.disposers.slice(0, 3).forEach((d) => expect(d).toHaveBeenCalledTimes(1));
  });
  it('anic_snapshot：真实工作区编码进 URL；缺省回退 getRoot()', async () => {
    const h = makeSlot(WS_EMPTY);
    registerPointerTools(h.register, h.getRoot);
    const r = await find(h.tools, 'anic_snapshot').execute({ workspace: WS_EMPTY });
    expect(r.snapshotUrl).toBe(`/anic/api/workflow-snapshot?workspace=${encodeURIComponent(WS_EMPTY)}`);
    const fallback = await find(h.tools, 'anic_snapshot').execute({});
    expect(fallback.snapshotUrl).toBe(`/anic/api/workflow-snapshot?workspace=${encodeURIComponent(WS_EMPTY)}`);
  });
  it('anic_snapshot：不存在的工作区与路径穿越被 validateWorkspace 拦截', async () => {
    const h = makeSlot(null);
    registerPointerTools(h.register, h.getRoot);
    const missing = await find(h.tools, 'anic_snapshot').execute({ workspace: join(TMP, 'nope') });
    expect(missing.error).toBe('workspace does not exist');
    const evil = await find(h.tools, 'anic_snapshot').execute({ workspace: '../evil' });
    expect(evil.error).toBe('path traversal not allowed');
  });
  it('anic_self_check / anic_hitl：纯指针不校验——错误工作区也返回 URL（行为契约）', async () => {
    const h = makeSlot(null);
    registerPointerTools(h.register, h.getRoot);
    const sc = await find(h.tools, 'anic_self_check').execute({ workspace: join(TMP, 'nope') });
    expect(sc.selfCheckUrl).toContain('/anic/api/self-check?workspace=');
    const hl = await find(h.tools, 'anic_hitl').execute({ workspace: '../evil' });
    expect(hl.hitlUrl).toBe('/anic/hitl-audit?workspace=..%2Fevil');
  });
});

describe('EvolutionGateway：anic_autonomy_downgrade（证据围栏）', () => {
  it('无 workspace → { error: "no workspace" }', async () => {
    const h = makeSlot(null);
    registerEvolutionTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_autonomy_downgrade').execute({});
    expect(r).toEqual({ error: 'no workspace' });
  });
  it('空工作区无 config → refused（零写入证据围栏）+ configPath 回显', async () => {
    const h = makeSlot(WS_EMPTY);
    registerEvolutionTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_autonomy_downgrade').execute({});
    expect(r.action).toBe('refused');
    expect(r.currentBand).toBe('L2');
    expect(r.reason).toBe('config file missing');
    expect(r.trippedBreakers).toEqual([]);
    expect(r.configPath).toBe(join(WS_EMPTY, '.cycles', 'config.yml'));
    expect(existsSync(join(WS_EMPTY, '.cycles'))).toBe(false); // refused 零写入
  });
  it('presentCall：generic 卡 edit 种类 + workspace 缺省 "."', () => {
    const h = makeSlot(null);
    registerEvolutionTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const tool = h.tools[0] as unknown as { presentCall: (a: Record<string, unknown>) => unknown };
    const view = tool.presentCall({}) as { card: string; kind: string; rawInput: Record<string, unknown> };
    expect(view.card).toBe('generic');
    expect(view.kind).toBe('edit');
    expect(view.rawInput.workspace).toBe('.');
  });
  it('presentResult：官方/宽容双形状都归一化到动作行', () => {
    const h = makeSlot(null);
    registerEvolutionTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const tool = h.tools[0] as unknown as { presentResult: (a: Record<string, unknown>, r: unknown) => { title: string } };
    const official = tool.presentResult({}, {
      content: [{ type: 'text', text: 'ignored' }], meta: { action: 'maintained' }, isError: false,
    });
    expect(official.title).toBe('anic_autonomy_downgrade: maintained');
    const tolerant = tool.presentResult({}, { action: 'refused' });
    expect(tolerant.title).toBe('anic_autonomy_downgrade: refused');
  });
});

describe('BootstrapGateway：错误路径 + 展示层接线（正派路径由 bootstrapOrchestrator 套件背书）', () => {
  it('无 workspace → { error: "no workspace" }；穿越路径拒绝', async () => {
    const h = makeSlot(null);
    registerBootstrapGatewayTools(h.slot, { getRoot: h.getRoot, register: h.register });
    expect(await find(h.tools, 'anic_bootstrap_cycle').execute({})).toEqual({ error: 'no workspace' });
    expect(await find(h.tools, 'anic_bootstrap_analyze').execute({ workspace: '../x' }))
      .toEqual({ error: 'path traversal not allowed' });
  });
  it('两工具 presentCall 接线 presentation 工厂；presentResult 恒 generic 卡', () => {
    const h = makeSlot(null);
    registerBootstrapGatewayTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const cycle = h.tools[0] as unknown as { presentCall: unknown; presentResult: () => { card: string } };
    const analyze = h.tools[1] as unknown as { presentCall: unknown; presentResult: () => { card: string } };
    expect(typeof cycle.presentCall).toBe('function');
    expect(typeof analyze.presentCall).toBe('function');
    expect(cycle.presentResult().card).toBe('generic');
    expect(analyze.presentResult().card).toBe('generic');
  });
});

describe('聚合契约：registerAnicTools 全量 19 工具恰好一次', () => {
  it('stub 宿主上注册 21 个 anic_ 工具，名字唯一且与市场草稿清单一致', () => {
    const registered: Tool[] = [];
    const disposers = Array.from({ length: 32 }, () => vi.fn());
    let call = 0;
    const ctx = {
      tools: { register: (t: Tool) => { registered.push(t); return disposers[call++] ?? vi.fn(); } },
      workspaceRegistry: { list: () => [{ path: WS_EMPTY }] },
    };
    const dispose = registerAnicTools(ctx);
    expect(typeof dispose).toBe('function');
    const names = registered.map((t) => t.name).sort();
    expect(new Set(names).size).toBe(21);
    expect(names).toEqual([
      'anic_autonomy_downgrade', 'anic_bootstrap', 'anic_bootstrap_analyze', 'anic_bootstrap_cycle',
      'anic_evaluate', 'anic_flows_advance', 'anic_flows_archive', 'anic_flows_auto_fix',
      'anic_flows_gate_check', 'anic_flows_hitl', 'anic_gate_check', 'anic_hitl', 'anic_install',
      'anic_iterate', 'anic_self_check', 'anic_skill', 'anic_skill_repair', 'anic_snapshot', 'anic_status',
      'anic_tool_detail', 'anic_tools_search',
    ]);
    dispose?.();
    expect(disposers.filter((d) => d.mock.calls.length === 1)).toHaveLength(21);
  });
});
