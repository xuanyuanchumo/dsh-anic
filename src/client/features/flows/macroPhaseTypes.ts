/**
 * 宏观相位漂移读数的**客户端契约**（cycle-96 WS-A）。
 *
 * ## 为什么客户端独立声明形状（而不是 import 宿主的 `MacroPhaseStatusView`）
 *
 * 与 `lifecycleTypes.ts` / `flowMatrixTypes.ts` 同一条纪律：面板跑在宿主 webview 里，
 * **宿主升级与客户端构建产物是两条独立发版链**。客户端 import `src/host/**` 的类型时，
 * 一次宿主字段改名就会让旧客户端整块崩（打包时类型擦除，编译期看不出来）；
 * G-IND 也禁止客户端跨层 import。⇒ 这里手工声明「可能缺字段」的形状，守卫只做最小准入。
 *
 * ## 这三个字段回答的问题（不是装饰）
 *
 * | 字段 | 回答 |
 * |---|---|
 * | `stored` | 磁盘上 `.cycles/workflow-state.json` 说的相位（写者 = advance） |
 * | `inferred` | 从当前循环**工件**推断出的相位（只读读数，永不落盘） |
 * | `drift` | 两者是否分叉 |
 *
 * 被修缺陷（cycle-96）：技能 `workflow-state.mjs` 的 `cmdStatus` 曾用 `inferPhase`
 * 静默改写磁盘相位 —— 「查一次状态」就改掉了被观察的状态。宿主侧本来就只读，
 * 但**只报 stored** ⇒ 「状态没跟上工件」在面板上完全不可见。三个值一起显示，
 * 谁说了算才是可读事实。
 *
 * ## `drift === null` 与 `drift === false` 不是一回事
 *
 * `null` = 没有状态文件（无从比较，**不判分叉**）；`false` = 比较过且一致。
 * 把 null 折成 false 会把「还没有状态」画成「一切正常」——正是本仓反复禁的假绿。
 */

/** 宏观相位视图的响应形状（`GET /anic/flows/status` 的 `macroPhase` 字段）。 */
export interface MacroPhaseStatusJson {
  currentPhase?: string | null;
  phaseName?: string | null;
  inferredPhase?: string | null;
  drift?: boolean | null;
  /** 推断器可达的最高相（deploy/maintain 无工件指纹 ⇒ 必然 ≤ 此值）。 */
  inferenceCeiling?: string;
  currentCycle?: string | null;
  projectionSeeded?: boolean;
}

/** 相位漂移的**可读裁决**（渲染层唯一消费的四态）。 */
export type DriftVerdict =
  /** 两值一致。 */
  | { kind: 'consistent'; stored: string; inferred: string }
  /** 真分叉：状态文件与工件推断不一致。 */
  | { kind: 'drift'; stored: string; inferred: string }
  /**
   * 推断到顶：`stored` 在 `inferenceCeiling` 之后（deploy/maintain），推断器根本
   * 到不了那里 ⇒ 这不是「状态文件错了」，是「推断器到顶了」。
   *
   * 为什么必须单列：若把这种形态也报成 drift，用户会去「修」一个其实正确的
   * 状态文件；而真正的 drift 反而淹没在噪声里（狼来了）。
   */
  | { kind: 'ceiling'; stored: string; inferred: string | null }
  /** 无状态文件 / 旧服务端没给字段 ⇒ 无从判定（不判分叉，不判一致）。 */
  | { kind: 'unknown'; stored: string | null; inferred: string | null };

/** 相序（与宿主 macroPhaseEngine.PHASES 同序；此处独立声明避免跨层 import）。 */
const PHASE_ORDER = ['plan', 'design', 'build', 'test', 'deploy', 'maintain'] as const;

/** `ceiling` 及之后的相：工件推断在这些相上**不可能**跟上。 */
const BEYOND_CEILING = new Set(['deploy', 'maintain']);

/**
 * 漂移裁决（纯函数，零副作用）。唯一的公开入口。
 *
 * 为什么这一层**不做形状守卫**（不像 `isFlowMatrix` 那样先 `isObj` 再窄化）：
 * 本函数接收的已是 `FlowStatusJson.macroPhase` 切片，而 `FLOWS_STATUS_URL` 的拉取
 * 守卫 `isFlowStatus` 只硬要求 `flows` 数组。**任何**字段缺失都该表现为 `unknown`
 * 读数（界面上如实显示「未采集」），而不是让整块面板走失败行 —— 故这里逐字段
 * `typeof` 判而不是一刀切校验形状。
 *
 * @param view `GET /anic/flows/status` 的 `macroPhase` 切片；null/undefined = 旧服务端或未拉取
 */
export function driftVerdictOf(view: MacroPhaseStatusJson | null | undefined): DriftVerdict {
  const stored = typeof view?.currentPhase === 'string' ? view.currentPhase : null;
  const inferred = typeof view?.inferredPhase === 'string' ? view.inferredPhase : null;
  // 读不到 stored ⇒ 没有可比对的「磁盘事实」⇒ unknown（不是 consistent）。
  if (stored === null) return { kind: 'unknown', stored: null, inferred };
  // 字段在但值为 null：旧宿主 / 状态文件缺失。
  if (typeof view?.drift !== 'boolean' || inferred === null) {
    return { kind: 'unknown', stored, inferred };
  }
  if (view.drift === false) return { kind: 'consistent', stored, inferred };
  // drift === true：先排「推断到顶」，再报真分叉。
  const storedIdx = PHASE_ORDER.indexOf(stored as (typeof PHASE_ORDER)[number]);
  const ceiling = typeof view.inferenceCeiling === 'string' ? view.inferenceCeiling : 'test';
  const ceilingIdx = PHASE_ORDER.indexOf(ceiling as (typeof PHASE_ORDER)[number]);
  if (BEYOND_CEILING.has(stored) || (storedIdx >= 0 && ceilingIdx >= 0 && storedIdx > ceilingIdx)) {
    return { kind: 'ceiling', stored, inferred };
  }
  return { kind: 'drift', stored, inferred };
}

/**
 * 读数行文案的**数据源**（三值原样给出，渲染层不重算）。
 *
 * 与 `driftVerdictOf` 是**同一个函数**，不再保留第二名字（死导出纪律）。
 */
