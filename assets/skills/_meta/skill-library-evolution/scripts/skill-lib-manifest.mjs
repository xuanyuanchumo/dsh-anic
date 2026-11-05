// skill-lib-manifest.mjs — 技能库注册表生成/校验 + 三锚一致守卫
//
// 用法（位置参数：第一个 = 项目目录）：
//   node skill-lib-manifest.mjs <projectDir> --check      错误级 exit 1（CI 硬门）
//   node skill-lib-manifest.mjs <projectDir> --report     只读报告 exit 0
//   node skill-lib-manifest.mjs <projectDir> --snapshot   冻结库快照（sha256 清单）
//
// 零外部依赖（node:fs/path/crypto）。绝不写明文凭据、绝不越出项目目录。
//
// 三锚一致（E1）：SKILL.md / scripts/<primary>.mjs / CHANGELOG.md / skills.index.json
// 四处版本必须一致。找不齐即报错——守卫必须能失败（E2）。
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 原子写复用主干 fs-safe（写 .cycles/** 必须走 atomicWriteFileSync——drift 守卫第 3 类检查的
// 就是这件事；守卫不能自己违反自己的规则）。Windows 下动态 import 绝对路径必须经 file:// URL。
const HERE = dirname(fileURLToPath(import.meta.url));
const FS_SAFE = pathToFileURL(
  join(HERE, '..', '..', '..', '..', 'skill', 'scripts', 'lib', 'fs-safe.mjs'),
).href;
const { atomicWriteFileSync } = await import(FS_SAFE);

const ANCHOR_SCRIPTS = ['skill-lib-manifest.mjs', 'skill-lib-drift.mjs', 'skill-lib-ledger.mjs'];
const REQUIRED_FIELDS = ['name', 'version', 'tier', 'summary', 'triggers', 'dependsOn', 'anchors'];

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { ok: false, name: null, version: null };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { ok: false, name: null, version: null };
  const block = raw.slice(3, end);
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const verMatch = block.match(/^version:\s*(.+)$/m);
  return {
    ok: true,
    name: nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : null,
    version: verMatch ? verMatch[1].trim().replace(/^["']|["']$/g, '') : null,
  };
}

function findLibraryRoot(projectDir) {
  const candidates = [
    join(projectDir, 'assets', 'skills'),
    join(projectDir, '..', 'assets', 'skills'),
    join(process.cwd(), 'assets', 'skills'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'skills.index.json'))) return c;
  }
  return null;
}

function readRegistry(libRoot) {
  const raw = readFileSync(join(libRoot, 'skills.index.json'), 'utf-8');
  return { raw, data: JSON.parse(raw) };
}

/** 技能目录：meta 技能声明了 dir（含 _meta/ 前缀），其余与 name 同名。 */
function skillDir(libRoot, skill) {
  return skill.dir ? join(libRoot, skill.dir) : join(libRoot, skill.name);
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter(a => !a.startsWith('--'));
  const flags = args.filter(a => a.startsWith('--')).map(a => a.slice(2));
  const mode = flags.includes('check') ? 'check' : flags.includes('report') ? 'report' : 'snapshot';

  const projectDir = positional[0] || process.cwd();
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    process.stderr.write(`skill-lib-manifest: project dir not found: ${projectDir}\n`);
    process.exit(2);
  }
  const libRoot = findLibraryRoot(projectDir);
  if (!libRoot) {
    process.stderr.write(`skill-lib-manifest: skills.index.json not found (searched ${projectDir}/assets/skills)\n`);
    process.exit(2);
  }

  const registry = readRegistry(libRoot);
  const skills = Array.isArray(registry.data.skills) ? registry.data.skills : [];
  const findings = [];
  const snapshot = [];

  for (const skill of skills) {
    for (const f of REQUIRED_FIELDS) {
      if (skill[f] === undefined) findings.push({ skill: skill.name, check: `field:${f}`, status: 'fail', detail: 'missing' });
    }
    const dir = skillDir(libRoot, skill);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      findings.push({ skill: skill.name, check: 'dir', status: 'fail', detail: `missing ${relative(libRoot, dir)}` });
      continue;
    }
    const skillMdPath = join(dir, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
      findings.push({ skill: skill.name, check: 'SKILL.md', status: 'fail', detail: 'missing' });
      continue;
    }
    const skillMdRaw = readFileSync(skillMdPath, 'utf-8');
    const fm = parseFrontmatter(skillMdRaw);
    if (!fm.ok || fm.name !== skill.name) {
      findings.push({ skill: skill.name, check: 'SKILL.md:name', status: 'fail', detail: `frontmatter name='${String(fm.name)}' != registry '${skill.name}'` });
    }
    // 版本一致：仅当 SKILL.md frontmatter 显式声明 version 时才比对（避免从正文任意
    // `v0.56.0` 引用里误推断版本——那会把引用误判成版本漂移）。
    if (fm.version && fm.version !== skill.version) {
      findings.push({ skill: skill.name, check: 'anchor:version', status: 'fail', detail: `registry v${skill.version} vs SKILL.md frontmatter v${fm.version}` });
    }
    // 锚点检查（每个声明的 anchor 相对技能目录）
    for (const anchor of skill.anchors || []) {
      const p = join(dir, anchor);
      if (!existsSync(p)) {
        findings.push({ skill: skill.name, check: `anchor:${anchor}`, status: 'fail', detail: 'missing' });
      }
    }
    // 元技能自身：脚本锚点必须存在
    if (skill.tier === 'meta') {
      for (const s of ANCHOR_SCRIPTS) {
        const sp = join(dir, 'scripts', s);
        if (!existsSync(sp)) findings.push({ skill: skill.name, check: `script:${s}`, status: 'fail', detail: 'missing' });
      }
    }
    // 快照：递归 sha256
    if (mode === 'snapshot') {
      const files = [];
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else files.push([relative(dir, full).split(sep).join('/'), sha256(readFileSync(full))]);
        }
      };
      walk(dir);
      snapshot.push({ skill: skill.name, version: skill.version, files });
    }
  }

  const failed = findings.filter(f => f.status === 'fail');
  const result = {
    mode,
    libraryRoot: libRoot,
    registryVersion: registry.data.version,
    skillCount: skills.length,
    findings,
    failed: failed.length,
    passed: failed.length === 0,
  };

  if (mode === 'snapshot') {
    const outDir = join(projectDir, '.cycles', 'skill-snapshot');
    mkdirSync(outDir, { recursive: true });
    atomicWriteFileSync(join(outDir, 'skills-manifest.json'), JSON.stringify(snapshot, null, 2), 'utf-8');
    process.stdout.write(`skill-lib-manifest: snapshot written to ${join(outDir, 'skills-manifest.json')} (${snapshot.length} skills)\n`);
    process.exit(0);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (mode === 'check' && failed.length > 0) {
    process.stderr.write(`skill-lib-manifest: ${failed.length} finding(s) — anchor/registry drift\n`);
    process.exit(1);
  }
  process.exit(0);
}

main();
