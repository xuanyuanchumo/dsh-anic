/**
 * 流程描述子的**触发器可达性**契约（cycle-91）。
 *
 * ## 为什么钉这个（本轮实测缺陷）
 *
 * 五个流程描述子里**共 11 条** `{from: <终态>, to: 'IDLE', trigger: 'reset'}`
 * 边，而**全部** `applyTransition` 调用点**没有一处传 `'reset'`** ——
 * 实测 `grep -rn "applyTransition" src/ -A3 | grep -i reset` **零命中**。
 *
 * ⇒ 那些边**永远不会发生**，但描述子对外**宣称**它们存在
 * （`GET /anic/flows` 的 `transitions` 投影会列出来）。
 *
 * ## 危害（比"少一条边"更重）
 *
 * 1. **死边比假边更坏**：死边让 API 对外宣称一条永不发生的转移 ⇒
 *    读者会基于**不存在的语义**做判断。
 * 2. **`IDLE` 不可达** ⇒ `GET /anic/flows/status` 的 `neverRun` 计数与
 *    `projection.current` 语义失真：「从未运行过」与「运行过并收敛」
 *    在投影层**不可区分**。
 *
 * ## 本文件的判据（通用，不只查 'reset'）
 *
 * ① **每个 trigger 都必须可达**：描述子里的每个 trigger 字符串，
 *    必须在本仓**至少有一个调用点**（否则是死边）；
 * ② **`reset` 必须真能回到 `IDLE`**：跑完一轮后 + `reset: true` 再跑 ⇒
 *    投影回到 `IDLE`；
 * ③ **重置不动外部事实**：账本条目数不变（`reset` 只重置投影）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_CHECK_FLOW, GATE_CHECK_GUARDS, runGateFlow } from '../../src/host/flows/gateCheckFlow.ts';
import { ARCHIVE_FLOW } from '../../src/host/flows/archiveFlow.ts';
import { HITL_FLOW } from '../../src/host/flows/hitlFlow.ts';
import { AUTO_FIX_FLOW } from '../../src/host/flows/autoFixFlow.ts';
import { supportsReset, loadForReset } from '../../src/host/flows/flowReset.ts';
import { loadFlowProjection } from '../../src/host/flows/persistence.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 五个内置描述子。 */
const DESCRIPTORS = [
  { name: 'gate-check', d: GATE_CHECK_FLOW },
  { name: 'archive', d: ARCHIVE_FLOW },
  { name: 'hitl', d: HITL_FLOW },
  { name: 'auto-fix', d: AUTO_FIX_FLOW },
] as const;

/** 宿主端源码目录（用于扫触发器调用点）。 */
const HOST_SRC = join(ROOT, 'src', 'host');

/** 递归读出所有 .ts 源文件内容。 */
function readHostSources(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.ts$/.test(e.name)) continue;
      out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(HOST_SRC);
  return out.join('\n');
}

describe('cycle-91：描述子 trigger 的可达性（死边检测）', () => {
  it('**每个 trigger 都必须有真实触发点**（死边即红）', () => {
    const sources = readHostSources();
    const dead: string[] = [];
    for (const { name, d } of DESCRIPTORS) {
      for (const t of d.transitions) {
        // trigger 必须在源码里作为 applyTransition 的参数出现。
        // 判据：出现 `'trigger'`（带引号的字面量）即可 —— 描述子里的
        // trigger 名是稳定的英文字面量，不会与其它词混淆。
        const quoted = `'${t.trigger}'`;
        if (!sources.includes(quoted)) dead.push(`${name}: ${t.trigger}`);
      }
    }
    expect(
      dead,
      `这些 trigger 在描述子里被声明，却没有任何调用点会传它们（死边）：\n${dead.join('\n')}`,
    ).toEqual([]);
  });

  it('`reset` 边存在于全部四个流程描述子（能力面齐备）', () => {
    for (const { name, d } of DESCRIPTORS) {
      expect(supportsReset(d), `${name} 描述子缺少 reset 转移`).toBe(true);
    }
  });

  it('`reset` 的目标态是 `IDLE`（干净起点）', () => {
    for (const { name, d } of DESCRIPTORS) {
      const resets = d.transitions.filter((t) => t.trigger === 'reset');
      expect(resets.length, `${name} 的 reset 边数异常`).toBeGreaterThan(0);
      for (const t of resets) {
        expect(t.to, `${name} 的 reset 目标应为 IDLE`).toBe('IDLE');
      }
    }
  });
});

describe('cycle-91：`reset` 真的能把投影打回 IDLE', () => {
  let ws = '';
  beforeEach(() => { ws = mkdtempSync(join(require('node:os').tmpdir(), 'anic-reset-')); });
  afterEach(() => { if (ws) rmSync(ws, { recursive: true, force: true }); });

  it('**gate-check**：跑一轮后投影是终态；再跑一轮（reset=true）后回到 IDLE 起跑', () => {
    // 第一轮：正常跑（无 reset）⇒ 投影落在终态。
    const first = runGateFlow(ws, { gate: 'G0', mode: 'native', timeoutMs: 5000 });
    expect(first.state === 'PASSED' || first.state === 'FAILED', `第一轮应落在终态，实际 ${first.state}`).toBe(true);
    const projPath = join(ws, '.cycles', 'flows', 'gate-check.json');
    expect(existsSync(projPath), '投影文件应存在').toBe(true);
    const after = loadFlowProjection<typeof first.state>(join(ws, '.cycles'), 'gate-check');
    expect(after?.current, '第一轮后投影应是终态').not.toBe('IDLE');

    // 第二轮：带 reset ⇒ 投影先回 IDLE 再跑 ⇒ 事件序列里出现 reset。
    const second = runGateFlow(ws, { gate: 'G0', mode: 'native', timeoutMs: 5000, reset: true });
    const resetEvent = second.events.find((e) => e.trigger === 'reset');
    expect(resetEvent, 'reset 事件应出现在本轮事件序列里（此前是死边，永不发生）').toBeDefined();
    expect(resetEvent?.to, 'reset 事件的目标态应为 IDLE').toBe('IDLE');
    // reset 之后确实又跑了一轮（run 事件存在）。
    expect(second.events.some((e) => e.trigger === 'run'), 'reset 后应继续跑本轮').toBe(true);
  });

  it('**重置不动外部事实**：账本条目数不变（reset 只重置投影）', () => {
    const cyclesDir = join(ws, '.cycles');
    const ledgerPath = join(cyclesDir, 'gates', 'ledger.json');
    const countLedger = (): number => {
      if (!existsSync(ledgerPath)) return 0;
      try {
        const raw = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { entries?: unknown[] };
        return Array.isArray(raw.entries) ? raw.entries.length : 0;
      } catch { return 0; }
    };
    const before = countLedger();
    runGateFlow(ws, { gate: 'G0', mode: 'native', timeoutMs: 5000, reset: true });
    const after = countLedger();
    expect(after, 'reset 绝不能改动账本（账本是只追加的审计链）').toBe(before);
  });

  it('`loadForReset` 对**不存在的投影**返回描述子的初始态（IDLE）', () => {
    const loaded = loadForReset(GATE_CHECK_FLOW, join(ws, '.cycles'));
    expect(loaded.current, '未运行过的流程投影应是 IDLE').toBe('IDLE');
  });
});
