/**
 * 开关解析态的**客户端契约**（cycle-91）—— `GET /anic/api/flows/resolved` 的响应形状。
 *
 * ## 为什么客户端独立声明形状
 *
 * 面板跑在宿主 webview 里，宿主升级（响应字段增删）与客户端构建产物是
 * **两条独立发版链**。若客户端 import `src/host/routes/resolvedFlowsRoute.ts`
 * 的类型，一次宿主字段改名就会让旧客户端整块崩掉（且打包时是类型擦除，
 * 编译期看不出来）。
 *
 * ⇒ 这里**手工声明可能缺字段**的形状，守卫只做最小准入。
 *
 * ## 为什么这个端点解决的是「界面与真相相反」
 *
 * **实测缺陷**（cycle-91 审计）：客户端抽屉只读 **user 层**
 * （`renderPrefsDrawer({}, ...)` 传空对象），而 `resolveFlows` 的三层合并
 * （user > workspace > deployment）只在**宿主侧**被读。
 *
 * ⇒ 工作区 `.cycles/config.yml` 写 `flow.selfInit: false` 时，
 * 抽屉显示「☑ 自举命令」，点下去宿主返回 **403** ——
 * **界面与真相相反**。
 *
 * 本端点把**服务端才知道的层**（workspace + deployment）如实送出来，
 * 客户端据此显示**真实生效态**。
 */

/** 单个开关的解析态。 */
export interface ResolvedFlowStateJson {
  /** 是否生效。 */
  enabled?: boolean;
  /** 生效来源层（`user` / `workspace` / `deployment` / null=默认）。 */
  source?: string | null;
}

/** `GET /anic/api/flows/resolved` 的响应。 */
export interface ResolvedFlowsJson {
  /** 每个开关的生效态与来源层。 */
  flows?: Record<string, ResolvedFlowStateJson>;
  /** 三层合并过程中的告警（未知键 / 非布尔值 / 层不支持）。 */
  warnings?: string[];
  /** 每个开关在用户层是否可写。 */
  userWritable?: Record<string, boolean>;
  /** 开关总数。 */
  total?: number;
}

/** 开关解析态端点。 */
export const RESOLVED_FLOWS_URL = '/anic/api/flows/resolved';

/** 对象形守卫（独立实现，避免跨域 import 环）。 */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 形状守卫：只要求「能取到 flows 对象」。
 *
 * 刻意**不**校验全部字段 —— 任何新增/缺失字段都不该让整块面板走失败行
 * （与 `flowMatrixTypes.isFlowMatrix` 同款最宽守卫）。
 */
export function isResolvedFlows(v: unknown): v is ResolvedFlowsJson {
  if (!isObj(v)) return false;
  return isObj(v['flows']);
}

/**
 * 取某个开关的生效态（端点不可用时返回 null —— **不猜**）。
 *
 * @param resolved 服务端响应（可能是 undefined）
 * @param flowId   开关 id
 */
export function resolvedFlowState(
  resolved: ResolvedFlowsJson | undefined | null,
  flowId: string,
): ResolvedFlowStateJson | null {
  const st = resolved?.flows?.[flowId];
  if (st === undefined) return null;
  return st;
}

/**
 * 某开关在**用户层**是否可写（服务端判据；端点不可用时回落到客户端判据）。
 *
 * @param resolved    服务端响应
 * @param flowId      开关 id
 * @param fallback    端点不可用时的回落值（客户端本地判据）
 */
export function resolvedUserWritable(
  resolved: ResolvedFlowsJson | undefined | null,
  flowId: string,
  fallback: boolean,
): boolean {
  const w = resolved?.userWritable?.[flowId];
  return typeof w === 'boolean' ? w : fallback;
}

/**
 * ## cycle-95 删除 `sourceLayerLabel()`（为什么删）
 *
 * 它把服务端来源层（`user`/`workspace`/`deployment`/null）映射成**一个词**，
 * 但真实的显示路径根本不走它：`features/prefs/prefsDrawer.ts` 用
 * `sourceLabelOf(layer)` → `t('prefs.sourceUser' / 'prefs.sourceWorkspace' / …)`
 * 产出**本地化文案**，并连同 `layers` 一起渲染成
 * `t('prefs.sourceLine', { source, layers })` 一整行。
 *
 * ⇒ 本函数若被接线，只会产出一个**绕过 t() 的硬编码英文词**，与本仓 i18n
 * 纪律（所有用户面文本经 t()）直接冲突；而它返回的 `'default'` 也是
 * **编造出的来源层**（服务端 `source` 为 null 的真实语义是「未定层 = 用默认值」，
 * 不是「有一个叫 default 的层」）。
 *
 * 全仓去注释后零消费（audit-wiring 全仓零文本命中），且没有任何测试引用它，
 * 所以删掉不损失表达能力：真要做这层映射时，正确落点是 `prefsDrawer` 的
 * `sourceLabelOf`（它已经在做，而且带 i18n）。
 */
