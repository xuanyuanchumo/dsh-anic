/**
 * 通道声明注册表（cycle-78 · WS-D「通道独占」白盒化 + 未声明棘轮）。
 *
 * ## 被修的缺口（本轮实测）
 * 闭环三态矩阵 `routes: 63 注册 / 17 代码消费 / 46 未消费`。这 46 条**不是死代码**，
 * 而是通道独占路由：消费方在 DSH 宿主 agent、外部 curl、运维脚本或 MCP 客户端，
 * 本仓源码里根本看不到调用点。问题是**机器无法区分**「已声明的运维通道」与
 * 「忘了接线的真缺口」——面板只能平铺「46 条未消费」，人无法据此行动。
 *
 * ## 声明 ≠ 豁免（本模块存在的唯一理由）
 * 声明把「我知道这条为什么没人读」变成**机器可读**的三元组：
 *   owner   谁维护这条通道（人/域 —— 出问题找谁）
 *   docRef  哪份文档的哪一节写了它（必须真实存在，且该节含路由字面量）
 *   reason  为什么本仓内没有消费方（业务上合法的通道型）
 * 三者缺一都不算声明。声明**不改变事实**：该项仍是 `consumed=false`、
 * 仍计入 `unconsumed`，只是从「未知缺口」搬到「已知通道」（bucket=declaredChannel）。
 * 新增路由**未声明即棘轮红**（closureAuditContract ③）：漏声明的人必须自己写清
 * owner/docRef/reason，而不是让缺口静默长大。
 *
 * ## 为什么 docRef 必须机器校验而不是只写字符串
 * 「指向某份文档」是最容易伪造的证据形态（写个不存在的锚点也看不出）。本模块的
 * `checkDocRef` 要求：文件在扫描集内 + 锚点能匹配到一个**真实标题** + 该标题所在章节
 * **正文含被声明的路由字面量**。三者同真才算有据——于是「声明了但文档没写」
 * 与「docRef 指错章节」都会被点名，不会静默通过。
 *
 * 纯数据 + 纯函数：不读盘（文本表由调用方传入）、不写盘、无副作用（R-31）。
 */

/** 一条通道声明（四元组缺一不可；空串由 validateDeclarationDocs 判红）。 */
export interface ChannelDeclaration {
  /** 路由字面量，必须与注册面完全一致（含前导 `/anic`）。 */
  route: string;
  /** 维护责任域/角色（出问题找谁）。 */
  owner: string;
  /** `docs/agents/<文件>#<路由字面量>` —— 锚点必须匹配真实标题且该节含该路由。 */
  docRef: string;
  /** 为什么本仓内没有生产代码消费方（业务合法性论证）。 */
  reason: string;
}

/**
 * 声明表（cycle-78 实测 46 条，逐条对应 `runClosureAudit` 的 routes 族未消费项）。
 *
 * 维护纪律：**只增不删**。路由被接上消费方后声明可保留（bucket 会自然转为 code），
 * 但**不得**为了让断言变绿而删声明——删声明等于把该路由重新扔回「未知缺口」。
 */
export const CHANNEL_DECLARATIONS: readonly ChannelDeclaration[] = [
  /* ── 周期面：外部调度器 / 运维脚本触发（docs/agents/API参考-周期面.md）── */
  { route: '/anic/cycle/init', owner: '周期面（运维/外部调度器）', docRef: 'docs/agents/API参考-周期面.md#/anic/cycle/init', reason: '外部触发新一轮循环初始化；本仓无生产代码调用方' },
  { route: '/anic/cycle/advance', owner: '周期面（运维/外部调度器）', docRef: 'docs/agents/API参考-周期面.md#/anic/cycle/advance', reason: '外部推进宏观相位；消费方是运维脚本而非插件代码' },
  { route: '/anic/cycle/close', owner: '周期面（运维/外部调度器）', docRef: 'docs/agents/API参考-周期面.md#/anic/cycle/close', reason: '外部收口一轮循环；消费方是运维脚本而非插件代码' },
  { route: '/anic/api/stack-probe', owner: '取证面（人类运维）', docRef: 'docs/agents/API参考-周期面.md#/anic/api/stack-probe', reason: '人工排障时取证调用栈；插件内部不调用自身端点' },
  /* ── 账本面：运维/脚本追加与校验（追加写即等于「由外部记账」）── */
  { route: '/anic/api/ledger/append', owner: '账本面（运维脚本）', docRef: 'docs/agents/API参考-周期面.md#/anic/api/ledger/append', reason: '外部脚本追加门禁账本条目；本仓读取方走文件而非该端点' },
  { route: '/anic/api/seg-ledger', owner: '分段账本面（运维脚本）', docRef: 'docs/agents/API参考-周期面.md#/anic/api/seg-ledger', reason: '运维查询分段账本；面板走 snapshot 而非该端点' },
  { route: '/anic/api/seg-ledger/append', owner: '分段账本面（运维脚本）', docRef: 'docs/agents/API参考-周期面.md#/anic/api/seg-ledger/append', reason: '外部脚本追加分段账本条目；本仓读取走文件' },
  { route: '/anic/api/seg-ledger/init', owner: '分段账本面（运维脚本）', docRef: 'docs/agents/API参考-周期面.md#/anic/api/seg-ledger/init', reason: '运维初始化分段账本；一次性运维动作' },
  { route: '/anic/api/seg-ledger/verify', owner: '分段账本面（运维脚本）', docRef: 'docs/agents/API参考-周期面.md#/anic/api/seg-ledger/verify', reason: '运维校验分段账本完整性；插件内校验走库函数' },
  /* ── 自举面：人类运维 / 外部调度器直调（docs/agents/API参考-自举与技能.md）── */
  { route: '/anic/self/evaluate', owner: '自举面（人类运维/外部调度器）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/self/evaluate', reason: '外部拉起自举评估；工具面走 in-process 而非本仓 HTTP 自调' },
  { route: '/anic/self/gate-check', owner: '自举面（人类运维/外部调度器）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/self/gate-check', reason: '外部拉起自举门禁；工具面走 in-process 而非本仓 HTTP 自调' },
  { route: '/anic/self/iterate', owner: '自举面（人类运维/外部调度器）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/self/iterate', reason: '外部跑一轮自举迭代；工具面走 in-process 而非本仓 HTTP 自调' },
  { route: '/anic/self/status', owner: '自举面（人类运维/外部调度器）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/self/status', reason: '外部查询自举状态；面板读 org-status 而非该端点' },
  { route: '/anic/self/dual-evaluate', owner: '双自举面（人类运维/外部调度器）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/self/dual-evaluate', reason: '外部双轨评估入口；工具面走 in-process 调用' },
  { route: '/anic/self/dual-advance', owner: '双自举面（人类运维/外部调度器）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/self/dual-advance', reason: '外部双轨推进入口；工具面走 in-process 调用' },
  { route: '/anic/self/dual-status', owner: '双自举面（人类运维/外部调度器）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/self/dual-status', reason: '外部查询双轨状态；面板不消费该端点' },
  /* ── 技能面：运维 CLI / MCP 客户端（技能脚本是外部进程，不写回插件源码）── */
  { route: '/anic/skill/list', owner: '技能面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/skill/list', reason: 'MCP/运维列技能；技能脚本以子进程形态存在，不在本仓源码引用' },
  { route: '/anic/skill/invoke', owner: '技能面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/skill/invoke', reason: 'MCP/运维调用技能脚本；消费方是外部进程' },
  { route: '/anic/skill/status', owner: '技能面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/skill/status', reason: '运维查询技能安装状态；面板走 org-status.skillIntegrity' },
  { route: '/anic/skill/repair', owner: '技能面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/skill/repair', reason: '运维修复技能安装双轨副本；一次性运维动作' },
  { route: '/anic/evaluate', owner: '技能脚本面（运维 CLI/MCP）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/evaluate', reason: '外部拉起技能评估脚本；本仓工具走 skillInvoker 而非该端点' },
  { route: '/anic/iterate', owner: '技能脚本面（运维 CLI/MCP）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/iterate', reason: '外部拉起技能迭代脚本；本仓工具走 skillInvoker 而非该端点' },
  { route: '/anic/api/truth-audit', owner: '反自欺面（人类运维/MCP 客户端）', docRef: 'docs/agents/API参考-自举与技能.md#/anic/api/truth-audit', reason: '反自欺体检入口，由人类/MCP 主动取证；插件不自调' },
  /* ── 进化/治理面：运维与 MCP 客户端（docs/agents/API参考-评审进化与治理.md）── */
  { route: '/anic/review', owner: '评审面（人类评审入口）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/review', reason: '人类评审入口；本仓无生产代码读取评审结果（人读）' },
  { route: '/anic/api/trust', owner: '进化面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/api/trust', reason: '运维查询信任分；面板走 org-status.trust' },
  { route: '/anic/api/autonomy', owner: '进化面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/api/autonomy', reason: '运维查询自主级/熔断；面板走 org-status.autonomy' },
  { route: '/anic/api/breakers', owner: '进化面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/api/breakers', reason: '运维查看/重置熔断器；工具面走 in-process' },
  { route: '/anic/api/tech-debt', owner: '进化面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/api/tech-debt', reason: '运维登记技术债；工具面走 in-process' },
  { route: '/anic/api/tech-debt/consume', owner: '进化面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/api/tech-debt/consume', reason: '运维消费技术债条目；工具面走 in-process' },
  { route: '/anic/autonomy/downgrade', owner: '进化面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/autonomy/downgrade', reason: '人类/运维降级自主级；工具面走 anic_autonomy_downgrade' },
  { route: '/anic/governance/archive', owner: '治理面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/governance/archive', reason: '运维归档循环；本仓无生产代码调用方' },
  { route: '/anic/governance/sweep', owner: '治理面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/governance/sweep', reason: '运维清理过期产物；一次性运维动作' },
  { route: '/anic/governance/prune', owner: '治理面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/governance/prune', reason: '运维裁剪历史；一次性运维动作' },
  { route: '/anic/band-detect', owner: '原生面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/band-detect', reason: '运维跑复杂度带检测；本仓走 anic_skill 脚本通道' },
  { route: '/anic/fact-base', owner: '原生面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/fact-base', reason: '运维校验事实基；本仓工具走 in-process' },
  { route: '/anic/plan-sync', owner: '原生面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/plan-sync', reason: '运维校验计划同步；本仓工具走 in-process' },
  { route: '/anic/multi-agent-gate', owner: '原生面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/multi-agent-gate', reason: '多 agent 门禁取证入口；工具面走 in-process' },
  { route: '/anic/fix-loop', owner: '原生面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/fix-loop', reason: '运维触发自动修复循环；工具面走 in-process' },
  { route: '/anic/flows', owner: '流程状态机面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/flows', reason: '运维列流程；面板走 snapshot 而非该端点' },
  { route: '/anic/flows/state', owner: '流程状态机面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/flows/state', reason: '运维查单流程状态；本仓读 flow-tracker.json' },
  { route: '/anic/flows/gate-check/run', owner: '流程状态机面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/flows/gate-check/run', reason: '运维经流程面跑门禁；工具面走 in-process' },
  { route: '/anic/flows/macro-phase/status', owner: '流程状态机面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/flows/macro-phase/status', reason: '运维查宏观相位；面板走 workflow-snapshot' },
  { route: '/anic/flows/macro-phase/advance', owner: '流程状态机面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/flows/macro-phase/advance', reason: '运维推进宏观相位；工具面走 anic_flows_advance' },
  { route: '/anic/flows/archive/run', owner: '流程状态机面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/flows/archive/run', reason: '运维归档循环产物；本仓工具走 in-process' },
  { route: '/anic/flows/hitl/run', owner: '流程状态机面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/flows/hitl/run', reason: '运维跑 HITL 三段修复；工具面走 anic_flows_hitl' },
  { route: '/anic/flows/auto-fix/run', owner: '流程状态机面（运维/MCP 客户端）', docRef: 'docs/agents/API参考-评审进化与治理.md#/anic/flows/auto-fix/run', reason: '运维跑自动修复循环；工具面走 anic_flows_auto_fix' },
  /* ── 运行时面：热更新重载（cycle-80；docs/agents/API参考-数据面.md §6）── */
  { route: '/anic/api/reload', owner: '运行时面（人类运维/外部脚本）', docRef: 'docs/agents/API参考-数据面.md#/anic/api/reload', reason: '外部运维在部署新 dist 后触发插件重载；本仓消费方是 anic_reload_self 工具（in-process），HTTP 面自身无本仓代码调用点' },
];

/** 路由 → 声明索引（一次建表；声明表本身保持只读顺序）。 */
const BY_ROUTE: ReadonlyMap<string, ChannelDeclaration> =
  new Map(CHANNEL_DECLARATIONS.map((d) => [d.route, d]));

/** 按路由查声明；未声明 → undefined（不编造默认值：默认值会让棘轮失去意义）。 */
export function findDeclaration(route: string): ChannelDeclaration | undefined {
  return BY_ROUTE.get(route);
}

/** 双向一致性结论（任一非空即守卫红）。 */
export interface DeclarationMismatch {
  /** 声明了、但注册面里不存在（幽灵声明：文档承诺了不存在的通道）。 */
  staleDeclarations: string[];
  /** 未消费、却没声明（**棘轮红**：新增路由忘了声明）。 */
  undeclaredRoutes: string[];
}

/**
 * 声明表 ⇄ 注册面**双向**一致性。
 *
 * @param registeredRoutes 注册面路由全集（判定「幽灵声明」）
 * @param unconsumedRoutes  未消费路由全集（判定「漏声明」，缺省 = registeredRoutes）
 * @param declarations      声明表（缺省 = 生产表；测试用**内存副本**做反向自检——
 *                          删一条声明必须让 undeclaredRoutes 立刻点名，否则棘轮是装饰）
 */
export function validateDeclarations(
  registeredRoutes: readonly string[],
  unconsumedRoutes: readonly string[] = registeredRoutes,
  declarations: readonly ChannelDeclaration[] = CHANNEL_DECLARATIONS,
): DeclarationMismatch {
  const registered = new Set(registeredRoutes);
  const unconsumed = new Set(unconsumedRoutes);
  const declared = new Set(declarations.map((d) => d.route));
  return {
    staleDeclarations: declarations.map((d) => d.route).filter((r) => !registered.has(r)).sort(),
    undeclaredRoutes: [...unconsumed].filter((r) => !declared.has(r)).sort(),
  };
}

/** 越界判定用的标题/字面量边界（与 scanPrimitives.boundaryContains 同判据，避免跨层 import 环）。 */
function hasToken(text: string, token: string): boolean {
  return new RegExp(token.split('.').join('\\.') + '(?![A-Za-z0-9_/.-])').test(text);
}

/**
 * 取「某个标题命中的章节正文」（标题行 → 下一个同级或更高级标题之前）。
 *
 * 为什么按**标题**而不是全文包含判定：docRef 的价值是「文档哪一节写了它」。
 * 若只要求全文任意位置出现路由字面量，一篇总目录（API参考.md 的表格）就能满足
 * 全部 46 条——那等于没有证据。要求锚点命中标题，把声明钉到**具体章节**上。
 */
export function routeSection(docText: string, token: string): string | null {
  const lines = docText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head === null) continue;
    // 标题里的反引号是排版符号，不是字面量的一部分（`/anic/x` → /anic/x）。
    const normalized = (head[2] ?? '').split('`').join('');
    if (!hasToken(normalized, token)) continue;
    const level = (head[1] ?? '#').length;
    let end = i + 1;
    while (end < lines.length) {
      const next = /^(#{1,6})\s/.exec(lines[end] as string);
      if (next !== null && (next[1] ?? '#').length <= level) break;
      end += 1;
    }
    return lines.slice(i, end).join('\n');
  }
  return null;
}

/**
 * 校验单条 docRef（返回 `null` = 有据，否则一句人话原因）。
 *
 * 三重判据全部机器可判：① 文件在扫描集内（不是脑子里想象的文件）；
 * ② 锚点能匹配到一个真实标题；③ 该标题所在章节正文含被声明的路由字面量。
 * 第 ③ 条同时挡住「docRef 指到别的路由章节」这种最难肉眼发现的伪证。
 */
export function checkDocRef(decl: ChannelDeclaration, files: ReadonlyMap<string, string>): string | null {
  const hashAt = decl.docRef.indexOf('#');
  if (hashAt <= 0) return 'docRef 缺 #章节锚：' + decl.docRef;
  const rel = decl.docRef.slice(0, hashAt);
  const fragment = decl.docRef.slice(hashAt + 1);
  if (fragment.trim() === '') return 'docRef 章节锚为空：' + decl.docRef;
  const text = files.get(rel);
  if (text === undefined) return 'docRef 文件不在扫描集：' + rel;
  const section = routeSection(text, fragment);
  if (section === null) return 'docRef 锚点在文档中无对应标题：' + decl.docRef;
  if (!hasToken(section, decl.route)) return 'docRef 章节正文未提到该路由：' + decl.docRef;
  return null;
}

/**
 * 声明表体检：字段非空 + 无重复 + 每条 docRef 有据。返回问题清单（空 = 全绿）。
 *
 * 为什么把「字段非空」也算问题：`owner: ''` 是形式上的声明、实质上的豁免
 * ——本模块存在的目的正是消灭这种「看起来声明了」的形态。
 */
export function validateDeclarationDocs(
  files: ReadonlyMap<string, string>,
  declarations: readonly ChannelDeclaration[] = CHANNEL_DECLARATIONS,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const d of declarations) {
    if (d.owner.trim() === '') problems.push(d.route + '：owner 为空（等于没人负责）');
    if (d.reason.trim() === '') problems.push(d.route + '：reason 为空（等于没解释）');
    if (seen.has(d.route)) problems.push(d.route + '：声明重复');
    seen.add(d.route);
    const p = checkDocRef(d, files);
    if (p !== null) problems.push(d.route + '：' + p);
  }
  return problems;
}
