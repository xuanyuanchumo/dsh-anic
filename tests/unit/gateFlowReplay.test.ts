/**
 * gate-check 流程的 **INV-13 replay === online** 契约（cycle-95 接线补测）。
 *
 * ## 为什么这条测试此前不存在，而它必须存在
 *
 * INV-13（`flows/machine.ts` 头注：「投影可丢弃：replay(history) === 在线推进」）
 * 是本流程存储设计的**全部理由**——投影落盘只是缓存，真相是事件序列。
 * 四个兄弟流程（archive / autoFix / hitl / macro-phase）各自都有
 * `rebuildXxxFlowState(events)` + 一条 replay 全等用例，**只有 gate-check 没有**：
 * 它的 `rebuildGateFlowState()` 写好了、导出了，但**零调用**（audit-wiring 实测
 * P1 别域死导出）—— 那不是"多余导出"，那是**这条不变量在本流程上没被验证过**。
 *
 * ⇒ cycle-95 的裁决是**接线**而不是删除：把它接进这条用例，让 gate-check 的
 * INV-13 从"注释里的承诺"变成"每次 vitest 都跑一次的断言"。
 *
 * ## 为什么用 native 模式驱动
 *
 * native 走插件侧判定（不调技能脚本），在 vitest 里是**确定且离线**的；
 * script 模式要真实技能目录，属冒烟层不是单测层。本用例只关心状态机与事件
 * 序列，与引擎产物无关 —— native 已足够覆盖 run → verdict 两条转移。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GATE_CHECK_FLOW, runGateFlow, rebuildGateFlowState } from '../../src/host/flows/gateCheckFlow.ts';
import type { FlowEvent } from '../../src/host/flows/contracts.ts';

let ws = '';

beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'anic-gatereplay-')); });
afterEach(() => { if (ws) rmSync(ws, { recursive: true, force: true }); });

describe('gate-check INV-13：replay === 在线推进', () => {
  it('两轮在线推进的事件序列，replay 后状态全等且零拒绝', () => {
    // 第一轮：IDLE → RUNNING → PASSED|FAILED（引擎裁决决定走向，此处不预设）。
    const first = runGateFlow(ws, { gate: 'G0', mode: 'native', timeoutMs: 5000 });
    expect(first.events.length, '一轮至少应产生 run + verdict 两个事件').toBeGreaterThanOrEqual(2);

    // 第二轮：从终态重入（描述子里 PASSED/FAILED --run--> RUNNING 的边）。
    const second = runGateFlow(ws, { gate: 'G0', mode: 'native', timeoutMs: 5000 });
    const events: FlowEvent<typeof first.state>[] = [...first.events, ...second.events];

    const replayed = rebuildGateFlowState(events);
    // INV-13 的全部含义：重放出的当前态 == 最后一轮在线推进后的状态。
    expect(replayed.state.current, 'replay 后的状态必须与在线推进同源').toBe(second.state);
    // 拒绝列表为空：全部事件都是描述子允许的转移（否则说明 replay 与在线分叉）。
    expect(replayed.rejected, 'replay 不该拒绝任何在线产生的事件').toEqual([]);
  });

  it('空事件序列 replay 到描述子初始态（不伪造历史）', () => {
    const replayed = rebuildGateFlowState([]);
    expect(replayed.state.current, '零事件必须是初始态，不是某个终态').toBe(GATE_CHECK_FLOW.initial);
    expect(replayed.rejected).toEqual([]);
  });

  it('非法转移被 replay 拒绝而**不**推进状态（拒绝不是静默忽略）', () => {
    // IDLE --all-pass--> PASSED 不在描述子里（必须经过 RUNNING）⇒ 必须被拒。
    const illegal: FlowEvent<'IDLE' | 'RUNNING' | 'PASSED' | 'FAILED'>[] = [
      { from: 'IDLE', to: 'PASSED', trigger: 'all-pass', at: new Date().toISOString() },
    ];
    const replayed = rebuildGateFlowState(illegal);
    expect(replayed.state.current, '非法事件不得把状态推到 PASSED').toBe(GATE_CHECK_FLOW.initial);
    expect(replayed.rejected.length, '非法事件必须被如实登记为拒绝').toBe(1);
  });
});
