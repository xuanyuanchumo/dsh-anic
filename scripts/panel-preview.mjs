#!/usr/bin/env node
/**
 * 面板静态预览生成器（cycle-89）——把**真实构建产物**渲染成可截图的静态 HTML。
 *
 * ## 为什么需要它（不是玩具）
 *
 * 本仓所有前端验证都是 jsdom 契约（断言 DOM 结构）与 stub 冒烟（断言元素计数）。
 * 两者都能证明「节点存在」，但**都不能回答「它看起来怎么样」**：字号是否挤成一团、
 * 泳道表头有没有压住卡片、暗色下描边是否消失。此前每次美学调整只能靠用户真机
 * 反馈，迭代一次要等一个人。
 *
 * 本脚本把 `dist/client.js`（**真正发布的那份 bundle**）挂到真实 React 上，
 * 用 `react-dom/server` 渲染成 HTML，输出单文件预览。于是「渲染 → 截图 → 看图 →
 * 改样式」变成 agent 自己能闭环的动作，而不是等一次人工验收。
 *
 * ## 为什么走 bundle 而不是直接 import TS 源码
 *
 * 源码里的 `locale/*.json` 用普通 `import`（TS/打包器接受），Node 原生 ESM 要求
 * `with { type: 'json' }` 才能加载——直接 import 会在 JSON 导入处报
 * `ERR_IMPORT_ATTRIBUTE_MISSING`。走 bundle 还顺带验证了「发布产物本身能渲染」，
 * 比源码预览更接近用户看到的东西。
 *
 * ## 两条诚实边界（写在这里避免误读）
 *
 * 1. **不跑 effect**：轮询、主题探测、折叠记忆都不生效——预览是「首屏 + 嵌入快照」
 *    形态，不是真实宿主里的热数据形态；
 * 2. **不是交互验证**：点击/键盘/追溯由 jsdom 契约钉死，不在此脚本覆盖范围。
 *
 * 用法：`node scripts/panel-preview.mjs [--out .preview/panel.html] [--theme dark|light]`
 * 前置：先 `pnpm run build`（脚本会检查 dist/client.js 的 mtime 并提示）。
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const out = resolve(ROOT, argOf('out', '.preview/panel.html'));
const theme = argOf('theme', 'light') === 'dark' ? 'dark' : 'light';
const bundlePath = resolve(ROOT, 'dist/client.js');
const bundleSrc = resolve(ROOT, 'src/client/index.ts');

// 前置检查：bundle 必须存在，且不应该比源码旧太多（旧 bundle 的预览会骗人）。
const st = statSync(bundlePath);
if (statSync(bundleSrc).mtimeMs > st.mtimeMs) {
  console.warn('[panel-preview] ⚠ dist/client.js 比 src/client/index.ts 旧——先 pnpm run build 再截图。');
}

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { tokenCssBlock } = await import(pathToFileURL(resolve(ROOT, 'src/shared/tokens.ts')).href);

const bundle = readFileSync(bundlePath, 'utf8');

/** 最小宿主桩：模块加载器 + localStorage + 只读 DOM 面（SSR 期间只有解析类调用）。 */
function makeSandbox() {
  let factory = null;
  const registered = [];
  const storage = new Map();
  const windowStub = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: (k) => { storage.delete(k); },
    },
    __ModuleLoader__: { load: (spec) => { factory = spec.factory; } },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  };
  const documentStub = {
    documentElement: { getAttribute: () => null, setAttribute: () => {}, style: {} },
    body: { getAttribute: () => null, setAttribute: () => {} },
    head: { appendChild: () => {} },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    addEventListener: () => {},
  };
  return { windowStub, documentStub, getFactory: () => factory, registered };
}

const { windowStub, documentStub, getFactory, registered } = makeSandbox();
const prevWindow = globalThis.window;
const prevDocument = globalThis.document;
globalThis.window = windowStub;
globalThis.document = documentStub;
try {
  // 执行 bundle：它注册 window.__ModuleLoader__，我们的桩把 factory 抓出来。
  // 用 Function 而不是 eval：bundle 是 IIFE 形态，作用域污染要隔离在本函数内。
  new Function('window', 'document', 'globalThis', 'require', bundle)(
    windowStub, documentStub, globalThis, (name) => (name === 'react' ? React : require(name)),
  );
  const factory = getFactory();
  if (typeof factory !== 'function') {
    console.error('[panel-preview] bundle 未调用 __ModuleLoader__.load（产物形态变化？）');
    process.exit(1);
  }
  const mod = factory((name) => (name === 'react' ? React : require(name)));
  const ctx = {
    // 与 offline-smoke 同契约：register(def, render) 两参，render 才是渲染入口。
    slots: {
      // 与 offline-smoke 同契约：inject(slot, cb) 必须**调用回调**（注册发生在里面）；
      // 不调用回调 ⇒ 零注册 ⇒ 面板根本不渲染（本脚本首轮就栽在这）。
      inject: (_slot, cb) => { cb(); return () => {}; },
      register: (def, render) => { registered.push({ def, render }); return () => {}; },
    },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => { try { fn(); } catch { /* 副作用面在 SSR 下不参与视觉验收 */ } },
  };
  mod.apply(ctx);
  if (registered.length === 0) {
    console.error('[panel-preview] 未注册任何视图（flag-off 或注入契约变化）');
    process.exit(1);
  }
  const entry = registered[0];
  const body = renderToStaticMarkup(entry.render());
  if (typeof body !== 'string' || body.length < 200) {
    console.error(`[panel-preview] 渲染产物过短（${typeof body === 'string' ? body.length : 'n/a'} 字符）——拒绝写出空预览`);
    process.exit(1);
  }
  const css = tokenCssBlock();
  const html = `<!doctype html>
<html lang="zh-CN" data-anic-theme="${theme}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ANIC 面板预览 · ${theme}</title>
<style>
/* 设计令牌：与宿主注入的是同一份 tokenCssBlock 输出（单一事实源） */
${css}
html, body { margin: 0; padding: 0; }
body {
  background: ${theme === 'dark' ? '#0b0d10' : '#f6f7f9'};
  color: var(--anic-text, #1f2328);
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  padding: 12px;
}
/* 模拟宿主会话右栏宽度；640 是桌面端实测的常见内容宽 */
.preview-shell { max-width: 640px; margin: 0 auto; }
.preview-note { font-size: 11px; color: #8a8f98; margin: 0 0 10px; }
details { display: block; }
</style>
</head>
<body data-anic-workflow="root">
<div class="preview-shell">
<p class="preview-note">静态首屏预览（无 effect / 无轮询；数据 = 构建期嵌入快照）· theme=${theme} · bundle=${st.size} bytes</p>
${body}
</div>
</body>
</html>
`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, 'utf8');
  console.log(`[panel-preview] 已写出 ${out}（${html.length} 字符，theme=${theme}）`);
  console.log(`[panel-preview] 截图：chrome-devtools navigate_page → file:///${out.replace(/\\/g, '/')}`);
} catch (e) {
  console.error('[panel-preview] 渲染失败：', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
} finally {
  globalThis.window = prevWindow;
  globalThis.document = prevDocument;
}
