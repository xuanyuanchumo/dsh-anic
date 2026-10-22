/**
 * 破坏性命令扫描域（diff 新增行）—— H2 插件增强的独立实现（cycle-71 T3 拆分）。
 *
 * 本文件是「破坏性命令行」判定的**唯一实现**：词形匹配（cycle-68 词边界）+
 * 引用上下文分类（cycle-71 降敏）。从 governance/hitlAudit.ts 拆出——母文件
 * 290 行触 250 模块纪律（truthAudit T3 红），且「扫什么」与「怎么裁决」是
 * 两个变更原因不同的域。
 *
 * ── cycle-68 词边界修复 ──
 * 旧 `/TRUNCATE/i` 无词边界——locale 键 `groupTruncated` 与英文 `truncated`/
 * `truncates` 等变形均被子串命中，cycle-47 真机旅程时工作树 diff 恰含 2 行
 * groupTruncated locale 新增 → 「Destructive commands in diff: 2 line(s)」假
 * 熔断 → 审计日志「历史遗留 H2 熔断·待人工」逐轮复制挂账 20 轮。词边界后：
 * SQL 命令形态（TRUNCATE / TRUNCATE TABLE）才命中；truncated 的 E→d 与
 * groupTruncated 的 p→T 均为字母间无边界，变形一律不命中。
 * H2 是熔断级检查（触发即挂账待人工），误报代价已实证（20 轮假挂账），
 * 漏报面本仓≈0（无 SQL 数据库面，.cycles 全是 JSON/MD）——宁窄勿滥。
 *
 * ── cycle-71 引用降敏（含本文件补全）──
 * 讨论破坏性命令的提交（正则原文/测试样例/文档示例/源码注释）命中词形即熔断
 * 挂账待人工（cycle-69 连续两轮「修复者 diff 自触发熔断」实证）。diff 文本判
 * 形态不判意图；但「词形处于引用上下文」是词法学可判定的引用形态（与 cycle-68
 * 同族方法论：只修「词法学可分」的误报类，不碰「意图不可分」类）。降敏是
 * **标注不熔断**而非「不检测」——findings 保留引用行供人审（白盒不减）。
 *
 * 设计文档（.cycles/cycles/cycle-71/任务清单.md §6）把引用上下文定义为
 * 「JS 单/双/反引号字符串字面量内、注释内、markdown 行内代码内」；首版实现
 * 只做了字符串/行内代码（引号区间），**遗漏注释与文档块**——实证：本体 JSDoc
 * 行 `* 词边界后：SQL 命令形态（TRUNCATE / TRUNCATE TABLE）才命中` 仍判
 * quoted=false → circuit=true（本模块自身的说明文字会触发自己熔断，正是
 * cycle-71 要消灭的形态）。本轮补全为四类引用上下文（见 isReferenceAt）。
 */

/**
 * 破坏性命令词形（插件增强，技能侧无此扫描）。
 *
 * **纪律：本数组不得加 `g` 标志。** `isDestructiveCommandLine` 用 `test()`
 * 判定，而带 `g` 的正则 `test()` 会读写并保留 `lastIndex`（状态化）——同一
 * 正则对同一行的二次调用会从上次命中点之后开始，造成漏判。迭代场景一律用
 * 下方的 `GLOBAL_SCAN_PATTERNS` 全局副本。
 */
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i, /\bDROP\s+TABLE\b/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i,
  /\bgit\s+push\s+--force\b/i, /\bgit\s+reset\s+--hard\b/i,
];

/**
 * 全局副本——仅供 `matchAll` 迭代用（`matchAll` 要求全局标志）。
 *
 * cycle-71 P0 根因记录：`classifyDestructiveLine` 首版对**非全局**正则调
 * `re.exec(line)` 并循环到 `null`。非全局正则的 `exec` 忽略 `lastIndex`，
 * 每次调用都返回**同一个首个命中**且 `lastIndex` 恒为 0——零宽保护
 * `if (m.index === re.lastIndex) re.lastIndex++` 永远不触发（`m.index` 是
 * 命中下标、`lastIndex` 是 0，二者不等）→ **死循环**。
 * 后果实证：`tests/unit/hitlQuotedProbe.test.ts` 永不结束 → vitest 122 个
 * 文件跑完 121 个后永不打印汇总、进程不退出（整条 `pnpm run test` 挂死）；
 * 且 `checkH2` 在同一路径上——**任何含破坏性命令词形的 diff 会挂住宿主进程**。
 *
 * 修复形态：模块级全局副本 + `matchAll`。`String.prototype.matchAll` 按规范
 * 用 species 构造克隆正则迭代（只读调用者的 lastIndex、不写回），故模块级复用
 * 安全，且天然有界（迭代器在无更多命中时自动终止，不依赖调用方推进 lastIndex）。
 */
const GLOBAL_SCAN_PATTERNS = DESTRUCTIVE_COMMAND_PATTERNS.map((p) => new RegExp(p.source, `${p.flags}g`));

/**
 * 行首散文/注释标记——整行为「文档文字」而非可执行代码。
 *
 * `#`：shell / YAML / TOML 行注释，markdown 标题（`# 词边界`）。
 * `*`：JSDoc 块续行（` * 说明`）、markdown 无序列表项（`* 示例`）。
 * 两者在本仓 diff 的真实形态里都不执行；命中点落在整行的任意位置都算引用。
 *
 * 风险取舍：`-`（markdown 列表）与 `>`（blockquote）**不纳入**——它们在
 * shell/YAML 里可以是重定向或 CLI 参数形态，非执行语义的可判定性弱于 `#`/`*`，
 * 宁可保守（保守方向＝熔断可人工放行，漏报不可逆）。
 */
const PROSE_MARKERS = new Set(['#', '*']);

/**
 * 词形命中位置是否处于「引用上下文」。
 *
 * 四类（位置法，全部只依赖本行文本）：
 *   ① 整行为散文/注释行（行首非空白字符是 `#` 或 `*`）；
 *   ② 位于字符串字面量区间内（`'` / `"` / `` ` ``，转义感知）；
 *   ③ 位于行注释 `//` 之后（**未被字符串包裹**的 `//`；且前一字符不是 `:`
 *      以排除 URL scheme——`curl http://x && rm -rf /` 的 `//` 属于 URL，
 *      其后 `rm -rf` 是**真命令**，必须仍熔断；这是本判定的漏报面防线）；
 *   ④ markdown 行内代码（反引号区间，已被 ② 覆盖）。
 *
 * 终止性：单遍扫描，每个分支要么 `return`、要么把游标至少推进 1；
 * **不依赖任何 `lastIndex`**，不存在 cycle-71 首版同款死循环风险。
 */
function isReferenceAt(line: string, matchIndex: number): boolean {
  // ① 整行散文/注释行
  const firstNonWs = line.search(/\S/);
  if (firstNonWs >= 0 && PROSE_MARKERS.has(line[firstNonWs] ?? '')) return true;

  // ②③ 单遍：追踪引号状态，遇未包裹的 `//` 则其后全为注释
  let i = 0;
  while (i < matchIndex) {
    const ch = line[i];
    if (ch === '\\') { i += 2; continue; } // 转义字符——跳过下一个
    if (ch === "'" || ch === '"' || ch === '`') {
      // 找同种引号闭合（处理转义）
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === ch) break;
        j++;
      }
      // 命中点在 [i, j] 引号区间内 → 引用
      if (matchIndex > i && matchIndex < (j < line.length ? j : line.length)) return true;
      if (j >= line.length) return true; // 未闭合到行尾——命中点必然在区间内
      i = j + 1;
      continue;
    }
    // 行注释起点：未在字符串内（此处已排除引号区间）的 `//`，且不是 URL scheme
    if (ch === '/' && line[i + 1] === '/' && line[i - 1] !== ':') return true;
    i++;
  }
  return false;
}

/** 破坏性命令行分类（cycle-71 三态纯函数核心）。 */
export interface DestructiveLineClass {
  /** 词形命中（isDestructiveCommandLine 同源） */
  hit: boolean;
  /** 全部命中点均处于引用上下文（字符串字面量/注释/文档块内） */
  quoted: boolean;
}

/** diff 新增行是否含破坏性命令（cycle-68 从 checkH2 内联提取为可测纯函数）。 */
export function isDestructiveCommandLine(line: string): boolean {
  return DESTRUCTIVE_COMMAND_PATTERNS.some((p) => p.test(line));
}

/**
 * 分类一行 diff 新增行：hit=词形命中；quoted=命中全在引用上下文。
 *
 * 任一命中点为「裸词形」（不在引用上下文内）→ quoted=false（保守：一行里
 * 既有引用又有裸命令时无法排除执行意图，按真命令处理）。
 */
export function classifyDestructiveLine(line: string): DestructiveLineClass {
  if (!isDestructiveCommandLine(line)) return { hit: false, quoted: false };
  for (const re of GLOBAL_SCAN_PATTERNS) {
    for (const m of line.matchAll(re)) {
      if (!isReferenceAt(line, m.index)) return { hit: true, quoted: false };
    }
  }
  return { hit: true, quoted: true };
}
