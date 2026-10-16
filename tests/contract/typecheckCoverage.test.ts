/**
 * typecheck 覆盖契约守卫（P0：typecheck 覆盖漏洞）。
 *
 * 缺陷类：**"两个 tsconfig 的 include 各自为政，部分源文件从未被类型检查"**。
 * 实证（2026-10-16）：`src/adapters/index.ts` 与 `src/shared/errors.ts` 不在
 * 任何 tsconfig include 里，且从两个入口（src/index.ts / src/client/index.ts）
 * 都不可达 —— 从未被 tsc 检查过，adapters 里潜伏 7 个真实类型错误
 * （TS2322/TS7006 ×7），而 `pnpm run typecheck` 恒 exit 0（伪自信）。
 * truthAudit 的 requiredFiles 检查只做 existsSync —— 文件存在即 pass，
 * 对"存在但从未编译"视而不见。
 *
 * 守卫三条纪律（与 independenceGuard / dshConformance 同形）：
 *   ① 反向自检：每个匹配器先证明正例/负例都能被正确判定；
 *   ② 不匹配自身：守卫不依赖被守文件的内容；
 *   ③ 扫描集非空：tsconfig 解析结果为空时必须报红，不能静默永绿。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = join(PLUGIN_ROOT, 'src');

interface TsConfig {
  include: string[];
}

function loadTsConfig(name: string): TsConfig {
  const raw = JSON.parse(readFileSync(join(PLUGIN_ROOT, name), 'utf-8')) as { include?: string[] };
  if (!Array.isArray(raw.include) || raw.include.length === 0) {
    throw new Error(`${name} 解析结果为空 include —— 守卫纪律③：扫描集非空，静默空扫描等同永久绿`);
  }
  return { include: raw.include.map(String) };
}

/** 递归列出 src/ 下全部 .ts/.tsx 文件（相对 PLUGIN_ROOT，用 / 分隔）。 */
function listSrcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        out.push(full.slice(PLUGIN_ROOT.length + 1).replace(/\\/g, '/'));
      }
    }
  };
  walk(SRC_ROOT);
  if (out.length < 20) throw new Error(`src/ 扫描只有 ${String(out.length)} 个文件 —— 守卫纪律③：扫描集异常`);
  return out;
}

/**
 * 极简 glob → 匹配器（只支持本仓库 tsconfig 使用的两种形态：
 * `src/x.ts` 精确路径 与 `src/dir/` 目录下递归后缀（双星形态））。
 * 注意：glob 字面量写成「目录前缀 + 双星 + 斜杠 + 后缀」时，其中的
 * 星星斜杠序列会提前终结本块注释 —— 这是本项目第五次踩到，改用行注释描述。
 */
function makeMatcher(pattern: string): (relPath: string) => boolean {
  if (!pattern.includes('*')) return (p) => p === pattern;
  const m = pattern.match(/^(.*)\/\*\*\/(.*)$/);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new Error(`不支持的 glob 形态：${pattern}（守卫需跟进 tsconfig 变更）`);
  }
  // 后缀自身可能带星（"*.ts"）：星号前的字面量必须原样出现，星号即通配。
  // 本仓库只有 "*.ts" / "*.tsx" 两种（单星前缀），按「单星通配尾段」处理。
  const dirPrefix = m[1];
  const suffix = m[2];
  const starIdx = suffix.indexOf('*');
  if (starIdx >= 0) {
    const head = suffix.slice(0, starIdx);
    const tail = suffix.slice(starIdx + 1);
    return (p) => p.startsWith(`${dirPrefix ?? ''}/`) && p.includes(head) && p.endsWith(tail);
  }
  return (p) => p.startsWith(`${dirPrefix ?? ''}/`) && p.endsWith(suffix);
}

describe('tsconfig include 覆盖契约（P0：typecheck 覆盖漏洞）', () => {
  const client = loadTsConfig('tsconfig.client.json');
  const host = loadTsConfig('tsconfig.host.json');
  const files = listSrcFiles();
  const clientMatchers = client.include.map(makeMatcher);
  const hostMatchers = host.include.map(makeMatcher);

  it('纪律①：匹配器反向自检（正例与负例都能正确判定）', () => {
    const m = makeMatcher('src/host/**/*.ts');
    expect(m('src/host/tools.ts')).toBe(true);
    expect(m('src/host/routes/index.ts')).toBe(true);
    expect(m('src/client/index.ts')).toBe(false);
    expect(m('src/shared/tokens.ts')).toBe(false);
    const exact = makeMatcher('src/index.ts');
    expect(exact('src/index.ts')).toBe(true);
    expect(exact('src/host/index.ts')).toBe(false);
    // 负例样例必须真的"不在任何 include 里"才证明下面的覆盖断言有意义
    const ghost = 'src/nowhere/orphan.ts';
    const coveredByAny = [...clientMatchers, ...hostMatchers].some((f) => f(ghost));
    expect(coveredByAny).toBe(false);
  });

  it('两个 tsconfig 的 include 互不重叠（同文件不会被双入口重复编译）', () => {
    for (const pattern of host.include) {
      const m = makeMatcher(pattern);
      for (const cp of client.include) {
        const cm = makeMatcher(cp);
        // 抽样判定：全部真实文件中不得有文件同时命中两个 config
        for (const f of files) {
          expect({ file: f, host: m(f), client: cm(f), hostPattern: pattern, clientPattern: cp }).not.toEqual(
            expect.objectContaining({ host: true, client: true }),
          );
        }
      }
    }
  });

  it('每个 src/**.(ts|tsx) 恰好落进一个 tsconfig（P0 主断言：零漏检、零双检）', () => {
    const uncovered: string[] = [];
    const double: string[] = [];
    for (const f of files) {
      const inClient = clientMatchers.some((m) => m(f));
      const inHost = hostMatchers.some((m) => m(f));
      if (!inClient && !inHost) uncovered.push(f);
      if (inClient && inHost) double.push(f);
    }
    expect(uncovered, `未被任何 tsconfig include 的文件（修复方向：加入对应 include，或删除死文件）:\n${uncovered.join('\n')}`).toEqual([]);
    expect(double, `被两个 tsconfig 同时 include 的文件:\n${double.join('\n')}`).toEqual([]);
  });

  it('回归样例：adapters 与 shared 曾经漏检的两个文件现在被覆盖', () => {
    const covered = (f: string) => [...clientMatchers, ...hostMatchers].some((m) => m(f));
    // P0 实证文件：2026-10-16 前 both uncovered & 从未被类型检查
    expect(covered('src/adapters/index.ts')).toBe(true);
    expect(covered('src/shared/errors.ts')).toBe(true);
  });
});
