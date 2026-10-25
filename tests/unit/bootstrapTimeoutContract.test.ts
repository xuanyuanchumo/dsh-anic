/**
 * 自举每步超时契约（cycle-72 P0-BOOTSTRAP-STEP-TIMEOUT）——task-1 的回归钉。
 *
 * 被守卫缺陷：anic_bootstrap_cycle / _analyze 的每步默认超时 60000ms，而该步
 * （eval-runner）要跑整条测试金字塔（实测 ≈57s）+ 脚本自身多层 spawn。真机证据：
 * .cycles/flow-tracker.json 中 eval-runner flow durationMs=60009 / status=TIMEOUT
 * （脚本在第 60.009s 被 SIGTERM 掐断）——不是质量结论，是预算不足。
 *
 * 本用例钉死四件事（全部来自真实数字，不是拍脑袋阈值）：
 *   1. 默认值 ≥ 实测金字塔预算（57s）× 3 —— 有下限，且下限有来源；
 *   2. 默认值有界（不引入无上限）；
 *   3. 显式传参优先（语义与旧内联表达式逐字等价）；
 *   4. 两个入口（cycle / analyze）同源同一常量——禁止再次分叉成两份默认值。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOOTSTRAP_STEP_TIMEOUT_MS,
  BOOTSTRAP_PYRAMID_BUDGET_MS,
  resolveBootstrapStepTimeout,
} from '../../src/host/runtime/bootstrapBudget.ts';

const ROOT = join(__dirname, '../..');

describe('自举每步超时：默认值有下限、有上界、可解释', () => {
  it('默认值 ≥ 实测金字塔预算 × 3（修复前 60000 连 1× 都不到）', () => {
    expect(BOOTSTRAP_PYRAMID_BUDGET_MS).toBeGreaterThanOrEqual(50_000); // 金字塔体量下界
    expect(BOOTSTRAP_STEP_TIMEOUT_MS).toBeGreaterThanOrEqual(BOOTSTRAP_PYRAMID_BUDGET_MS * 3);
    // 反向前提：修复前那个 60000 必须**不再**满足（证明这条断言真能失败）
    expect(60_000).toBeLessThan(BOOTSTRAP_PYRAMID_BUDGET_MS * 3);
  });

  it('默认值有界（不引入无上限：单步仍是有限预算）', () => {
    expect(Number.isFinite(BOOTSTRAP_STEP_TIMEOUT_MS)).toBe(true);
    expect(BOOTSTRAP_STEP_TIMEOUT_MS).toBeLessThanOrEqual(600_000); // 10 分钟硬上界
  });

  it('显式传参优先（与旧内联语义逐字等价）', () => {
    expect(resolveBootstrapStepTimeout(12_345)).toBe(12_345);
    expect(resolveBootstrapStepTimeout(1)).toBe(1);
    // 非正数 / 非数 → 落回默认（旧表达式同义）
    expect(resolveBootstrapStepTimeout(0)).toBe(BOOTSTRAP_STEP_TIMEOUT_MS);
    expect(resolveBootstrapStepTimeout(-5)).toBe(BOOTSTRAP_STEP_TIMEOUT_MS);
    expect(resolveBootstrapStepTimeout(undefined)).toBe(BOOTSTRAP_STEP_TIMEOUT_MS);
    expect(resolveBootstrapStepTimeout('90000')).toBe(BOOTSTRAP_STEP_TIMEOUT_MS);
    expect(resolveBootstrapStepTimeout(null)).toBe(BOOTSTRAP_STEP_TIMEOUT_MS);
  });
});

describe('两入口同源：默认值不得分叉成第二份字面量', () => {
  it('toolsBootstrapGateway 的两处默认值都走同一常量与同一解析函数', () => {
    const src = readFileSync(join(ROOT, 'src/host/toolsBootstrapGateway.ts'), 'utf-8');
    // 两个工具（cycle / analyze）都必须调用同一解析函数
    const calls = src.match(/resolveBootstrapStepTimeout\(args\.timeout\)/g) ?? [];
    expect(calls.length).toBe(2);
    // 反向前提：旧形态（内联三元 + 60000 字面量）必须彻底消失
    expect(src).not.toMatch(/args\.timeout > 0 \? args\.timeout : 60000/);
    expect(src).not.toMatch(/Per-step timeout ms \(default 60000\)/);
    // 描述串由常量渲染（工具面与实现同源）
    expect(src).toMatch(/default \$\{BOOTSTRAP_STEP_TIMEOUT_MS\}/);
  });
});

describe('消费面诚实性：注释声明的消费者必须真实（反「声明>实现」）', () => {
  it('bootstrapBudget 头注列举的消费者在源码中真实存在（导出被引用）', () => {
    const budget = readFileSync(join(ROOT, 'src/host/runtime/bootstrapBudget.ts'), 'utf-8');
    const gateway = readFileSync(join(ROOT, 'src/host/toolsBootstrapGateway.ts'), 'utf-8');
    const invoker = readFileSync(join(ROOT, 'src/host/skillInvoker.ts'), 'utf-8');
    // 头注必须如实列出真实消费者（不得粉饰为「已覆盖全链」）
    expect(budget).toMatch(/真实消费面/);
    expect(budget).toMatch(/toolsBootstrapGateway\.ts/);
    // cycle-78 WS-B：同步入口的 120000 cap 不对称**已收敛**，头注必须如实改口
    // （继续写「未在本轮收敛」= 注释与源码里的 MAX_SKILL_INVOKE_TIMEOUT_MS 互相矛盾）
    expect(budget).toMatch(/已收敛/);
    expect(budget).not.toMatch(/未在本轮收敛/);
    // 该臂头注声明的唯一入口消费者必须真的 import 本模块
    expect(gateway).toMatch(/from '\.\/runtime\/bootstrapBudget\.ts'/);
    // 新增消费者（同步技能入口）必须真的调用上限纯函数
    expect(invoker).toMatch(/resolveSkillInvokeTimeout/);
    // 反向前提：旧假声明（声称两个编排器与 engine integration 都用默认参数引用）必须已删除
    expect(budget).not.toMatch(/本条被 runtime\/bootstrapOrchestrator\.ts、/);
  });
});
