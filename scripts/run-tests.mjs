#!/usr/bin/env node
/**
 * dsh-anic 测试编排器 —— 一条命令跑完可离线执行的层。
 *
 * 离线层覆盖：DSH 规范符合性门、单元 + 契约守卫、stub 宿主机制冒烟、触发评估；
 * `--live` 追加真实宿主 J0 probe（E2E）。
 *
 * **层数与断言数不在本注释里声明**：层序/层数由下方 `STEPS` 数组决定，运行期逐层
 * 打印 `=== [i/N] … ===`、结尾打印汇总表——两者是唯一事实源。F-05（cycle-77）的教训：
 * 本注释曾写死层数与冒烟断言数；`--live` 让层数可变之后，实现变了而注释没变，
 * 于是注释与真实执行各说一套（文档漂移）。此处只描述能力，不重复任何数字。
 *
 * 用法：
 *   node scripts/run-tests.mjs            # 默认离线层
 *   node scripts/run-tests.mjs --live     # 追加真实宿主 E2E（需 start-dsh-test.mjs 环境）
 *   node scripts/run-tests.mjs --only=vitest
 *
 * 任一层失败即停后续层（fail-fast）并退出 1；全绿打印汇总表退出 0。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const live = argv.includes('--live');
const only = argv.find((a) => a.startsWith('--only='))?.slice(7) ?? null;
// cycle-97 P4-1（分片感知）：`--files=a.test.ts,b.test.ts` 把文件过滤器透传给
// vitest 层（eval-runner 的 smoke 影响域收窄是调用方）。设计约束：
//   1. 只对 vitest 层生效——validate/smoke/trigger 是整层断言，按文件截断会让
//      「规范门/冒烟」变成没跑过的假绿（比慢更危险）；
//   2. 透传即声明：用了 --files 的运行**不是全量证据**，汇总表显式标注
//      SHARD（读者与门禁可见，防止把分片结果当全量结论引用）；
//   3. 其余层在 --files 模式下自动跳过（只有 vitest 有意义，跑别的层纯属浪费）。
const filesArg = argv.find((a) => a.startsWith('--files='));
const shardFiles = filesArg ? filesArg.slice(8).split(',').filter(Boolean) : null;

const STEPS = [
  { id: 'validate', cmd: [process.execPath, join(PLUGIN_ROOT, 'scripts', 'validate-dsh.mjs')], label: 'DSH 规范符合性门' },
  { id: 'vitest', cmd: [process.execPath, join(PLUGIN_ROOT, 'scripts', 'run-vitest.mjs')], label: '单元 + 契约守卫 (vitest)' },
  { id: 'smoke', cmd: [process.execPath, join(PLUGIN_ROOT, 'scripts', 'offline-smoke.mjs')], label: '机制冒烟 (stub 宿主)' },
  { id: 'trigger', cmd: [process.execPath, join(PLUGIN_ROOT, 'scripts', 'trigger-eval.mjs')], label: '触发评估 (trigger-eval 代理评分)' },
];
if (live) STEPS.push({ id: 'live', cmd: [process.execPath, join(PLUGIN_ROOT, 'scripts', 'j0-probe.mjs')], label: '真实宿主 E2E (J0 probe)' });

const results = [];
let failed = false;
for (const [i, step] of STEPS.entries()) {
  if (only && step.id !== only) continue;
  // P4-1：分片模式只跑 vitest 层（其它层被截断即假绿，直接声明跳过）
  if (shardFiles && step.id !== 'vitest') {
    if (!only || only === step.id) results.push({ ...step, ok: null, note: 'skipped（--files 分片模式：仅 vitest 层可分片）' });
    continue;
  }
  if (failed && !only) {
    results.push({ ...step, ok: null, note: 'skipped（前序失败）' });
    continue;
  }
  process.stdout.write(`\n=== [${i + 1}/${STEPS.length}] ${step.label}${shardFiles && step.id === 'vitest' ? ` [SHARD: ${shardFiles.length} file(s)]` : ''} ===\n`);
  const t0 = Date.now();
  // P4-1：vitest 层在分片模式下把文件列表作为额外位置参数透传（run-vitest.mjs
  // 已把 extra 追加在 vitest run 之后——vitest 位置参数即文件过滤器）。
  const stepArgs = shardFiles && step.id === 'vitest' ? [...step.cmd.slice(1), ...shardFiles] : step.cmd.slice(1);
  const r = spawnSync(step.cmd[0], stepArgs, { stdio: 'inherit', cwd: PLUGIN_ROOT, windowsHide: true });
  const ok = (r.status ?? 1) === 0;
  results.push({ ...step, ok, note: `${((Date.now() - t0) / 1000).toFixed(1)}s${shardFiles && step.id === 'vitest' ? ' (shard)' : ''}` });
  if (!ok) failed = true;
}

console.log('\n=== 测试汇总 ===');
for (const r of results) {
  const mark = r.ok === null ? ' ⏭ SKIP ' : r.ok ? ' ✅ PASS' : ' ❌ FAIL';
  console.log(`${mark}  ${r.id.padEnd(9)} ${r.label}  ${r.note ?? ''}`);
}
if (shardFiles) console.log(`\n⚠️  SHARD RUN — 不是全量证据（${shardFiles.length} 个文件过滤器），不可替代全量门禁`);
if (results.every((r) => r.ok === true)) console.log(shardFiles ? '\nSHARD GREEN（分片内全绿）' : '\nALL GREEN');
// cycle-101（证据时序根治）：金字塔跑完立即把分层结果写进最新循环目录的
// test-reports/测试报告.md（正典名 = G2 与 ⑨ 契约的致证来源）。
//   动机（鸡生蛋）：⑨ 要求「测试报告非空」，但报告此前靠 agent 手工后置写入——
//   新循环首轮全量测试永远红 1 项（Q2 判据），评估基线被证据时序污染而非真实缺陷。
//   机制：由测试编排器自己落证据（先于判定存在，与 coverage reportOnFailure 同纪律）。
//   诚实性约束：
//     1. 只在**全量运行**（非 --files 分片）时写——分片不是全量证据，不可顶替正典报告；
//     2. 失败层如实记 FAIL——失败运行产出的报告会让 G2 判 FAIL（属预期，不掩盖）；
//     3. 跳过的层（fail-fast）记 SKIP——跳过层不是通过层；
//     4. 写入失败不改变测试结论（退出码只由层结果决定），但必须可见（诚实降级）。
if (!shardFiles) {
  try {
    const cyclesDir = join(PLUGIN_ROOT, '.cycles', 'cycles');
    if (existsSync(cyclesDir)) {
      const dirs = readdirSync(cyclesDir)
        .filter((d) => /^cycle-\d+$/.test(d))
        .sort((a, b) => parseInt(a.slice(6), 10) - parseInt(b.slice(6), 10));
      const latest = dirs[dirs.length - 1];
      if (latest) {
        const reportDir = join(cyclesDir, latest, 'test-reports');
        if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
        const anyFail = results.some((r) => r.ok === false);
        const failedCount = results.filter((r) => r.ok === false).length;
        const table = results
          .map((r) => {
            const status = r.ok === null ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
            return `| ${r.id} | ${r.label} | ${status} | ${r.note ?? ''} |`;
          })
          .join('\n');
        const report = [
          '# 测试报告',
          '',
          `**循环**: ${latest}`,
          `**日期**: ${new Date().toISOString().slice(0, 10)}`,
          '**执行者**: run-tests.mjs（自动证据写入，cycle-101 时序根治）',
          '**金字塔入口**: node scripts/run-tests.mjs（层序以本次汇总表为准）',
          '',
          '## §1 分层执行记录',
          '',
          '| 层 | 说明 | 结果 | 耗时 |',
          '|---|---|---|---|',
          table,
          '',
          '## §2 汇总',
          '',
          '| 维度 | 数值 |',
          '|---|---|',
          `| 通过 | ${anyFail ? '—' : '全层'} |`,
          `| 失败 | ${failedCount} |`,
          '| 错误 | 0 |',
          `| 跳过 | ${results.filter((r) => r.ok === null).length} |`,
          `| 合计 | ${results.length}（编排层；用例级计数见 vitest stdout） |`,
          '',
          anyFail
            ? `⚠️ ${failedCount} 个层失败——本报告如实记录失败层，不可作为 G2 致证（G2 将判 FAIL，属预期）。`
            : 'ALL GREEN——离线金字塔全过。',
          '',
        ].join('\n');
        writeFileSync(join(reportDir, '测试报告.md'), report);
        console.log(`\n[test-evidence] 分层报告已写入 .cycles/cycles/${latest}/test-reports/测试报告.md`);
      }
    }
  } catch (e) {
    console.log(`\n[test-evidence] 报告写入失败（不影响测试结论）: ${e?.message ?? e}`);
  }
}
process.exit(results.some((r) => r.ok === false) ? 1 : 0);
