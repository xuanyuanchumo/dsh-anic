/**
 * CORS 来源策略（P0-8 修复）。
 *
 * 背景：`snapshotRoute.ts:70` 此前对所有响应无条件写
 * `Access-Control-Allow-Origin: '*'`。后果不是"本地小问题"：
 * 任何网页只要知道 `http://127.0.0.1:<port>/anic/...` 就能**读取**本插件
 * 的全部响应体 —— 包括工作区绝对路径、账本内容、agent 卡提示词、
 * `org-status` 里的信任分与自主级。这是一个真实的**跨站信息泄露**面
 * （DNS rebinding / 任意网页探测本机端口都能命中）。
 *
 * 关键事实：**本插件的客户端面板不需要 CORS**。
 * 面板由宿主 Web 服务器同源提供（`http://127.0.0.1:<port>/`），
 * 它 fetch `/anic/api/...` 是**同源请求**，浏览器不发 Origin、也不需要
 * `Access-Control-Allow-Origin`。所以通配符的唯一"受益者"是外部页面 ——
 * 这正是要拦住的对象。
 *
 * 策略（默认拒绝，显式放行）：
 *   - 无 Origin 头（同源导航 / curl / 服务端调用）→ 不发 CORS 头（无需放行）
 *   - Origin 在允许集内 → 回显该 Origin（**不是** `*`）+ `Vary: Origin`
 *   - Origin 不在允许集内 → **不发** CORS 头（浏览器按同源策略拒绝读取）
 *
 * 允许集来源（三层，与 F 族开关同构）：
 *   1. 部署层环境变量 `ANIC_ALLOWED_ORIGINS`（逗号分隔）
 *   2. 工作区 `.cycles/config.yml` 的 `anic.allowedOrigins`（逗号分隔）
 *   3. 默认：本机回环来源（http/https + localhost / 127.0.0.1 / [::1]，任意端口）
 *
 * 默认集**刻意**保留回环来源：多 profile 下 web/desktop 可能跑在不同端口，
 * 同机互访是开发常态；而"任意公网网页"始终不在集合内。
 */

/** 回环来源判定：http(s) + localhost/127.0.0.1/[::1]（任意端口）。 */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** 解析逗号分隔的来源列表（去空白、去尾斜杠、丢弃空项）。 */
function parseOrigins(raw: string | undefined | null): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s.length > 0);
}

/**
 * 工作区/部署层追加的允许集（由 `routeContext` 在注册时写入一次）。
 *
 * 为什么用模块级变量而不是参数：`sendJson` 是全插件唯一的响应出口，
 * 而它拿不到「当前工作区的配置」——路由 handler 只收到 `(req, res)`。
 * 插件的生命周期是「一个工作区一次注册」，因此注册时写入、请求时读取
 * 是语义正确的。**不做动态变更**：改配置需重载插件（与其它配置同语义）。
 */
let configuredOrigins: string[] = [];

/** 注册期写入追加允许集（`routeContext` 调用；同进程多工作区场景取最后一次）。 */
export function setConfiguredOrigins(origins: string[]): void {
  configuredOrigins = origins;
}

/** 读取当前追加允许集（测试用）。 */
export function getConfiguredOrigins(): string[] {
  return configuredOrigins;
}

/** 读取环境变量层允许集。 */
export function envAllowedOrigins(env: Record<string, string | undefined> = process.env): string[] {
  return parseOrigins(env.ANIC_ALLOWED_ORIGINS);
}

/**
 * 判定某个 Origin 是否被允许。
 * @param origin 请求的 Origin 头（可能为 undefined）
 * @param extra 追加的允许集（缺省用注册期写入的 configuredOrigins）
 */
export function isOriginAllowed(origin: string | undefined, extra: string[] = configuredOrigins): boolean {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  const normalized = origin.replace(/\/+$/, '');
  const allowed = [...envAllowedOrigins(), ...extra];
  // 显式配置的 `*` **不**作为通配符放行 —— 它退化为默认回环策略。
  // 这样即使有人在 config.yml 里写了 `allowedOrigins: '*'`，也不会重新打开
  // 那个跨站读取面（配置错误必须是安全的，不能是危险的）。
  const explicit = allowed.filter((o) => o !== '*');
  if (explicit.includes(normalized)) return true;
  return LOOPBACK_ORIGIN.test(normalized);
}

/**
 * 计算响应应带的 CORS 头。
 *
 * @returns 允许时 `{ 'Access-Control-Allow-Origin': <origin>, Vary: 'Origin' }`；
 *          无 Origin 或不允许时 `{}`（**绝不返回 `*`**）。
 */
export function corsHeaders(origin: string | undefined, extra: string[] = configuredOrigins): Record<string, string> {
  if (typeof origin !== 'string' || origin.length === 0) return {};
  if (!isOriginAllowed(origin, extra)) return {};
  return {
    'Access-Control-Allow-Origin': origin.replace(/\/+$/, ''),
    // 响应随 Origin 变化 → 必须 Vary，否则中间缓存会把 A 站的可读响应喂给 B 站
    Vary: 'Origin',
  };
}

/** 从请求头中取出 Origin（大小写不敏感，兼容 string[] 形态）。 */
export function originOf(headers: Record<string, string | string[] | undefined> | undefined): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'origin') continue;
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  }
  return undefined;
}

/**
 * 从 `res.req` 取请求对象并读 Origin。
 *
 * Node `ServerResponse` 上有 `req` 反向引用（`http` 模块自 Node 0.x 起即如此，
 * 且 `dsh-host-webserver` 直接消费原生 `(req, res)`）。用 `res.req` 而不是
 * 改所有 handler 签名：`sendJson` 是全插件唯一出口，改一处即可全量生效。
 */
export function originFromRes(res: unknown): string | undefined {
  const r = res as { req?: { headers?: Record<string, string | string[] | undefined> } };
  return originOf(r?.req?.headers);
}
