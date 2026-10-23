/**
 * 工具面渐进式披露契约（cycle-74 T-7401）——模式解析 + 索引注入文本 + 体积棘轮。
 *
 * 前置（cycle-73 实测）：A0′ **PASS** —— scoped ctx 上 `restrict` 生效（scope 视图 25→24、
 * `get(name,agent)` 归 absent、全局视图不受影响、disposer 精确恢复）。
 * 证据：`.cycles/tech-debt/cycle-73-a0-probe-result.md`。故激活面机制无障碍。
 *
 * 本守卫钉**可离线机器验证**的那些判据（design §4 的 A2/A8/A9 的披露侧）：
 *   A2 注入面体积 ≤ 2 KB；
 *   A8 **默认模式零行为变更**（`resolveDisclosureMode` 非 'indexed' 一律回落 'full'）；
 *   A9 注入面文本体积棘轮。
 *
 * 未在本守卫内（**诚实标注**）：A1（prompt cache 影响）、A3/A4（激活后可见性与差分）、
 * A6/A7（幂等/旧代降级）——它们需真机或激活接线，本轮未落地。**SKIP ≠ PASS**。
 *
 * 守卫纪律：① 反向自检（变异体必须使断言翻假）；② 扫描集非空下限；③ 只读纯函数。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveDisclosureMode,
  getToolDisclosure,
  buildIndexSectionText,
  indexSectionBytes,
} from '../../src/host/toolDisclosure.ts';
import { buildCapabilityIndex } from '../../src/host/capabilityIndex.ts';
import { captureRegisteredFaces } from '../../src/host/toolsFaceCapture.ts';
import { listSkillScripts } from '../../src/host/skillInvoker.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const faces = captureRegisteredFaces();
const scripts = listSkillScripts();
const idx = buildCapabilityIndex(faces, scripts, 'test').injectable;

describe('cycle-74 T-7401 工具面渐进式披露契约', () => {
  it('A8 默认零行为变更：仅显式 indexed 才切换，其余一律 full（fail-closed）', () => {
    expect(resolveDisclosureMode('indexed')).toBe('indexed');
    expect(resolveDisclosureMode('full')).toBe('full');
    // 反向：任何非法/缺失/近似值都不得悄悄切到 indexed
    for (const bad of [undefined, null, '', 'INDEXED', 'index', true, 1, {}, ['indexed']]) {
      expect(resolveDisclosureMode(bad), String(bad) + ' 不应切到 indexed').toBe('full');
    }
  });

  it('config 解析：anic 段 toolDisclosure 键；缺省/非法 → full', () => {
    expect(getToolDisclosure(null)).toBe('full');
    expect(getToolDisclosure('')).toBe('full');
    expect(getToolDisclosure('toolDisclosure: indexed')).toBe('indexed');
    expect(getToolDisclosure("toolDisclosure: 'indexed'")).toBe('indexed');
    expect(getToolDisclosure('toolDisclosure: bogus')).toBe('full');
    // 反向自检：键名近似值不得误命中（防子串匹配）
    expect(getToolDisclosure('notToolDisclosure: indexed')).toBe('full');
  });

  it('A2 注入面文本体积 ≤ 2 KB（含索引全量 19 工具 + 15 脚本）', () => {
    const text = buildIndexSectionText(idx);
    const bytes = Buffer.byteLength(text, 'utf8');
    expect(bytes).toBeLessThanOrEqual(2048);
    // 必须真的含全部工具与脚本（空/截断文本会显得「很瘦」但无用）
    for (const f of faces) expect(text).toContain(f.name);
    expect(text).toContain('anic_tool_detail');
  });

  it('A9 体积棘轮：注入面 ≤ 2304 B（防披露层自己变胖）', () => {
    expect(indexSectionBytes(idx)).toBeLessThanOrEqual(2304);
  });

  it('注入面**不含** triggers/parameters 原文（防把 description 塞回上下文）', () => {
    const text = buildIndexSectionText(idx);
    expect(text).not.toContain('Triggers:');
    expect(text).not.toContain('parameters');
  });

  it('纪律① 反向自检：删一个工具后文本不再含它（证明工具列表真从索引来）', () => {
    const trimmed = { ...idx, tools: idx.tools.slice(1) };
    const text = buildIndexSectionText(trimmed);
    const removed = idx.tools[0]?.[0] as string;
    expect(text).not.toContain(removed);
  });

  it('mode 默认 full 的既有行为未被本模块改变（源码面：无强制切换）', () => {
    const src = readFileSync(join(ROOT, 'src', 'host', 'toolDisclosure.ts'), 'utf8');
    // 反向：不得出现「默认即 indexed」的写法
    expect(src).not.toMatch(/resolveDisclosureMode\([^)]*\)\s*[;{]?\s*\/\/\s*default indexed/);
    expect(src).toMatch(/=== 'indexed' \? 'indexed' : 'full'/);
  });
});
