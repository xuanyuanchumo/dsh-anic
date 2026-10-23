/**
 * README 数字契约（cycle-39 T-3906）——「以 README 为准」的指针链修复。
 *
 * 缺陷史（cycle-39 docs 审计）：doc16 L6 指定 dsh-anic/README.md 为「当前
 * 工具清单权威」，但该 README 自身漏 1 工具（18 vs 19）、路由数差 25 条
 * （37 vs 62）——被指定的活真相源漂移一个版本周期，无任何门禁拦截
 * （truthAudit T4 只扫 src 不覆盖文档数字）。
 *
 * 本契约把 README 的关键数字钉到 glob 实测计数上——数字漂移即红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

/** 数 README 中 tools*.ts 域真实注册的工具（源码形态计数）。 */
function countRegisteredTools(): number {
  const hostDir = join(ROOT, 'src', 'host');
  const toolFiles = readdirSync(hostDir).filter((f) => /^tools.*\.ts$/.test(f));
  const names = new Set<string>();
  for (const f of toolFiles) {
    const code = readFileSync(join(hostDir, f), 'utf8');
    for (const m of code.matchAll(/name:\s*'(anic_[a-z_]+)'/g)) names.add(m[1] ?? '');
  }
  return names.size;
}

/** 数路由注册路径（path: 字面量 + reg('...') 帮助形态 + 常量引用）。 */
function countRegisteredRoutes(): number {
  const files = [
    ...readdirSync(join(ROOT, 'src', 'host', 'routes')).filter((f) => f.endsWith('.ts')).map((f) => join(ROOT, 'src', 'host', 'routes', f)),
    ...readdirSync(join(ROOT, 'src', 'host')).filter((f) => /Route\.ts$/.test(f)).map((f) => join(ROOT, 'src', 'host', f)),
  ];
  const found: string[] = [];
  for (const p of files) {
    const t = readFileSync(p, 'utf8');
    const patterns = [
      /path:\s*'(\/anic[^']*)'/g,
      /path:\s*"(\/anic[^"]*)"/g,
      /reg\(\s*'(?:GET|POST|PUT|DELETE)'\s*,\s*'(\/anic[^']*)'/g,
      /reg\(\s*'(\/anic[^']*)'\s*,/g,
    ];
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null = re.exec(t);
      while (m !== null) {
        if (m[1]) found.push(m[1]);
        m = re.exec(t);
      }
    }
    // 常量引用形态：const X_ROUTE = '/anic/...' + path: X_ROUTE
    const constRe = /const (\w+_ROUTE) = '(\/anic[^']*)'/g;
    let cm: RegExpExecArray | null = constRe.exec(t);
    const constMap: Record<string, string> = {};
    while (cm !== null) {
      if (cm[1] && cm[2]) constMap[cm[1]] = cm[2];
      cm = constRe.exec(t);
    }
    const useRe = /(?:path:\s*|register\(\s*'(?:GET|POST|PUT|DELETE)'\s*,\s*)(\w+_ROUTE)/g;
    let um: RegExpExecArray | null = useRe.exec(t);
    while (um !== null) {
      if (um[1] && constMap[um[1]]) found.push(constMap[um[1]]);
      um = useRe.exec(t);
    }
  }
  return new Set(found).size;
}

describe('README 数字契约（活真相源不漂移）', () => {
  it('README「21 个 anic_* LLM 工具」== tools*.ts 源码注册计数', () => {
    const declared = /(\d+) 个 `anic_\*` LLM 工具/.exec(README)?.[1];
    expect(declared, 'README 需声明「N 个 anic_* LLM 工具」（找不到该句式 = 契约句被删）').toBeDefined();
    expect(Number(declared)).toBe(countRegisteredTools());
  });

  it('README「N 个 HTTP 路由注册」== 路由文件 path 注册计数', () => {
    const declared = /(\d+) 个 HTTP 路由注册/.exec(README)?.[1];
    expect(declared, 'README 需声明「N 个 HTTP 路由注册」').toBeDefined();
    expect(Number(declared)).toBe(countRegisteredRoutes());
  });

  it('README「19 DSH 工具」小节标题存在且 anic_skill_repair 在清单中', () => {
    expect(README).toMatch(/### 19 DSH 工具/);
    expect(README).toContain('`anic_skill_repair`');
  });

  it('反向自检：工具计数器能数到 19（扫描器哑掉时本断言红）', () => {
    expect(countRegisteredTools()).toBe(21);
  });
});
