// budget.mjs — 技能脚本**子进程超时预算的单一事实源**（cycle-96 WS-C P1）。
//
// 被修缺陷（不是「机器慢」，是预算写错）：
//   auto-fix-loop.mjs:38 写死 `timeout: 120000` 跑 test_cmd，而真机
//   `.cycles/flow-tracker.json` 实测 auto-fix-loop 四次运行：DONE 26995、
//   TIMEOUT 240145 / 240711 / 243876 —— 18.8s 均值被 120s 预算掐断 ⇒
//   anic_status.health 报 timeoutRate 0.75。同一语义的预算在别处又写 300000
//   （eval-runner 的 test_cmd），两处彼此无依据、无对照：同一条 test_cmd 在
//   auto-fix-loop 里会被杀、在 eval-runner 里不会。预算必须只有一处定义。
//
// 数值依据（全部可复算，无一是目测）：
//   `.cycles/performance-baseline.md` 记录全量测试时长实测 **33.1s**（阈值 60s，
//   负载区间 36.5–69.2s）。本模块以该基线作为 test 的标尺，取 **×3** 余量：
//     33.1s × 3 ≈ 99.3s → 圆整 120s。
//   ×3 而非 ×1.5 的理由：基线本身已标注「随机器负载波动」，负载区间上界
//   69.2s 是基线的 2.09×；再留 ~1.4× 冷启动/并发余量才覆盖实测上界，
//   合计 ≈3×。1.5× 只能覆盖到 49.7s，比**已记录的真实上界 69.2s** 还低——
//   那等于换一个更小的魔法数，不是修错。
//   （注：本仓当前实测 `node scripts/run-tests.mjs --only=vitest` 73.9s，
//   仍在 120s 内；这正是「×1.5 不够、×3 够」的直接证据。）
//
// 其余 kind 的标尺（cycle-96 实测，本机，只读取证）：
//   lint   `node scripts/validate-dsh.mjs`  → 0.277s ⇒ 30s = 108×（极廉价，
//          留出 CI 冷启动与磁盘抖动，仍远低于任何真实工作量）。
//   build  `node scripts/build-client.mjs`  → 3.173s ⇒ 120s = 37.8×。
//   probe  一次性探测（--version / --help 类）：5s，见 PROBE_* 用点。
//   audit  `pnpm audit --json` 等网络命令：60s（网络 I/O 抖动远大于本地命令）。
//
// 为什么默认值必须同时可配置：不同项目 test_cmd 工作量差一到两个数量级
// （本仓 74s，一个纯单元测试项目 <2s，一个大工作区可达数百秒）。把默认值
// 当成唯一真值就是把「本仓的负载」写死给所有下游项目——这正是原缺陷的成因。
// 覆盖顺序：显式调用方入参 > 项目 `.cycles/config.yml` > 本模块 DEFAULT。
//
// 单一实现纪律：预算由本模块 resolveTimeout 收口一次，调用点只许
// `timeoutFor(kind)` / `resolveTimeout(kind, { config, override })`，不得
// 再写裸数字（回归守卫 tests/contract/scriptBudgetContract.test.ts 逐文件扫描）。

/** 各类子进程的**硬上限**（不是建议值）：单次调用不可超过它。 */
export const TIMEOUT_MS = {
  /** test_cmd：基线 33.1s × ~3.6（对上界 69.2s 约 1.7×）。 */
  test: 120_000,
  /** lint_cmd：实测 0.277s，给 108× 余量。 */
  lint: 30_000,
  /** build_cmd：实测 3.173s，给 ~38× 余量。 */
  build: 120_000,
  /**
   * 本机 node 脚本（如 band-detector，由 eval-runner 内调）：实测 0.180s、
   * 0.174s。沿用原本就存在的 30000 口径（≈167×）而**不下调**——把一个能过
   * 的检查因预算收紧变 SKIP，是拿"统一"换取新的假证据，比不统一更坏。
   */
  script: 30_000,
  /** 一次性探测（--version/--help/存在性）：允许冷启动，阻止挂死。 */
  probe: 5_000,
  /** 网络型命令（audit 等）：I/O 抖动主导，与本地命令不同标尺。 */
  audit: 60_000,
};

/**
 * 预算的**可配置来源**说明串（供 --help / 报告详情引用，避免文案与实现漂移）。
 * 键名即 `.cycles/config.yml` 里的键（与 test_cmd 同层，扁平）。
 */
export const BUDGET_CONFIG_KEYS = {
  test: 'test_timeout_ms',
  lint: 'lint_timeout_ms',
  build: 'build_timeout_ms',
};

const KNOWN_KINDS = Object.keys(TIMEOUT_MS);

/**
 * 取某 kind 的默认预算（毫秒）。未知 kind **响亮失败**——静默回退默认值正是
 * 「预算写错却没人发现」的温床（例如有人写成 'tests' 就永远拿不到真预算）。
 */
export function timeoutFor(kind) {
  const v = TIMEOUT_MS[kind];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(`[budget] unknown or invalid kind: ${String(kind)} (known: ${KNOWN_KINDS.join(', ')})`);
  }
  return v;
}

/**
 * 收口一次超时值：override > configMs > default，越界/非法一律落回默认。
 *
 * @param {string} kind    TIMEOUT_MS 的键
 * @param {object} [opts]
 *   override  调用方显式超时（命令行旗标 / 上层宿主预算）；非正数/非数被忽略。
 *   configMs  从 `.cycles/config.yml` 解析出的覆盖值（timeoutFromConfig 的产物）；
 *             优先级低于 override——显式入参是比项目配置更近的决定，与
 *             显式传参优先的既有语义一致。
 * @returns {number} 毫秒
 */
export function resolveTimeout(kind, opts = {}) {
  const base = timeoutFor(kind);
  for (const candidate of [opts.override, opts.configMs]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return base;
}

/**
 * 从配置内容里解析某 kind 的超时覆盖值；缺键/非正整数 → null（不是 0）。
 *
 * 独立解析而非 import lib/config.mjs：本模块被 eval-runner / gate-check /
 * auto-fix-loop 三处引用，任何依赖都必须零副作用且不成环。解析规则与
 * config.mjs 的 getYamlString 保持一致（引号可选、容忍行尾注释）——
 * 若将来两者漂移，由 scriptBudgetContract 的 parity 断言报红。
 */
export function timeoutFromConfig(configContent, kind) {
  const key = BUDGET_CONFIG_KEYS[kind];
  if (!key || typeof configContent !== 'string') return null;
  // `^` + m 旗标 = 行首锚定，避免键名出现在注释/嵌套块里被误当覆盖值。
  const m = configContent.match(new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm'));
  if (!m) return null;
  let raw = m[1].trim();
  const hash = raw.indexOf(' #');
  if (hash >= 0) raw = raw.slice(0, hash).trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 判定一次 execSync 抛出的错误是否**超时**（而非测试失败）。
 *
 * 为什么需要这个函数：`execSync` 的超时错误形态在 Windows 与 POSIX 上不同，
 * 而且**本仓既有实现有死角**：
 *   - eval-runner.mjs 判 `e.killed === true && e.signal === 'SIGTERM'`；
 *     但真机实测（Windows / cmd.exe）超时错误是
 *     `{ name:'Error', code:'ETIMEDOUT', status:null, signal:'SIGTERM', killed:undefined }`
 *     —— **killed 属性根本不存在**，该判据恒假 ⇒ 超时被当成测试失败
 *     （把半截 stderr 当失败详情，正是 cycle-39 归因错误的另一半根因）。
 *   - auto-fix-loop.mjs 完全不判超时 ⇒ 超时与失败同归「修复失败」，重试对
 *     超时无效（重试同一超只会再超时，还每轮烧掉一整个预算）。
 * 判据按**证据强度**排序：code ETIMEDOUT（最强，跨平台）> killed > SIGTERM+无退出码。
 * 真实测试失败形态是 `{ status: <数字退出码>, signal: null }`，与之不相交。
 */
export function isTimeoutError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'ETIMEDOUT') return true;
  if (err.killed === true) return true;
  // SIGTERM 且无数字退出码：非零退出码一定不是超时（进程正常终止过）；
  // status === null 表示「被杀而不是自己退出」。
  return err.signal === 'SIGTERM' && err.status === null;
}

/** 判定是否缓冲区溢出（ENOBUFS）：同为「看不见完整输出」，但不是超时。 */
export function isBufferOverflowError(err) {
  return Boolean(err && typeof err === 'object' && err.code === 'ENOBUFS');
}

/**
 * 一次 auto-fix-loop 的**总时长**预算：每轮跑两遍（验证 + 复验），
 * 加上报告/审计写盘开销。
 * 键存在的理由：脚本内的单次预算是 per-command；宿主侧 spawn 超时是
 * per-invocation（见 src/host/runtime/bootstrapBudget.ts 的 240s 上限）。
 * 两者若不联动，内层预算调大后外层反而先掐断——把「预算不足」的病
 * 换个地方复发。此函数让「总预算」也可算、可断言。
 */
export function loopBudgetMs(maxRetries, perCommandMs = timeoutFor('test')) {
  const retries = Number.isFinite(maxRetries) && maxRetries > 0 ? maxRetries : 3;
  const perRun = Number.isFinite(perCommandMs) && perCommandMs > 0 ? perCommandMs : timeoutFor('test');
  return retries * 2 * perRun;
}

/** 已知 kind 列表（供契约测试与 --help 遍历，避免测试手抄一份）。 */
export function knownKinds() {
  return [...KNOWN_KINDS];
}
