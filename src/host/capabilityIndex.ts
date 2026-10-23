/**
 * 能力索引（cycle-73 T-7301）—— 「注册↔索引」的**单一投影**。
 *
 * 用户诉求（原文）：「生成一份技能/skill、mcp 等工具的**轻量索引 + 按需加载 + 渐进式披露**」。
 * 本模块只做**索引那一半**（可离线机器验证的那一半）；激活那一半需要真机探针
 *（见 docs/agents/渐进式披露与轻量索引设计.md §3.4 与 §4 的 A0/A1），未验证前不落地。
 *
 * 纪律（承 design §3.1，逐条可查）：
 *   ① **投影而非第二真相源**：真相在注册处（src/host/tools*.ts 的 name/description/parameters）。
 *      本模块只把「注册处的形状」投影成两份产物，并由契约测试做**双向**比对。
 *   ② **注入面与校验面分离**：模型要用什么才进上下文，校验用的东西不进。
 *      → 注入面（injectable）只含 id + 摘要 + 脚本裸名；schema 哈希进 sidecar，**永不进上下文**。
 *   ③ **绝不含 parameters 与完整 description**：实测 params 占模型面 47%（design §1.1），
 *      含则收益归零。
 *   ④ **摘要不冒充 description**：description 是**触发条件**（SDO 纪律，tools.ts 各工具的
 *      「Triggers:」行，供 trigger-eval 用）；摘要（summary）是**能力语**。二者语义不同、
 *      **不得互相自动派生**——派生会毁掉 trigger-eval 的区分度（24/24 recall / FPR 0/14）。
 *      故摘要是**手写策展表**（TOOL_SUMMARIES），并由守卫钉死：
 *      (a) id 集与注册面双向相等；(b) 每条 ≤ SUMMARY_MAX_CHARS；(c) **不得等于** description。
 *
 * 体积（design §3.1 实测口径）：注入面目标 ≤ 2 KB（基线 11,738 B → 净减 ≈82.9%）。
 */
import { createHash } from 'node:crypto';

/** 索引资产版本（与 package.json version **解耦**：只记 commit 供 stale 判定）。 */
export const CAPABILITY_INDEX_VERSION = 1;

/** 摘要字数上限——design §3.1：40 字符是「模型能据此选工具」的下限（再瘦会靠猜名字选工具）。 */
export const SUMMARY_MAX_CHARS = 40;

/**
 * 工具能力摘要（**手写策展**，勿从 description 派生——见文件头纪律④）。
 *
 * 写作口径：能力语（这个工具**能做什么**），不是触发词（什么时候用）——
 * 触发词留在注册处的 description 里给 trigger-eval 用。
 */
export const TOOL_SUMMARIES: Record<string, string> = {
  anic_autonomy_downgrade: '降级自主级别（熔断回退路径）',
  anic_bootstrap: '插件自举：评估自身并产出改进提案',
  anic_bootstrap_analyze: '自举编排 + 模块引擎深度分析',
  anic_bootstrap_cycle: '自举链：评估→门禁→修复 自动驱动循环',
  anic_evaluate: '跑 E1-E8/Q1-Q8 评估并写评估报告',
  anic_flows_advance: '推进流程状态机到下一状态',
  anic_flows_archive: '归档已完成的循环工作区',
  anic_flows_auto_fix: '自动修复循环：失败→根因→重试',
  anic_flows_gate_check: '跑 G0-G3 收敛门禁判定',
  anic_flows_hitl: 'H1-H4 人工门禁自动审计',
  anic_gate_check: '门禁判定并写入哈希链账本',
  anic_hitl: '人工门禁审计队列（待裁决项）',
  anic_install: '把技能安装到目标工作区',
  anic_iterate: '评估 + 门禁 微迭代（跨项目）',
  anic_self_check: '插件自检：工件与账本一致性',
  anic_skill: '按白名单直调技能脚本（唯一全量可见通道）',
  anic_skill_repair: '修复技能安装副本与内联版本的差异',
  anic_snapshot: '取工作流快照（图数据 + 计数）',
  anic_status: '插件运行状态、调用流与技能健康',
};

/** 注册面的一条工具（只取索引与校验需要的三字段）。 */
export interface ToolFace {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 注入面（进上下文，必须极简）。 */
export interface CapabilityIndexInjectable {
  v: number;
  commit: string;
  /** [id, 摘要] 对——**不含** description/parameters。 */
  tools: Array<[string, string]>;
  /** 技能脚本裸名（= listSkillScripts()，15 个；mcp-server 是传输层，不入索引）。 */
  scripts: string[];
}

/** 校验面（**不进上下文**，供失效判定与 A5 一致性命验使用）。 */
export interface CapabilityHashes {
  v: number;
  commit: string;
  /** id → 'sha256:<hex>'（canonical description + parameters）。 */
  hashes: Record<string, string>;
}

/** 递归规范化 JSON：对象键**排序**，保证同一形状恒得同一串（哈希可比）。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** 一条工具的 canonical JSON（description + parameters，键排序）。 */
export function canonicalToolJson(face: ToolFace): string {
  return JSON.stringify(canonicalize({ description: face.description, parameters: face.parameters }));
}

/** 一条工具的 schema 哈希（'sha256:<hex>'）。 */
export function schemaHash(face: ToolFace): string {
  return 'sha256:' + createHash('sha256').update(canonicalToolJson(face), 'utf8').digest('hex');
}

/** 索引构建结果（两份产物 + 注入面字节数）。 */
export interface CapabilityIndexBuild {
  injectable: CapabilityIndexInjectable;
  hashes: CapabilityHashes;
  /** 注入面字节数（UTF-8，用于 A2/A9 的体积棘轮）。 */
  injectedBytes: number;
}

/**
 * 从**注册面**投影出两份索引产物。
 *
 * `tools` 的**顺序即注册序**（投影保序，便于 diff）；摘要有缺失即抛——
 * 索引漏一个工具就是「注册了但不被发现」，正是本轮要消灭的形态（fail-closed）。
 */
export function buildCapabilityIndex(
  tools: ToolFace[],
  scripts: string[],
  commit: string,
): CapabilityIndexBuild {
  const missing = tools.filter((f) => !TOOL_SUMMARIES[f.name]).map((f) => f.name);
  if (missing.length > 0) {
    throw new Error('capability index: missing summary for ' + missing.join(', '));
  }
  const injectable: CapabilityIndexInjectable = {
    v: CAPABILITY_INDEX_VERSION,
    commit,
    tools: tools.map((f) => [f.name, TOOL_SUMMARIES[f.name] as string] as [string, string]),
    scripts: [...scripts],
  };
  const hashes: CapabilityHashes = {
    v: CAPABILITY_INDEX_VERSION,
    commit,
    hashes: Object.fromEntries(tools.map((f) => [f.name, schemaHash(f)])),
  };
  return {
    injectable,
    hashes,
    injectedBytes: Buffer.byteLength(JSON.stringify(injectable), 'utf8'),
  };
}

/** 摘要策展表与注册面的一致性（守卫调用；返回问题清单，空 = 通过）。 */
export function summaryIssues(tools: ToolFace[]): string[] {
  const issues: string[] = [];
  const ids = new Set(tools.map((f) => f.name));
  for (const f of tools) {
    const s = TOOL_SUMMARIES[f.name];
    if (!s) { issues.push(f.name + ': 缺摘要'); continue; }
    if (s.length > SUMMARY_MAX_CHARS) issues.push(f.name + ': 摘要超长 ' + String(s.length));
    if (s === f.description) issues.push(f.name + ': 摘要等于 description（疑似派生）');
  }
  for (const id of Object.keys(TOOL_SUMMARIES)) {
    if (!ids.has(id)) issues.push(id + ': 策展表有条目但注册面没有（臆造）');
  }
  return issues;
}
