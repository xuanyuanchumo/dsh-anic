/**
 * WS-3 技能侧新鲜度守卫契约（cycle-80 G-04）。两个被守卫缺陷：
 *  1. `quick-validate` 只校验四锚/目录结构 ⇒「assets 改了忘 repair / 文档与发行源脱钩」照样全绿；
 *     新增 `--freshness` 把"发行面是否与自身一致"变成机器可判定（默认关闭，关闭时输出逐字节不变）。
 *  2. `gate-check` 的 G3 只跑 build_cmd、不记录**产出哪份字节** ⇒「源码改了忘 build」也全绿
 *     （dist 被 gitignore，旧产物对提交清单不可见）。detail 追加 `[dist=<revision 前 8 位>]`，
 *     revision 口径与宿主侧同一算法：sha256(sha256(host.js)+":"+sha256(client.js)).slice(0,16)。
 *
 * 判别力（反向自检见 ⑦）：把 revision 算法换成"文件大小拼串"后，④/⑥ 的期望值必红。
 * 纪律：全部真 spawn（不 mock），夹具在 tests/contract/tmp-fresh-* 且 afterAll 清理。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkG3, loadGateConfig } from '../../src/host/flows/gateEngine.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILL = join(ROOT, 'assets', 'skill');
const QV = join(SKILL, 'scripts', 'quick-validate.mjs');
const GC = join(SKILL, 'scripts', 'gate-check.mjs');
const HERE = fileURLToPath(new URL('.', import.meta.url));

const fixtures: string[] = [];
afterAll(() => {
  for (const d of fixtures) rmSync(d, { recursive: true, force: true });
});
function mkTmp(tag: string): string {
  const d = mkdtempSync(join(HERE, `tmp-fresh-${tag}-`));
  fixtures.push(d);
  return d;
}

function run(script: string, args: string[], cwd = ROOT) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 复制技能目录（含 scripts/lib），供反向自检用。 */
function copySkill(tag: string): string {
  const dir = join(mkTmp(tag), 'skill');
  cpSync(SKILL, dir, { recursive: true });
  return dir;
}

const hexOf = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
/** 教学用的"真实口径"独立复算（与脚本实现分开写，才能证明钉的是同一条算法）。 */
function expectedRevision(distDir: string): string | null {
  const host = join(distDir, 'host.js');
  const client = join(distDir, 'client.js');
  if (!existsSync(host) || !existsSync(client)) return null;
  return createHash('sha256').update(`${hexOf(host)}:${hexOf(client)}`).digest('hex').slice(0, 8);
}

/** 一个可跑 G3 的最小工作区：config + cycle-1 + 可选 dist 字节。 */
function g3Workspace(tag: string, buildCmd: string, dist?: { host: string; client: string }): string {
  const ws = mkTmp(tag);
  mkdirSync(join(ws, '.cycles', 'cycles', 'cycle-1'), { recursive: true });
  writeFileSync(join(ws, '.cycles', 'config.yml'), `autonomy_level: L4\nbuild_cmd: "${buildCmd}"\n`);
  if (dist) {
    mkdirSync(join(ws, 'dist'), { recursive: true });
    writeFileSync(join(ws, 'dist', 'host.js'), dist.host);
    writeFileSync(join(ws, 'dist', 'client.js'), dist.client);
  }
  return ws;
}
const g3Detail = (out: string): string => (out.split('\n').find((l) => /^\[(PASS|FAIL)\] G3: /.test(l)) ?? '').replace(/^\[(?:PASS|FAIL)\] G3: /, '');

describe('A. quick-validate --freshness（发行新鲜度）', () => {
  it('① 真实 assets/skill：--freshness 全绿且 exit 0', () => {
    const r = run(QV, [SKILL, '--freshness']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[OK] freshness: scripts index complete');
    expect(r.stdout).toContain('[OK] freshness: version anchor consistent');
    expect(r.stdout).not.toContain('[FAIL] freshness:');
  });

  it('② 不带 --freshness：去掉 FRESHNESS 段后与开启时逐字节一致（且与 HEAD 旧版一致）', () => {
    const off = run(QV, [SKILL]);
    expect(off.status).toBe(0);
    expect(off.stdout).not.toContain('FRESHNESS');
    expect(off.stdout).not.toContain('freshness');
    // 纯增量证明：开/关输出仅在 FRESHNESS 段（含其前置空行）上有差异
    const on = run(QV, [SKILL, '--freshness']);
    const onWithout = on.stdout.replace(/\nFRESHNESS \(\d+\):\n(?:  \[(?:OK|FAIL)\] freshness: [^\n]*\n)+/, '');
    expect(onWithout).toBe(off.stdout);
    // 与 HEAD（旧版）逐字节对比：四锚行等既有输出不得漂移
    const headSrc = spawnSync('git', ['show', 'HEAD:assets/skill/scripts/quick-validate.mjs'], { cwd: ROOT, encoding: 'utf-8' });
    if (headSrc.status === 0 && headSrc.stdout.trim()) {
      const legacy = join(copySkill('legacy'), 'scripts', 'quick-validate.mjs');
      writeFileSync(legacy, headSrc.stdout);
      const old = run(legacy, [SKILL]);
      expect(off.stdout).toBe(old.stdout);
      expect(off.status).toBe(old.status);
    }
  });

  it('③ 反向自检：索引里删掉一个脚本 ⇒ --freshness 必红并点名该文件', () => {
    const skill = copySkill('ghost');
    const ref = join(skill, 'references', 'scripts-reference.md');
    const before = readFileSync(ref, 'utf-8');
    const after = before.replace(/^-\s*\[scripts\/gate-ledger\.mjs\][^\n]*\n/m, '');
    expect(after).not.toBe(before); // 前提：确实删掉了一条索引
    writeFileSync(ref, after);
    const r = run(join(skill, 'scripts', 'quick-validate.mjs'), [skill, '--freshness']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[FAIL] freshness: scripts index missing: scripts/gate-ledger.mjs');
  });
});

describe('B. gate-check G3：构建产物 revision 证据', () => {
  it('④ 真实 dist 字节 ⇒ [dist=<8 位 hex>] 且与独立复算全等；无 dist ⇒ [dist=absent]', () => {
    const realDist = join(ROOT, 'dist');
    const hasDist = existsSync(join(realDist, 'host.js')) && existsSync(join(realDist, 'client.js'));
    const ws = hasDist
      ? g3Workspace('real', 'exit 0', { host: readFileSync(join(realDist, 'host.js'), 'utf-8'), client: readFileSync(join(realDist, 'client.js'), 'utf-8') })
      : g3Workspace('real', 'exit 0');
    const r = run(GC, [ws, '--gate', 'G3']);
    expect(r.status).toBe(0);
    const detail = g3Detail(r.stdout);
    const expected = expectedRevision(join(ws, 'dist'));
    if (expected) {
      expect(detail).toContain(`[dist=${expected}]`);
      expect(detail).toMatch(/\[dist=[0-9a-f]{8}\]$/);
    } else {
      expect(detail).toMatch(/\[dist=absent\]$/);
    }
  });

  it('⑤ dist 缺文件 ⇒ [dist=absent]，且 G3 结论仍只由 build_cmd 决定（不改判）', () => {
    const ws = g3Workspace('absent', 'exit 0', { host: 'h', client: 'c' });
    expect(g3Detail(run(GC, [ws, '--gate', 'G3']).stdout)).toMatch(/\[dist=[0-9a-f]{8}\]$/);
    renameSync(join(ws, 'dist', 'host.js'), join(ws, 'dist', 'host.js.bak')); // 只动 tmp 夹具，不动真 dist
    const absent = run(GC, [ws, '--gate', 'G3']);
    expect(absent.status).toBe(0); // build_cmd exit 0 ⇒ 仍 PASS
    expect(g3Detail(absent.stdout)).toMatch(/\[dist=absent\]$/);
    // 结论由 build_cmd 决定：换成失败的 build_cmd 后 dist 仍在也照样 FAIL
    const wsFail = g3Workspace('absentfail', 'exit 2', { host: 'h', client: 'c' });
    const failed = run(GC, [wsFail, '--gate', 'G3']);
    expect(failed.status).not.toBe(0);
    expect(g3Detail(failed.stdout)).toMatch(/\[dist=[0-9a-f]{8}\]$/);
  });

  it('⑥ native(gateEngine.checkG3) 与 script 同夹具 detail 逐字全等', () => {
    const ws = g3Workspace('native', 'exit 0', { host: 'host-native', client: 'client-native' });
    const scripted = g3Detail(run(GC, [ws, '--gate', 'G3']).stdout);
    const native = checkG3(ws, loadGateConfig(ws).content).detail;
    expect(native).toBe(scripted);
    expect(native).toContain(`[dist=${expectedRevision(join(ws, 'dist'))}]`);
  });

  it('⑦ 反向自检：revision 算法改成"文件大小拼串" ⇒ ④/⑥ 的期望值必红', () => {
    const ws = g3Workspace('mutate', 'exit 0', { host: 'host-bytes-AAAA', client: 'client-bytes-BBBB' });
    const canonical = g3Detail(run(GC, [ws, '--gate', 'G3']).stdout);
    const expected = expectedRevision(join(ws, 'dist'));
    expect(canonical).toContain(`[dist=${expected}]`); // 真口径先自证

    // 变异副本：把内容哈希换成文件大小拼串（同一脚本其余逻辑不动）
    const skill = copySkill('mutate');
    const mutated = join(skill, 'scripts', 'gate-check.mjs');
    const src = readFileSync(mutated, 'utf-8');
    const marker = "const fileHash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');";
    expect(src).toContain(marker); // 前提：变异点存在
    writeFileSync(mutated, src.replace(marker, 'const fileHash = (p) => String(statSync(p).size);'));

    const wrong = g3Detail(run(mutated, [ws, '--gate', 'G3']).stdout);
    const sizeRev = createHash('sha256').update(`${readFileSync(join(ws, 'dist', 'host.js')).length}:${readFileSync(join(ws, 'dist', 'client.js')).length}`).digest('hex').slice(0, 8);
    expect(wrong).toContain(`[dist=${sizeRev}]`); // 变异确实生效（口径真的变了）
    expect(wrong).not.toBe(canonical); // ⇒ ④/⑥ 钉的真口径会红
  });
});
