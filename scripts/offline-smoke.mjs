#!/usr/bin/env node
/**
 * M0-① offline mechanism smoke test（真实宿主验证前的机制级验证，dsh-anic 正式切片版）。
 *
 * 用 stub 复现 DSH web 的加载契约：window.__ModuleLoader__.load({id, factory})，
 * factory(require) 中 require 只需解析 react（stub createElement 记录元素树 +
 * 最小 hooks 桩 —— 面板已升级为取数组件，stub 不触发 useEffect）；
 * ctx.slots 用记录器实现 register/inject 语义（register 返回 disposer）。
 *
 * 断言（21）：
 *   1. exports 形状（name='dsh-anic-client'/inject=['slots']/apply）
 *   2. factory require 解析 react
 *   3. 默认 → register 恰一次，def {conversation.view / anic-workflow-tab / order 101 / label 'ANIC'}
 *   4. render() 元素树含 数据驱动圆点/边线计数（快照一致）—— **函数组件必须展开**（首轮 13/15 的
 *      2 个 FAIL 即树遍历没展开函数组件，circle/line 计 0）
 *   5. telemetry nodes/edges/autonomy 与快照一致
 *   6. FAIL 结果节点带红圈标记（数量 = 快照中 result==='FAIL' 的节点数，数据驱动）
 *   7. unregister() → disposer 调用、registered=false；reregister() → 第二次注册
 *   8. flag-off（localStorage 'anic-workflow-tab'='off'）→ skipped，零注册
 *   9. 工具栏含 data-anic-refresh 刷新按钮 + svg 根（热更新 UI 面存在）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '..');
const bundle = readFileSync(join(pluginDir, 'dist', 'client.js'), 'utf8');
const snapshot = JSON.parse(readFileSync(join(pluginDir, 'artifacts', 'workflow-snapshot.json'), 'utf8'));

/** 在受控全局环境里执行 bundle，抓取 factory 与 exports */
function loadBundle({ storageValue = null } = {}) {
  const requires = [];
  let factory = null;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    // 面板取数组件的最小 hooks 桩：useState 返回初值（stub 不触发 useEffect → 无 fetch）
    useState: (v) => [v, () => {}],
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    // cycle-42（Top2 store 化）新增三个 API 的桩：
    //   memo —— 直通（返回原函数）：countType/hasProp 的「函数组件展开」逻辑
    //           只认 typeof type === 'function'，直通让 memo 包装的分区组件
    //           在 stub 树里仍可被遍历器调用展开（真实 React 中 memo 是对象）。
    //   useSyncExternalStore —— 立即返回 getSnapshot()：外部 store 订阅在
    //           无渲染循环的 stub 里退化为一次性读值（不 subscribe，正好）。
    //   useDeferredValue —— 直通（返回原值）：无并发渲染，无陈旧态。
    memo: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useDeferredValue: (v) => v,
  };
  const sandboxWindow = {
    localStorage: { getItem: () => storageValue },
    __ModuleLoader__: { load: (spec) => { factory = spec.factory; } },
  };
  const sandboxGlobalThis = globalThis;
  const prevWindow = sandboxGlobalThis.window;
  sandboxGlobalThis.window = sandboxWindow;
  try {
    // bundle 是经典脚本：用 Function 在 stub 全局下执行（bundle 读 window.__ModuleLoader__）
    new Function('window', 'require', bundle)(sandboxWindow, (name) => { requires.push(name); return React; });
  } finally {
    sandboxGlobalThis.window = prevWindow;
  }
  const factoryExports = factory((name) => { requires.push(name); return React; });
  return { exports: factoryExports, requires, window: sandboxWindow };
}

/** 元素树遍历（函数组件展开 + 数组层展开 —— stub createElement 把数组参数记成
 *  children: [[...]]，嵌套数组不展开则 circle/line 永远计 0） */
function countType(node, type, acc = { n: 0 }, depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return acc;
  if (depth > 20) return acc; // 防御环
  if (Array.isArray(node)) {
    for (const item of node) countType(item, type, acc, depth + 1);
    return acc;
  }
  if (typeof node.type === 'function') {
    // 函数组件：调用其 render 再遍历（props 透传）
    return countType(node.type(node.props ?? {}), type, acc, depth + 1);
  }
  if (node.type === type) acc.n += 1;
  const children = node.children ?? [];
  for (const c of Array.isArray(children) ? children : [children]) countType(c, type, acc, depth + 1);
  return acc;
}

/** props 感知遍历：树中是否存在带指定 data-* 属性的元素（热更新 UI 面检查用） */
function hasProp(node, key, value, depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object' || depth > 20) return false;
  if (Array.isArray(node)) {
    return node.some((item) => hasProp(item, key, value, depth + 1));
  }
  if (typeof node.type === 'function') {
    return hasProp(node.type(node.props ?? {}), key, value, depth + 1);
  }
  if (node.props && node.props[key] === value) return true;
  const children = node.children ?? [];
  const list = Array.isArray(children) ? children : [children];
  return list.some((c) => hasProp(c, key, value, depth + 1));
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ── 场景 1：默认（无 kill-switch）──
const run1 = loadBundle();
const ex = run1.exports;
check('exports.name === dsh-anic-client', ex?.name === 'dsh-anic-client', String(ex?.name));
check('exports.inject === [slots, locale]（cycle-99：宿主语言联动，locale 为官方包服务）',
  Array.isArray(ex?.inject) && ex.inject.length === 2 && ex.inject[0] === 'slots' && ex.inject[1] === 'locale');
check('factory require 解析 react', run1.requires.includes('react'), JSON.stringify(run1.requires));
check('exports.apply 是函数', typeof ex?.apply === 'function');

const registrations = [];
const disposerCalls = { n: 0 };
const ctx = {
  slots: {
    inject(_slot, cb) { cb(); return () => { disposerCalls.n += 1; }; },
    register(def, render) { registrations.push({ def, render }); return () => { disposerCalls.n += 1; }; },
  },
};
ex.apply(ctx);
const t = run1.window.__ANIC_TAB_SPIKE__;
check('telemetry 暴露且数据面与快照一致', !!t
  && t.nodes === snapshot.counts.nodes
  && t.edges === snapshot.counts.edges
  && t.autonomy === snapshot.autonomy,
t ? `nodes=${t.nodes} edges=${t.edges} autonomy=${t.autonomy}` : 'missing');
check('register 恰一次（inject 回调后）', registrations.length === 1, `got ${registrations.length}`);
const def = registrations[0]?.def;
check('def.name === conversation.view', def?.name === 'conversation.view');
check('def.id === anic-workflow-tab', def?.id === 'anic-workflow-tab', String(def?.id));
check('def.order === 101', def?.order === 101);
check("label() === 'ANIC'", typeof def?.label === 'function' && def.label() === 'ANIC');
check('registered === true', t.registered === true);

const tree = registrations[0].render();
const circles = countType(tree, 'circle').n;
/**
 * 边计数改为「**锚点计数**」而非「`<line>` 标签计数」（cycle-83）。
 *
 * 旧断言 `countType(tree,'line').n === edges` 只在"所有边都是直线"时成立。
 * cycle-83 的视觉升级要给边分语义（时序实线 / 证据虚线 / 事件点线 / 跨 lane 贝塞尔），
 * 直线会变成 `<path d="M.. C..">` ⇒ 按 `line` 标签数会立刻少算，而**渲染是完全正确的**。
 * 那是判据与实现形态耦合的典型假红（本仓 cycle-82 已在 `panelDataLegContract` 上修过同族问题）。
 *
 * 新判据只看**属性**：每个边元素必须带 `data-anic-edge`。它比数标签更强——
 * 不但不关心你画的是 line 还是 path，还能抓出"渲染了边但忘了打锚点"这种真缺陷。
 */
const edgeAnchors = (() => {
  let n = 0;
  (function walk(node, depth = 0) {
    if (node === null || node === undefined || typeof node !== 'object' || depth > 20) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (typeof node.type === 'function') return walk(node.type(node.props ?? {}), depth + 1);
    if (node.props && node.props['data-anic-edge'] !== undefined) n += 1;
    const children = node.children ?? [];
    for (const c of Array.isArray(children) ? children : [children]) walk(c, depth + 1);
  })(tree);
  return n;
})();
check(`SVG 圆点 ${snapshot.counts.nodes}（76-cycle 量级）`, circles === snapshot.counts.nodes, `got ${circles}`);
check(`SVG 边（锚点数）${snapshot.counts.edges}`, edgeAnchors === snapshot.counts.edges, `got ${edgeAnchors}`);

const expectedFailed = snapshot.nodes.filter((n) => n.result === 'FAIL').length;
const redRings = countType(tree, 'circle', { n: 0 });
// 红圈 = strokeWidth 2 的 circle；数据驱动断言（账本无 FAIL 时为 0）
const redCount = (() => {
  let n = 0;
  (function walk(node, depth = 0) {
    if (node === null || node === undefined || typeof node !== 'object' || depth > 20) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (typeof node.type === 'function') return walk(node.type(node.props ?? {}), depth + 1);
    if (node.type === 'circle' && node.props?.strokeWidth === 2) n += 1;
    const children = node.children ?? [];
    for (const c of Array.isArray(children) ? children : [children]) walk(c, depth + 1);
  })(tree);
  return n;
})();
check('FAIL 节点红圈标记（数据驱动）', redCount === expectedFailed, `red=${redCount} expected=${expectedFailed} (circles=${redRings.n})`);

// M1 工具栏演进：原断言是 `buttons === 1`（M0 单按钮形态）。M1 全功能面把工具栏
// 扩到三个动作（刷新 / 偏好抽屉 / 自举），所以`总按钮数===1`是**过期契约**，
// 但它原本想守的东西必须保留并加强：
//   ① 刷新按钮存在且**唯一**（两个刷新按钮 = 重复注册或渲染路径跑了两遍）；
//   ② 三个 M1 动作各自存在（少一个 = 功能面静默缺失，这与`总数===1`是两回事）。
const buttons = countType(tree, 'button').n;
const svgs = countType(tree, 'svg').n;
/**
 * 面板工具栏**后代**按钮计数（cycle-82 取代全树 `buttons === 3`）。
 *
 * 为什么改：`buttons === 3` 是 M1 时代的**全树**计数——它默认"整个面板只有工具栏
 * 有按钮"。cycle-82 给图区加了三个真 `<button>`（放大/缩小/适配视图），这条立刻
 * 变红，但它想守的东西（M1 三动作存在 + 刷新唯一）**一字没少**，红的是"全树不得
 * 有其它按钮"这条从未被声明过的附带假设。
 *
 * 改成「`data-anic-toolbar` 子树内的按钮数 == 3」：范围收敛到工具栏这个语义单元，
 * 原意保留且更强（工具栏里多一个按钮也会红，全树计数反而管不到分区里乱塞的按钮）。
 * 仍保留 `prefsButtons===1 && selfInitButtons===1` 两条全树唯一性断言。
 */
const toolbarButtons = (() => {
  let n = 0;
  (function walk(node, inToolbar, depth = 0) {
    if (node === null || node === undefined || typeof node !== 'object' || depth > 20) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, inToolbar, depth + 1); return; }
    if (typeof node.type === 'function') return walk(node.type(node.props ?? {}), inToolbar, depth + 1);
    const here = inToolbar || node.props?.['data-anic-toolbar'] === 'true';
    if (here && node.type === 'button') n += 1;
    const children = node.children ?? [];
    for (const c of Array.isArray(children) ? children : [children]) walk(c, here, depth + 1);
  })(tree, false);
  return n;
})();
const countProp = (prop, value) => {
  let n = 0;
  (function walk(node, depth = 0) {
    if (node === null || node === undefined || typeof node !== 'object' || depth > 20) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (typeof node.type === 'function') return walk(node.type(node.props ?? {}), depth + 1);
    if (node.type === 'button' && node.props?.[prop] === value) n += 1;
    const children = node.children ?? [];
    for (const c of Array.isArray(children) ? children : [children]) walk(c, depth + 1);
  })(tree);
  return n;
};
const refreshButtons = countProp('data-anic-refresh', 'true');
const prefsButtons = countProp('data-anic-prefs-toggle', 'true');
const selfInitButtons = countProp('data-anic-self-init', 'true');
check('刷新按钮存在且唯一（重复注册/双渲染路径会翻倍）', refreshButtons === 1 && hasProp(tree, 'data-anic-refresh', 'true'), `refresh=${refreshButtons}`);
check('M1 工具栏三动作齐备（刷新/偏好/自举）', prefsButtons === 1 && selfInitButtons === 1 && toolbarButtons === 3, `toolbarButtons=${toolbarButtons} allButtons=${buttons} prefs=${prefsButtons} selfInit=${selfInitButtons}`);
check('svg 根存在（renderGraph 纯渲染路径）', svgs === 1, `svgs=${svgs}`);

t.unregister();
check('unregister 调用 disposer 且 registered=false', t.unregisterCount === 1 && t.registered === false && disposerCalls.n >= 1);
t.reregister();
check('reregister 第二次注册（dispose 后可重进）', registrations.length === 2 && t.registered === true);

// ── 场景 2：kill-switch ──
const run2 = loadBundle({ storageValue: 'off' });
const reg2 = [];
run2.exports.apply({ slots: { inject: (_s, cb) => { cb(); return () => {}; }, register: (d) => { reg2.push(d); return () => {}; } } });
check('flag-off → skipped 且零注册', run2.window.__ANIC_TAB_SPIKE__.skipped === 'flag-off' && reg2.length === 0);

// ── 汇总 ──
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
