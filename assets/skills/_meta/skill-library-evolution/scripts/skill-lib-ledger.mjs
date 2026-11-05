// skill-lib-ledger.mjs — 技能库补丁生命周期账本（复用主干 canonical 载荷）
//
// 用法：
//   node skill-lib-ledger.mjs <projectDir> --record <EVENT> --skill <name> [--detail "..."] [--extra-json '{}']
//   node skill-lib-ledger.mjs <projectDir> --verify
//   node skill-lib-ledger.mjs <projectDir> --list
//
// 事件类型（库级新增，全部入账本）：
//   SKILL_PATCH_PROPOSED / SKILL_PATCH_KEPT / SKILL_PATCH_REVERTED
//   SKILL_VERSION_BUMP / SKILL_DRIFT_ALARM / SKILL_LIB_AUTONOMY_CHANGE / SKILL_EVIDENCE_LINK
//
// 关键纪律（E7 / INV-9 / H4）：
//   · 账本 append-only：只追加新条目，绝不原地改写历史（改历史即 HASH_MISMATCH）。
//   · revert 的语义是「追加一条 SKILL_PATCH_REVERTED + 原子还原工作区文件」，不是改历史条目。
//   · canonical 载荷复用主干 lib/ledger.mjs（固定六字段键序 + JSON.stringify + sha256），
//     保证与既有门禁账本同一条链、同一套验证。
//
// 零外部依赖（复用主干 lib）。绝不写明文凭据。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// 主干 ledger lib 的相对位置：本脚本在 assets/skills/_meta/skill-library-evolution/scripts/
const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_LEDGER = pathToFileURL(
  join(HERE, '..', '..', '..', '..', 'skill', 'scripts', 'lib', 'ledger.mjs'),
).href;
const { appendEntry, verifyLedger, listEntries } = await import(MAIN_LEDGER);

const EVENT_TYPES = [
  'SKILL_PATCH_PROPOSED',
  'SKILL_PATCH_KEPT',
  'SKILL_PATCH_REVERTED',
  'SKILL_VERSION_BUMP',
  'SKILL_DRIFT_ALARM',
  'SKILL_LIB_AUTONOMY_CHANGE',
  'SKILL_EVIDENCE_LINK',
];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const rest = process.argv.slice(2);
  const positional = rest.filter(a => !a.startsWith('--'));
  const projectDir = arg('project') || positional[0] || process.cwd();
  const mode = rest.includes('--verify') ? 'verify' : rest.includes('--list') ? 'list' : 'record';

  if (mode === 'verify') {
    const res = verifyLedger(projectDir);
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    process.exit(res.valid ? 0 : 1);
  }
  if (mode === 'list') {
    process.stdout.write(JSON.stringify({ entries: listEntries(projectDir) }, null, 2) + '\n');
    process.exit(0);
  }

  const event = arg('record');
  const skill = arg('skill');
  if (!EVENT_TYPES.includes(event)) {
    process.stderr.write(`skill-lib-ledger: unknown event '${String(event)}'. Valid: ${EVENT_TYPES.join(', ')}\n`);
    process.exit(2);
  }
  if (!skill) {
    process.stderr.write('skill-lib-ledger: --skill is required\n');
    process.exit(2);
  }
  const detail = arg('detail') || `${event} for ${skill}`;
  const extraRaw = arg('extra-json');
  let extra = {};
  if (extraRaw) {
    try { extra = JSON.parse(extraRaw); } catch {
      process.stderr.write('skill-lib-ledger: --extra-json is not valid JSON\n');
      process.exit(2);
    }
  }

  const entry = appendEntry(projectDir, event, 'PASS', detail, {
    kind: 'skill-library',
    skill,
    event,
    ...extra,
  });
  process.stdout.write(JSON.stringify({ ok: true, entry }, null, 2) + '\n');
  process.exit(0);
}

main();
