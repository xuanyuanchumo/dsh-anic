/**
 * ANIC agent 角色卡 loader（docs/anic/13 §1 的 M1 落地切片 · A 族）。
 *
 * 域分配：本文件只做"卡的 schema 校验与装载"；卡的**内容**在 assets/agents/*.json
 * （出厂默认，anic_self_init 复制到 `.cycles/agents/` 供工作区覆盖，工作区优先）；
 * 编排配方（Team Lead 如何按门派子代理）在 docs/anic/agents/orchestration.md。
 *
 * 纪律（13 §1.2）：
 * - 卡 schema 闭合：未知字段/未知门/非法授权带 → 拒绝加载并响亮（INV-19），
 *   不静默跳过 —— 角色卡漂移是 R-34，必须在装载时拦截。
 * - toolsAllowlist 做**两级**校验（cycle-38 M2-a 落地）：形状（^anic_[a-z][a-z0-9_]*$）
 *   + 存在性（必须出现在 src/host/toolIds.ts 的 ANIC_TOOL_IDS 里）。此前只校验形状，
 *   于是 `anic_this_tool_does_not_exist` 这种语法合法的幽灵工具能进白名单——
 *   白名单因此只是装饰。存在性的单一真相源是注册代码，toolIds.ts 是其投影，
 *   由 tests/contract/toolIdsContract.test.ts 双向比对钉死。
 * - 诚实前提：agent preset 注册是宿主/部署概念，插件不发明 API —— DSH 调用
 *   本插件的三条路径见 13 §1.3（工具面/编排配方/HTTP 面）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isKnownToolId, unknownToolIds } from './toolIds.ts';

export const AGENT_GATES = ['intent', 'spec', 'plan', 'pr', 'release'] as const;
export type AgentGate = (typeof AGENT_GATES)[number];

export const AGENT_ROLES = ['planner', 'implementer', 'reviewer'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentCard {
  id: string;
  role: AgentRole;
  gate: AgentGate;
  systemPrompt: string;
  /** 可调用工具白名单（形状 + 存在性双校验，见 toolIds.ts） */
  toolsAllowlist: string[];
  /** 该角色的自主级上限（受授权带约束，12 §2.6） */
  autonomyBand: 'L1' | 'L2' | 'L3' | 'L4';
  /** 输出闭合契约（真 LLM 子代理必须产出该形状；INV-23 的 evidenceIds 在其中必填） */
  outputContract: string;
  /** 何时升级人类门（HITL 队列，12 §2.6） */
  escalation: string;
}

const TOOL_ID_RE = /^anic_[a-z][a-z0-9_]*$/;

/** 单卡校验：返回 { card } 或 { errors }（两者互斥；errors 非空即拒绝） */
export function validateAgentCard(raw: unknown, source: string): { card?: AgentCard; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { errors: [`${source}: card is not an object`] };
  const obj = raw as Record<string, unknown>;
  const REQUIRED: ReadonlyArray<keyof AgentCard> = [
    'id', 'role', 'gate', 'systemPrompt', 'toolsAllowlist', 'autonomyBand', 'outputContract', 'escalation',
  ];
  for (const key of REQUIRED) {
    if (!(key in obj)) errors.push(`${source}: missing field '${key}'`);
  }
  for (const key of Object.keys(obj)) {
    if (!REQUIRED.includes(key as keyof AgentCard)) errors.push(`${source}: unknown field '${key}' (closed schema, INV-19)`);
  }
  if (errors.length > 0) return { errors };

  if (typeof obj.id !== 'string' || obj.id.length === 0) errors.push(`${source}: 'id' must be a non-empty string`);
  if (!AGENT_ROLES.includes(obj.role as AgentRole)) {
    errors.push(`${source}: 'role' must be one of ${AGENT_ROLES.join('|')} (got '${String(obj.role)}')`);
  }
  if (!AGENT_GATES.includes(obj.gate as AgentGate)) {
    errors.push(`${source}: 'gate' must be one of ${AGENT_GATES.join('|')} (got '${String(obj.gate)}')`);
  }
  if (typeof obj.systemPrompt !== 'string' || obj.systemPrompt.length < 20) {
    errors.push(`${source}: 'systemPrompt' must be a string of >=20 chars`);
  }
  if (!Array.isArray(obj.toolsAllowlist) || obj.toolsAllowlist.some((t) => typeof t !== 'string' || !TOOL_ID_RE.test(t))) {
    errors.push(`${source}: 'toolsAllowlist' must be an array of tool ids matching ${TOOL_ID_RE}`);
  } else {
    // 存在性：语法合法但本插件没有的工具 id = 幽灵白名单项（fail-closed 拒绝装载）
    const ghosts = unknownToolIds(obj.toolsAllowlist as string[]);
    if (ghosts.length > 0) {
      errors.push(`${source}: 'toolsAllowlist' references unknown tool id(s): ${ghosts.join(', ')} (see src/host/toolIds.ts)`);
    }
  }
  if (typeof obj.autonomyBand !== 'string' || !/^L[1-4]$/.test(obj.autonomyBand)) {
    errors.push(`${source}: 'autonomyBand' must match /^L[1-4]$/`);
  }
  if (typeof obj.outputContract !== 'string' || obj.outputContract.length < 10) {
    errors.push(`${source}: 'outputContract' must be a string of >=10 chars`);
  }
  if (typeof obj.escalation !== 'string' || obj.escalation.length < 5) {
    errors.push(`${source}: 'escalation' must be a string of >=5 chars`);
  }
  if (errors.length > 0) return { errors };
  return {
    card: {
      id: obj.id as string,
      role: obj.role as AgentRole,
      gate: obj.gate as AgentGate,
      systemPrompt: obj.systemPrompt as string,
      toolsAllowlist: obj.toolsAllowlist as string[],
      autonomyBand: obj.autonomyBand as AgentCard['autonomyBand'],
      outputContract: obj.outputContract as string,
      escalation: obj.escalation as string,
    },
    errors: [],
  };
}

/**
 * 单条工具 id 是否为本插件真实注册的工具（调用点与测试共用同一判据）。
 */
export function isAllowedToolId(id: string): boolean {
  return TOOL_ID_RE.test(id) && isKnownToolId(id);
}

/**
 * 装载目录下全部 *.json 角色卡。
 * 任何一张卡非法 → 该卡进 errors（调用方响亮呈现），**其余卡不掩盖问题**：
 * errors 非空即视为装载失败（拒绝部分可用，S-11 家族语义）。
 */
export function loadAgentCards(dir: string): { cards: AgentCard[]; errors: string[] } {
  const errors: string[] = [];
  const cards: AgentCard[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (e) {
    return { cards: [], errors: [`agents dir unreadable: ${dir} (${e instanceof Error ? e.message : String(e)})`] };
  }
  if (files.length === 0) return { cards: [], errors: [`no agent cards found in ${dir}`] };
  const seenIds = new Set<string>();
  for (const file of files) {
    const path = join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e) {
      errors.push(`${file}: unparseable JSON (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const { card, errors: cardErrors } = validateAgentCard(raw, file);
    if (cardErrors.length > 0) {
      errors.push(...cardErrors);
      continue;
    }
    if (card) {
      if (seenIds.has(card.id)) {
        errors.push(`${file}: duplicate card id '${card.id}'`);
        continue;
      }
      seenIds.add(card.id);
      cards.push(card);
    }
  }
  return { cards, errors };
}
