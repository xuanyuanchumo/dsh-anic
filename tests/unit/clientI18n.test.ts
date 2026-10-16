/**
 * 客户端 i18n 契约（P0-1 第一步 / P0-2 自举反馈）。
 *
 * 守什么：
 * - t() 缺省中文：与既有中文文案一致 —— jsdom（lang 缺失）与旧宿主场景
 *   的渲染输出不得因引入 i18n 而改变（回归红线）；
 * - 回退链：当前语言缺键 → zh → 键名本身（漏翻可见，不静默空白）；
 * - {param} 插值与 host 侧 t() 同一约定；
 * - detectClientLang 优先级：localStorage 覆盖 > documentElement.lang > 缺省 zh；
 * - locale/zh.json 与 en.json 的 panel.* 自举四态键齐全（P0-2 依赖）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, detectClientLang } from '../../src/client/i18n.ts';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('client i18n: t() 语义', () => {
  it('缺省返回中文（回归红线：引入 i18n 不改变既有渲染输出）', () => {
    expect(t('panel.refresh')).toBe('刷新');
    expect(t('panel.selfInit')).toBe('自举');
  });

  it('{param} 插值', () => {
    expect(t('panel.selfInitFailed', { error: 'HTTP 500' })).toBe('自举失败：HTTP 500');
    expect(t('panel.selfInitOk', { detail: '（200）' })).toBe('自举已触发（幂等）（200）');
  });

  it('缺键回退链：en 缺键 → zh → 键名', () => {
    // 'meta.title' 两边都有：证明点路径确实穿透嵌套结构
    expect(t('meta.title')).toBe('ANIC 工作流');
    // 不存在的键：可见的键名（漏翻可见，非空白）
    expect(t('no.such.key')).toBe('no.such.key');
  });

  it('中英字典 shape 对齐：panel.* 自举四态键两端齐全（P0-2 依赖）', () => {
    const zh = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'locale', 'zh.json'), 'utf-8')) as Record<string, Record<string, string>>;
    const en = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'locale', 'en.json'), 'utf-8')) as Record<string, Record<string, string>>;
    const keys = ['selfInitTitle', 'selfInitRunning', 'selfInitOk', 'selfInitAlready', 'selfInitFailed', 'selfInitRetry'];
    for (const k of keys) {
      expect(typeof zh.panel?.[k]).toBe('string');
      expect(typeof en.panel?.[k]).toBe('string');
    }
    // 插值占位符两端一致（en 侧换了占位符名会让失败信息静默丢参）
    expect(zh.panel?.selfInitFailed).toContain('{error}');
    expect(en.panel?.selfInitFailed).toContain('{error}');
  });
});

describe('client i18n: detectClientLang 优先级', () => {
  const originalDefine = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    if (originalDefine) Object.defineProperty(globalThis, 'localStorage', originalDefine);
    else delete (globalThis as Record<string, unknown>).localStorage;
    if (typeof document !== 'undefined') document.documentElement.lang = '';
  });

  function stubLocalStorage(value: Record<string, string> | null): void {
    if (value === null) {
      delete (globalThis as Record<string, unknown>).localStorage;
      return;
    }
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => value[k] ?? null, setItem: () => undefined },
    });
  }

  beforeEach(() => {
    stubLocalStorage({});
    if (typeof document !== 'undefined') document.documentElement.lang = '';
  });

  it('localStorage 显式覆盖优先', () => {
    stubLocalStorage({ 'anic-lang': 'en' });
    expect(detectClientLang()).toBe('en');
    stubLocalStorage({ 'anic-lang': 'zh' });
    expect(detectClientLang()).toBe('zh');
  });

  it('非法覆盖值不生效（回退到下一层）', () => {
    stubLocalStorage({ 'anic-lang': 'fr' });
    expect(detectClientLang()).toBe('zh');
  });

  it('documentElement.lang=en 检出英文', () => {
    if (typeof document === 'undefined') return; // 无 DOM 环境跳过（不算失败）
    document.documentElement.lang = 'en-US';
    expect(detectClientLang()).toBe('en');
  });

  it('lang=zh 或缺失 → 缺省中文', () => {
    if (typeof document !== 'undefined') document.documentElement.lang = 'zh-CN';
    expect(detectClientLang()).toBe('zh');
    if (typeof document !== 'undefined') document.documentElement.lang = '';
    expect(detectClientLang()).toBe('zh');
  });

  it('localStorage 不可用（沙盒/SSR）不抛错且缺省 zh', () => {
    stubLocalStorage(null);
    expect(detectClientLang()).toBe('zh');
  });
});
