/**
 * cycle-99c：进程窗口抑制静态审计（「不要有 node/vitest 命令窗口」的机器守卫）。
 *
 * 被守卫缺陷：Windows 上 spawnSync/spawn/execSync 进程创建原语缺 windowsHide
 * 会**每次调用弹一个控制台窗口**（eval-runner 一次派 3 个 detached 子进程 +
 * 15 个技能脚本 + 自举循环反复触发 = 一排弹窗）。cycle-98/99b 修了大部分，
 * 本轮审计发现 multi-agent-gate / plan-sync-check / org-status / start-dsh-test
 * 仍有漏网——已全部补齐，本守卫防复发。
 *
 * 白盒纪律：数字非零下限（防空扫描假绿）+ 反向自检（守卫判据对故意漏写的
 * 夹具必须变红，证明不是恒真检查）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');

/** 递归收集某扩展名文件（跳过 node_modules/dist/.git/.cycles 归档）。 */
function collectFiles(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === '.cycles' || entry === '.dsh') continue;
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) collectFiles(p, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(p);
  }
  return out;
}

/** 从源码文本提取所有 spawnSync(/spawn(/execSync( 调用点（逐行扫描）。 */
export function findProcessCallSites(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // 排除注释行
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    // 排除正则常量（如 CALL_PRIMITIVE_RE = /…spawn(?:Sync)?…/ ——字面量里的
    // spawn( 不是真实调用点）
    if (/const\s+\w*(RE|Regex)\s*=\s*\//.test(line)) continue;
    // spawnSync/execSync 全匹配；spawn 用负向后顾排除 spawnSync 前缀
    if (/execSync\s*\(/.test(line) || /(?<![A-Za-z])spawnSync\s*\(/.test(line) || /(?<![A-Za-z])spawn\s*\(/.test(line)) {
      out.push({ line: i + 1, text: line.trim() });
    }
  }
  return out;
}

/**
 * 判定调用点是否被 windowsHide 覆盖：从调用行扫描到**调用的闭括号**（`});`），
 * 以内出现 windowsHide: 即覆盖；无闭括号形态（同行内联 options）则看同行 +
 * 向后最多 12 行兜底。
 */
export function isWindowsHideCovered(text: string, line: number): boolean {
  const lines = text.split('\n');
  const end = Math.min(lines.length, line + 12);
  for (let i = line - 1; i < end; i++) {
    const cur = lines[i] ?? '';
    // 注释行不计（`// windowsHide: true` 不是真实配置）
    if (/^\s*(\/\/|\*|\/\*)/.test(cur)) continue;
    if (/windowsHide\s*:/.test(cur)) return true;
    // 调用的 options 闭括号：到此为止。两种形态：
    //   a) 行首 `});`（多行 options）
    //   b) 调用行自身内联闭合（同行 `});`——只认同行 windowsHide）
    if (i > line - 1 && /^\s*\}\s*\)\s*;/.test(cur)) return false;
    if (i === line - 1 && /\}\s*\)\s*;/.test(cur) && !/\{\s*$/.test(cur)) {
      // 同行内联闭合且同行无 windowsHide（走到这里说明上面 return true 没触发）
      return false;
    }
  }
  return false;
}

describe('全仓进程创建原语 windowsHide 覆盖审计（cycle-99c）', () => {
  it('每个 spawnSync/spawn/execSync 调用点都在 windowsHide 覆盖内', () => {
    const files = [
      ...collectFiles(join(ROOT, 'src'), ['.ts']),
      ...collectFiles(join(ROOT, 'scripts'), ['.mjs']),
      ...collectFiles(join(ROOT, 'assets', 'skill', 'scripts'), ['.mjs']),
    ];
    expect(files.length).toBeGreaterThan(5); // 扫描集非空

    const violations: string[] = [];
    let checked = 0;
    for (const f of files) {
      const text = readFileSync(f, 'utf-8');
      for (const site of findProcessCallSites(text)) {
        checked++;
        if (!isWindowsHideCovered(text, site.line)) {
          violations.push(`${f}:${site.line}: ${site.text}`);
        }
      }
    }
    // 数字非零下限：真实仓库进程创建点 ≥ 25 处（防扫描器坏掉假绿）
    expect(checked).toBeGreaterThanOrEqual(25);
    expect(violations).toEqual([]);
  });

  it('反向自检①：判据对故意漏写 windowsHide 的夹具必须变红（不是恒真）', () => {
    const fixture = [
      "const r = spawnSync('node', ['x.mjs'], { cwd, timeout: 1000 });",
      'const c = spawn(cmd, args, { stdio: "ignore", detached: true });',
      'const o = execSync(cmd, { cwd, stdio: "pipe" });',
    ].join('\n');
    expect(findProcessCallSites(fixture).length).toBe(3);
    expect(isWindowsHideCovered(fixture, 1)).toBe(false);
    expect(isWindowsHideCovered(fixture, 2)).toBe(false);
    expect(isWindowsHideCovered(fixture, 3)).toBe(false);
  });

  it('反向自检②：带 windowsHide 的形态必须判绿（守卫不误伤）', () => {
    const fixture = [
      "const r = spawnSync('node', ['x.mjs'], { cwd, timeout: 1000, windowsHide: true });",
      'const c = spawn(cmd, args, {',
      '  stdio: "ignore", detached: true,',
      '  windowsHide: true, // cycle-98 注释',
      '});',
    ].join('\n');
    expect(isWindowsHideCovered(fixture, 1)).toBe(true);
    expect(isWindowsHideCovered(fixture, 2)).toBe(true);
    // 同一调用 options 内隔多行仍算覆盖（扫描到闭括号为止）
    const loose = [
      'const c = spawn(cmd, args, {',
      '  stdio: "ignore",',
      '  detached: true,',
      '  // ……',
      '  // ……',
      '  windowsHide: true,',
      '});',
    ].join('\n');
    expect(isWindowsHideCovered(loose, 1)).toBe(true);
    // 反向：windowsHide 出现在**闭括号之后**（属于下一个调用/其他语句）不计数
    const afterClose = [
      'const c = spawn(cmd, args, { stdio: "ignore" });',
      '// windowsHide: true  ←注释行不算',
      'const d = otherCall(x, { windowsHide: true });',
    ].join('\n');
    expect(isWindowsHideCovered(afterClose, 1)).toBe(false);
  });

  it('正则精度：spawnSync( 不被 \\bspawn\\s*\\( 误命中重复计数', () => {
    const fixture = "const r = spawnSync(cmd, opts);";
    // 该行只产生 1 个调用点（spawnSync），不会因 spawn 前缀再记 1 次
    expect(findProcessCallSites(fixture).length).toBe(1);
  });
});
