/**
 * 工具面渐进式披露：模式解析与索引注入文本（cycle-74 T-7401）。
 *
 * 前置：A0′ **已 PASS**（cycle-73 零凭据真机，见 .cycles/tech-debt/cycle-73-a0-probe-result.md）：
 *   scoped ctx 上 restrict 生效（scope 视图 25→24、get(name,agent) 归 absent、全局不受影响、disposer 恢复）。
 * 故激活面（按需加载）的机制障碍已清除。
 *
 * **两半必须同轮落地（硬约束，design §6）**：
 *   只注入不激活 = 索引 1.5 KB **加上**全量 schema 11.7 KB ⇒ 净增 ~1.5 KB（有害）；
 *   注入 + 激活   = 索引 1.5 KB **替代**全量 schema   ⇒ 净减 ~10 KB（收益）。
 * 本模块提供两半共用的**模式判定**与**注入文本**；激活接线见 indexActivation.ts。
 *
 * 默认 'full'（零行为变更）——既有契约（toolIds/toolOutput/triggerEval/readmeNumbers）在默认下恒绿。
 */
import type { CapabilityIndexInjectable } from './capabilityIndex.ts';

/** 工具面披露模式。`full` = 现状（19 个工具 schema 全量可见）；`indexed` = 索引 + 按需激活。 */
export type ToolDisclosureMode = 'full' | 'indexed';

/** 解析模式：仅接受显式 'indexed'，其余（含缺失/非法）一律 'full'（fail-closed 到零变更）。 */
export function resolveDisclosureMode(raw: unknown): ToolDisclosureMode {
  return raw === 'indexed' ? 'indexed' : 'full';
}

/**
 * 从 `.cycles/config.yml` 的 `anic` 段读 `toolDisclosure` 键。
 *
 * 为什么走 config 而不是新配置面：INV-25（配置单入口）——第二个配置读取入口即架构违规。
 * 本函数只解析**已读入的内容**，不自己开文件（与 loadWorkspaceConfig 的分工一致）。
 */
export function getToolDisclosure(content: string | null): ToolDisclosureMode {
  if (!content) return 'full';
  const m = content.match(/^\s*toolDisclosure:\s*(\S+)\s*$/m);
  return resolveDisclosureMode(m && m[1] ? m[1].replace(/^['"]|['"]$/g, '') : undefined);
}

/** 索引注入文本的**纯函数**构造（离线可测；注册路径只负责把它挂上）。 */
export function buildIndexSectionText(index: CapabilityIndexInjectable): string {
  const tools = index.tools.map(([id, summary]) => '- ' + id + ' — ' + summary).join('\n');
  const scripts = index.scripts.join(', ');
  return [
    '## anic 能力索引（渐进式披露）',
    '',
    '本插件的工具当前处于**索引模式**：下面只列出能力摘要。要调用某个工具，请先用',
    '`anic_tool_detail` 取它的完整参数 schema 并激活，再用 `anic_tools_search` 按关键词检索。',
    '',
    '工具：',
    tools,
    '',
    '技能脚本（经 anic_skill 调用）：' + scripts,
  ].join('\n');
}

/** 注入面文本的 UTF-8 字节数（供 A2/A9 体积棘轮断言）。 */
export function indexSectionBytes(index: CapabilityIndexInjectable): number {
  return Buffer.byteLength(buildIndexSectionText(index), 'utf8');
}
