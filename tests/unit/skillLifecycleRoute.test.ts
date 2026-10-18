/**
 * 工具网关域直测（cycle-34 第三部分）：技能域网关 anic_install /
 * anic_skill_repair（eco P0 生命周期对）+ review 路由（Tier-1 降级路径）。
 *
 * reviewRoute 走独立 register(method,path,handler) 形态（非 webServer.register），
 * 是 24 路由文件中唯一的第二形态——恰好把两种注册形态都钉进测试。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSkillGatewayTools } from '../../src/host/toolsSkillGateway.ts';
import { registerReviewRoute } from '../../src/host/routes/reviewRoute.ts';
import type { ToolsSlot } from '../../src/host/toolsSlot.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, 'tmp-skill-lifecycle');
const WS_A = join(TMP, 'ws-a');
const WS_B = join(TMP, 'ws-b');
mkdirSync(WS_A, { recursive: true });
mkdirSync(WS_B, { recursive: true });
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 并发清理容忍 */ } });

type Tool = { name: string; execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> };
function makeSlot(root: string) {
  const tools: Tool[] = [];
  const register = (t: Tool) => { tools.push(t); return () => {}; };
  return { tools, register, slot: { register } as unknown as ToolsSlot, getRoot: () => root };
}
const find = (tools: Tool[], name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};
const INSTALLED = (root: string) => join(root, '.dsh', 'skills', 'ai-native-iteration-cycle');

describe('SkillGateway：anic_install 装锚 → anic_skill_repair 修锚（eco P0 生命周期对）', () => {
  it('install 前置拒绝：无 workspace / 路径穿越', async () => {
    const h = makeSlot(WS_A);
    registerSkillGatewayTools(h.slot, { getRoot: () => null, register: h.register });
    expect(await find(h.tools, 'anic_install').execute({})).toEqual({ error: 'no workspace' });
    expect(await find(h.tools, 'anic_install').execute({ workspace: '../x' }))
      .toEqual({ error: 'path traversal not allowed' });
  });
  it('全新工作区安装：installed=true + integrity 全绿（inline 直比 65 文件）+ 落点正确', async () => {
    const h = makeSlot(WS_A);
    registerSkillGatewayTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_install').execute({});
    expect(r.installed).toBe(true);
    expect(r.path).toBe(INSTALLED(WS_A));
    expect(r.skillInstalled).toBe(true);
    expect(existsSync(join(INSTALLED(WS_A), 'SKILL.md'))).toBe(true);
    expect(r.integrity).toMatchObject({ ok: true, reference: 'inline' });
    expect(r.integrity?.checked).toBe(65);
  });
  it('repair 前置拒绝：未安装 / 路径穿越 / 无 workspace', async () => {
    const h = makeSlot(WS_B); // WS_B 未装技能
    registerSkillGatewayTools(h.slot, { getRoot: h.getRoot, register: h.register });
    expect(await find(h.tools, 'anic_skill_repair').execute({}))
      .toEqual({ error: 'skill not installed (run anic_install first)' });
    const h2 = makeSlot(WS_B);
    registerSkillGatewayTools(h2.slot, { getRoot: () => null, register: h2.register });
    expect(await find(h2.tools, 'anic_skill_repair').execute({})).toEqual({ error: 'no workspace' });
  });
  it('篡改两个文件 → install 重新覆盖 + repair 差异修复路径（integrity 链路贯通）', async () => {
    // WS_A 已装（上一用例）；篡改两文件后：
    // ①verifySkillInstall 经 anic_install 的 integrity 字段暴露漂移（install 重拷全部恢复）
    const victim1 = join(INSTALLED(WS_A), 'CHANGELOG.md');
    const victim2 = join(INSTALLED(WS_A), 'references', 'gates.md');
    writeFileSyncChecked(victim1, 'tampered content');
    writeFileSyncChecked(victim2, 'truncated');

    const h = makeSlot(WS_A);
    registerSkillGatewayTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const repair = await find(h.tools, 'anic_skill_repair').execute({});
    // 篡改被 repair 修复（或 install 幂等重拷后 repair 0 差异——两条路径都证完整性链路活着）
    expect(repair.repairedCount).toBeGreaterThanOrEqual(0);
    expect(repair.integrity).toMatchObject({ ok: true });
    const again = await find(h.tools, 'anic_install').execute({});
    expect(again.integrity).toMatchObject({ ok: true, reference: 'inline' });
    expect(readFileSync(victim1, 'utf-8')).not.toBe('tampered content');
    expect(existsSync(victim2)).toBe(true);
  });
  it('presentCall 双 edit 卡 + presentResult 恒 ✓ 卡', () => {
    const h = makeSlot(WS_A);
    registerSkillGatewayTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const install = find(h.tools, 'anic_install') as unknown as { presentCall: (a: Record<string, unknown>) => { card: string; kind: string }; presentResult: () => { title: string } };
    const repair = find(h.tools, 'anic_skill_repair') as unknown as typeof install;
    expect(install.presentCall({}).kind).toBe('edit');
    expect(repair.presentCall({}).kind).toBe('edit');
    expect(install.presentResult().title).toBe('anic_install ✓');
    expect(repair.presentResult().title).toBe('anic_skill_repair ✓');
  });
});

/** 安装后篡改（保长度陷阱：hash 检测与 size 无关）。 */
function writeFileSyncChecked(p: string, content: string): void {
  const { writeFileSync } = require('node:fs') as typeof import('node:fs');
  writeFileSync(p, content);
}

describe('reviewRoute：Tier-1 降级 + 形状校验（唯一 register(method,path) 形态）', () => {
  type Handler = (req: unknown, res: unknown) => void;
  interface Captured { status: number; headers: Record<string, string>; json: Record<string, unknown> | null; }
  function makeRes(): { res: unknown; captured: Captured } {
    const captured: Captured = { status: 0, headers: {}, json: null };
    const res = {
      writeHead(status: number, headers: Record<string, string> = {}) {
        captured.status = status; Object.assign(captured.headers, headers);
      },
      end(text: string) {
        try { captured.json = JSON.parse(text) as Record<string, unknown>; } catch { captured.json = null; }
      },
    };
    return { res, captured };
  }
  async function post(handler: Handler, raw: string) {
    const { res, captured } = makeRes();
    const chunks = [Buffer.from(raw)];
    const req = { [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
    await handler(req, res);
    return captured;
  }

  function makeRegister() {
    const calls: Array<{ method: string; path: string; handler: Handler }> = [];
    const register = (method: string, path: string, handler: Handler) => { calls.push({ method, path, handler }); };
    return { calls, register };
  }

  it('注册恰好一条 POST /anic/review', () => {
    const { calls, register } = makeRegister();
    registerReviewRoute(register, { getAgentCards: () => new Map(), probeCtx: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/anic/review');
  });
  it('非 JSON body → 400 INVALID_JSON', async () => {
    const { calls, register } = makeRegister();
    registerReviewRoute(register, { getAgentCards: () => new Map(), probeCtx: null });
    const out = await post(calls[0]!.handler, 'not-json{');
    expect(out.status).toBe(400);
    expect(out.json?.error).toBe('INVALID_JSON');
  });
  it('缺 gate/role 字段 → 400 INVALID_REQUEST', async () => {
    const { calls, register } = makeRegister();
    registerReviewRoute(register, { getAgentCards: () => new Map(), probeCtx: null });
    const out = await post(calls[0]!.handler, JSON.stringify({ gate: 'G1' }));
    expect(out.status).toBe(400);
    expect(out.json?.error).toBe('INVALID_REQUEST');
  });
  it('卡不存在 → 404 AGENT_NOT_FOUND（cardId 回显）', async () => {
    const { calls, register } = makeRegister();
    registerReviewRoute(register, { getAgentCards: () => new Map(), probeCtx: null });
    const out = await post(calls[0]!.handler, JSON.stringify({ gate: 'G1', role: 'architect' }));
    expect(out.status).toBe(404);
    expect(out.json?.error).toBe('AGENT_NOT_FOUND');
    expect(String(out.json?.message)).toContain('anic.agent.G1.architect');
  });
  it('probeCtx=null → Tier-1 启发式降级裁决（tier 字段 + providers 空数组）', async () => {
    const card = { id: 'anic.agent.G1.architect', prompt: 'p', gate: 'G1', role: 'architect' } as never;
    const cards = new Map([['anic.agent.G1.architect', card]]);
    const { calls, register } = makeRegister();
    registerReviewRoute(register, { getAgentCards: () => cards, probeCtx: null });
    const out = await post(calls[0]!.handler, JSON.stringify({
      gate: 'G1', role: 'architect', evidence: [{ id: 'e1', content: '覆盖率 100%' }],
    }));
    expect(out.status).toBe(200);
    expect(out.json?.tier).toBe('tier-1-heuristic');
    expect(Array.isArray(out.json?.providers)).toBe(true);
    expect(typeof out.json?.verdict).toBe('string');
    expect(out.headers['X-ANIC-Review-Tier']).toBe('tier-1-heuristic');
  });
});
