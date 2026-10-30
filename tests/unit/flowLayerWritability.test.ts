/**
 * 开关**层可写性**契约（cycle-90）—— 「面板不能让你改你改不了的东西」。
 *
 * ## 被守卫的缺陷（实测）
 *
 * `flow.selfInit` / `flow.gateRecord` / `flow.budgetEnforce` /
 * `flow.agentsOrchestration` 的 `layers` **不含 `'user'`** ——
 * 语义是「这个开关只能由工作区/部署层控制，用户层不可写」。
 *
 * 但 `resolveFlows` 此前**不检查 `layers`**，只按层序（deployment → workspace → user）
 * 覆盖。于是：
 *
 * ```
 * resolveFlows({ user: { 'flow.selfInit': false } })
 *   → { enabled: false, source: 'user' }   ← user 层写入**生效了**
 * ```
 *
 * 双重失真：
 * ① **数据面**：用户层写入本应被拒（locale 键 `panel.selfInitOffTitle` 写的就是
 *    「该开关只支持工作区/部署层，用户层不可写」），但它生效了；
 * ② **界面面**：面板 checkbox 可点、点了界面变了 —— 而真相没变（「面板在骗人」）。
 *
 * ## 修法（两层，同源）
 *
 * - **数据面**（`src/shared/flows.ts` 的 `resolveFlows`）：层不在该开关 `layers` 里
 *   ⇒ **忽略该层写入 + 产出 warning**（fail-closed，不静默）。
 * - **界面面**（`isUserWritable`）：面板据此**禁用** checkbox + 给专门文案。
 *
 * 两者都读同一份 `FlowDefinition.layers` —— 不同源就会判出不同结果。
 */
import { describe, expect, it } from 'vitest';
import {
  FLOWS,
  isUserWritable,
  resolveFlows,
  type FlowLayer,
} from '../../src/shared/flows.ts';

/** 不支持用户层的开关 id（应当全部不可写）。 */
const WORKSPACE_ONLY = FLOWS.filter((f) => !f.layers.includes('user')).map((f) => f.id);

describe('resolveFlows：层不支持 ⇒ 该层写入被拒（fail-closed）', () => {
  it('**实测反例守卫：user 层写 flow.selfInit 不再生效**', () => {
    const r = resolveFlows({ user: { 'flow.selfInit': false } });
    expect(r.flows['flow.selfInit']?.enabled).toBe(true);
    expect(r.flows['flow.selfInit']?.source).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join(' ')).toContain('flow.selfInit');
    expect(r.warnings.join(' ')).toContain('user');
  });

  it('**所有 workspace-only 开关都拒绝 user 层写入**（逐个验，不抽样）', () => {
    expect(WORKSPACE_ONLY.length).toBeGreaterThan(0);
    for (const id of WORKSPACE_ONLY) {
      const r = resolveFlows({ user: { [id]: false } });
      expect(r.flows[id]?.enabled, `${id} 的 user 层写入不应生效`).toBe(true);
      expect(r.flows[id]?.source, `${id} 不应有 user 来源`).toBeNull();
      expect(r.warnings.length, `${id} 应产出 warning`).toBeGreaterThan(0);
    }
  });

  it('**警告说清「不支持哪层 + 支持哪几层」**（可执行的诊断，不是「失败了」）', () => {
    const r = resolveFlows({ user: { 'flow.gateRecord': false } });
    const msg = r.warnings.join(' ');
    expect(msg).toContain('flow.gateRecord');
    expect(msg).toContain('workspace/deployment');
  });

  it('**支持 user 层的开关照常生效**（修法不能误伤）', () => {
    const r = resolveFlows({ user: { 'flow.workflowTab': false } });
    expect(r.flows['flow.workflowTab']?.enabled).toBe(false);
    expect(r.flows['flow.workflowTab']?.source).toBe('user');
    expect(r.warnings).toHaveLength(0);
  });

  it('**工作区层写入 workspace-only 开关仍然生效**（拒绝只针对不支持的层）', () => {
    const r = resolveFlows({ workspace: { 'flow.selfInit': false } });
    expect(r.flows['flow.selfInit']?.enabled).toBe(false);
    expect(r.flows['flow.selfInit']?.source).toBe('workspace');
    expect(r.warnings).toHaveLength(0);
  });

  it('**部署层写入 workspace-only 开关仍然生效**', () => {
    const r = resolveFlows({ deployment: { 'flow.selfInit': false } });
    expect(r.flows['flow.selfInit']?.enabled).toBe(false);
    expect(r.flows['flow.selfInit']?.source).toBe('deployment');
  });

  it('未知键仍按 unknown 告警处理（既有语义不变）', () => {
    const r = resolveFlows({ user: { 'flow.notExists': false } });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join(' ')).toContain('flow.notExists');
  });

  it('非布尔值仍按既有语义忽略并告警', () => {
    const r = resolveFlows({ user: { 'flow.workflowTab': 'yes' as unknown as boolean } });
    expect(r.warnings.join(' ')).toContain('non-boolean');
  });
});

describe('isUserWritable：面板侧的单层可写性', () => {
  it('与 `resolveFlows` 的拒绝逻辑**同源**（同一份 layers）', () => {
    for (const f of FLOWS) {
      const writable = isUserWritable(f.id);
      const r = resolveFlows({ user: { [f.id]: false } });
      const rejected = r.warnings.some((w) => w.includes(f.id) && w.includes('user'));
      expect(writable, `${f.id} 的可写性判定应与 resolveFlows 一致`).toBe(!rejected);
    }
  });

  it('**未知 id ⇒ 可写**（保守：新开关在配好 locale 前不应变成死开关）', () => {
    expect(isUserWritable('flow.brandNew')).toBe(true);
  });

  it('已知开关的可写性符合其 layers 声明', () => {
    for (const f of FLOWS) {
      const expected = f.layers.includes('user');
      expect(isUserWritable(f.id), `${f.id} layers=${f.layers.join('/')}`).toBe(expected);
    }
  });
});

describe('层集合自洽（防止将来加开关时写错）', () => {
  it('每个开关的 layers 至少有一层', () => {
    for (const f of FLOWS) {
      expect(f.layers.length, `${f.id} 没有任何层`).toBeGreaterThan(0);
    }
  });

  it('每个开关的 layers 都是合法层名', () => {
    const valid: FlowLayer[] = ['user', 'workspace', 'deployment'];
    for (const f of FLOWS) {
      for (const l of f.layers) {
        expect(valid, `${f.id} 含非法层 ${l}`).toContain(l);
      }
    }
  });
});
