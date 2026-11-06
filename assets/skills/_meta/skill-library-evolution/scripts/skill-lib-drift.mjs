// skill-lib-drift.mjs — 技能库漂移守卫（四类，错误级 exit 1）
//
// 用法：
//   node skill-lib-drift.mjs <projectDir> --check   错误级 exit 1（CI 硬门）
//   node skill-lib-drift.mjs <projectDir> --report  只读报告 exit 0
//
// 四类守卫（E5 漂移守卫）：
//   0. 注册表字段 —— `dir` 必填（缺字段即判红；曾 9 条叶技能全部隐身）
//   1. 版本锚    —— 与 skill-lib-manifest 同语义（SKILL.md 推断版本 == 注册表版本）
//   2. 词表绑定  —— 只许 A 族维度词（dimensions.mjs），禁 B 族旧称（S-2 漂移面）
//   3. 原子写    —— 写 .cycles/** 必须原子（atomicWriteFileSync 或 temp+renameSync
//                   模式），禁裸 writeFileSync 直达 .cycles（S-6）。
//                   识别形态：脚本含 `renameSync`（tmp 写完再改名）即视为原子写，
//                   与主干 fs-safe 的 temp+rename 语义同构。
//   4. 配置入口  —— ⛔ **未实现**（本行曾是纯声明）。`.cycles/config.yml` 是唯一规范入口
//                   （INV-25），但"禁新造第二入口"没有可机械判定的形态，硬写只会变成
//                   误报源。要落地需先定义判据（例如：技能脚本出现 `config.yml` 之外的
//                   `*.yml` 读点即报），否则保持"未实现"比假装有守卫更诚实。
//
// 零外部依赖。守卫必须能失败（E2）：每类都有反向自检（见 --selftest）。
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

// B 族旧称（docs/anic/09 §2 S-2：第二套 E 维名称，与 A 族零重叠，必须清零）
const B_FAMILY_NAMES = ['功能覆盖', '架构健康', '技术债务', '用户旅程', '覆盖率门限', '混沌用例', '循环依赖', '契约一致性', '响应式', '视觉一致性'];

const ANCHOR_FILES = ['SKILL.md', 'CHANGELOG.md'];

function findLibraryRoot(projectDir) {
  for (const c of [join(projectDir, 'assets', 'skills'), join(process.cwd(), 'assets', 'skills')]) {
    if (existsSync(join(c, 'skills.index.json'))) return c;
  }
  return null;
}

/** 技能目录：meta 技能声明了 dir（含 _meta/ 前缀），其余与 name 同名。 */
function skillDir(libRoot, skill) {
  return skill.dir ? join(libRoot, skill.dir) : join(libRoot, skill.name);
}

function walkFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** 只取 SKILL.md frontmatter 的显式 version（避免从正文任意 `v0.56.0` 引用误推断）。 */
function frontmatterVersion(raw) {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return null;
  const m = raw.slice(3, end).match(/^version:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

// 守卫自身的文件：它必须**列出**被禁词才能检测它们，故从词表扫描中排除（自指豁免，
// 已在文件头声明）。排除的是本脚本自身，不是叶技能。路径用规范化正斜杠形态
// （与下面 rel 的 split(sep).join('/') 同口径，Windows 下才不会因反斜杠失配）。
const SELF_EXEMPT_FILES = ['scripts/skill-lib-drift.mjs'];

function run(projectDir, mode) {
  const libRoot = findLibraryRoot(projectDir);
  if (!libRoot) {
    process.stderr.write(`skill-lib-drift: skills.index.json not found\n`);
    process.exit(2);
  }
  const registry = JSON.parse(readFileSync(join(libRoot, 'skills.index.json'), 'utf-8'));
  const skills = Array.isArray(registry.skills) ? registry.skills : [];
  const findings = [];

  for (const skill of skills) {
    const dir = skillDir(libRoot, skill);
    // 注册表字段守卫（守卫必须能失败）：`dir` 缺失时 skillDir() 的兜底会静默兜住，
    // 曾导致 9 条叶技能在"按注册表遍历"的机器面上全部隐身。所以缺失即判红。
    if (!skill.dir) {
      findings.push({ skill: skill.name, check: 'registry:dir', status: 'fail', detail: 'dir 字段缺失（注册表唯一事实源，禁止 dir ?? name 派生）' });
    }
    if (!existsSync(dir)) continue;
    for (const f of ANCHOR_FILES) {
      if (!existsSync(join(dir, f))) {
        findings.push({ skill: skill.name, check: `anchor:${f}`, status: 'fail', detail: 'missing' });
      }
    }
    const skillMdPath = join(dir, 'SKILL.md');
    if (existsSync(skillMdPath)) {
      const raw = readFileSync(skillMdPath, 'utf-8');
      const inferred = frontmatterVersion(raw);
      if (inferred && inferred !== skill.version) {
        findings.push({ skill: skill.name, check: 'anchor:version', status: 'fail', detail: `registry v${skill.version} vs SKILL.md frontmatter v${inferred}` });
      }
    }
    // 词表绑定：SKILL.md + references + scripts 都扫（守卫自身文件除外）
    for (const f of walkFiles(dir)) {
      const text = readFileSync(f, 'utf-8');
      const rel = relative(dir, f).split(sep).join('/');
      if (SELF_EXEMPT_FILES.includes(rel)) continue;
      for (const bad of B_FAMILY_NAMES) {
        if (text.includes(bad)) {
          findings.push({ skill: skill.name, check: 'vocabulary:B-family', status: 'fail', detail: `${rel} contains B-family name '${bad}'` });
        }
      }
      // 原子写：scripts 里写 .cycles 必须原子——接受主干 atomicWriteFileSync，
      // 也接受等价的 temp+renameSync 模式（与 fs-safe 同语义）；裸 writeFileSync 直达 .cycles 即违规。
      if (rel.startsWith('scripts/') && /\.cycles/.test(text)) {
        if (text.includes('writeFileSync') && !text.includes('atomicWriteFileSync') && !text.includes('renameSync')) {
          findings.push({ skill: skill.name, check: 'atomic-write', status: 'fail', detail: `${rel} writes .cycles with bare writeFileSync (no atomic/rename pattern)` });
        }
      }
    }
  }

  const failed = findings.filter(f => f.status === 'fail');
  return { mode, libraryRoot: libRoot, skillCount: skills.length, findings, failed: failed.length, passed: failed.length === 0 };
}

function selftest() {
  // 反向自检（E2）：守卫必须能失败。用两个已知违规的临时库验证 vocabulary 与
  // atomic-write 守卫都会红；再用一个合规库验证它们不误报。
  const makeLib = (name, skillMd, scriptBody, withDir = true) => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-lib-drift-selftest-'));
    const lib = join(tmp, 'assets', 'skills');
    mkdirSync(join(lib, name), { recursive: true });
    // dir 是本轮新增的注册表必填字段：合规用例必须带上，否则 registry:dir 会误报。
    const entry = { name, version: '0.1.0', anchors: [] };
    if (withDir) entry.dir = name;
    writeFileSync(join(lib, 'skills.index.json'), JSON.stringify({ version: '0.1.0', skills: [entry] }));
    writeFileSync(join(lib, name, 'SKILL.md'), skillMd);
    writeFileSync(join(lib, name, 'CHANGELOG.md'), '# changelog\n');
    mkdirSync(join(lib, name, 'scripts'), { recursive: true });
    writeFileSync(join(lib, name, 'scripts', 'demo.mjs'), scriptBody);
    return { tmp, lib };
  };

  // 违规 1：B 族词
  const bad1 = makeLib('bad-vocab', '---\nname: bad-vocab\n---\n# demo\n功能覆盖 check\n', '// no cycles write\n');
  const r1 = run(bad1.tmp, 'check');
  rmSync(bad1.tmp, { recursive: true, force: true });
  const sawB = r1.findings.some(f => f.check === 'vocabulary:B-family');

  // 违规 2：裸 writeFileSync 直达 .cycles（无 renameSync/atomic）
  const bad2 = makeLib('bad-atomic', '---\nname: bad-atomic\n---\n# demo\n', 'const fs=require("node:fs");fs.writeFileSync(".cycles/x.json","{}");\n');
  const r2 = run(bad2.tmp, 'check');
  rmSync(bad2.tmp, { recursive: true, force: true });
  const sawA = r2.findings.some(f => f.check === 'atomic-write');

  // 合规：原子写（temp+rename）+ 无 B 族词
  const good = makeLib('good-atomic', '---\nname: good-atomic\n---\n# demo\n', 'const fs=require("node:fs");fs.writeFileSync(tmp,"x");fs.renameSync(tmp,".cycles/x.json");\n');
  const r3 = run(good.tmp, 'check');
  rmSync(good.tmp, { recursive: true, force: true });
  const clean = r3.findings.length === 0;

  // 违规 3：注册表缺 dir（曾让 9 条叶技能在机器面隐身）
  const bad3 = makeLib('bad-dir', '---\nname: bad-dir\n---\n# demo\n', '// no cycles write\n', false);
  const r4 = run(bad3.tmp, 'check');
  rmSync(bad3.tmp, { recursive: true, force: true });
  const sawD = r4.findings.some(f => f.check === 'registry:dir');

  const allPass = sawB && sawA && sawD && clean;
  process.stdout.write(JSON.stringify({
    selftest: allPass ? 'PASS' : 'FAIL',
    reason: allPass ? 'B-family + atomic-write + registry:dir guards fire on tainted input; clean input passes' : `sawB=${sawB} sawA=${sawA} sawD=${sawD} clean=${clean}`,
  }, null, 2) + '\n');
  process.exit(allPass ? 0 : 1);
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) { selftest(); }
const positional = args.filter(a => !a.startsWith('--'));
const mode = args.includes('--check') ? 'check' : 'report';
const projectDir = positional[0] || process.cwd();
const res = run(projectDir, mode);
process.stdout.write(JSON.stringify(res, null, 2) + '\n');
if (mode === 'check' && res.failed > 0) {
  process.stderr.write(`skill-lib-drift: ${res.failed} drift finding(s)\n`);
  process.exit(1);
}
process.exit(0);
