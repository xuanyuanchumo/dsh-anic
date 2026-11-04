#!/usr/bin/env node
/**
 * dsh-anic J0 真实宿主探针 —— 对正在运行的 DSH Web 测试环境（start-dsh-test.mjs 启动）
 * 经 Chrome DevTools 协议（9222）验证 conversation.view 集成的六项判据：
 *
 *   J0-1  ANIC 标签可见且可点击（与既有标签共存）
 *   J0-2  图渲染：真实 .cycles 数据面（节点/边数量 ≥ 阈值，且与遥测一致）
 *   J0-3  遥测通道：window.__ANIC_TAB_SPIKE__.registered=true, nodes/edges>0
 *   J0-4  数据来源如实标注（live 或 嵌入快照，二者必居其一）
 *   J0-5  运行时热卸载：unregister() → 标签消失 → reregister() → 恢复
 *   J0-6  kill-switch：localStorage['anic-workflow-tab']='off' + reload → skipped='flag-off'
 *
 * 前置：node scripts/start-dsh-test.mjs start   （本探针绝不启动/杀死宿主进程）
 * 用法：node scripts/j0-probe.mjs [--keep-switch]   （--keep-switch 不恢复 kill-switch）
 *
 * 自愈与兜底（cycle-99 实测教训）：
 *   - 残留 kill-switch 自愈：上轮探针若在 J0-6 中途被杀，localStorage 残留 'off'
 *     会让标签永不挂载——启动时先摘掉陈旧开关再测。
 *   - 无会话视图兜底：全新 profile 落在空态，conversation view 不挂载就没有标签条
 *     ——自动代开侧栏第一个既有会话（不依赖宿主构建哈希类名，走 role=treeitem 结构）。
 */
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 自洽化（cycle-43）：测试宿主工作区默认=本仓库自身（数据面与本仓 .cycles 绑定，
// 与验证场地零默认绑定）。@playwright/test 仍借用工具链（本仓库不引入 playwright
// 依赖，TD-A1 式过渡态）——解析顺序：本仓库 node_modules → DSH_ANIC_TEST_WORKSPACE。
// （旧顺序含同级 dsh-codegraph-visualizer 工具链兜底，自洽化后移除默认场地引用。）
const TOOLCHAIN_ROOTS = [
  PLUGIN_ROOT,
  ...(process.env.DSH_ANIC_TEST_WORKSPACE ? [resolve(process.env.DSH_ANIC_TEST_WORKSPACE)] : []),
];
const CDP_URL = 'http://127.0.0.1:9222';
const keepSwitch = process.argv.includes('--keep-switch');

let requireFromRepo = null;
let chromium = null;
let loadErr = null;
for (const root of TOOLCHAIN_ROOTS) {
  try {
    const req = createRequire(join(root, 'package.json'));
    ({ chromium } = req('@playwright/test'));
    requireFromRepo = req;
    break;
  } catch (e) {
    loadErr = e;
  }
}
if (!chromium) {
  console.error(`[j0-probe] 无法加载 @playwright/test（尝试过 ${TOOLCHAIN_ROOTS.join(' → ')}）: ${loadErr?.message ?? ''}`);
  process.exit(2);
}

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? '  [PASS]' : '[FAIL]'} ${id}  ${detail}`);
}

function failFast(msg) {
  console.error(`[j0-probe] ${msg}`);
  console.error('前置条件：先运行 node scripts/start-dsh-test.mjs start（本探针不自行启动宿主）');
  process.exit(2);
}

const browser = await chromium.connectOverCDP(CDP_URL).catch((e) => failFast(`无法连接 CDP ${CDP_URL}: ${e.message}`));
const contexts = browser.contexts();
if (contexts.length === 0) failFast('CDP 已连接但没有任何浏览器上下文');
const page = contexts[0].pages().find((p) => /127\.0\.0\.1:3080|localhost:3080/.test(p.url())) ?? contexts[0].pages()[0];
if (!page) failFast('未找到可用的页面');
console.log(`[j0-probe] 目标页面: ${page.url().slice(0, 80)}...`);

// 每条判据独立 try，避免一条崩溃吞掉整份报告
await page.bringToFront().catch(() => {});

// ── 防御 1：残留 kill-switch 自愈 ─────────────────────────────────────────────
// 场景（实测）：上一轮探针在 J0-6「写入开关 → reload」之后、恢复之前被中途终止
// （例如输出管道被 Select-Object -First N 截断杀进程），localStorage 里残留
// 'anic-workflow-tab' = 'off'。此时 ANIC 标签永不挂载，J0-1/1b/2/4 全部假失败，
// 且从 FAIL 文本完全看不出是开关问题——必须先摘掉陈旧开关再测。
// （--keep-switch 模式下不摘：那是故意保留开关观察行为的模式。）
if (!keepSwitch) {
  const stale = await page.evaluate(() => window.localStorage.getItem('anic-workflow-tab'));
  if (stale === 'off') {
    await page.evaluate(() => window.localStorage.removeItem('anic-workflow-tab'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    console.log('  [清理] 检测到残留 kill-switch（上次探针可能被中途终止）——已移除并刷新');
  }
}

// ── 防御 2：无会话视图时代开既有会话 ──────────────────────────────────────────
// 场景（实测）：全新浏览器 profile 落在「新会话」空态——conversation view 不挂载，
// 标签条（对话/轨迹/代码图谱/ANIC）根本不存在，J0-1 计数为 0 且与插件无关。
// 侧栏是 role=tree 树：带 aria-expanded 的 treeitem 是工作区/分组行（点它展开），
// 不带 aria-expanded 的 treeitem 是会话行（点它打开会话视图）。「新会话」占位行
// 打开的是空输入态（不挂标签条），必须排除、点真实会话行。
if ((await page.locator('[role="tab"]').count()) === 0) {
  const opened = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findSess = () => [...document.querySelectorAll('[role="treeitem"]')]
      .filter((n) => !n.hasAttribute('aria-expanded') && (n.textContent || '').trim() && !(n.textContent || '').includes('新会话'))
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    let sess = findSess();
    if (!sess) {
      for (const proj of [...document.querySelectorAll('[role="treeitem"][aria-expanded="false"]')]) {
        proj.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await sleep(600);
        sess = findSess();
        if (sess) break;
      }
    }
    if (!sess) return null;
    sess.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(1200);
    return (sess.textContent || '').trim().slice(0, 30);
  });
  if (opened) {
    await page.waitForSelector('[role="tab"]', { timeout: 8000 }).catch(() => {});
    console.log(`  [兜底] 无打开会话——已代开既有会话「${opened}」以挂载会话视图`);
  } else {
    console.log('  [警告] 侧栏没有可打开的既有会话——标签判据可能因无会话视图而失败');
  }
}

// J0-1 ANIC 标签可见
let anicTab = null;
try {
  anicTab = page.getByRole('tab', { name: 'ANIC', exact: true }).or(page.locator('[role="tab"]:has-text("ANIC")')).first();
  await anicTab.waitFor({ state: 'visible', timeout: 10000 });
  record('J0-1 标签可见', true, 'role=tab "ANIC" 可见');
} catch (e) {
  record('J0-1 标签可见', false, `未找到 ANIC 标签: ${String(e).slice(0, 160)}`);
}

// J0-1b 共存：除 ANIC 外还有其他顶层标签
try {
  const tabCount = await page.locator('[role="tab"]').count();
  record('J0-1b 标签共存', tabCount >= 2, `顶层标签数=${tabCount}（≥2 才算共存）`);
} catch (e) {
  record('J0-1b 标签共存', false, String(e).slice(0, 120));
}

// 点击进入 ANIC 面板
if (anicTab) await anicTab.click({ timeout: 5000 }).catch(() => {});

// J0-2 图渲染 + J0-3 遥测（同一 evaluate 拿齐，减少竞态）
// cycle-96 修正：宿主图标 svg（本轮实测 71 个）排在文档序前面，
// document.querySelector('svg') 会命中宿主图标而非 ANIC 图——必须以
// [data-anic-workflow] 为作用域取面板内 svg。面板 svg 在点击标签后才挂载，
// 所以点击后先等它出现再读数（waitFor 代替拍脑袋 sleep，天然覆盖懒加载验证）。
try {
  await page.waitForSelector('[data-anic-workflow] svg', { timeout: 8000 }).catch(() => {});
  const probe = await page.evaluate(() => {
    const t = window.__ANIC_TAB_SPIKE__ ?? null;
    const wf = document.querySelector('[data-anic-workflow]');
    const svg = wf ? wf.querySelector('svg') : null;
    const circles = svg ? svg.querySelectorAll('circle').length : 0;
    // cycle-104 判据升级：边自 cycle-83 起渲染为贝塞尔 <path data-anic-edge>（跨列
    // 曲线支持），<line> 只剩同列直边的少数形态——旧断言数 <line> 在 79 边的图上
    // 只读到 7 条直边而假红（J0 真机实录）。判据改为**锚点数**（与
    // offline-smoke / graphInteractiveContract 同源纪律：任何边形态都必须带锚点）。
    const edges = svg ? svg.querySelectorAll('[data-anic-edge]').length : 0;
    return { t, circles, edges, hasSvg: !!svg };
  });
  const t = probe.t;
  record('J0-3 遥测通道', !!t && t.registered === true, t ? `registered=${t.registered} registerCount=${t.registerCount}` : 'window.__ANIC_TAB_SPIKE__ 不存在');
  // cycle-10 强不变量：渲染 = 遥测（面板 live 到达后同步 spike.nodes/edges——
  // 旧断言只查 circles>=100，在会话工作区 .cycles 较小时假红、在遥测陈旧时假绿
  // （cycle-9 实录 175 圆 vs 169 遥测即后者）。现在要求逐数相等：画的就是报的。
  record('J0-2 图渲染', probe.hasSvg && probe.circles >= 20 && probe.edges >= 20 && !!t && t.nodes > 0
    && probe.circles === t.nodes && probe.edges === t.edges,
    `svg=${probe.hasSvg} circles=${probe.circles} edges=${probe.edges} 遥测 nodes=${t?.nodes} edges=${t?.edges}`);
} catch (e) {
  record('J0-2 图渲染', false, String(e).slice(0, 160));
  record('J0-3 遥测通道', false, String(e).slice(0, 160));
}

// J0-4 数据来源如实标注（live 或嵌入快照，不得伪装）
// cycle-96 修正：宿主自身也有含 "snapshot" 字样的叶节点（会话/插件 UI），
// 全文档扫描会命中宿主文本——同样是作用域问题，收窄到 [data-anic-workflow]。
try {
  const source = await page.evaluate(() => {
    const wf = document.querySelector('[data-anic-workflow]');
    const el = [...(wf?.querySelectorAll('*') ?? [])].find((n) => n.children.length === 0 && /live|嵌入快照|snapshot/i.test(n.textContent ?? ''));
    return el ? (el.textContent ?? '').trim().slice(0, 120) : null;
  });
  record('J0-4 来源如实', !!source && /live|嵌入快照|snapshot/i.test(source), source ?? '未找到来源标注行');
} catch (e) {
  record('J0-4 来源如实', false, String(e).slice(0, 160));
}

// J0-5 热卸载 → 恢复
try {
  const before = await page.evaluate(() => ({ registered: window.__ANIC_TAB_SPIKE__?.registered === true }));
  await page.evaluate(() => window.__ANIC_TAB_SPIKE__?.unregister());
  await page.waitForTimeout(300);
  const afterUn = await page.evaluate(() => ({ registered: window.__ANIC_TAB_SPIKE__?.registered === false, count: window.__ANIC_TAB_SPIKE__?.unregisterCount ?? 0 }));
  await page.evaluate(() => window.__ANIC_TAB_SPIKE__?.reregister());
  await page.waitForTimeout(300);
  const afterRe = await page.evaluate(() => ({ registered: window.__ANIC_TAB_SPIKE__?.registered === true, count: window.__ANIC_TAB_SPIKE__?.registerCount ?? 0 }));
  record('J0-5 热卸载/恢复', before.registered && afterUn.registered && afterUn.count >= 1 && afterRe.registered && afterRe.count >= 2,
    `before=${before.registered} unregistered=${afterUn.registered}(count=${afterUn.count}) reregistered=${afterRe.registered}(count=${afterRe.count})`);
} catch (e) {
  record('J0-5 热卸载/恢复', false, String(e).slice(0, 160));
}

// J0-6 kill-switch（写入 → reload → skipped='flag-off' → 恢复）
try {
  await page.evaluate(() => window.localStorage.setItem('anic-workflow-tab', 'off'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const sk = await page.evaluate(() => window.__ANIC_TAB_SPIKE__?.skipped ?? null);
  const tabGone = (await page.locator('[role="tab"]:has-text("ANIC")').count()) === 0;
  record('J0-6 kill-switch', sk === 'flag-off' || tabGone, `skipped=${JSON.stringify(sk)} anicTabGone=${tabGone}`);
  if (!keepSwitch) {
    await page.evaluate(() => window.localStorage.removeItem('anic-workflow-tab'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const restored = await page.evaluate(() => window.__ANIC_TAB_SPIKE__?.registered === true);
    record('J0-6b 开关恢复', restored, `移除开关并 reload 后 registered=${restored}`);
  } else {
    console.log('  [SKIP] J0-6b 开关恢复（--keep-switch）');
  }
} catch (e) {
  record('J0-6 kill-switch', false, String(e).slice(0, 160));
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(failed.length === 0
  ? `J0 PROBE PASSED — ${results.length} checks`
  : `J0 PROBE FAILED — ${failed.length}/${results.length}: ${failed.map((f) => f.id).join(', ')}`);
await browser.close().catch(() => {});
process.exit(failed.length === 0 ? 0 : 1);
