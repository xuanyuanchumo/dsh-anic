#!/usr/bin/env node
// workflow-state.mjs — 工作流图运行时：支持 status/advance/check 命令推进图节点
// 用法:
//   状态: node workflow-state.mjs <project-dir> status [--json]
//   推进: node workflow-state.mjs <project-dir> advance [--node <node-id>]
//   检查: node workflow-state.mjs <project-dir> check
//
// 读写边界（cycle-96 WS-A 的根修）：**只有 advance 写 `.cycles/workflow-state.json`**。
// status 曾把 `inferPhase(artifacts)` 静默写回 `currentPhase`——于是「查一次状态」
// 就改掉了被观察的状态（观测改变被观察对象）。宿主侧早就守这条纪律
// （flows/macroPhaseStatusView.ts「不落盘、不 inferPhase 回写」），本脚本对齐它：
// status 只**显示** stored 与 inferred 两个读数，并标 drift；谁说了算必须是可读事实。

import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCliArgs } from './lib/args.mjs';
import { listCycleDirNames } from './lib/cycle.mjs';
import { atomicWriteFileSync } from './lib/fs-safe.mjs';

const PHASES = [
  { id: 'plan', name: 'Plan（规划）', gates: ['G0'] },
  { id: 'design', name: 'Design（设计）', gates: ['G0'] },
  { id: 'build', name: 'Build（构建）', gates: ['G1'] },
  { id: 'test', name: 'Test（测试）', gates: ['G2'] },
  { id: 'deploy', name: 'Deploy（部署）', gates: ['G3'] },
  { id: 'maintain', name: 'Maintain（维护）', gates: [] },
];

function loadWorkflowGraph(projectDir) {
  const graphPath = join(projectDir, '.cycles', 'workflow-graph.yaml');
  if (!existsSync(graphPath)) return null;
  return readFileSync(graphPath, 'utf-8');
}

function loadState(projectDir) {
  const statePath = join(projectDir, '.cycles', 'workflow-state.json');
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function saveState(projectDir, state) {
  const cyclesDir = join(projectDir, '.cycles');
  if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });
  // v1.8.3：原子写（S-6 家族收尾——半写的 workflow-state.json 会让状态机下次启动解析失败）
  atomicWriteFileSync(join(cyclesDir, 'workflow-state.json'), JSON.stringify(state, null, 2));
}

function initState(projectDir) {
  const cyclesDir = join(projectDir, '.cycles', 'cycles');
  let currentCycle = null;
  // v1.8.3：数值序（原 .sort() 字典序在 cycle-10 之后会把 currentCycle 指到 cycle-9）
  const cycleDirs = listCycleDirNames(cyclesDir);
  if (cycleDirs.length > 0) currentCycle = cycleDirs[cycleDirs.length - 1];
  return {
    currentPhase: 'plan',
    currentCycle,
    phaseHistory: [],
    nodeStatus: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function getCycleArtifacts(projectDir, cycleName) {
  if (!cycleName) return {};
  const cyclePath = join(projectDir, '.cycles', 'cycles', cycleName);
  if (!existsSync(cyclePath)) return {};

  const artifacts = {};
  const files = [
    ['项目评估报告.md', 'eval'],
    ['当前循环总规划.md', 'plan'],
    ['任务清单.md', 'tasks'],
    ['当前循环页面状态.md', 'pageState'],
    ['审计日志.md', 'audit'],
    ['交付清单.md', 'delivery'],
    ['非功能验证报告.md', 'nonFunc'],
  ];
  for (const [filename, key] of files) {
    artifacts[key] = existsSync(join(cyclePath, filename));
  }

  const testDir = join(cyclePath, 'test-reports');
  artifacts.testReports = existsSync(testDir) && readdirSync(testDir).filter(e => e.endsWith('.md')).length > 0;

  return artifacts;
}

function inferPhase(artifacts) {
  if (artifacts.eval && !artifacts.plan) return 'plan';
  if (artifacts.plan && !artifacts.tasks) return 'design';
  if (artifacts.tasks && !artifacts.testReports) return 'build';
  if (artifacts.testReports) return 'test';
  return 'plan';
}

function getGateResults(projectDir) {
  const gatesDir = join(projectDir, '.cycles', 'gates');
  if (!existsSync(gatesDir)) return { passed: [], failed: [] };

  const ledgerPath = join(gatesDir, 'ledger.json');
  if (!existsSync(ledgerPath)) return { passed: [], failed: [] };

  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
  const passed = ledger.entries.filter(e => e.result === 'PASS').map(e => e.gate);
  const failed = ledger.entries.filter(e => e.result === 'FAIL').map(e => e.gate);
  return { passed, failed };
}

/**
 * 相位名（合法 id → 表中全角名；非法 id → 原样回显，不抛）。
 *
 * 为什么不用 `PHASES[idx].name` 直取：`workflow-state.json` 是**人工与脚本混合写入**
 * 的文件（本仓 phaseHistory 里就有 `{note, at}` 这种无 phase 字段的条目），
 * 一个手改出来的 `currentPhase: "limbo"` 不该让查询命令崩掉——查不到就如实回显原值。
 */
function phaseNameOf(id) {
  return PHASES.find(p => p.id === id)?.name ?? String(id);
}

/**
 * `status` 的**只读**视图（cycle-96 WS-A 根修）。
 *
 * 被修缺陷：旧实现把 `inferPhase(artifacts)` 的结果**静默写回** `state.currentPhase`
 * 并 `saveState`。于是「查一次状态」就改掉了被观察的状态——观测改变被观察对象。
 * 本仓宿主侧早有共识（`flows/macroPhaseStatusView.ts`：「不落盘、不 inferPhase 回写」），
 * 脚本侧此前没跟上；本轮对齐宿主，而不是让宿主放松。
 *
 * 现在的口径：`stored`（磁盘上的事实）与 `inferred`（工件推断的读数）**两个都显示**，
 * 不一致就标 `drift` —— 谁说了算必须是可读事实，不能靠静默改写其中一个。
 * 回写只发生在 `advance`（那条命令本身就是写动作）。
 */
function cmdStatus(projectDir, asJson) {
  // 状态文件缺失时**同样不落盘**：内存里按 initState 形状展示并标注
  // projectionSeeded=false。旧实现在这里 `saveState`，等于「第一次查询就创世出
  // 一个状态文件」——后续 advance 的「文件从未存在」语义被查询行为篡改。
  const loaded = loadState(projectDir);
  const state = loaded ?? initState(projectDir);
  const projectionSeeded = loaded !== null;

  const artifacts = getCycleArtifacts(projectDir, state.currentCycle);
  const storedPhase = state.currentPhase;
  const inferredPhase = inferPhase(artifacts);
  const drift = storedPhase !== inferredPhase;

  const gateResults = getGateResults(projectDir);
  const currentPhaseIdx = PHASES.findIndex(p => p.id === storedPhase);

  if (asJson) {
    // 机器可读形态（`--json`）：{stored, inferred, drift} 三字段是判据核心，
    // 其余字段与人类可读输出同源（同一次读取，不二次采信）。
    console.log(JSON.stringify({
      command: 'status',
      projectDir,
      currentPhase: storedPhase,
      phaseName: phaseNameOf(storedPhase),
      stored: storedPhase,
      inferred: inferredPhase,
      drift,
      currentCycle: state.currentCycle,
      projectionSeeded,
      phaseHistoryLength: state.phaseHistory.length,
      artifacts,
      gates: gateResults,
    }, null, 2));
    return;
  }

  const currentPhaseName = phaseNameOf(storedPhase);

  console.log(`=== AI-Native Iteration Cycle Workflow State ===`);
  console.log(`Project: ${projectDir}`);
  console.log(``);

  if (state.currentCycle) {
    console.log(`Current Cycle: ${state.currentCycle}`);
  } else {
    console.log(`No cycles initialized. Run init-workflow + init-cycle to start.`);
  }
  // 状态文件是否存在要如实说：缺失时上面的读数来自内存缺省（plan），
  // 不是磁盘事实。不写这一行，读者会把「默认值」当成「已验证的状态」。
  if (!projectionSeeded) {
    console.log(`  state file: absent（本次仅为报告，未写盘；advance 才会创建）`);
  }

  console.log(``);
  // 双读数（cycle-96 WS-A）：stored 是磁盘事实，inferred 是工件推断。两者都是
  // 「读数」而不是「结论」——所以一致时也照印（`(stored: test / inferred: test)`），
  // 读者才知道推断确实跑过，而不是「省掉了没显示」。
  console.log(`Current Phase: ${currentPhaseName} (stored: ${storedPhase} / inferred: ${inferredPhase})`);
  if (drift) {
    // drift 行必须给出**可操作出路**：谁说了算在 advance 那只写动作里决定，
    // 查询命令只负责把分叉摆到台面上（不替任何一方静默校正）。
    console.log(`  drift: 相位推断不一致（工作件推断出 ${inferredPhase}，状态文件仍是 ${storedPhase}；`
      + `查询不写盘——要以前者为准请显式 advance --node ${inferredPhase}）`);
  }
  console.log(`  Artifacts:`);
  for (const [key, exists] of Object.entries(artifacts)) {
    console.log(`    ${exists ? '[x]' : '[ ]'} ${key}`);
  }

  console.log(``);
  console.log(`Phase Progress:`);
  for (let i = 0; i < PHASES.length; i++) {
    const phase = PHASES[i];
    const marker = i === currentPhaseIdx ? '>>>' : i < currentPhaseIdx ? ' [x]' : ' [ ]';
    console.log(`  ${marker} ${phase.name}`);
    if (phase.gates.length > 0) {
      for (const g of phase.gates) {
        const passed = gateResults.passed.includes(g);
        const failed = gateResults.failed.includes(g);
        const status = passed ? 'PASS' : failed ? 'FAIL' : 'PENDING';
        console.log(`        ${g}: ${status}`);
      }
    }
  }

  console.log(``);
  console.log(`Gates:`);
  console.log(`  Passed: ${gateResults.passed.length} ${gateResults.passed.length > 0 ? `(${gateResults.passed.join(', ')})` : ''}`);
  console.log(`  Failed: ${gateResults.failed.length} ${gateResults.failed.length > 0 ? `(${gateResults.failed.join(', ')})` : ''}`);

  console.log(``);
  console.log(`=== End of State Report ===`);
}

function cmdAdvance(projectDir, targetNode) {
  let state = loadState(projectDir);
  if (!state) {
    state = initState(projectDir);
  }

  const currentIdx = PHASES.findIndex(p => p.id === state.currentPhase);
  if (currentIdx === -1) {
    console.error(`Invalid current phase: ${state.currentPhase}`);
    process.exit(1);
  }

  let nextIdx;
  if (targetNode) {
    nextIdx = PHASES.findIndex(p => p.id === targetNode);
    if (nextIdx === -1) {
      console.error(`Unknown phase: ${targetNode}. Valid phases: ${PHASES.map(p => p.id).join(', ')}`);
      process.exit(1);
    }
  } else {
    nextIdx = currentIdx + 1;
  }

  if (nextIdx <= currentIdx) {
    console.error(`Cannot advance backwards or to same phase. Current: ${state.currentPhase}, Target: ${PHASES[nextIdx].id}`);
    process.exit(1);
  }

  if (nextIdx >= PHASES.length) {
    console.log(`Already at final phase (${PHASES[currentIdx].name}). No more phases to advance.`);
    return;
  }

  const currentPhase = PHASES[currentIdx];
  const nextPhase = PHASES[nextIdx];

  const gateResults = getGateResults(projectDir);
  for (const g of currentPhase.gates) {
    if (!gateResults.passed.includes(g)) {
      console.error(`Cannot advance: gate ${g} for phase ${currentPhase.name} has not passed.`);
      console.error(`  Passed gates: ${gateResults.passed.join(', ') || 'none'}`);
      process.exit(1);
    }
  }

  state.phaseHistory.push({
    phase: state.currentPhase,
    exitedAt: new Date().toISOString(),
  });
  state.currentPhase = nextPhase.id;
  state.updatedAt = new Date().toISOString();
  saveState(projectDir, state);

  console.log(`Advanced from ${currentPhase.name} to ${nextPhase.name}.`);

  if (nextPhase.gates.length > 0) {
    console.log(`  Next gates to pass: ${nextPhase.gates.join(', ')}`);
  }
}

function cmdCheck(projectDir) {
  // 同 status 纪律（cycle-96 WS-A）：check 也是**查询**命令。
  // 旧实现缺状态文件时 `saveState` —— 一次「检查」就把状态文件创世出来，
  // 后续 advance 的「从未存在过」语义被观测行为篡改。现在只在内存里缺省。
  const loaded = loadState(projectDir);
  const state = loaded ?? initState(projectDir);
  const projectionSeeded = loaded !== null;

  const artifacts = getCycleArtifacts(projectDir, state.currentCycle);
  const inferredPhase = inferPhase(artifacts);
  const gateResults = getGateResults(projectDir);
  const storedPhase = state.currentPhase;
  const currentPhase = PHASES.find(p => p.id === storedPhase);

  const checks = [];

  // 非法相位（手改出来的 id）不该让检查崩掉：如实报 WARN 并给出有效名单。
  if (!currentPhase) {
    checks.push({
      gate: 'PHASE_VALID',
      status: 'WARN',
      message: `State says unknown phase "${storedPhase}"; valid phases: ${PHASES.map(p => p.id).join(', ')}`,
    });
  }
  for (const g of currentPhase?.gates ?? []) {
    if (gateResults.passed.includes(g)) {
      checks.push({ gate: g, status: 'PASS', message: 'Gate passed' });
    } else if (gateResults.failed.includes(g)) {
      checks.push({ gate: g, status: 'FAIL', message: 'Gate failed — must fix before advancing' });
    } else {
      checks.push({ gate: g, status: 'PENDING', message: 'Gate not yet evaluated' });
    }
  }

  if (inferredPhase !== storedPhase) {
    checks.push({
      gate: 'PHASE_SYNC',
      status: 'WARN',
      message: `State says ${storedPhase} but artifacts suggest ${inferredPhase}`,
    });
  }

  console.log(`Workflow Check Report`);
  console.log(`  Current phase: ${phaseNameOf(storedPhase)}`);
  console.log(`  Inferred phase: ${phaseNameOf(inferredPhase)}`);
  if (!projectionSeeded) {
    console.log(`  state file: absent（本次仅为报告，未写盘；advance 才会创建）`);
  }
  console.log(``);

  let allPass = true;
  for (const c of checks) {
    console.log(`  [${c.status}] ${c.gate}: ${c.message}`);
    if (c.status === 'FAIL') allPass = false;
  }

  console.log(``);
  if (allPass) {
    console.log(`All checks passed. Ready to advance.`);
  } else {
    console.error(`Some checks failed. Fix issues before advancing.`);
    process.exit(1);
  }
}

const args = parseCliArgs(process.argv, {
  script: 'workflow-state',
  usage: 'Usage: node workflow-state.mjs <project-dir> status|advance|check [--node <node-id>] [--json]',
  // `--json` 只对 status 有意义（机器可读的 stored/inferred/drift 三字段）。
  // 为什么不做成全局旗标语义：advance/check 的输出是给人看的流水，强行 JSON 化
  // 会破坏既有消费方（hook-settings 与 MCP 封装都按文本流解析）。
  flags: { node: { type: 'string' }, json: { type: 'boolean' } },
  positionals: { min: 2, max: 2, name: '<project-dir> <command>' },
});

const projectDir = resolve(args._[0]);
const command = args._[1];

// `--json` 与 status 之外命令的组合是**用法错误**，不是静默忽略：
// 静默接受会让调用方以为自己拿到了机器可读结果，实际拿到的是人读流。
if (args.json && command !== 'status') {
  console.error(`[workflow-state] --json 只适用于 status 命令（收到: ${command}）`);
  console.error('Usage: node workflow-state.mjs <project-dir> status [--json]');
  process.exit(1);
}

switch (command) {
  case 'status':
    cmdStatus(projectDir, args.json);
    break;
  case 'advance':
    cmdAdvance(projectDir, args.node);
    break;
  case 'check':
    cmdCheck(projectDir);
    break;
  default:
    console.error(`Unknown command: ${command}. Use status, advance, or check.`);
    process.exit(1);
}