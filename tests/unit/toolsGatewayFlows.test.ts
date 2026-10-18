/**
 * 工具网关域直测（cycle-34 第二部分）：flows 三工具 / hitl / auto-fix 网关。
 *
 * 参数校验层（execute 前置守卫）+ 只读 list 动作 + presentCall/presentResult
 * 双形状归一化。重型正派路径（gate 脚本/宏相推进/修复循环）由 flows 域
 * 差分契约套件背书，此处钉网关层的入参契约面。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerFlowsTools } from '../../src/host/toolsFlowsGateway.ts';
import { registerHitlTools } from '../../src/host/toolsHitlGateway.ts';
import { registerAutoFixTools } from '../../src/host/toolsAutoFixGateway.ts';
import type { ToolsSlot } from '../../src/host/toolsSlot.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, 'tmp-gateway-flows');
const WS_CYCLES = join(TMP, 'ws-cycles'); // 有 .cycles 无 config——引擎前置错误的最小工作区
mkdirSync(join(WS_CYCLES, '.cycles'), { recursive: true });
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 并发清理容忍 */ } });

type Tool = { name: string; execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> };
function makeSlot() {
  const tools: Tool[] = [];
  const register = (t: Tool) => { tools.push(t); return () => {}; };
  return { tools, slot: { register } as unknown as ToolsSlot, register, getRoot: () => WS_CYCLES };
}
const find = (tools: Tool[], name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};
type Presentable = {
  presentCall: (a: Record<string, unknown>) => { card: string; kind: string; rawInput: Record<string, unknown> };
  presentResult: (a: Record<string, unknown>, r: unknown) => { title: string };
};
const presentable = (t: Tool) => t as unknown as Presentable;

describe('FlowsGateway：anic_flows_gate_check', () => {
  it('gate 白名单外值拒绝（G0-G3 或 all）', async () => {
    const h = makeSlot();
    registerFlowsTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_flows_gate_check').execute({ gate: 'G9' });
    expect(r.error).toBe('invalid gate "G9" (expected G0-G3 or all)');
  });
  it('不存在的工作区先被 validateWorkspace 拦截', async () => {
    const h = makeSlot();
    registerFlowsTools(h.slot, { getRoot: () => null, register: h.register });
    const r = await find(h.tools, 'anic_flows_gate_check').execute({});
    expect(r.error).toBe('workspace is required');
  });
  it('presentCall 缺省 gate=all mode=script；presentResult 双形状归一化', () => {
    const h = makeSlot();
    registerFlowsTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const p = presentable(find(h.tools, 'anic_flows_gate_check'));
    const call = p.presentCall({});
    expect(call.card).toBe('generic');
    expect(call.rawInput).toEqual({ workspace: '.', gate: 'all', mode: 'script' });
    expect(p.presentResult({}, { content: [{ type: 'text', text: 'x' }], meta: { state: 'PASSED', allPass: true } }).title)
      .toBe('anic_flows_gate_check: PASSED (all-pass)');
    expect(p.presentResult({}, { state: 'FAILED', allPass: false }).title)
      .toBe('anic_flows_gate_check: FAILED (has-fail)');
  });
});

describe('FlowsGateway：anic_flows_advance', () => {
  it('非法 target 列出全部合法相', async () => {
    const h = makeSlot();
    registerFlowsTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_flows_advance').execute({ target: 'bogus' });
    expect(r.error).toContain('invalid target phase "bogus"');
    expect(r.error).toContain('plan, design, build, test, deploy, maintain');
  });
  it('dryRun 只允许 native 模式', async () => {
    const h = makeSlot();
    registerFlowsTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_flows_advance').execute({ dryRun: true });
    expect(r.error).toBe('dryRun is only supported with mode=native');
  });
});

describe('FlowsGateway：anic_flows_archive', () => {
  it('list 是只读缺省：IDLE 不推状态机，inventory 双空数组', async () => {
    const h = makeSlot();
    registerFlowsTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_flows_archive').execute({});
    expect(r.ok).toBe(true);
    expect(r.action).toBe('list');
    expect(r.flowState).toBe('IDLE');
    expect(r.events).toEqual([]);
    expect(r.inventory).toEqual({ active: [], archived: [] });
  });
  it('cycle/keep 必须是数字（HTTP 宽容入口的类型守卫）', async () => {
    const h = makeSlot();
    registerFlowsTools(h.slot, { getRoot: h.getRoot, register: h.register });
    expect((await find(h.tools, 'anic_flows_archive').execute({ cycle: '7' as unknown as number })).error)
      .toBe('cycle must be a number');
    expect((await find(h.tools, 'anic_flows_archive').execute({ clean: true, keep: '5' as unknown as number })).error)
      .toBe('keep must be a number');
  });
  it('presentCall 三动作显示：cycle-N / clean(keep N) / list', () => {
    const h = makeSlot();
    registerFlowsTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const p = presentable(find(h.tools, 'anic_flows_archive'));
    expect(p.presentCall({ cycle: 7 }).rawInput.action).toBe('cycle-7');
    expect(p.presentCall({ clean: true, keep: 3 }).rawInput.action).toBe('clean(keep 3)');
    expect(p.presentCall({}).rawInput.action).toBe('list');
  });
});

describe('HitlGateway：anic_flows_hitl', () => {
  it('gate 白名单外值拒绝（H1-H4 或 all）', async () => {
    const h = makeSlot();
    registerHitlTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_flows_hitl').execute({ gate: 'H9' });
    expect(r.error).toBe('invalid gate "H9" (expected H1-H4 or all)');
  });
  it('空工作区 native 审计返回完整判定形状（verdict 三值域 + checks/events 数组）', async () => {
    const h = makeSlot();
    registerHitlTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_flows_hitl').execute({ gate: 'H1', mode: 'native' });
    expect(['pass', 'fail', 'circuit']).toContain(r.verdict);
    expect(typeof r.exitCode).toBe('number');
    expect(typeof r.flowState).toBe('string');
    expect(Array.isArray(r.checks)).toBe(true);
    expect(Array.isArray(r.events)).toBe(true);
    expect(r.auditLogPath === null || typeof r.auditLogPath === 'string').toBe(true);
  });
  it('presentResult：circuit 建议追加 autonomy-fallback 提示行', () => {
    const h = makeSlot();
    registerHitlTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const p = presentable(find(h.tools, 'anic_flows_hitl'));
    const t = p.presentResult({}, { verdict: 'circuit', state: 'BLOCKED', suggestedNextStep: 'autonomy-fallback' }).title;
    expect(t).toContain('circuit');
    expect(t).toContain('-> autonomy-fallback suggested');
    expect(p.presentResult({}, { verdict: 'pass', state: 'IDLE' }).title).not.toContain('autonomy-fallback');
  });
});

describe('AutoFixGateway：anic_flows_auto_fix', () => {
  it('不存在的工作区被拦（工具级守卫先于引擎）', async () => {
    const h = makeSlot();
    registerAutoFixTools(h.slot, { getRoot: () => null, register: h.register });
    const r = await find(h.tools, 'anic_flows_auto_fix').execute({});
    expect(r.error).toBe('workspace is required');
  });
  it('无 config 前置错误：不推进状态机、error 响亮、exitCode 1', async () => {
    const h = makeSlot();
    registerAutoFixTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_flows_auto_fix').execute({ mode: 'native' });
    expect(r.error).toBe('No test command found. Specify --test-cmd or configure test_cmd in .cycles/config.yml');
    expect(r.exitCode).toBe(1);
    expect(r.flowState).toBe('IDLE'); // 前置错误零状态推进
    expect(r.attempts).toEqual([]);
  });
  it('maxRetries 非整数被拒（回退缺省 3）；有 testCmd 无 cycle 目录是第二道前置错误', async () => {
    const h = makeSlot();
    registerAutoFixTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_flows_auto_fix')
      .execute({ mode: 'native', maxRetries: 4.5, testCmd: 'echo hi' });
    expect(r.error).toBe('No cycle directory found. Run init-cycle first.');
    expect(r.maxRetries).toBe(3);
  });
  it('presentResult：verdict/state/attemptsCount 行 + pattern 附加', () => {
    const h = makeSlot();
    registerAutoFixTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const p = presentable(find(h.tools, 'anic_flows_auto_fix'));
    expect(p.presentResult({}, { verdict: 'circuit', state: 'EXHAUSTED', attemptsCount: 3, pattern: 'repeating' }).title)
      .toBe('anic_flows_auto_fix: circuit (EXHAUSTED, 3 attempt(s), pattern=repeating');
    expect(p.presentResult({}, { content: [{ type: 'text', text: 'x' }], meta: { verdict: 'pass', state: 'ALL_PASS', attemptsCount: 1 } }).title)
      .toBe('anic_flows_auto_fix: pass (ALL_PASS, 1 attempt(s)');
  });
});

describe('HitlGateway 副作用审计：auditLog 落盘 + flows 投影', () => {
  it('H1 审计后 .cycles 下出现投影或审计产物（native 模式可观测性）', async () => {
    const h = makeSlot();
    registerHitlTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_flows_hitl').execute({ gate: 'H1', mode: 'native' });
    const proj = join(WS_CYCLES, '.cycles', 'flows', 'hitl.json');
    let saw = false;
    try { readFileSync(proj, 'utf-8'); saw = true; } catch { /* 状态可能保持 IDLE 未落投影 */ }
    expect(typeof r.auditLogPath === 'string' || saw).toBe(true);
  });
});
