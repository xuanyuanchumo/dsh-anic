/**
 * 客户端同源契约守卫（cycle-71，依据 asar 一手取证）。
 *
 * **为什么需要这条守卫**：桌面端不是 `file://`+IPC，而是 `dsh-app://app`
 * （privileged scheme）+ `protocol.handle` **同源反向代理**到 Host webserver
 * （asar `lib/main.js:7009` 定义 scheme、`:11880-11890` 注册、`:12411-12412`
 * `forwardWebRequest`）。代理层按 Origin 白名单放行——`:8271` 逐字：
 *
 *     if (origin !== null && origin !== "dsh-app://app") return 403
 *
 * 后果：客户端任何**绝对 http(s):// URL** 的 fetch 在桌面端会被 403 或跨源
 * 拒绝（网页端可能被 CORS 拦、桌面端被 Origin 白名单拦）——两端都坏，且
 * 失效形态是「运行时静默不出数据」而非编译期报错。相对路径 fetch
 * （`/anic/...`）在两端都走同一 Host webserver，是同源唯一正确形态。
 *
 * 本仓当前已是相对路径，本守卫把它**钉死**，防止后续重构引入绝对 URL。
 *
 * 守卫三条纪律（docs/anic/09 §7 / 开发规范-守卫与约束 §10）：
 *   ① 反向自检：样例（正/负）必须先被判定器正确分类；
 *   ② 不匹配自身：样例字面量拼接构造，避免守卫扫到自己的匹配器；
 *   ③ 扫描集非空：CLIENT_FILES 必须有下限断言，空扫描 = 永久假绿。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT_DIR = join(PLUGIN_ROOT, 'src', 'client');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const CLIENT_FILES = walk(CLIENT_DIR);

/**
 * 判定器：文本中是否含**绝对 http(s) 字面量**。
 *
 * 只认真正的协议字面量（拼接构造，避免本文件自匹配）。注释里的 URL 也算——
 * 本仓纪律是"客户端域不出现绝对 URL"，注释里出现同样是误导源（读者会照抄）。
 */
const ABSOLUTE_URL_RE = new RegExp(['https?', '://'].join(''));

/** 反向自检样例（拼接构造，永不匹配守卫自身文件）。 */
const BAD_SAMPLE = ['fetch(', `'https`, `://example.com/anic/org-status')`].join('');
const GOOD_SAMPLE = ['fetch(', `'/anic/org-status')`].join('');

describe('客户端同源契约（cycle-71：asar dsh-app 代理 Origin 白名单）', () => {
  it('扫描集非空（空扫描 = 守卫永久假绿）', () => {
    expect(CLIENT_FILES.length).toBeGreaterThan(10);
  });

  it('守卫纪律①：判定器反向自检（绝对 URL 命中 / 相对路径不命中）', () => {
    expect(BAD_SAMPLE).toMatch(ABSOLUTE_URL_RE);
    expect(GOOD_SAMPLE).not.toMatch(ABSOLUTE_URL_RE);
  });

  it('src/client/** 零绝对 http(s) URL —— 桌面端经 dsh-app:// 同源代理，绝对 URL 会被 Origin 白名单拒绝', () => {
    const offenders: string[] = [];
    for (const f of CLIENT_FILES) {
      const text = readFileSync(f, 'utf8');
      text.split(/\r?\n/).forEach((line, i) => {
        if (ABSOLUTE_URL_RE.test(line)) offenders.push(`${f.slice(PLUGIN_ROOT.length + 1)}:${String(i + 1)}: ${line.trim()}`);
      });
    }
    expect(offenders, '客户端域出现绝对 URL（改相对路径，两端同源）：\n' + offenders.join('\n')).toEqual([]);
  });

  it('面板 fetch 走相对路径形态（正例在场，防止"零命中"因客户端被整体删除而假绿）', () => {
    const joined = CLIENT_FILES.map((f) => readFileSync(f, 'utf8')).join('\n');
    // 相对路径 fetch 的真实形态至少一处存在
    expect(joined).toMatch(/fetch\(\s*['"`]?\$?\{?/);
    expect(joined).toMatch(/['"`]\/anic\//);
  });
});
