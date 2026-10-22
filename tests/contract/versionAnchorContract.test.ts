/**
 * 版本锚点契约守卫（cycle-71，补录 v0.39/v0.40 欠账的结构性根治）。
 *
 * ## 为什么钉这个
 *
 * **实证缺陷**：`package.json` 为 `0.40.0`，但 `CHANGELOG.md` 首条版本停在
 * **v0.38.0**——v0.39.0 / v0.40.0 **两代未记录**（git commit `2ada8b3` /
 * `3c70baa` 早已带这两个版本号）。漂移持续了 **31 个提交**且**无人报警**。
 *
 * 同类先例：cycle-67 的 `apiDocShapeContract` 证明「文档无同步触发器 → 协议
 * 扩展时静默落后四轮」（API 册停在 cycle-97）。本守卫是同一模式的**版本面**
 * 收口：把「包版本 ⇄ CHANGELOG 首条」固化为契约。
 *
 * ## 判据（双向）
 *
 *   `package.json.version` 必须**等于** `CHANGELOG.md` 第一条 `## vX.Y.Z` 版本。
 *
 * 单向 `contains` 会放过「CHANGELOG 有新版本但包没升」或反之——双向相等才拦得住。
 *
 * ## 守卫三条纪律（同 guardRegistry / dshConformance）
 *
 * - 反向自检：先用样例证明解析器能判「不相等」，再谈守卫；
 * - 不匹配自身：样例字面量拼接构造；
 * - 扫描集非空：解析出空串 = 格式漂移，直接 FAIL（不静默永绿）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
const CHANGELOG = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

/** 从 CHANGELOG 提取首个 `## vX.Y.Z` 版本号；无匹配返回 ''。 */
function firstChangelogVersion(text: string): string {
  const m = /^##\s+v(\d+\.\d+\.\d+)/m.exec(text);
  return m?.[1] ?? '';
}

/** 语义化版本形状（含预发布后缀）。 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe('版本锚点契约（package.json ⇄ CHANGELOG 首条）', () => {
  it('守卫纪律③：解析集非空（CHANGELOG 首条版本必须能解析出来）', () => {
    const cl = firstChangelogVersion(CHANGELOG);
    expect(cl, 'CHANGELOG 未解析出 `## vX.Y.Z` 首条版本——格式漂移或文件缺失').not.toBe('');
  });

  it('守卫纪律①：解析器反向自检（能判「不相等」且不被相似形态欺骗）', () => {
    // 正例：首个版本行被正确提取
    expect(firstChangelogVersion('## v0.40.0 — 2026-10-22\n\n## v0.39.0 — x')).toBe('0.40.0');
    // 负例：无版本行 → 空串（守卫纪律③ 会据此 FAIL）
    expect(firstChangelogVersion('## 头部\n无版本')).toBe('');
    // 负例：`###` 三级标题不算首条版本（只有 `## vX.Y.Z` 契约形态才认）
    expect(firstChangelogVersion('### v0.40.0\n## v0.38.0 — x')).toBe('0.38.0');
    // 负例：非版本号文本不匹配
    expect(firstChangelogVersion('## 版本历史（无号）')).toBe('');
  });

  it('package.json 版本是合法 semver 形状', () => {
    expect(pkg.version).toMatch(SEMVER_RE);
  });

  it('**主断言**：package.json.version === CHANGELOG 首条版本（双向，改一处不改另一处即红）', () => {
    const cl = firstChangelogVersion(CHANGELOG);
    expect(
      pkg.version,
      `包版本 ${pkg.version} 与 CHANGELOG 首条 v${cl} 不一致——升包版本必须同步补 CHANGELOG 条目（反向亦然）`,
    ).toBe(cl);
  });

  it('CHANGELOG 首条版本不早于次条版本（版本序单调，防插错位置）', () => {
    const versions = [...CHANGELOG.matchAll(/^##\s+v(\d+\.\d+\.\d+)/gm)].map((m) => m[1] ?? '');
    expect(versions.length, 'CHANGELOG 版本条目数下限').toBeGreaterThanOrEqual(3);
    const num = (v: string): number[] => v.split('.').map(Number);
    const cmp = (a: string, b: string): number => {
      const [x, y] = [num(a), num(b)];
      for (let i = 0; i < 3; i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      }
      return 0;
    };
    for (let i = 1; i < versions.length; i++) {
      const prev = versions[i - 1] ?? '';
      const cur = versions[i] ?? '';
      expect(cmp(prev, cur), `CHANGELOG 版本序应降序：v${prev} 不应早于 v${cur}`).toBeGreaterThan(0);
    }
  });
});
