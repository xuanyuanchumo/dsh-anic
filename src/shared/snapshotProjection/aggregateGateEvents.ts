/**
 * 账本事件的**聚合**投影（cycle-83 产物治理）：194 条独立 evt 节点 → 每轮一个摘要节点。
 *
 * ## 被修的形态
 *
 * 旧快照把账本**每条**记录摊成一个 `evt:N` 节点（实测 194 个），加上 79 个 cycle
 * 节点，296 个点里 273 个（92%）在讲历史。读者想知道的其实只有一件事：
 * **「最近这几轮，四道门过没过？」** 194 个点回答不了这个问题，8 个带徽章的摘要
 * 才回答得了。
 *
 * ## 为什么分组用「位置法」而不是从 detail 里正则捞 cycle 号
 *
 * INV-21 实测教训：账本 detail 是自由文本，同一份账本按文本归属会造出 3 组
 * "乱序"假象（15 条 detail 提到多个 cycle），按位置归属是 0 组。所以本模块
 * **只看 gate 字段与顺序**：`G0` 开启一个新组（技能侧语义：G0 是新一轮的第一道门），
 * 其余门归入当前组。detail 只作证据原样保留，绝不参与归属判定。
 *
 * ## 为什么聚合不能变成"看不见"（证据必须可展开）
 *
 * 摘要节点把**组内每条记录**的 gate / result / timestamp / detail 收进 `evidence`，
 * 由快照写进节点的 `detail`（节点详情抽屉正是读它）。折叠像素，不折叠事实——
 * 「聚合」与「丢数据」的分界线就是这条证据链还在不在。
 *
 * ## 纪律
 *
 * 纯函数、零 IO、确定性（同输入同输出，不依赖对象遍历顺序）。
 */

/** 账本记录的结构化事实（只读这些字段——detail 仅作证据，不作归属）。 */
export interface LedgerEntryFact {
  gate?: string;
  gateName?: string;
  result?: string;
  detail?: string;
  timestamp?: string;
}

/** 收敛门集合（徽章顺序固定，保证标签逐字稳定）。 */
export const CONVERGENCE_GATES: readonly string[] = ['G0', 'G1', 'G2', 'G3'];

/** 一个按位置切出的门禁组（通常对应一轮循环）。 */
export interface GateGroup {
  /** 组序号（0 起，位置序）。 */
  index: number;
  /** 组内首/末条在账本里的下标（闭区间）。 */
  start: number;
  end: number;
  /**
   * 各收敛门在组内的**最后一次**裁决；`null` = 该门在这组里没出现过。
   *
   * 为什么取最后一次而不是"任一次 FAIL"：同一轮里门可能被判 FAIL 后修好重判
   * PASS（本仓实测有这种组），"最后一次"才是这轮走到哪里的真相；把曾经失败过
   * 的门永久标红会让修好的轮次一直显示红点。
   */
  verdicts: Record<string, string | null>;
  /** 组内记录条数。 */
  entryCount: number;
  /** 组内出现过的门（去重、保持首次出现顺序）。 */
  gates: string[];
  /** 证据（原始记录，逐条；聚合后的可展开层）。 */
  evidence: LedgerEntryFact[];
  /** 组内最早/最晚时间戳（缺省 null，不伪造时间）。 */
  startedAt: string | null;
  endedAt: string | null;
}

/** 规范化门名：只做大小写归一（`g0` → `G0`）；不认识的原样保留。 */
function normalizeGate(raw: string | undefined): string {
  const g = String(raw ?? '').trim().toUpperCase();
  return g === '' ? '?' : g;
}

/** 该组的整体裁决：有 FAIL 即 FAIL，否则有 PASS 即 PASS，否则 null。 */
export function groupVerdict(group: GateGroup): 'PASS' | 'FAIL' | null {
  let sawPass = false;
  for (const g of CONVERGENCE_GATES) {
    const v = group.verdicts[g];
    if (v === 'FAIL') return 'FAIL';
    if (v === 'PASS') sawPass = true;
  }
  // 非收敛门的记录（如 spec/human 门）也参与：全组一条 FAIL 就足以标红。
  for (const v of Object.values(group.verdicts)) if (v === 'FAIL') return 'FAIL';
  return sawPass ? 'PASS' : null;
}

/**
 * 按位置把账本切成门禁组。
 *
 * 切分规则：`G0` 开启新组（**首条恒开组**，即便它自己不是 G0）；其余门归当前组。
 * 空账本 → 空数组（不是"一个空组"：空组会在图上变成一个没有任何信息的点）。
 */
export function groupGateEvents(entries: readonly LedgerEntryFact[]): GateGroup[] {
  const groups: GateGroup[] = [];
  let cur: GateGroup | null = null;

  entries.forEach((e, i) => {
    const gate = normalizeGate(e.gate);
    const isOpener = gate === 'G0';
    if (cur === null || isOpener) {
      if (cur !== null) groups.push(cur);
      cur = {
        index: groups.length, start: i, end: i,
        verdicts: {}, entryCount: 0, gates: [], evidence: [],
        startedAt: null, endedAt: null,
      };
    }
    cur.end = i;
    cur.entryCount += 1;
    cur.evidence.push({ ...e, gate });
    if (!cur.gates.includes(gate)) cur.gates.push(gate);
    if (e.result === 'PASS' || e.result === 'FAIL') cur.verdicts[gate] = e.result;
    const ts = typeof e.timestamp === 'string' && e.timestamp !== '' ? e.timestamp : null;
    if (ts !== null) {
      if (cur.startedAt === null || ts < cur.startedAt) cur.startedAt = ts;
      if (cur.endedAt === null || ts > cur.endedAt) cur.endedAt = ts;
    }
  });
  if (cur !== null) groups.push(cur);
  return groups;
}

/**
 * 组的徽章串（`G0 PASS · G1 FAIL · G2 —`）。
 *
 * 为什么把徽章写进 label 而不是只放 detail：节点是**图的像素单位**，
 * 徽章只有画在节点上才算"一眼看出这轮过没过"；detail 是点开之后的事。
 * 没出现的门写 `—`（而不是省略）：省略会让"这轮没跑 G2"和"这轮 G2 过了"
 * 在视觉上无法区分——那正是读数歧义的来源。
 */
export function badgeLabel(group: GateGroup, cycleName?: string): string {
  const parts: string[] = [];
  for (const g of CONVERGENCE_GATES) {
    const v = group.verdicts[g];
    parts.push(`${g} ${v ?? '—'}`);
  }
  const base = parts.join(' · ');
  return cycleName !== undefined && cycleName !== '' ? `${cycleName}: ${base}` : `group ${String(group.index)}: ${base}`;
}

/**
 * 组的证据文本（写进节点 detail，供详情抽屉展开）。
 *
 * 截断纪律：单条 detail 保留 160 字，整段保留 12 条——超出部分**如实标注**剩余条数
 * （`… (+N more)`）。静默截断会让"聚合"变回"看不见"，而如实标注让规模可感知。
 */
export function evidenceDetail(group: GateGroup, maxItems = 12, maxChars = 160): string {
  const head = `entries ${String(group.start)}–${String(group.end)} (${String(group.entryCount)} records)`;
  const time = group.endedAt !== null ? `, last ${group.endedAt}` : '';
  const lines = group.evidence.slice(0, maxItems).map((e) => {
    const detail = String(e.detail ?? '').replace(/\s+/g, ' ').slice(0, maxChars);
    return `${normalizeGate(e.gate)} ${String(e.result ?? '?')}${detail !== '' ? ' — ' + detail : ''}`;
  });
  const rest = group.entryCount - lines.length;
  return `${head}${time}\n` + lines.join('\n') + (rest > 0 ? `\n… (+${String(rest)} more)` : '');
}

/**
 * 把账本组按**窗口**裁剪（cycle-83：聚合之后仍需窗口，否则 73 组还是 73 个节点）。
 *
 * ## 为什么窗口必须同时作用于 cycle 与账本组
 *
 * 只窗口化 cycle 目录、却把 194 条账本全摊成 73 组摘要节点，节点数是 8 + 73 = 81 ——
 * 实测仍然超一屏。事实是**两者都编码同一段历史**：每轮 cycle 有自己的门禁记录。
 * 只裁一头，另一头继续把历史摊在图上。所以判据必须是同一条：**最近 N 组 + 当前组**。
 *
 * ## 「当前组」怎么定
 *
 * 账本没有结构化 cycle 归属（INV-21 禁止从 detail 解析），所以"当前组"只能取
 * **位置法的最后一组**（组按账本顺序切出，最后一组 = 最近一次记账）。这是位置法，
 * 不是文本猜测——与技能侧「G0 开启新一轮」的语义一致。
 *
 * 被折叠的组不删除：折成一个计数节点（`foldedOut` 可读），并保留首组信息
 * （"最早那组是第几条到第几条"），使"折叠了多少"与"丢没丢"两问都能回答。
 */
export interface WindowedGroups {
  /** 进主图的组（按组序号升序）。 */
  kept: GateGroup[];
  /** 被折叠的组（升序）。 */
  folded: GateGroup[];
  /** 折叠组的合并摘要（folded 为空时 null：不生成空节点）。 */
  foldedSummary: {
    /** 折叠的组数。 */
    groups: number;
    /** 折叠的账本记录总条数。 */
    entries: number;
    /** 首/末条账本下标（回答"折叠的是哪一段历史"）。 */
    start: number;
    end: number;
    nodeId: string;
    label: string;
  } | null;
}

/**
 * 组 → 窗口裁剪。
 *
 * @param groups `groupGateEvents` 的输出（按账本顺序）
 * @param recent 保留最近多少组（缺省 8，与 cycle 窗口同值——同一段历史必须同一尺度）
 */
export function windowGateGroups(groups: readonly GateGroup[], recent: number): WindowedGroups {
  const n = Math.max(1, Math.floor(recent));
  const total = groups.length;
  if (total <= n) return { kept: [...groups], folded: [], foldedSummary: null };
  const cut = total - n;
  const folded = groups.slice(0, cut);
  const kept = groups.slice(cut);
  const entries = folded.reduce((s, g) => s + g.entryCount, 0);
  const start = folded[0]?.start ?? 0;
  const end = folded[folded.length - 1]?.end ?? 0;
  return {
    kept,
    folded,
    foldedSummary: {
      groups: folded.length,
      entries,
      start,
      end,
      // ★ 前缀仍在 selfCheckRoute P2 认的结构化集合内（evt:）。
      nodeId: 'evt:folded',
      label: `folded ${String(folded.length)} gate groups (${String(entries)} records, ledger #${String(start)}–${String(end)})`,
    },
  };
}

