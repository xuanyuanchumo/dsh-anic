/**
 * 构建新鲜度域（cycle-80 WS-1 · 一域一文件）：dist 指纹 + 源码是否新于构建。
 *
 * ## 被修的缺口
 * 热重载若「无条件触发」，每次调用都会让宿主拆装一遍插件——既慢又会打断正在跑的会话；
 * 反过来「永远不触发」就等于人工重启。判据必须是**可机器验证的事实**：dist 两个产物的
 * 指纹（sha256）与较新 mtime，对上 src 下最新 mtime。没有这个判据，`refused` 与
 * `scheduled` 就只能靠调用方自觉——那等于没有设计。
 *
 * ## 诚实边界
 * - dist 缺失 → `stale=true` 且 reason 点名「先 build」，**不伪造**指纹；
 * - 时间判据用严格大于：构建后同毫秒写盘不判 stale（否则刚 build 完就误触发重载）；
 * - 本模块只读盘算判断，不触发任何重载（动作在 reloadOrchestrator）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

/** 当前构建的指纹（host/client 各自 sha256 + 合成 revision；任一产物缺失即 null）。 */
export interface BuildRevision {
  /** dist/host.js 的 sha256（全 hex，供对账）。 */
  host: string;
  /** dist/client.js 的 sha256（全 hex，供对账）。 */
  client: string;
  /** 前两者合成的 16 位指纹（人读/留痕用）。 */
  revision: string;
  /** 两个产物中**较新**的 mtime（ISO）——重载命中面是合并后的产物。 */
  builtAt: string;
}

/** 源码是否新于构建产物（stale = src 最新 mtime > dist 较新 mtime）。 */
export interface BuildFreshness {
  stale: boolean;
  newestSrc: string | null;
  newestSrcFile: string | null;
  revision: BuildRevision | null;
  reason?: string;
}

/** 读 dist/host.js + dist/client.js 算构建指纹；任一缺失返回 null（不伪造）。 */
export function computeBuildRevision(pluginRoot: string): BuildRevision | null {
  const hostPath = join(pluginRoot, 'dist', 'host.js');
  const clientPath = join(pluginRoot, 'dist', 'client.js');
  try {
    if (!existsSync(hostPath) || !existsSync(clientPath)) return null;
    const host = createHash('sha256').update(readFileSync(hostPath)).digest('hex');
    const client = createHash('sha256').update(readFileSync(clientPath)).digest('hex');
    const revision = createHash('sha256').update(`${host}:${client}`).digest('hex').slice(0, 16);
    const builtAtMs = Math.max(statSync(hostPath).mtimeMs, statSync(clientPath).mtimeMs);
    return { host, client, revision, builtAt: new Date(builtAtMs).toISOString() };
  } catch {
    // 权限/竞态读取失败与「没有产物」同等处理：判断不了新鲜度就不许触发重载。
    return null;
  }
}

/** 递归取 src/ 下最新 mtime 的 .ts（跳过隐藏目录；单文件消失不算发现）。 */
function newestSource(pluginRoot: string): { ms: number; file: string } | null {
  const srcRoot = join(pluginRoot, 'src');
  if (!existsSync(srcRoot)) return null;
  let best: { ms: number; file: string } | null = null;
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries: Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const name = String(e.name);
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!name.endsWith('.ts')) continue;
      try {
        const ms = statSync(full).mtimeMs;
        if (best === null || ms > best.ms) best = { ms, file: full };
      } catch { /* 消失中的文件不是发现 */ }
    }
  };
  walk(srcRoot, 0);
  return best;
}

/** 源码是否新于构建产物（stale）。dist 缺失 → stale=true 且 reason 点名怎么修。 */
export function buildFreshness(pluginRoot: string): BuildFreshness {
  const revision = computeBuildRevision(pluginRoot);
  const newest = newestSource(pluginRoot);
  const newestSrc = newest === null ? null : new Date(newest.ms).toISOString();
  const newestSrcFile = newest?.file ?? null;
  if (revision === null) {
    return { stale: true, newestSrc, newestSrcFile, revision: null, reason: 'dist build missing — run `pnpm run build` first' };
  }
  if (newest === null) {
    return { stale: true, newestSrc, newestSrcFile, revision, reason: 'no src/**/*.ts found — cannot judge freshness' };
  }
  // 严格大于：构建后同毫秒写盘不判 stale（否则刚 build 完立刻调用就会误触发重载）。
  const stale = newest.ms > Date.parse(revision.builtAt);
  return { stale, newestSrc, newestSrcFile, revision };
}
