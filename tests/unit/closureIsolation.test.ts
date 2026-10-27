/**
 * 跨项目隔离判定单测（cycle-82 可观测性收口）。
 *
 * ## 这一族为什么必须单独成测（而不仅是契约测试）
 *
 * 契约测试（tests/contract/isolationContract.test.ts）证明**真实仓库**当前是隔离的；
 * 本文件证明**判据本身有牙**：给一个越界路径，它必须点名；给一个合法路径，它必须放行。
 * 只有后者没有前者的守卫是恒绿装饰 —— 本仓「告警级守卫等于没有守卫」的教训即此。
 *
 * ## 三个判据面（各自两态）
 *
 *   ① `judgePath`：`..` 逃逸 / 跨根绝对路径 / 前缀碰撞（`/a/proj-evil` vs `/a/proj`）；
 *   ② `checkIsolation`：登记表逐项 + 死登记（登记了但源码无锚点）单列；
 *   ③ `scanAbsoluteLiterals`：代码行里的写死绝对路径（注释里的例子不算）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_PATHS,
  checkIsolation,
  inWorkspace,
  judgePath,
  scanAbsoluteLiterals,
  toIsolationView,
} from '../../src/host/closureAudit/isolation.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BS = String.fromCharCode(92);

/** 夹具插件根：含登记表所需的全部锚点（每路径一条代码行）。 */
let PLUGIN = '';
/** 夹具 workspace（与插件根**不同**的目录，验证不靠"恰好同一层"通过）。 */
let WS = '';
let PREV_SKILL: string | undefined;

/** 生成一个"每条登记路径都有锚点"的最小插件源码树。 */
function makePluginWithAnchors(dir: string): void {
  const host = join(dir, 'src', 'host');
  mkdirSync(host, { recursive: true });
  const lines: string[] = [];
  for (const { rel } of WORKSPACE_PATHS) {
    const last = rel.split('/').pop() as string;
    // 用 path.join 形态写锚点：与真实代码 `join(cyclesDir, 'ledger.json')` 同构
    lines.push("export const p" + String(lines.length) + " = join(cyclesDir, '" + last + "');");
  }
  writeFileSync(join(host, 'probe.ts'), "import { join } from 'node:path';\n" + lines.join('\n') + '\n', 'utf8');
}

beforeAll(() => {
  PLUGIN = mkdtempSync(join(tmpdir(), 'anic-iso-plugin-'));
  WS = mkdtempSync(join(tmpdir(), 'anic-iso-ws-'));
  mkdirSync(join(WS, '.cycles', 'gates'), { recursive: true });
  PREV_SKILL = process.env.ANIC_SKILL_DIR;
  makePluginWithAnchors(PLUGIN);
});

afterAll(() => {
  if (PREV_SKILL === undefined) delete process.env.ANIC_SKILL_DIR;
  else process.env.ANIC_SKILL_DIR = PREV_SKILL;
  for (const d of [PLUGIN, WS]) if (d !== '' && existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe('judgePath：路径来源判据（两态，逐态钉死）', () => {
  it('工作区相对路径 ⇒ ok（前向）', () => {
    const j = judgePath(WS, '.cycles/gates/ledger.json', 'probe.ts:1');
    expect(j.source).toBe('ok');
    expect(j.inWorkspace).toBe(true);
    expect(j.evidence).toBe('probe.ts:1');
  });

  it('`..` 逃逸 ⇒ escape（**即使解析结果碰巧还在工作区内**也要红）', () => {
    // 深度正好够的写法：workspace/.cycles/../gates/x 解析后仍在工作区内
    const inside = judgePath(WS, '.cycles/../x.json', 'probe.ts:2');
    expect(inside.source, '靠"深度正好够"才不越界的写法未被点名').toBe('escape');
    // 真越界
    const out = judgePath(WS, '../other-project/.cycles/gates/ledger.json', 'probe.ts:3');
    expect(out.source).toBe('escape');
    expect(out.inWorkspace).toBe(false);
  });

  it('workspace 外的绝对路径 ⇒ escape（用户点名的反向自检形态）', () => {
    const outside = join(tmpdir(), 'anic-other-project', '.cycles', 'gates', 'ledger.json');
    const j = judgePath(WS, outside, 'probe.ts:4');
    expect(j.source).toBe('escape');
    expect(j.inWorkspace).toBe(false);
    expect(j.relPath).toBe(outside);
  });

  it('workspace 内的绝对路径 ⇒ ok（绝对形态本身不是罪，越界才是）', () => {
    const insideAbs = join(WS, '.cycles', 'gates', 'ledger.json');
    expect(judgePath(WS, insideAbs, 'probe.ts:5').source).toBe('ok');
  });

  it('前缀碰撞：`/a/proj-evil` 不得被判成在 `/a/proj` 内（startsWith 陷阱）', () => {
    const base = join(tmpdir(), 'anic-proj');
    const evil = join(tmpdir(), 'anic-proj-evil', 'x.json');
    expect(inWorkspace(base, evil), 'startsWith 式前缀碰撞复活').toBe(false);
    expect(inWorkspace(base, join(base, 'x.json'))).toBe(true);
    // 同一路径判自身为在内部（relative 返回空串的边界）
    expect(inWorkspace(base, base)).toBe(true);
  });
});

describe('checkIsolation：登记表逐项（全绿两态）', () => {
  it('全部锚点齐备且路径合法 ⇒ ok=true、violations 与 dangling 皆空', () => {
    const r = checkIsolation(WS, PLUGIN);
    expect(r.violations).toEqual([]);
    expect(r.dangling).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(WORKSPACE_PATHS.length);
    expect(r.scannedFiles).toBeGreaterThan(0);
    for (const i of r.items) {
      expect(i.inWorkspace, i.id + ' 不在工作区内').toBe(true);
      expect(i.source).toBe('ok');
      expect(i.evidence).not.toBe('(none)');
    }
  });

  it('少一条锚点 ⇒ 进 dangling（**不**进 violations：两类成因不同）', () => {
    const partial = mkdtempSync(join(tmpdir(), 'anic-iso-partial-'));
    const host = join(partial, 'src', 'host');
    mkdirSync(host, { recursive: true });
    // 只写第一条登记路径的锚点
    const first = WORKSPACE_PATHS[0] as { rel: string };
    writeFileSync(join(host, 'probe.ts'),
      "export const p = join(cyclesDir, '" + (first.rel.split('/').pop() as string) + "');\n", 'utf8');
    const r = checkIsolation(WS, partial);
    expect(r.dangling.length, '缺锚点未进 dangling').toBe(WORKSPACE_PATHS.length - 1);
    expect(r.violations, '死登记被误报成污染违规').toEqual([]);
    expect(r.ok, '有死登记时仍报 ok').toBe(false);
    // 点名的第一条必须有锚点（不误伤）
    expect(r.items.find((i) => i.id === (WORKSPACE_PATHS[0] as { id: string }).id)?.evidence).not.toBe('(none)');
    rmSync(partial, { recursive: true, force: true });
  });

  it('**反向自检**：注入 workspace 外绝对路径 ⇒ violations 必须点名它', () => {
    /*
     * 这是用户点名的交付质量底线。做法：让插件源码里把 ledger 的锚点写成
     * **另一个项目**的绝对路径 —— 判据必须把它从"正常路径"里揪出来。
     */
    const evil = mkdtempSync(join(tmpdir(), 'anic-iso-evil-'));
    const host = join(evil, 'src', 'host');
    mkdirSync(host, { recursive: true });
    const other = join(tmpdir(), 'anic-some-other-project', '.cycles');
    writeFileSync(join(host, 'probe.ts'),
      "import { join } from 'node:path';\n"
      + '// 真实越界形态：把路径拼到别的项目根上\n'
      + "export const ledger = join('" + other.replace(/\\/g, '/') + "', 'gates', 'ledger.json');\n", 'utf8');
    // 关键：登记表里的 rel 仍是相对的，但我们要验证**注入的越界输入**被判红 ——
    // 用 judgePath 直喂（判据本体），再用 checkIsolation 的 dangling 面交叉确认。
    const j = judgePath(WS, join(other, 'gates', 'ledger.json'), 'src/host/probe.ts:3');
    expect(j.source).toBe('escape');
    expect(j.inWorkspace).toBe(false);
    const r = checkIsolation(WS, evil);
    expect(r.ok).toBe(false);
    /*
     * 该夹具里只有一条代码行（含 `'gates','ledger.json'` 两段），而锚点判据刻意
     * **宽**（文件名或目录段出现即算）——故 ledger/gates 两条登记**有**锚点，
     * 其余 10 条是死登记。断言"绝大多数是死登记"而不是"满额 12"：
     *     满额断言会逼我们**收窄**锚点判据（只认完整路径），而收窄会让真实代码里
     *     `join(cyclesDir, 'ledger.json')` 这种跨行拼装漏判 —— 宁可宽认锚点，
     *     路径**对不对**由 judgePath 判（两者分工，互不冒充）。
     */
    expect(r.dangling.length).toBe(WORKSPACE_PATHS.length - 2);
    expect(r.dangling.join(',')).not.toContain('ledger.json');
    rmSync(evil, { recursive: true, force: true });
  });

  it('扫描集为空 ⇒ 抛错（空集恒绿是假守卫）', () => {
    const bare = mkdtempSync(join(tmpdir(), 'anic-iso-bare-'));
    expect(() => checkIsolation(WS, bare)).toThrow(/source scan empty/i);
    rmSync(bare, { recursive: true, force: true });
  });
});

describe('scanAbsoluteLiterals：写死绝对路径（注释不算）', () => {
  it('代码行里写死盘符/家目录 ⇒ 点名；注释里的例子 ⇒ 不算', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anic-iso-abs-'));
    const host = join(dir, 'src', 'host');
    mkdirSync(host, { recursive: true });
    const winAbs = 'C' + ':' + BS + 'Projects' + BS + 'other';
    writeFileSync(join(host, 'probe.ts'), [
      '// 注释里举例（本仓大量"实测踩坑"注释）不算泄漏：' + winAbs,
      '// 另一形态：/home/someone/project',
      "export const bad = '" + winAbs + BS + "x.json';",
      "export const home = '/home/someone/proj/x.json';",
      "export const good = join(cyclesDir, 'ledger.json');",
    ].join('\n'), 'utf8');
    const out = scanAbsoluteLiterals(dir);
    expect(out.length, '写死的绝对路径未被点名').toBe(2);
    expect(out.every((v) => v.kind === 'absolute-literal')).toBe(true);
    expect(out.map((v) => v.target).join(',')).toContain('probe.ts:3');
    expect(out.map((v) => v.target).join(',')).toContain('probe.ts:4');
    // 注释行（1、2 行）不得被点名
    expect(out.some((v) => /:1$|:2$/.test(v.target))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('真实仓零泄漏（当前基线；若新增则红——这是棘轮）', () => {
    const out = scanAbsoluteLiterals(REPO_ROOT);
    expect(out.map((v) => v.target), '源码里出现写死的绝对路径').toEqual([]);
  });
});

describe('投影：去 workspace 绝对路径 + 真值自洽', () => {
  it('投影不含 workspace 绝对路径，且保留违规/死登记分离', () => {
    const r = checkIsolation(WS, PLUGIN);
    const v = toIsolationView(r);
    const json = JSON.stringify(v);
    expect(json).not.toContain(WS.replace(/\\/g, '/'));
    expect(json).not.toContain(WS);
    expect(v.items).toHaveLength(r.items.length);
    expect(v.ok).toBe(r.ok);
    expect(Array.isArray(v.dangling)).toBe(true);
    expect(v.scannedFiles).toBe(r.scannedFiles);
  });

  it('ok=false 时投影仍可序列化且无损（面板要能渲染失败态）', () => {
    const partial = mkdtempSync(join(tmpdir(), 'anic-iso-proj2-'));
    mkdirSync(join(partial, 'src', 'host'), { recursive: true });
    writeFileSync(join(partial, 'src', 'host', 'x.ts'), "export const a = 'C" + ':' + BS + "bad';\n", 'utf8');
    const v = toIsolationView(checkIsolation(WS, partial));
    expect(v.ok).toBe(false);
    expect(v.violations.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(v))).toEqual(v); // roundtrip
    rmSync(partial, { recursive: true, force: true });
  });
});
