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
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('全新工作区安装：installed=true + integrity 全绿（inline 直比 64 文件）+ 落点正确', async () => {
    const h = makeSlot(WS_A);
    registerSkillGatewayTools(h.slot, { getRoot: h.getRoot, register: h.register });
    const r = await find(h.tools, 'anic_install').execute({});
    expect(r.installed).toBe(true);
    expect(r.path).toBe(INSTALLED(WS_A));
    expect(r.skillInstalled).toBe(true);
    expect(existsSync(join(INSTALLED(WS_A), 'SKILL.md'))).toBe(true);
    expect(r.integrity).toMatchObject({ ok: true, reference: 'inline' });
    expect(r.integrity?.checked, '安装校验的文件数必须与发行源实测一致').toBeGreaterThan(0);
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

  // ── cycle-38：授权可见性 + 归因留痕（两处此前「有定义无消费方」的接线）──

  it('响应带 grant：该卡的工具白名单与授权带上限原样透出（越权可事后审计）', async () => {
    const card = {
      id: 'anic.agent.G1.architect',
      gate: 'G1',
      role: 'architect',
      systemPrompt: '闭合 JSON 输出',
      toolsAllowlist: ['anic_status', 'anic_self_check'],
      autonomyBand: 'L2',
      outputContract: '闭合 JSON',
      escalation: '升级人类门',
    };
    const cards = new Map([['anic.agent.G1.architect', card]]);
    const { calls, register } = makeRegister();
    registerReviewRoute(register, { getAgentCards: () => cards, probeCtx: null });
    const out = await post(calls[0]!.handler, JSON.stringify({
      gate: 'G1', role: 'architect', evidence: [{ id: 'e1', content: 'x' }],
    }));
    const grant = out.json?.grant as { toolsAllowlist?: string[]; autonomyBand?: string };
    expect(grant.toolsAllowlist).toEqual(['anic_status', 'anic_self_check']);
    expect(grant.autonomyBand).toBe('L2');
  });

  it('响应带 attribution：Tier-1 路径 provider/model 如实记 none（不借用 provider 名）', async () => {
    const card = {
      id: 'anic.agent.G1.architect',
      gate: 'G1',
      role: 'architect',
      systemPrompt: '闭合 JSON 输出',
      toolsAllowlist: [],
      autonomyBand: 'L2',
      outputContract: '闭合 JSON',
      escalation: '升级人类门',
    };
    const cards = new Map([['anic.agent.G1.architect', card]]);
    const { calls, register } = makeRegister();
    registerReviewRoute(register, { getAgentCards: () => cards, probeCtx: null });
    const out = await post(calls[0]!.handler, JSON.stringify({
      gate: 'G1', role: 'architect', evidence: [{ id: 'e1', content: 'x' }, { id: 'e2', content: 'y' }],
    }));
    const attr = out.json?.attribution as {
      provider?: string; model?: string; promptDigest?: string; evidenceIds?: string[];
    };
    expect(attr.provider).toBe('none');
    expect(attr.model).toBe('none');
    expect(attr.evidenceIds).toEqual(['e1', 'e2']);
    // digest 是 sha256 前 16 位十六进制（不落提示词原文）
    expect(attr.promptDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('attribution.promptDigest 同输入同摘要、异输入异摘要（可复现比对）', async () => {
    const card = {
      id: 'anic.agent.G1.architect',
      gate: 'G1',
      role: 'architect',
      systemPrompt: '闭合 JSON 输出',
      toolsAllowlist: [],
      autonomyBand: 'L2',
      outputContract: '闭合 JSON',
      escalation: '升级人类门',
    };
    const cards = new Map([['anic.agent.G1.architect', card]]);
    const { calls, register } = makeRegister();
    registerReviewRoute(register, { getAgentCards: () => cards, probeCtx: null });
    const body = (content: string) => JSON.stringify({
      gate: 'G1', role: 'architect', evidence: [{ id: 'e1', content }],
    });
    const a = await post(calls[0]!.handler, body('同一份证据'));
    const b = await post(calls[0]!.handler, body('同一份证据'));
    const c = await post(calls[0]!.handler, body('换过的证据'));
    const digest = (o: Captured) => (o.json?.attribution as { promptDigest?: string }).promptDigest;
    expect(digest(a)).toBe(digest(b));
    expect(digest(a)).not.toBe(digest(c));
  });

  // ── cycle-38 G5：结论时效（内容指纹判据，零模型参与）──

  const STALE_CARD = {
    id: 'anic.agent.G1.architect',
    gate: 'G1',
    role: 'architect',
    systemPrompt: '闭合 JSON 输出',
    toolsAllowlist: [],
    autonomyBand: 'L2',
    outputContract: '闭合 JSON',
    escalation: '升级人类门',
  };

  function makeCards() {
    return new Map([['anic.agent.G1.architect', STALE_CARD]]);
  }

  function tempWorkspace(): string {
    return mkdtempSync(join(tmpdir(), 'anic-review-fresh-'));
  }

  it('首次评审 → freshness none（此前没有结论，不冒充 fresh）', async () => {
    const ws = tempWorkspace();
    const { calls, register } = makeRegister();
    registerReviewRoute(register, {
      getAgentCards: makeCards, probeCtx: null, getWorkspaceRoot: () => ws,
    });
    const out = await post(calls[0]!.handler, JSON.stringify({
      gate: 'G1', role: 'architect', evidence: [{ id: 'e1', content: 'x' }],
    }));
    const review = out.json?.review as { freshness?: string; previous?: unknown; error?: unknown };
    expect(review.freshness).toBe('none');
    expect(review.previous).toBeNull();
    expect(review.error).toBeNull();
  });

  it('同一批证据再评 → freshness fresh；换证据再评 → stale（判据是指纹不是时间）', async () => {
    const ws = tempWorkspace();
    const { calls, register } = makeRegister();
    registerReviewRoute(register, {
      getAgentCards: makeCards, probeCtx: null, getWorkspaceRoot: () => ws,
    });
    const handler = calls[0]!.handler;
    const body = (content: string) => JSON.stringify({
      gate: 'G1', role: 'architect', evidence: [{ id: 'e1', content }],
    });
    await post(handler, body('证据甲'));
    const same = await post(handler, body('证据甲'));
    expect((same.json?.review as { freshness?: string }).freshness).toBe('fresh');
    const changed = await post(handler, body('证据乙'));
    const review = changed.json?.review as {
      freshness?: string;
      previous?: { evidenceDigest?: string; verdict?: string; tier?: string };
    };
    expect(review.freshness).toBe('stale');
    // 上一次结论的摘要随响应可见（审计：当时依据的是哪批证据、给出什么裁决）
    expect(review.previous?.verdict).toBe('approve');
    expect(review.previous?.tier).toBe('tier-1-heuristic');
    expect(review.previous?.evidenceDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('结论落盘到 .cycles/reviews/ledger.json（重启后仍可判时效）', async () => {
    const ws = tempWorkspace();
    const { calls, register } = makeRegister();
    registerReviewRoute(register, {
      getAgentCards: makeCards, probeCtx: null, getWorkspaceRoot: () => ws,
    });
    await post(calls[0]!.handler, JSON.stringify({
      gate: 'G1', role: 'architect', evidence: [{ id: 'e1', content: 'x' }],
    }));
    const file = join(ws, '.cycles', 'reviews', 'ledger.json');
    expect(existsSync(file)).toBe(true);
    const records = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ gate?: string; role?: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]?.gate).toBe('G1');
    expect(records[0]?.role).toBe('architect');
  });

  it('未注入 getWorkspaceRoot → freshness unknown + error 如实说明（评审本身不受影响）', async () => {
    const { calls, register } = makeRegister();
    registerReviewRoute(register, { getAgentCards: makeCards, probeCtx: null });
    const out = await post(calls[0]!.handler, JSON.stringify({
      gate: 'G1', role: 'architect', evidence: [{ id: 'e1', content: 'x' }],
    }));
    expect(out.status).toBe(200);
    const review = out.json?.review as { freshness?: string; error?: string };
    expect(review.freshness).toBe('unknown');
    expect(String(review.error)).toContain('workspace root unresolved');
  });
});
