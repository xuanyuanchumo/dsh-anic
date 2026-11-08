#!/usr/bin/env node
// init-cycle.mjs — 初始化循环工作区 cycle-{N}/
// 用法: node scripts/init-cycle.mjs <project-dir> [--cycle N]
//
// cycle-43 根因修复：此前本脚本只建目录、不联动 .cycles/workflow-state.json，
// 而 workflow-state.mjs 的 initState 仅在状态文件不存在时才重建——两脚本各管半边
// 导致 currentCycle 漂移（cycle-27..41 停在 cycle-26 的实际成因）。现在建目录后
// 同步把状态机推到新循环（loadState→不存在/损坏则重建→currentCycle 前移+留痕）。
//
// cycle-78 WS-A（全生命周期）：新号前移分支同时把 currentPhase 归零到 plan 并给旧相
// 留一条 phaseHistory 记录（note='cycle-init'）。此前只前移 currentCycle、相位永久
// 停在上一循环——与 host 侧 cycleRunner.initCycle 同一语义（双实现同语义）。

import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from './lib/args.mjs';
import { atomicWriteFileSync } from './lib/fs-safe.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');

function getNextCycleNum(projectDir) {
  // cycle-147 修复（真机实证：146 循环全部归档后 init-cycle 回落 cycle-1）：
  // 原实现只扫活跃区（.cycles/cycles/），归档收口态（active 合法为空）时返回 1——
  // 忽略 .cycles/archive/ 的历史编号与 workflow-state.json 的 currentCycle，产生
  // 「归档名碰撞（archive/cycle-1 已存在 ⇒ archive-cycle 永远拒绝）」与
  // 「状态机拒回拉（1 < 146 ⇒ currentCycle 停在旧号）」双重后果。
  // 修法：活跃区、归档区、状态机三处取最大值再 +1；三处皆无信息才回落 1（真·全新项目）。
  // --cycle N 显式旗标仍最高优先（调用方裁决不受影响，见主流程 args.cycle || …）。
  const candidates = [0];
  const activeDir = join(projectDir, '.cycles', 'cycles');
  if (existsSync(activeDir)) {
    for (const e of readdirSync(activeDir)) {
      if (!e.startsWith('cycle-')) continue;
      const n = parseInt(e.slice('cycle-'.length), 10);
      if (Number.isFinite(n)) candidates.push(n);
    }
  }
  const archiveDir = join(projectDir, '.cycles', 'archive');
  if (existsSync(archiveDir)) {
    for (const e of readdirSync(archiveDir)) {
      if (!e.startsWith('cycle-')) continue;
      const n = parseInt(e.slice('cycle-'.length), 10);
      if (Number.isFinite(n)) candidates.push(n);
    }
  }
  const statePath = join(projectDir, '.cycles', 'workflow-state.json');
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (typeof state.currentCycle === 'string' && state.currentCycle.startsWith('cycle-')) {
        const n = parseInt(state.currentCycle.slice('cycle-'.length), 10);
        if (Number.isFinite(n)) candidates.push(n);
      }
    } catch {
      // 损坏状态不参与取数：syncWorkflowState 的重建线兜底（与 cycle-43 语义一致）。
    }
  }
  return Math.max(...candidates) + 1;
}

/**
 * cycle-43：状态机联动（与 workflow-state.mjs 的 initState 同一形状，数值序取最新）。
 * 三条防御线：损坏 JSON 走重建；仅当新号 > 旧号才前移（防旧号回拉）；同号幂等。
 */
function syncWorkflowState(projectDir, cycleNum) {
  const cyclesDir = join(projectDir, '.cycles');
  const statePath = join(cyclesDir, 'workflow-state.json');
  const now = new Date().toISOString();
  let state = null;
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, 'utf-8'));
    } catch {
      state = null; // 半写/损坏：走重建（原子写守护在 fs-safe.mjs）
    }
  }
  const cycleName = `cycle-${cycleNum}`;
  if (!state) {
    state = { currentPhase: 'plan', currentCycle: cycleName, phaseHistory: [], nodeStatus: {}, createdAt: now, updatedAt: now };
  } else if (state.currentCycle !== cycleName) {
    // 数值序兜底：只允许前移（新号 > 旧号），防旧号重建把状态机拉回过去。
    const prevNum = typeof state.currentCycle === 'string' ? parseInt(state.currentCycle.replace('cycle-', ''), 10) : NaN;
    if (!Number.isFinite(prevNum) || cycleNum > prevNum) {
      // cycle-78 WS-A：新循环归零到 plan。此前只前移 currentCycle、不碰 currentPhase，
      // 相位永久停在上一循环（真实工作区 cycle-77 已收口仍显示 build：全生命周期
      // 的"阶段流转"是死的）。旧相留痕：exitedAt 取真实当前时间（不伪造，也不给
      // 尚未开始的 plan 写 exitedAt）；currentPhase 非字符串时无相可记，不编造条目。
      const history = Array.isArray(state.phaseHistory) ? state.phaseHistory : [];
      const exited = typeof state.currentPhase === 'string' ? state.currentPhase : null;
      state = {
        ...state,
        currentPhase: 'plan',
        currentCycle: cycleName,
        phaseHistory: exited
          ? [...history, { phase: exited, exitedAt: now, note: 'cycle-init' }]
          : history,
        updatedAt: now,
      };
    } else {
      return; // 旧号或不可比：不动状态机（init-cycle 幂等语义）
    }
  } else {
    return; // 已指向本循环：幂等
  }
  if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });
  atomicWriteFileSync(statePath, JSON.stringify(state, null, 2));
}

function scaffoldCycle(projectDir, cycleNum) {
  const cycleDir = join(projectDir, '.cycles', 'cycles', `cycle-${cycleNum}`);
  const subdirs = ['subplans', 'test-reports'];

  for (const d of subdirs) {
    const p = join(cycleDir, d);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }

  const templateDir = join(SKILL_ROOT, 'assets', 'templates');
  const filesToCopy = [
    ['eval-report.md', '项目评估报告.md'],
    ['cycle-plan.md', '当前循环总规划.md'],
    ['task-list.md', '任务清单.md'],
    ['page-state.md', '当前循环页面状态.md'],
    ['audit-log.md', '审计日志.md'],
    ['delivery-checklist.md', '交付清单.md'],
    ['non-functional-report.md', '非功能验证报告.md'],
  ];

  for (const [template, name] of filesToCopy) {
    const src = join(templateDir, template);
    const dst = join(cycleDir, name);
    if (existsSync(src) && !existsSync(dst)) {
      let content = readFileSync(src, 'utf-8');
      content = content.replace(/cycle-\{N\}/g, `cycle-${cycleNum}`);
      atomicWriteFileSync(dst, content);
    }
  }

  // cycle-43：目录就绪后同步状态机（防 currentCycle 漂移根因复发）。
  syncWorkflowState(projectDir, cycleNum);

  console.log(`Initialized cycle-${cycleNum} workspace in ${cycleDir}`);
}


const args = parseCliArgs(process.argv, {
  script: 'init-cycle',
  usage: 'Usage: node init-cycle.mjs <project-dir> [--cycle N]',
  flags: { cycle: { type: 'int' } },
  positionals: { min: 1, max: 1, name: 'project-dir' },
});
const cycleNum = args.cycle || getNextCycleNum(args._[0]);
scaffoldCycle(args._[0], cycleNum);
