/**
 * **门禁工具映射**契约（cycle-92）—— 防「死键」（指向不存在/永不命中的映射）。
 *
 * ## 为什么钉这个（审计实测缺陷）
 *
 * `renderLastCompletedCard.ts` 的 `GATE_TOOL_GATES` 表把「工具 → 账本 gate 集」
 * 硬编码进去，用来在 live 卡片上显示门禁裁决。初版有 **3** 个键，其中
 * `anic_multi_agent_gate` 是**双重死键**：
 *
 * 1. **工具名不存在**：本插件 23 个工具里没有 `anic_multi_agent_gate`
 *    （`ANIC_TOOL_IDS` 无此项）。该能力由 `anic_skill({script:'multi-agent-gate'})`
 *    调起，feed 里记录的工具名是 `anic_skill` ⇒ 按工具名查表**永远查不到**。
 * 2. **它的门名从不进账本**：该脚本的门是 `intent`/`spec`/`plan`/`pr`/`release`
 *    （人工门，判据来自 git 变更文件），而账本实测只含 `G0`-`G3` ⇒
 *    即使工具名对了，`gates.includes(e.gate)` 也**永远为假**。
 *
 * ## 为什么「死键」比「缺键」更坏
 *
 * 缺键 ⇒ 卡片不显示门禁段（诚实缺席）。
 * 死键 ⇒ 读者/维护者以为**这个能力已被覆盖**，而实际上它**从来没有工作过**，
 * 且没有任何报错。这正是「用看似有值的东西掩盖真空」——本仓纪律反对的形态。
 *
 * ## 两条判据（本文件）
 *
 * 1. 表里**每个键**都必须是 `ANIC_TOOL_IDS` 里的真实工具 id；
 * 2. 表里**每个门名**都必须真的出现在账本的门名集合里（否则永不命中）。
 *
 * 第 2 条需要真实账本 ⇒ 从 `.cycles/gates/ledger.json` 读；账本不存在时
 * 用 G0-G3 作为**契约基线**（`gate-check.mjs` 的合法门集）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANIC_TOOL_IDS } from '../../src/host/toolIds.ts';
import { GATE_TOOL_GATES } from '../../src/client/features/live/renderLastCompletedCard.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 账本里真实出现过的门名（账本缺失 ⇒ 回落 G0-G3 契约基线）。 */
function ledgerGateNames(): Set<string> {
  const p = join(ROOT, '.cycles', 'gates', 'ledger.json');
  if (!existsSync(p)) return new Set(['G0', 'G1', 'G2', 'G3']);
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { entries?: Array<{ gate?: string }> };
    const names = new Set<string>();
    for (const e of raw.entries ?? []) if (typeof e.gate === 'string') names.add(e.gate);
    // 空账本是合法状态（尚未跑过门禁）⇒ 回落契约基线，否则契约会因"没跑过"而假红。
    return names.size === 0 ? new Set(['G0', 'G1', 'G2', 'G3']) : names;
  } catch {
    return new Set(['G0', 'G1', 'G2', 'G3']);
  }
}

describe('cycle-92：门禁工具映射不得有死键', () => {
  it('守卫纪律①：扫描集非空（表为空则下面的断言全部空转）', () => {
    const keys = Object.keys(GATE_TOOL_GATES);
    expect(keys.length, 'GATE_TOOL_GATES 为空 —— 契约无意义').toBeGreaterThan(0);
  });

  it('**每个键都是真实注册的工具 id**（防「工具名不存在」型死键）', () => {
    const known = new Set(ANIC_TOOL_IDS);
    const ghosts = Object.keys(GATE_TOOL_GATES).filter((k) => !known.has(k));
    expect(
      ghosts,
      `GATE_TOOL_GATES 里这些键不是本插件注册的工具（按工具名查表永远查不到）：${ghosts.join(', ')}`,
    ).toEqual([]);
  });

  it('**每个门名都真的在账本门名集合里**（防「永不命中」型死键）', () => {
    const ledgerNames = ledgerGateNames();
    const dead: string[] = [];
    for (const [tool, gates] of Object.entries(GATE_TOOL_GATES)) {
      for (const g of gates) {
        if (!ledgerNames.has(g)) dead.push(`${tool} → ${g}`);
      }
    }
    expect(
      dead,
      `这些门名从不出现在账本里（gateFinding 永远返回 null）：${dead.join(', ')}\n`
      + `账本现有门名：${[...ledgerNames].sort().join(', ')}`,
    ).toEqual([]);
  });

  it('反向自检：判定器**能识别**死键（否则本条是恒真装饰）', () => {
    const known = new Set(ANIC_TOOL_IDS);
    const judge = (k: string): boolean => known.has(k);
    expect(judge('anic_gate_check'), '真实工具应判为合法').toBe(true);
    expect(judge('anic_multi_agent_gate'), 'cycle-92 删除的死键必须被判为非法').toBe(false);
    expect(judge('anic_this_does_not_exist'), '编造的工具名必须被判为非法').toBe(false);
  });

  it('**删除决策留痕**：源码注释必须说明为何删 `anic_multi_agent_gate`', () => {
    const src = readFileSync(join(ROOT, 'src', 'client', 'features', 'live', 'renderLastCompletedCard.ts'), 'utf8');
    expect(src, '必须留下删除理由（否则下一个人会把它加回去）').toContain('anic_multi_agent_gate');
    expect(src).toContain('死键');
  });
});
