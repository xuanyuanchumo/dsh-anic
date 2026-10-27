/**
 * 运行实例标记域（cycle-81 · 一域一文件）：**本实例到底跑的是哪个 revision**。
 *
 * ## 为什么需要这个域（真机跑出来的，不是推演）
 * cycle-80 的重载判据是「dist 是否比 src 旧」。真机做完一轮完整流程后暴露了它的错位：
 *   改源码 → build（dist 已是新 revision）→ 此刻 dist **不再 stale**，但**运行中的实例仍是旧代码**
 *   → 重载被 `refused` 掉，恰好拒绝在最该重载的那一刻。用户诉求「热重载插件」于是退化成
 *   「先 build 再人工重启」。
 *
 * 正确判据是「**运行实例** revision ⇄ 当前 dist revision」。而「实例跑的是什么」不能猜——
 * 必须在 `apply` 时记录，否则任何判据都只是对 dist 的重复确认。
 *
 * ## 两级载体（各解决一半问题，缺一不可）
 * 1. **模块内存**：`apply` 与同模块实例的调用方共享，零成本、无 IO。
 * 2. **工作区旁路文件**（`.cycles/running-revision.json`）：真机第二轮实测——`POST /anic/api/reload`
 *    走的是**路由模块**，两次调用 `fromRevision` 均为 `null`，说明它读不到 apply 写入的内存值
 *    （门面 barrel 的模块实例是否共享取决于宿主加载粒度）。旁路文件让标记跨模块实例可见。
 *
 * ## 两条诚实纪律
 * - **过期即弃**（`RUNNING_REVISION_TTL_MS`）：停机窗口后留下的旧标记不可拿去否决本次重载；
 * - **读取失败 = 未知 = 不阻拦**：读不到不是「已同步」的证据（方向与"没有证据≠通过"一致：
 *   多一次无害重载 ≪ 误拒一次真重载）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 旁路文件名（放工作区 `.cycles/` 下，与 reload-history 同域）。 */
export const RUNNING_REVISION_FILE = 'running-revision.json';
/** 标记有效期：超过即视为陈旧（重启窗口 / 长时间停机后的旧记录不可信）。 */
export const RUNNING_REVISION_TTL_MS = 24 * 60 * 60 * 1000;

/** 进程内标记（唯一写点由 markRunningRevision 维护）。 */
let runningRevision: string | null = null;

/**
 * 记录本实例加载的 revision（apply 时调用，唯一写点）。
 *
 * @param revision dist 指纹；空串/无效值按「未知」处理（不伪造）。
 * @param cyclesDir 给出时同时写工作区旁路（跨模块实例可见）。
 */
export function markRunningRevision(revision: string | null, cyclesDir?: string): void {
  runningRevision = revision !== null && revision !== '' ? revision : null;
  if (cyclesDir === undefined || runningRevision === null) return;
  try {
    mkdirSync(cyclesDir, { recursive: true });
    const target = join(cyclesDir, RUNNING_REVISION_FILE);
    const tmp = `${target}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ revision: runningRevision, at: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    renameSync(tmp, target); // 原子替换：读侧永不见半写
  } catch {
    // 写失败不阻断 apply：内存值仍有效，路由侧退化为「未知 ⇒ 放行」。
  }
}

/**
 * 读本实例加载的 revision：内存 → 工作区旁路（TTL 校验）。
 *
 * 返回 `null` = **未知**（不是「已同步」）：调用方必须据此放行，而不是拒绝。
 */
export function readRunningRevision(cyclesDir?: string): string | null {
  if (runningRevision !== null) return runningRevision;
  if (cyclesDir === undefined) return null;
  try {
    const p = join(cyclesDir, RUNNING_REVISION_FILE);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { revision?: unknown; at?: unknown };
    if (typeof raw.revision !== 'string' || raw.revision === '') return null;
    const at = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN;
    if (!Number.isFinite(at) || Date.now() - at > RUNNING_REVISION_TTL_MS) return null;
    return raw.revision;
  } catch {
    return null;
  }
}

/** 仅测试用：清空内存标记（避免用例间串味）。 */
export function resetRunningRevisionForTest(): void {
  runningRevision = null;
}
