/**
 * 闭环体检：技能/MCP 面（**第四族**）——cycle-75 T6。此前三族对技能脚本面与 MCP 面
 * **零覆盖**（实测：capability-index.json 有 scripts(15) 而提到 mcp 0 次）。
 *
 * 注册表（纪律①）= `assets/skill/scripts/*.mjs` 真实文件清单（16 = 15 业务 + 1 传输层），
 * 不是手写数组。两锚点分开记——declaredAt = 宿主白名单条目（能否被 anic_skill 调度）；
 * producedAt = 脚本入口执行体 `parseCliArgs(`（真能被 node 跑起来）。传输层 mcp-server
 * 有意不在白名单（anic_skill 拒绝调度）⇒ declaredAt=null：它自为 MCP server 进程，由
 * 用户/宿主写进 mcpServers 配置启动。
 *
 * 消费面分级（纪律④，显性更正两处**既往噪声源**）——真消费 = src/ 调度点（flows/*、
 * runtime/*、routes/skillRoute、toolsSkillGateway）+ bin/ 拉起指引；**不算**消费：
 * tests/（只证明脚本可加载）、docs/ 与任何 .md、locale/、**assets/**（capability-index.json
 * 的 scripts 数组是**投影回声**：生成器从 listSkillScripts() 抄出，无读取方据此调用脚本）、
 * **src/host/closureAudit/*（扫描器自指——别族证据里出现 `capabilityIndex.ts` 即此噪声）**。
 * 证据三级（invoke 真调用点 > path `.mjs` 路径 > literal 身份字面量）；只有精确引号
 * `'<id>'` 或 `<id>.mjs` 命中——`/anic/org-status` 这类**同名路由**不再冒充脚本消费。
 *
 * 诚实边界：MCP 面在本仓内**无任何代码启动**（纪律⑤，不硬算 consumed）；mcpSurface()
 * 给出清单来源 / 分发面 / 清单⇄分发⇄runScript 成对性 / 谁教启动。纯只读（R-31），
 * 不 import 父工程 src（G-IND）。
 */
import type { ClusterAudit, ClosureItem } from './closureModel.ts';
import { assertScanNonEmpty, kindOf, quoteClasses, stripComments, tallyProduced } from './scanPrimitives.ts';

/** 宿主白名单文件（业务脚本「能否被调度」的声明面）。 */
export const SKILL_WHITELIST_FILE = 'src/host/skillInvoker.ts';
/** 传输层脚本裸名——三集合唯一已知差集（自为 MCP server，不被 spawn）。 */
export const TRANSPORT_LAYER_SCRIPT = 'mcp-server';
/** 传输层文件（工具清单与分发器的登记处）。 */
export const MCP_SERVER_FILE = 'assets/skill/scripts/mcp-server.mjs';

const SCRIPTS_PREFIX = 'assets/skill/scripts/';
const SCRIPT_FILE_RE = /^assets\/skill\/scripts\/([^/]+)\.mjs$/;
/** 入口执行体原语：16 个脚本统一经 lib/args.mjs 的 parseCliArgs 进入。 */
const ENTRY_MARK = 'parseCliArgs(';
const LIST_TOOLS_MARK = 'setRequestHandler(ListToolsRequestSchema';
const CALL_TOOL_MARK = 'setRequestHandler(CallToolRequestSchema';
/** 真调用原语：宿主/传输层的调度入口（区别于散文里的路径提及）。 */
const CALL_PRIMITIVE_RE = /(?:invokeSkillScript(?:Async)?|runScript|spawn(?:Sync)?)\s*\(/;
const MAX_EVIDENCE = 3;
/** 参考收集上限（先多收再按级别取前 3——真调用点不得被弱字面量挤掉）。 */
const REF_SCAN_CAP = 9;
const Q = quoteClasses();
const HAS_QUOTE = new RegExp('[' + Q + ']');
const EXACT_QUOTED = new RegExp('[' + Q + ']([a-z][a-z0-9-]*)[' + Q + ']');
const TOOL_NAME_RE = /\bname:\s*["']([a-z][a-z0-9_]*)["']/g;

/** 索引 → 行号（1 起）；输入为**去注释**文本（保留换行，行号与磁盘一致）。 */
function lineAt(text: string, idx: number): number {
  return text.slice(0, Math.min(idx, text.length)).split('\n').length;
}

function scriptIdOf(rel: string): string | null {
  const m = SCRIPT_FILE_RE.exec(rel);
  return m && m[1] ? m[1] : null;
}

/** 脚本文件**真实清单**（出厂 .mjs 裸名，排序）——本族唯一注册表。 */
export function scanSkillScriptFiles(files: Map<string, string>): string[] {
  return [...files.keys()].map(scriptIdOf).filter((x): x is string => x !== null).sort();
}
/**
 * 宿主白名单声明表（id → file:line）。只在 `const SKILL_SCRIPTS = [ … ]` 块内扫（整文件扫会
 * 命中 `path.join(…,'assets','skill')` 这类无关小写字面量 = 幽灵白名单），且**去注释**。
 * 块缺失 ⇒ 空表，由调用方 assertScanNonEmpty 响亮抛错（不静默降级）。
 */
export function scanSkillWhitelist(files: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const raw = files.get(SKILL_WHITELIST_FILE);
  if (raw === undefined) return out;
  const text = stripComments(raw);
  const head = text.indexOf('const SKILL_SCRIPTS');
  const block = /const SKILL_SCRIPTS\s*=\s*\[([\s\S]*?)\];/.exec(text);
  if (head < 0 || !block || block[1] === undefined) return out;
  const base = text.slice(0, head).split('\n').length;
  const lines = block[1].split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = EXACT_QUOTED.exec(lines[i] as string);
    if (m && m[1]) out.set(m[1], SKILL_WHITELIST_FILE + ':' + String(base + i));
  }
  return out;
}

/** 脚本入口执行体行号表（`parseCliArgs(`）——「产出了可执行的东西」的证据锚点。 */
export function scriptEntrySites(files: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of [...files.keys()].sort()) {
    const id = scriptIdOf(rel);
    if (id === null) continue;
    const text = stripComments(files.get(rel) as string);
    const at = text.indexOf(ENTRY_MARK);
    if (at >= 0) out.set(id, rel + ':' + String(lineAt(text, at)));
  }
  return out;
}

/** 消费面：真读取方 = src（非扫描器）/ scripts / bin；投影、测试、文档、技能自身一律不计。 */
function skillConsumerUniverse(rel: string): boolean {
  if (rel.startsWith('src/host/closureAudit/')) return false;
  if (rel.startsWith('tests/') || rel.startsWith('docs/') || rel.startsWith('locale/')) return false;
  if (rel.startsWith('assets/')) return false;
  if (rel.endsWith('.md') || rel.endsWith('.json')) return false;
  return /^(src|scripts|bin)\//.test(rel);
}

/** 候选消费文件的**去注释**文本（行号与磁盘一致）；空集由调用方响亮抛错。 */
function consumerTexts(files: Map<string, string>, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [rel, raw] of files) {
    if (!skillConsumerUniverse(rel)) continue;
    if (!ids.some((id) => raw.indexOf(id) >= 0)) continue;
    out.set(rel, stripComments(raw));
  }
  return out;
}

/** 引用级别：invoke = 真调用点；path = `.mjs` 路径形态；literal = 身份字面量。 */
export type ScriptRefTier = 'invoke' | 'path' | 'literal';
export interface ScriptRef { at: string; tier: ScriptRefTier; }
const TIER_ORDER: Record<ScriptRefTier, number> = { invoke: 0, path: 1, literal: 2 };

/**
 * 脚本引用扫描（每文件最多 1 条，按路径确定序）。命中条件：精确引号 `'<id>'` 或 `<id>.mjs`
 * 形态（防同名路由/散文误报）。`max` 是**收集**上限；取证据前按 tier 排序（topRefs）。
 */
export function scanScriptRefs(stripped: Map<string, string>, id: string, max = REF_SCAN_CAP): ScriptRef[] {
  const quoted = new RegExp('[' + Q + ']' + id.replace(/[-]/g, '\\-') + '[' + Q + ']');
  const asFile = id + '.mjs';
  const out: ScriptRef[] = [];
  for (const rel of [...stripped.keys()].sort()) {
    const lines = (stripped.get(rel) as string).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      if (!HAS_QUOTE.test(line)) continue;
      const isFile = line.indexOf(asFile) >= 0;
      if (!quoted.test(line) && !isFile) continue;
      const tier: ScriptRefTier = CALL_PRIMITIVE_RE.test(line) ? 'invoke' : (isFile ? 'path' : 'literal');
      out.push({ at: rel + ':' + String(i + 1), tier });
      break;
    }
    if (out.length >= max) break;
  }
  return out;
}

/** 按级别取前 n 条引用（同级别内按路径序）——真调用点不得被弱字面量挤掉。 */
export function topRefs(refs: readonly ScriptRef[], n = MAX_EVIDENCE): ScriptRef[] {
  return [...refs].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
    || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, n);
}

/** MCP 面真值（工具清单来源 / 分发面 / 成对性 / 本仓内谁碰它）。 */
export interface McpSurface {
  server: string; declaredAt: string; dispatchAt: string;
  declaredTools: string[]; dispatchCases: string[]; consumers: string[];
  declaredWithoutDispatch: string[]; dispatchWithoutDeclared: string[]; declaredWithoutWiring: string[];
  consumed: boolean; note: string;
}
/**
 * MCP 传输层真值。清单与分发**必须成对**（只有清单 = 工具声明了却不可调；只有分发 =
 * 幽灵工具），且每个分发分支必须落到 runScript（否则该 MCP 工具什么都做不了）。
 * 文件或两个 handler 缺失 ⇒ 响亮抛错（MCP 面是本族注册表成员，缺它即注册表损坏）。
 */
export function mcpSurface(files: Map<string, string>, strippedConsumers: Map<string, string>): McpSurface {
  const raw = files.get(MCP_SERVER_FILE);
  if (raw === undefined) throw new Error('closure audit: mcp transport missing: ' + MCP_SERVER_FILE);
  const text = stripComments(raw);
  const li = text.indexOf(LIST_TOOLS_MARK);
  const ci = text.indexOf(CALL_TOOL_MARK);
  if (li < 0 || ci < 0 || ci <= li) throw new Error('closure audit: mcp transport handlers not found (guard must fail loudly)');
  const declaredTools = [...text.slice(li, ci).matchAll(TOOL_NAME_RE)].map((m) => m[1] as string);
  const caseBodies = new Map<string, string>();
  const parts = text.slice(ci).split(/\bcase\s+["']/);
  for (let i = 1; i < parts.length; i += 1) {
    const m = /^([a-z][a-z0-9_]*)["']/.exec(parts[i] as string);
    if (m && m[1]) caseBodies.set(m[1], parts[i] as string);
  }
  const dispatchCases = [...caseBodies.keys()];
  const declaredAt = MCP_SERVER_FILE + ':' + String(lineAt(text, li));
  const dispatchAt = MCP_SERVER_FILE + ':' + String(lineAt(text, ci));
  const consumers = scanScriptRefs(strippedConsumers, TRANSPORT_LAYER_SCRIPT, 50).map((r) => r.at);
  return {
    server: MCP_SERVER_FILE, declaredAt, dispatchAt, declaredTools, dispatchCases, consumers,
    declaredWithoutDispatch: declaredTools.filter((t) => !dispatchCases.includes(t)),
    dispatchWithoutDeclared: dispatchCases.filter((t) => !declaredTools.includes(t)),
    declaredWithoutWiring: declaredTools.filter((t) => !/runScript\s*\(/.test(caseBodies.get(t) ?? '')),
    consumed: consumers.length > 0,
    note: 'MCP 工具清单来源=本文件 ' + String(declaredTools.length) + ' 条 name 字面量 @' + declaredAt
      + '；分发=' + String(dispatchCases.length) + ' 个 case @' + dispatchAt
      + '；本仓内无 src 启动点（consumers 仅 bin 用户指引 ⇒ 通道级）',
  };
}
/** 本族口径注（供编排层并入 notes；集中在扫描器侧，避免口径两处维护）。 */
export const SKILL_CLOSURE_NOTES: readonly string[] = [
  '技能族注册表 = `assets/skill/scripts/*.mjs` 真实文件清单（15 业务 + 1 传输层）；declaredAt 取'
  + '宿主白名单、producedAt 取脚本入口执行体 parseCliArgs(，两锚点分开记。',
  '`capability-index.json` 的 scripts 数组是**投影回声**（生成器从 listSkillScripts() 抄出），'
  + '不是消费方；tests/docs 亦然（只证明脚本可加载）。',
  'MCP 面：mcp-server 在本仓内无启动点（只被 bin 用户指引提到、被测试加载）⇒ 通道级消费；'
  + '其清单来源与清单⇄分发成对性见 mcpSurface()。',
];
/** 技能/MCP 族（第四族）：15 业务脚本 + 1 传输层。 */
export function skillClosure(files: Map<string, string>): ClusterAudit {
  const ids = scanSkillScriptFiles(files);
  assertScanNonEmpty(ids.length, 'skill-script-files');
  const whitelist = scanSkillWhitelist(files);
  assertScanNonEmpty(whitelist.size, 'skill-script-whitelist');
  const entries = scriptEntrySites(files);
  assertScanNonEmpty(entries.size, 'skill-script-entries');
  const consumers = consumerTexts(files, ids);
  assertScanNonEmpty(consumers.size, 'skill-consumer-universe');
  const mcp = mcpSurface(files, consumers);
  const items: ClosureItem[] = ids.map((id) => {
    const rel = SCRIPTS_PREFIX + id + '.mjs';
    const declaredAt = whitelist.get(id) ?? null;
    const entry = entries.get(id) ?? null;
    const evidence = topRefs(scanScriptRefs(consumers, id)).map((r) => r.at);
    const produced = entry !== null;
    return {
      cluster: 'skills',
      id,
      definedAt: declaredAt ?? rel + ':1',
      producedAt: produced ? entry : null,
      producedKind: produced ? 'handler-in-file' : 'declaration-only',
      // 传输层另有两条产出锚点：清单登记处 + 分发 handler（它是 MCP 面的生产本体）。
      producedEvidence: produced
        ? (id === TRANSPORT_LAYER_SCRIPT ? [entry as string, mcp.declaredAt, mcp.dispatchAt] : [entry as string])
        : [],
      consumed: evidence.length > 0,
      evidenceKind: kindOf(evidence),
      dynamic: false,
      evidence,
    };
  });
  const consumed = items.filter((it) => it.consumed).length;
  const codeConsumed = items.filter((it) => it.evidenceKind === 'code').length;
  return {
    cluster: 'skills',
    unit: 'skill script / MCP transport',
    total: items.length,
    consumed,
    codeConsumed,
    unconsumed: items.length - consumed,
    producedByKind: tallyProduced(items),
    items,
  };
}
