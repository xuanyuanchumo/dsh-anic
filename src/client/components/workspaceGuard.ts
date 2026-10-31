/**
 * 多项目隔离守卫（cycle-89）—— **工作区载荷守卫 + 在途响应丢弃 + 分键视图态**。
 *
 * ## 被守卫的缺口（实测，非推断）
 *
 * `src/client/components/usePanelFetch.ts` 的轮询层此前**没有任何工作区隔离**：
 *
 * 1. `X-ANIC-Workspace` 头来自 `src/client/WorkflowGraphPanel.ts` 的 `workspaceRef`，
 *    它是在**首个成功快照响应**时学到的（`src/client/panelLiveTargets.ts` 学
 *    `X-ANIC-Workspace` 响应头）。也就是说：**学到的头属于「第一个响应的项目」**。
 * 2. 之后所有 4s / 2s 轮询都带着这个头，但**面板自身不校验返回的载荷属于哪个工作区**。
 * 3. 真机后果：宿主切到另一个项目（多会话 / 多窗口）时，旧项目的轮询响应仍会
 *    **apply 到当前 store** —— 面板显示 A 项目的账本/流程/门禁，
 *    而用户以为在看 B 项目。**串味**。
 *
 * ## 三道防线（本模块 + usePanelFetch 接线）
 *
 * - **防线一 · 载荷守卫**：响应体声明的工作区与期望不符 → **拒绝 apply**。
 * - **防线二 · 在途丢弃**：切换工作区时在途响应到达 → **丢弃**（世代号不匹配）。
 * - **防线三 · 分键视图态**：缩放/平移/筛选按工作区分键存储 → 切回来还是上次的视图。
 *
 * ## 为什么不 import host 的 `flowJoin.normalizeWorkspace`
 *
 * client 与 host 是**两条独立发版链**：宿主升级（字段增删）与客户端构建产物
 * 不在同一个节奏。client import host 类型，一次宿主改名就会让旧客户端整块崩
 * （且打包时是类型擦除，编译期看不出来）。所以这里**独立实现一份**归一，
 * 并用**相同的测试向量**保证两份语义一致（见 `workspaceIsolation.test.ts`）。
 *
 * ## 纯函数纪律
 *
 * 本模块零 DOM、零 clock、零 random，可独立单测。
 */

/** 归一后的工作区键（Windows 盘符大小写不敏感；POSIX 保持原样）。 */
export type WorkspaceKey = string;

/** 工作区未知时使用的固定键（**不用空串** —— 空串无法与「真实空路径」区分）。 */
export const UNKNOWN_WORKSPACE_KEY = '__unknown__';

/**
 * 工作区路径归一。
 *
 * 规则：
 * - 反斜杠 → 正斜杠；
 * - 去尾部斜杠（`/` 与 `\` 都去）；
 * - 含盘符的 Windows 路径**整体小写**（`C:\Users\A` ≡ `c:/users/a`）；
 * - POSIX 路径**大小写敏感**，保持原样。
 *
 * 为什么要小写 Windows 路径：同���个项目在不同工具里可能以不同大小写出现
 * （`D:\Proj` vs `d:\proj`），不归一会让隔离守卫把同一项目当两个 —— 于是
 * 「切换项目」永远触发不了世代号递增，防线二静默失效。
 */
export function normalizeWorkspace(path: string): WorkspaceKey {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(unified) ? unified.toLowerCase() : unified;
}

/** 两个工作区是否同一个（归一后比较；空串永不相等）。 */
export function sameWorkspace(a: string, b: string): boolean {
  if (!a || !b) return false;
  return normalizeWorkspace(a) === normalizeWorkspace(b);
}

/** 取工作区的分键（未知 → 固定键）。 */
export function workspaceKeyOf(workspace: string | null | undefined): WorkspaceKey {
  if (typeof workspace !== 'string' || workspace.trim() === '') return UNKNOWN_WORKSPACE_KEY;
  const key = normalizeWorkspace(workspace.trim());
  return key === '' ? UNKNOWN_WORKSPACE_KEY : key;
}

/** 载荷守卫的裁决。 */
export interface PayloadVerdict {
  /** 是否允许把该载荷应用到当前 store。 */
  accepted: boolean;
  /** 裁决理由（**始终有值** —— 拒绝时必须能说清为什么）。 */
  reason: string;
  /** 载荷声明的工作区（无声明则 null）。 */
  declared: WorkspaceKey | null;
}

/** 从载荷里读出工作区标识（**尽力而为**：多种常见形态）。 */
export function declaredWorkspaceOf(payload: unknown): WorkspaceKey | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  // 常见形态：{ workspace } / { workspaceRoot } / { root } / { data: { workspace } }
  for (const key of ['workspace', 'workspaceRoot', 'workspacePath', 'root']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return workspaceKeyOf(v);
  }
  const data = obj['data'];
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const nested = (data as Record<string, unknown>)['workspace'];
    if (typeof nested === 'string' && nested.trim() !== '') return workspaceKeyOf(nested);
  }
  return null;
}

/**
 * 工作区载荷守卫。
 *
 * ## 裁决规则（取舍在此写明）
 *
 * | 载荷声明工作区 | 期望工作区 | 裁决 |
 * |---|---|---|
 * | 有，且相同 | 已知 | **放行** |
 * | 有，且不同 | 已知 | **拒绝**（串味防线） |
 * | 有 | 未知（期望侧没工作区） | **放行**（无从判断 ≠ 有证据表明串味） |
 * | 无（载荷不带标识） | 任意 | **放行** |
 *
 * ## 为什么「载荷不带标识」要放行而不是拒绝
 *
 * 本仓多数端点的响应体**本来就没有**工作区字段（账本列表端点返回条目数组、
 * 自举状态端点返回状态对象……）。若「无标识即拒绝」，
 * 整个面板会全线失效 —— 那不是隔离，是自毁。
 *
 * 正确的说法是：**无标识 = 无证据表明串味**，而不是「无证据表明没串味」。
 * 真正防串味的是防线二（在途丢弃）——它不需要载荷自带标识。
 *
 * ## 为什么「期望工作区未知」时放行
 *
 * 宿主当前会话还没解析出工作区时（面板刚挂载），此时任何载荷都无法证伪。
 * 拒绝会让面板永远空白。��线二会随后把工作区学出来。
 */
export function acceptPayload(
  expectedWorkspace: string | null | undefined,
  payload: unknown,
): PayloadVerdict {
  const expected = typeof expectedWorkspace === 'string' && expectedWorkspace.trim() !== ''
    ? workspaceKeyOf(expectedWorkspace)
    : null;
  const declared = declaredWorkspaceOf(payload);
  if (declared === null) {
    return { accepted: true, reason: '载荷未声明工作区——无串味证据，放行（防线二负责真正的隔离）', declared: null };
  }
  if (expected === null) {
    return { accepted: true, reason: '期望工作区未知——无从证伪，放行', declared };
  }
  if (declared === expected) {
    return { accepted: true, reason: '工作区一致', declared };
  }
  return {
    accepted: false,
    reason: `工作区不符：载荷属 ${declared}，期望 ${expected}——拒绝应用（防多项目串味）`,
    declared,
  };
}

/** 世代号守卫：切换工作区时递增，使在途响应失效。 */
export interface EpochGuard {
  /** 当前世代号。 */
  readonly current: number;
  /** 推进世代号（切换工作区时调用）。 */
  advance(): number;
  /** 某次请求发起时的世代号是否仍然有效。 */
  isCurrent(epoch: number): boolean;
}

/**
 * 构造世代号守卫。
 *
 * ## 为什么需要它
 *
 * 切换工作区时，**在途**的旧项目响应可能在新项目的上下文到达。若不丢弃，
 * 旧数据会 apply 进当前 store —— 而用户此刻正在看新项目。
 *
 * 关键点：世代号必须能随「工作区切换」递增。`usePanelFetch` 的 effect 依赖是
 * `[pollMs, manualKey]`，所以工作区切换必须能引起 **manualKey 变化**，
 * 否则世代号永远不推进，防线二就是空转的。
 */
export function createEpochGuard(initial = 0): EpochGuard {
  let epoch = initial;
  return {
    get current(): number {
      return epoch;
    },
    advance(): number {
      epoch += 1;
      return epoch;
    },
    isCurrent(candidate: number): boolean {
      return candidate === epoch;
    },
  };
}

/**
 * ## cycle-95 删除 `payloadRejectionFailure()`（为什么删）
 *
 * 它唯一的职责是把 `PayloadVerdict.reason` 包成 `{ kind: 'malformed', reason }`。
 * 但真实的消费点 `components/usePanelFetch.ts` 是**逐项内联**判定的：
 *
 * ```
 * if (!tgt.guard(json)) { tgt.onFail?.({ kind: 'malformed' }); return; }
 * ... const verdict = acceptPayload(...);
 * if (!verdict.accepted) { tgt.onFail?.({ kind: 'malformed', reason: verdict.reason }); return; }
 * ```
 *
 * ⇒ 这是「聚合包装」，而调用方本就逐项处理（两处 malformed 语义不同：一处是
 * 形状不符、一处是载荷被拒，后者才带 reason）。若接线，反而会**抹掉这个区分**
 * （给形状不符也塞一个 reason）。全仓去注释后零消费，tests/ 也无引用。
 * 本仓教训：没人用的兼容层是最贵的兼容层。
 *
 * 注意：本文件其余导出（`normalizeWorkspace` / `sameWorkspace` / `workspaceKeyOf` /
 * `UNKNOWN_WORKSPACE_KEY` / `declaredWorkspaceOf` / `acceptPayload` /
 * `createEpochGuard`）**全部保留并仍被消费**，本次只删这一个包装。
 */
