/**
 * 部署一致性守卫（cycle-80 WS-2）——「源码改了但 dist 没重建」必须红。
 *
 * ## 被守卫的缺陷（真实事故类，不是假想）
 *
 * 本插件以 `link:` 方式装在宿主 profile 里 ⇒ 宿主加载的**就是** `dist/host.js` +
 * `dist/client.js`。而仓库里的开发流程是「改 `src/` → 全量测试绿 → 忘了 build」：
 * 测试跑的是 TS 源码（vitest 直接 import src），宿主跑的却是**旧 bundle**。
 * 于是一整轮"已修好"的结论在真机上完全不成立，而且没有任何一条断言会变红——
 * 这不是"环境差异"，是**部署一致性没有任何守卫**。
 *
 * ## 判据
 *
 * ① `computeBuildRevision` 形状真实：revision 16 位 hex、host/client 各 64 位 sha256、
 *    builtAt 可解析（不是伪造的 ''/0/unknown）；
 * ② 真实仓库 `stale === false`（Lead 收口前统一 build；此后谁改 src 忘 build，这里红）；
 * ③ **反向自检**：tmp pluginRoot 里 dist 比 src 新 → fresh；再造一个更新的 src 文件
 *    → 必须 stale（证明判定真的在看 mtime，而不是恒 false）；
 * ④ 失败方向诚实：dist 缺失 → `stale === true` 且 `reason` 非空、`revision === null`
 *    （缺文件不得报"新鲜"——那是把"不知道"伪装成"没问题"）。
 *
 * 反向自检夹具全在 `mkdtempSync` 临时目录里，不碰真实 dist；只读真实仓库（R-31）。
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFreshness, computeBuildRevision } from '../../src/host/runtime/hotReload.ts';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 在 tmp 里造一个最小 pluginRoot（src + dist 的 mtime 由调用方决定）。 */
function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  return root;
}

/** 给文件设定未来 mtime（避免依赖真实时钟精度：秒级 mtime 在同一秒内会相等）。 */
function touchAt(file: string, msFromNow: number): void {
  const t = new Date(Date.now() + msFromNow);
  utimesSync(file, t, t);
}

describe('cycle-80 部署一致性契约（src 新于 dist ⇒ 红）', () => {
  it('① computeBuildRevision 形状真实（不伪造 {{ "", 0, unknown }}）', () => {
    const rev = computeBuildRevision(PLUGIN_ROOT);
    expect(rev, 'dist 缺失 ⇒ 无法校验部署一致性（请先 build）').not.toBeNull();
    if (rev === null) return;
    expect(rev.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(rev.host).toMatch(/^[0-9a-f]{64}$/);
    expect(rev.client).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(rev.builtAt))).toBe(false);
    // revision 必须是 host:client 的派生量，而不是两段哈希之外另编的值
    expect(rev.revision).toHaveLength(16);
    expect(rev.revision).not.toBe(rev.host.slice(0, 16));
  });

  it('② 真实仓库必须 fresh：stale === false（改了 src 忘 build 就红）', () => {
    const freshness = buildFreshness(PLUGIN_ROOT);
    expect(
      freshness.stale,
      `dist 落后于源码（newest src = ${String(freshness.newestSrcFile)}）——先 build 再跑本契约`,
    ).toBe(false);
    expect(freshness.revision, 'fresh 却拿不到 revision ⇒ 判定与 revision 不同源').not.toBeNull();
    expect(freshness.newestSrcFile).not.toBeNull();
  });

  it('③ 反向自检：dist 新 → fresh；再造更新的 src → 必须 stale', () => {
    const root = makeRoot('anic-fresh-');
    try {
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      const host = join(root, 'dist', 'host.js');
      const client = join(root, 'dist', 'client.js');
      writeFileSync(host, 'host-bundle');
      writeFileSync(client, 'client-bundle');
      touchAt(host, 60_000);
      touchAt(client, 60_000);
      expect(buildFreshness(root).stale, 'dist 比 src 新却被判 stale ⇒ 恒红守卫').toBe(false);

      // 这就是"改完源码忘 build"的确切形态：src 比 dist 新。
      const b = join(root, 'src', 'b.ts');
      writeFileSync(b, 'export const b = 2;\n');
      touchAt(b, 120_000);
      const stale = buildFreshness(root);
      expect(stale.stale, 'src 已新于 dist 却报 fresh ⇒ 守卫恒绿').toBe(true);
      expect(stale.newestSrcFile).toContain('b.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('④ 失败方向诚实：dist 缺失 → stale=true + reason 非空 + revision=null', () => {
    const root = makeRoot('anic-fresh-nodist-');
    try {
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      rmSync(join(root, 'dist'), { recursive: true, force: true });
      expect(computeBuildRevision(root)).toBeNull();
      const freshness = buildFreshness(root);
      expect(freshness.stale, 'dist 缺失不得报 fresh（把"不知道"伪装成"没问题"）').toBe(true);
      expect((freshness.reason ?? '').length).toBeGreaterThan(0);
      expect(freshness.revision).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
