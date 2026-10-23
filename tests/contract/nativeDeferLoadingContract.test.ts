/**
 * 宿主原生披露机制契约（cycle-74 T-7403）——`deferLoading` 字段与**作用域张力**的机械钉。
 *
 * 背景（源码取证，app.asar dsh 0.2.1-rc.2）：
 *   宿主 `ToolSchema` 支持 `deferLoading?: true`（官方注释「Uses Anthropic's
 *   defer_loading terminology」），是**原生**渐进式披露通道；`register` 原样收下该字段。
 *
 * 但本插件**不能**用它做配置化披露——因为它是**注册期/全局**属性，
 * 而本插件单实例服务多工作区会话，需要 **per-agent-scope** 的 `restrict`：
 * 全局延迟会让「A 项目 indexed、B 项目 full」不可表达。
 *
 * 本守卫钉两件事：
 *   ① 插件契约**已声明** `deferLoading`（此前属「宿主支持但插件不知道」的盲区）；
 *   ② 该字段**默认不被设置**（零行为变更）——披露必须经 restrict 走 agent scope。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureRegisteredFaces } from '../../src/host/toolsFaceCapture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');

describe('cycle-74 T-7403 宿主原生 deferLoading：契约声明与作用域张力', () => {
  it('插件 slot 契约已声明 deferLoading（宿主支持面不再盲区）', () => {
    const src = readFileSync(join(ROOT, 'src', 'host', 'toolsSlot.ts'), 'utf8');
    expect(src).toMatch(/deferLoading\?: true;/);
    // 契约注释必须写明官方语义（防后人误以为是本仓自造）
    expect(src).toContain('defer_loading');
    expect(src).toMatch(/deferred loading/i);
  });

  it('默认零行为变更：当前注册的工具**都不带** deferLoading', () => {
    // 反向自检：若将来有人无条件设它，这条会红——迫使该变更显式接受（并解释为何全局可接受）
    const faces = captureRegisteredFaces() as Array<Record<string, unknown>>;
    expect(faces.length).toBeGreaterThanOrEqual(19);
    const withDefer = faces.filter((f) => f.deferLoading !== undefined);
    expect(withDefer.map((f) => f.name), '默认不得设置 deferLoading（会全局影响所有工作区）').toEqual([]);
  });

  it('作用域张力成文：设计册写明「全局 deferLoading vs per-scope restrict」的取舍', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'agents', '渐进式披露与轻量索引设计.md'), 'utf8');
    expect(doc).toContain('deferLoading');
    // 必须写明「per-workspace 披露必须走 restrict」这一结论，而非含糊带过
    expect(doc).toMatch(/per-agent-scope|per-workspace/);
    expect(doc).toMatch(/restrict/);
  });
});
