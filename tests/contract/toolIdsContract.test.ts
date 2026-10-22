/**
 * 契约：工具 id 清单与注册代码**双向**一致（cycle-38 · M2-a）。
 *
 * 背景：`src/host/agents.ts` 曾自认「`toolsAllowlist` M1 只做形状校验；存在性校验
 * 在 M2-a 工具面落地后接入」。形状校验放得过 `anic_ghost_tool`——语法合法、
 * 工具不存在，白名单因此可以声明幽灵能力而无人拒绝（doc13 §4 R-34 的实体）。
 *
 * 本契约钉死两件事：
 *   1. `src/host/toolIds.ts` 的 ANIC_TOOL_IDS 与 `src/host/tools*.ts` 里
 *      `name: 'anic_...'` 字面量**集合相等**（多一个 / 少一个都红）。
 *      → 真相在注册代码；清单是投影。改代码不改清单会立刻失败，反之亦然。
 *   2. 15 张角色卡的 `toolsAllowlist` 每一条都必须是真实存在的工具 id，
 *      且通过 `validateAgentCard`（即装载期不会被拒）。
 *
 * 为什么不是「只比数量」：数量相等而内容漂移（换了一个工具）是本契约要防的
 * 主要退化形态，集合比对才拦得住。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANIC_TOOL_IDS, isKnownToolId, unknownToolIds } from '../../src/host/toolIds.ts';
import { loadAgentCards, validateAgentCard, isAllowedToolId } from '../../src/host/agents.ts';

const HOST_DIR = fileURLToPath(new URL('../../src/host/', import.meta.url));
const AGENTS_DIR = fileURLToPath(new URL('../../assets/agents/', import.meta.url));

/** 扫 src/host/tools*.ts 的 `name: 'anic_...'` 字面量（与 truthAudit 同判据）。 */
function registeredToolIds(): string[] {
  const ids = new Set<string>();
  for (const file of readdirSync(HOST_DIR).filter((f) => /^tools.*\.ts$/.test(f))) {
    const src = readFileSync(join(HOST_DIR, file), 'utf-8');
    for (const m of src.matchAll(/name:\s*['"]((anic_[a-z0-9_]+))['"]/g)) {
      if (m[1]) ids.add(m[1]);
    }
  }
  return [...ids].sort();
}

describe('契约：工具 id 清单 ⇄ 注册代码', () => {
  it('扫描集非空（防止扫描器坏掉后静默空真）', () => {
    const scanned = registeredToolIds();
    expect(scanned.length).toBeGreaterThanOrEqual(15);
    expect(ANIC_TOOL_IDS.length).toBeGreaterThanOrEqual(15);
  });

  it('注册代码里的工具 id 全部在清单中（新增工具必须登记）', () => {
    const scanned = registeredToolIds();
    const missing = scanned.filter((id) => !isKnownToolId(id));
    expect(missing, `注册了但未登记到 src/host/toolIds.ts：${missing.join(', ')}`).toEqual([]);
  });

  it('清单里的每个 id 都真实注册（删除工具必须同步删清单）', () => {
    const scanned = new Set(registeredToolIds());
    const ghosts = ANIC_TOOL_IDS.filter((id) => !scanned.has(id));
    expect(ghosts, `清单里有幽灵工具（代码里没有）：${ghosts.join(', ')}`).toEqual([]);
  });

  it('集合完全相等（双向比对，顺序无关）', () => {
    expect([...ANIC_TOOL_IDS].sort()).toEqual(registeredToolIds());
  });

  it('清单无重复且全部匹配 anic_ 形状', () => {
    expect(new Set(ANIC_TOOL_IDS).size).toBe(ANIC_TOOL_IDS.length);
    for (const id of ANIC_TOOL_IDS) {
      expect(id).toMatch(/^anic_[a-z][a-z0-9_]*$/);
    }
  });
});

describe('契约：角色卡 toolsAllowlist 存在性', () => {
  const { cards, errors } = loadAgentCards(AGENTS_DIR);

  it('15 张出厂卡全部合法装载（含存在性校验）', () => {
    expect(errors).toEqual([]);
    expect(cards).toHaveLength(15);
  });

  it('每张卡的白名单项都是真实存在的工具 id', () => {
    for (const card of cards) {
      const ghosts = unknownToolIds(card.toolsAllowlist);
      expect(ghosts, `${card.id} 引用了不存在的工具：${ghosts.join(', ')}`).toEqual([]);
      for (const id of card.toolsAllowlist) {
        expect(isAllowedToolId(id)).toBe(true);
      }
    }
  });

  it('白名单只含只读工具（doc13 §2.2：写端点须逐个显式列名，卡内默认不授予）', () => {
    // 只读面：状态/快照/自检。三者都不写工作区（snapshot/status/self-check 均只读）。
    const READ_ONLY = new Set(['anic_status', 'anic_snapshot', 'anic_self_check']);
    for (const card of cards) {
      for (const id of card.toolsAllowlist) {
        expect(READ_ONLY.has(id), `${card.id} 的 ${id} 不在只读面内——写端点需显式评审`).toBe(true);
      }
    }
  });

  it('幽灵工具 id 会被装载期拒绝（存在性校验的执行点存在）', () => {
    const ghost = {
      id: 'anic.agent.intent.planner',
      role: 'planner',
      gate: 'intent',
      systemPrompt: '这是一个足够长的系统提示，用于通过 >=20 字符的形状校验。',
      toolsAllowlist: ['anic_this_tool_does_not_exist'],
      autonomyBand: 'L2',
      outputContract: '闭合 JSON 契约足够长',
      escalation: '升级人类门',
    };
    const r = validateAgentCard(ghost, 'ghost.json');
    expect(r.card).toBeUndefined();
    expect(r.errors.join(' ')).toContain('unknown tool id');
    expect(r.errors.join(' ')).toContain('anic_this_tool_does_not_exist');
  });

  it('形状非法仍先被形状校验拦下（两级校验，不互相掩盖）', () => {
    const bad = {
      id: 'anic.agent.intent.planner',
      role: 'planner',
      gate: 'intent',
      systemPrompt: '这是一个足够长的系统提示，用于通过 >=20 字符的形状校验。',
      toolsAllowlist: ['Bash', 'anic-evaluate'],
      autonomyBand: 'L2',
      outputContract: '闭合 JSON 契约足够长',
      escalation: '升级人类门',
    };
    const r = validateAgentCard(bad, 'bad.json');
    expect(r.card).toBeUndefined();
    expect(r.errors.join(' ')).toContain('must be an array of tool ids matching');
  });
});

/**
 * 契约：工具面参考册 ⇄ 注册代码（cycle-71 T-7104）。
 *
 * **为什么加这条**：19 个工具有 `toolIds.ts` 清单守卫（源码 ⇄ 清单），但
 * **文档册没有任何同步触发器**——cycle-67 的 apiDocShapeContract 已证明这个
 * 形态会在协议扩展时静默落后四轮（「API 册停在 cycle-97」先例）。
 * `docs/agents/工具面参考.md` 是本仓此前**完全缺失**的一册（19 工具零覆盖，
 * skill-eco 研究实证），新册若无守卫，下一次加工具必然漂移。
 *
 * 判据：文档 §2 各表中的 `` `anic_xxx` `` 反引号 token 集合 === 注册代码集合。
 * 双向相等（多写=文档臆造 / 漏写=文档缺口都红），不允许单向 contain 吞掉。
 */
describe('契约：工具面参考册 ⇄ 注册代码（双向）', () => {
  const doc = readFileSync(fileURLToPath(new URL('../../docs/agents/工具面参考.md', import.meta.url)), 'utf-8');

  /** 从文档提取反引号包裹的 anic_* token（本册以 `anic_xxx` 形态列工具）。 */
  function documentedToolIds(): Set<string> {
    const ids = new Set<string>();
    for (const m of doc.matchAll(/`(anic_[a-z0-9_]+)`/g)) {
      if (m[1]) ids.add(m[1]);
    }
    return ids;
  }

  it('扫描集非空（文档格式漂移 = 解析空集，直接拦）', () => {
    expect(documentedToolIds().size).toBeGreaterThanOrEqual(15);
  });

  it('文档里的每个工具 id 都真实注册（文档臆造 = 红）', () => {
    const scanned = new Set(registeredToolIds());
    const fabricated = [...documentedToolIds()].filter((id) => !scanned.has(id));
    expect(fabricated, `文档写了但代码里没有的工具：${fabricated.join(', ')}`).toEqual([]);
  });

  it('注册的每个工具在文档中都有记载（新增工具必须补册 = 红）', () => {
    const documented = documentedToolIds();
    const undocumented = registeredToolIds().filter((id) => !documented.has(id));
    expect(undocumented, `注册了但工具面参考册未记载：${undocumented.join(', ')}`).toEqual([]);
  });

  it('集合完全相等（双向；顺序无关）', () => {
    expect([...documentedToolIds()].sort()).toEqual(registeredToolIds());
  });
});
