/**
 * 插件信息契约（cycle-111）—— PluginInfoPanel 与版本同步的三腿守卫。
 *
 * ## 被守卫的缺陷
 *
 * 版本号同步管理（全生命周期评审体系的「版本号同步管理」项）的实际风险：
 * 发版只改 package.json 忘了重新生成 src/client/info/pluginInfo.ts ⇒ 面板显示
 * 陈旧版本，用户拿着旧版本号去对 Issue——反馈旅程在第一步就断了。本契约把
 * 「生成物 == package.json 投影」钉成硬断言，漂移即红。
 *
 * 三腿：
 * ① 版本同步：PLUGIN_INFO 逐字段 == package.json 投影（name/version/urls）；
 * ② 面板形状：真渲染输出含信息锚点 + 四个反馈外链（issues/repo/npm/docs）；
 * ③ locale 对齐：fold.pluginInfo 与 wb.info.* 两语言键集全等（漏翻可见）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PLUGIN_INFO } from '../../src/client/info/pluginInfo.ts';
import { renderPluginInfoBody, openExternal } from '../../src/client/features/info/PluginInfoSection.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string; version: string; homepage: string;
  repository: { url: string }; bugs: { url: string };
};

const repoUrl = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');

describe('腿① 版本同步：生成物 == package.json 投影', () => {
  it('name/version 与 package.json 一致（发版三锚的第四锚）', () => {
    expect(PLUGIN_INFO.name).toBe(pkg.name);
    expect(PLUGIN_INFO.version).toBe(pkg.version);
  });
  it('四个入口 URL 与 package.json 派生值一致（反馈入口不指向陈旧仓库）', () => {
    expect(PLUGIN_INFO.repository).toBe(repoUrl);
    expect(PLUGIN_INFO.issues).toBe(pkg.bugs.url);
    expect(PLUGIN_INFO.homepage).toBe(pkg.homepage);
    expect(PLUGIN_INFO.npm).toBe(`https://www.npmjs.com/package/${pkg.name}`);
    expect(PLUGIN_INFO.docs).toBe(`${repoUrl}/tree/main/docs/anic`);
  });
  it('builtAt 可解析且不晚于当前时间（mtime 锚点有效性）', () => {
    const at = new Date(PLUGIN_INFO.builtAt);
    expect(Number.isNaN(at.getTime())).toBe(false);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('腿② 面板形状：反馈入口真实可点（用户验收项）', () => {
  const html = renderToStaticMarkup(renderPluginInfoBody());

  it('信息锚点齐备：data-anic-info / 行 / 版本徽标', () => {
    expect(html).toContain('data-anic-info="true"');
    expect(html).toContain('data-anic-info-row="version"');
    expect(html).toContain(`data-anic-info-version="${PLUGIN_INFO.version}"`);
    expect(html).toContain('data-anic-info-row="name"');
    expect(html).toContain('data-anic-info-row="builtAt"');
  });
  it('四个反馈外链存在且 href 指向 PLUGIN_INFO 同源目标', () => {
    for (const [kind, href] of [
      ['issues', PLUGIN_INFO.issues],
      ['repo', PLUGIN_INFO.repository],
      ['npm', PLUGIN_INFO.npm],
      ['docs', PLUGIN_INFO.docs],
    ] as const) {
      expect(html).toContain(`data-anic-info-link="${kind}"`);
      expect(html).toContain(`href="${href}"`);
    }
  });
  it('外链安全语义：target=_blank + noreferrer（不泄漏宿主会话 referrer）', () => {
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });
  it('反向自检：openExternal 无 DOM 时静默（不抛错）', () => {
    expect(() => openExternal('https://example.com')).not.toThrow();
  });
});

describe('腿③ locale 对齐：wb.info.* 两语言键集全等', () => {
  const zh = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8')) as { wb: { info: Record<string, string> } };
  const en = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8')) as { wb: { info: Record<string, string> } };

  it('zh/en 的 wb.info 键集双向相等（漏翻/漏删都红）', () => {
    expect(Object.keys(zh.wb.info).sort()).toEqual(Object.keys(en.wb.info).sort());
  });
  it('四个链接键恰好覆盖 LINKS 值域（issues/repo/npm/docs）', () => {
    for (const key of ['issues', 'repo', 'npm', 'docs']) {
      expect(typeof zh.wb.info[key]).toBe('string');
      expect(zh.wb.info[key]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
