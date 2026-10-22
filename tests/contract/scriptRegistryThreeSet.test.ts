/**
 * 技能脚本三集合显式契约守卫（cycle-72 P0-SCRIPT-REGISTRY-THREE-SET）。
 *
 * 本仓有**三份**互不相通的事实源描述「技能包里有哪些脚本」：
 *   集合 A：`src/host/skillInvoker.ts` 的 `SKILL_SCRIPTS` 白名单（15，**不含** mcp-server）
 *   集合 B：`assets/skill/scripts/*.mjs` 出厂文件（16，含 mcp-server）
 *   集合 C：`assets/skill/scripts/quick-validate.mjs` 的 `EXPECTED_SCRIPTS`（16，含 mcp-server）
 *
 * 此前只有 A ⇄ B 的守卫（且用 `.filter(n => n !== 'mcp-server')` 把第三个集合的
 * 差异**手工抹掉**），C 从未被任何测试读取。后果：
 *   - 有人把 `mcp-server` 加进白名单（或删掉 C 里某项）不会让任何测试变红；
 *   - 新脚本出厂后漏登 C，quick-validate 只会打 `warnings.push('Missing script: ...')`
 *     ——**告警级守卫等于没有守卫**（skill 包自己的 iteration-5 纪律原话：
 *     "守卫必须是 ERROR（exit 1）：告警级守卫等于没有守卫"）。
 *
 * 本守卫把三集合的差集**显式钉死**为唯一已知例外 `{mcp-server}`（传输层：
 * 它自己就是 MCP server，不能被当作被调脚本 spawn，见 16 号文档 §5.3）。
 * 任何第四个差异都必须让测试变红并附上集合名——「差集恰为 {mcp-server}」既是
 * 断言也是文档。
 *
 * 反向自检（negative control）：正则先对已知正/负样本验证，防止 regex 失效后
 * 守卫永久假绿（同 skillInvokerContract.test.ts 的纪律）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listSkillScripts } from '../../src/host/skillInvoker.ts';

const HERE = import.meta.dirname;
const BUNDLED_SCRIPTS = join(HERE, '..', '..', 'assets', 'skill', 'scripts');
const QUICK_VALIDATE = join(BUNDLED_SCRIPTS, 'quick-validate.mjs');

/** 唯一已知的集合差异：传输层脚本（自为 MCP server，不是被 spawn 的业务脚本）。 */
const TRANSPORT_ONLY = 'mcp-server';

/** 集合 A：宿主白名单（运行时事实源，取自实现而非手抄）。 */
function whitelistSet(): Set<string> {
  return new Set(listSkillScripts());
}

/** 集合 B：出厂 .mjs 文件（去扩展名）。 */
function bundledSet(): Set<string> {
  return new Set(
    readdirSync(BUNDLED_SCRIPTS)
      .filter((n) => n.endsWith('.mjs'))
      .map((n) => n.replace(/\.mjs$/, '')),
  );
}

/**
 * 集合 C：从 quick-validate.mjs **源码文本**解析 EXPECTED_SCRIPTS。
 *
 * 为何不 import：该文件顶层有 `await`/`process.exit` 副作用（它是 CLI 脚本，
 * 直接 import 会执行检查并可能退出进程）。文本解析是唯一安全的读法，也因此
 * 必须有反向自检兜住 regex 失效。
 */
const EXPECTED_BLOCK = /const EXPECTED_SCRIPTS = \[([\s\S]*?)\];/;
const ENTRY_QUOTED = /'([^']+)\.mjs'/g;

function parseExpectedScripts(src: string): Set<string> | null {
  const block = EXPECTED_BLOCK.exec(src);
  if (!block) return null;
  const names = new Set<string>();
  for (const m of block[1]!.matchAll(ENTRY_QUOTED)) names.add(m[1]!);
  return names;
}

function quickValidateSet(): Set<string> {
  const parsed = parseExpectedScripts(readFileSync(QUICK_VALIDATE, 'utf-8'));
  expect(parsed, 'EXPECTED_SCRIPTS 未能从 quick-validate.mjs 解析——文本结构已变，守卫必须随之更新').not.toBeNull();
  return parsed!;
}

/** 差集（左有右无）。 */
function diff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x)).sort();
}

describe('反向自检：解析器真的能提取集合 C（regex 失效必须在此暴露）', () => {
  it('正样本：含 EXPECTED_SCRIPTS 块 → 提取到全部条目', () => {
    const sample = `const EXPECTED_SCRIPTS = [\n  'a.mjs',\n  'b.mjs',\n];\n`;
    const got = parseExpectedScripts(sample);
    expect(got).not.toBeNull();
    expect([...got!].sort()).toEqual(['a', 'b']);
  });

  it('负样本：无该块 → null（不返回空集冒充成功）', () => {
    expect(parseExpectedScripts('const OTHER = [1, 2];')).toBeNull();
  });

  it('负样本：块存在但无引号条目 → 空集（不是 undefined）', () => {
    const got = parseExpectedScripts('const EXPECTED_SCRIPTS = [\n];');
    expect(got).not.toBeNull();
    expect(got!.size).toBe(0);
  });

  it('真实文件解析结果非空（防止真实结构漂移后守卫静默通过）', () => {
    expect(quickValidateSet().size).toBeGreaterThan(10);
  });
});

describe('三集合契约：差集恰为 {mcp-server}（新增脚本未登记即红）', () => {
  it('集合 A（白名单）与集合 B（出厂文件）差集恰为 {mcp-server}', () => {
    const a = whitelistSet();
    const b = bundledSet();
    // B 比 A 多出的：只能是传输层
    expect(diff(b, a)).toEqual([TRANSPORT_ONLY]);
    // A 比 B 多出的：不许有（白名单点名的脚本必须真实出厂）
    expect(diff(a, b)).toEqual([]);
  });

  it('集合 B（出厂文件）与集合 C（quick-validate EXPECTED_SCRIPTS）完全相等', () => {
    const b = bundledSet();
    const c = quickValidateSet();
    // 出厂文件漏登 quick-validate → 该守卫红（旧行为只打 warning，不阻塞构建）
    expect(diff(b, c)).toEqual([]);
    // quick-validate 点名了不存在的脚本 → 红
    expect(diff(c, b)).toEqual([]);
  });

  it('集合 A（白名单）与集合 C 差集恰为 {mcp-server}', () => {
    const a = whitelistSet();
    const c = quickValidateSet();
    expect(diff(c, a)).toEqual([TRANSPORT_ONLY]);
    expect(diff(a, c)).toEqual([]);
  });

  it('三集合规模如实为 15 / 16 / 16（数量漂移必须显式更新本断言）', () => {
    // 规模断言是给「有人新增脚本」的第二道提示：差集断言会说"多了 X"，
    // 这条会说"总数从 16 变了"——两条一起看才知道是漏登记还是真新增。
    expect(whitelistSet().size).toBe(15);
    expect(bundledSet().size).toBe(16);
    expect(quickValidateSet().size).toBe(16);
  });

  it('传输层例外确实存在（否则上面的差集断言在空集上恒真）', () => {
    // 反向自检：若 mcp-server 哪天被移出技能包，差集断言会退化成 [] !== ['mcp-server']，
    // 但若两边同时消失就会双双安静通过——所以显式钉一次存在性。
    expect(bundledSet().has(TRANSPORT_ONLY)).toBe(true);
    expect(quickValidateSet().has(TRANSPORT_ONLY)).toBe(true);
    expect(whitelistSet().has(TRANSPORT_ONLY)).toBe(false);
  });
});
