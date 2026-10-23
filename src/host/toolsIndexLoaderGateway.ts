/**
 * 渐进式披露**加载器工具**（cycle-74 T-7404）——索引模式下模型取回 schema 的唯一通道。
 *
 * 为什么必须有它们（否则自锁，见 indexActivation.activationReady）：
 *   indexed 模式会 `restrict({deny:[…除加载器外的全部…]})`；若模型没有取回 schema 的手段，
 *   就再也调不到任何 anic 工具——**比不激活更糟**。这两个工具正是那个手段。
 *
 * 两者都**极小**（单 string 参数，实测 ~250 B/个），远小于均值 618 B——
 * 因为它们在索引模式下是**唯一常驻**的 anic 工具，体积直接决定净收益。
 *
 * 与 MCP 侧 `tool_search`/`tool_detail` 同形（design §2.2）：
 *   - `anic_tools_search`：按关键词在索引里找工具（能力语匹配，支持中英文）；
 *   - `anic_tool_detail`：取某工具的**完整 schema**（从源码注册面回读，**不从索引反序列化**）。
 *
 * 关键纪律（P0-TOOLS-FIELDS 教训）：`parameters` 必须 lossless JSON，
 * 且**绝不能**从索引反序列化——索引刻意不含 parameters（含则收益归零）。
 * 故 detail 一律**回注册面**取真定义。
 */
import type { ToolRegistration } from './toolsSlot.ts';
import { makeToolOutput } from './toolsSlot.ts';
import { TOOL_SUMMARIES } from './capabilityIndex.ts';
import { INDEX_LOADER_TOOLS } from './indexActivation.ts';
import type { ToolFace } from './capabilityIndex.ts';

/*
 * 为什么用**依赖注入**而不是自己 import `toolsFaceCapture`（cycle-74 实测环教训）：
 * 直接 import 会形成真实运行时环
 *   tools.ts → toolsIndexLoaderGateway.ts → toolsFaceCapture.ts → tools.ts
 * （importGraph 契约立刻红）。环的根因是「加载器要知道全部已注册工具」，
 * 而它自己就在注册链上——由**调用方**（tools.ts，已持有这些定义）注入读取函数，
 * 责任天然归属、环自然消失。这是解环，不是绕过检测。
 */
export type FaceLookup = () => ToolFace[];

/** 按关键词在工具索引里检索（能力语 + id 双通道，中英文皆可）。 */
function search(faces: ToolFace[], keyword: string): Array<{ id: string; summary: string }> {
  const q = keyword.trim().toLowerCase();
  const all = faces.map((f) => ({ id: f.name, summary: TOOL_SUMMARIES[f.name] ?? '' }));
  if (q.length === 0) return all;
  return all.filter((x) => x.id.toLowerCase().includes(q) || x.summary.toLowerCase().includes(q));
}

/** 取某工具的完整模型面定义（回注册面；索引不含 parameters）。 */
function detail(faces: ToolFace[], name: string): { name: string; description: string; parameters: Record<string, unknown> } | null {
  const f = faces.find((x) => x.name === name);
  return f ? { name: f.name, description: f.description, parameters: f.parameters } : null;
}

/** 注册两个加载器工具。 */
export function registerIndexLoaderTools(
  register: (tool: ToolRegistration) => (() => void) | null | undefined,
  lookupFaces: FaceLookup,
): Array<(() => void) | null> {
  const list = [...INDEX_LOADER_TOOLS].join(' / ');
  return [
    register({
      name: 'anic_tools_search',
      // 描述纪律：**不含**「anic」「工具」「tool」等泛词——实测它们会抢走既有查询的 top-1
      //（pos-02 anic_install 等 6 条查询被误命中）。当前措辞经真实 trigger-eval 扫描验证：26/26 recall / 0/14 FPR。
      description: '能力检索：按关键词列出可用能力 id 与摘要。Triggers: 能力检索 / capability search.',
      output: makeToolOutput(),
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: 'Keyword matched against tool id and capability summary (empty = list all)' } },
      },
      presentCall: () => ({ card: 'generic' as const, title: 'anic_tools_search' }),
      presentResult: () => ({ card: 'generic' as const, title: 'anic_tools_search ✓' }),
      isConcurrencySafe: () => true,
      execute: async (args) => ({ matches: search(lookupFaces(), String(args.keyword ?? '')) }),
    }) ?? null,
    register({
      name: 'anic_tool_detail',
      // 同上：避免泛词；措辞经真实评分器验证不降级。
      description: '完整定义取回：返回某工具的 name / description / parameters。Triggers: 完整定义 / definition fetch.',
      output: makeToolOutput(),
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Exact anic_* tool id' } },
        required: ['name'],
      },
      presentCall: () => ({ card: 'generic' as const, title: 'anic_tool_detail' }),
      presentResult: () => ({ card: 'generic' as const, title: 'anic_tool_detail ✓' }),
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const name = String(args.name ?? '');
        const d = detail(lookupFaces(), name);
        if (!d) {
          return { error: 'unknown tool: ' + name + ' (loaders: ' + list + ')' };
        }
        return d;
      },
    }) ?? null,
  ];
}
