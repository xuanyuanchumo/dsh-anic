#!/usr/bin/env node
/**
 * dsh-anic build — client bundle + host bundle.
 *
 * Client: tsdown → CJS → wrapped into window.__ModuleLoader__.load({...})
 * (the only shape DSH web executes for /plugins/<name>/client.js).
 * react / react-dom stay external — they resolve through the loader's
 * factory.require against the HOST's copies (version skew is the host's
 * business; we must not double-bundle them).
 *
 * Host: tsdown → ESM dist/host.js (exports["."]).
 *
 * 热更新模式：`node scripts/build-client.mjs --watch`
 *   tsdown --watch 持续重建 dist/client-cjs/；fs.watch 监听其输出并在每次重建后
 *   重新 wrap 到 dist/client.js —— 插件以 link: 安装时，dist/client.js 就是宿主
 *   实际加载的文件，保存源码 → 重建 → 重 wrap → 浏览器刷新即生效（bundle 级热更新）。
 *   watch 模式只管 client（host 变更极少，需要时全量 build）。
 *
 * F-09 原子化（cycle-77 T3，台账 §9）：旧实现先 `rmSync(distDir)` 再跑 tsdown——
 * 构建失败时**宿主运行目录 dist/ 已整体消失**（2026-10-23 真实事故：client.js 与
 * host.js 全部丢失 + UNRESOLVED_IMPORT）。现改为「staging 构建 → 全部成功后才原子替换」：
 * 非 watch 路径**不再删除 dist/ 整体**，失败时旧 dist 一个字节都不动；可见窗口只剩
 * 单文件 rename（原子），不存在「目录缺失」窗口。watch 模式行为保持不变（仍从干净
 * dist/ 起跑；它删的是同一个 dist，但那是长驻重建进程，不在本债务的事件形态内）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, existsSync, readdirSync, watch, renameSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');
const distDir = join(pluginDir, 'dist');
const cjsDir = join(distDir, 'client-cjs');
const watchMode = process.argv.includes('--watch');

// staging 目录：非 watch 构建的中间产物全落这里。宿主**不加载**此目录，
// 因此清理它永远安全；只有全部产出成功后才把成品 rename 进 dist/。
const STAGE = '.build-staging';
const stageDir = join(pluginDir, STAGE);
const stageCjsOut = `${STAGE}/client-cjs`;
const stageHostOut = `${STAGE}/host-esm`;

function findTsdown() {
  // tsdown lives in the parent workspace's node_modules (pnpm); walk up.
  let probe = pluginDir;
  for (let i = 0; i < 4; i++) {
    const bin = join(probe, 'node_modules', '.bin', process.platform === 'win32' ? 'tsdown.CMD' : 'tsdown');
    if (existsSync(bin)) return bin;
    probe = join(probe, '..');
  }
  return 'tsdown';
}

const CLIENT_ARGS = [
  'src/client/index.ts',
  '--format', 'cjs',
  '--outDir', 'dist/client-cjs',
  '--platform', 'browser',
  '--external', 'react',
  '--external', 'react-dom',
];

/** 跑一次 tsdown；返回是否成功（**不在内部 exit**——调用方要先决定 dist/ 命运）。 */
function run(args) {
  const r = spawnSync(findTsdown(), args, { cwd: pluginDir, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`[build-client] tsdown failed: ${args.join(' ')}`);
    return false;
  }
  return true;
}

/** 把 cjs 产物包成 window.__ModuleLoader__.load({...})；watch 模式沿用 dist 内路径。 */
function wrapOnce(fromDir = cjsDir, toFile = join(distDir, 'client.js')) {
  const files = existsSync(fromDir) ? readdirSync(fromDir) : [];
  const cjsFile = files.find((f) => f.endsWith('.cjs') || f.endsWith('.js'));
  if (!cjsFile) {
    console.error(`[build-client] no CJS output found in ${fromDir}`);
    return false;
  }
  const r = spawnSync(process.execPath, [
    join(here, 'wrap-client-bundle.mjs'),
    join(fromDir, cjsFile),
    toFile,
    'dsh-anic',
  ], { stdio: 'inherit' });
  return r.status === 0;
}

/** 构建 client 到 staging，返回成品绝对路径；失败 → null（dist/ 未动）。 */
function buildClientStaged() {
  if (!run([
    'src/client/index.ts',
    '--format', 'cjs',
    '--outDir', stageCjsOut,
    '--platform', 'browser',
    '--external', 'react',
    '--external', 'react-dom',
  ])) return null;
  const out = join(stageDir, 'client.js');
  return wrapOnce(join(stageDir, 'client-cjs'), out) ? out : null;
}

/** 构建 host 到 staging，返回 ESM 产物绝对路径；失败 → null（dist/ 未动）。 */
function buildHostStaged() {
  if (!run(['src/index.ts', '--format', 'esm', '--outDir', stageHostOut])) return null;
  const dir = join(stageDir, 'host-esm');
  const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.js')) : undefined;
  if (!file) {
    console.error('[build-client] no ESM host output found in staging host-esm');
    return null;
  }
  return join(dir, file);
}

/**
 * 原子替换：同卷 rename 覆盖目标文件（NTFS/POSIX 均为原子操作）。
 * 逐个文件替换 ⇒ 任何时刻 dist/client.js 与 dist/host.js 都存在（要么旧、要么新），
 * 不存在「目录缺失」窗口。成对替换之间有极小混合窗口（新 client + 旧 host），
 * 但两者各自都是完整可加载产物——这正是本债务要消除的事故形态。
 */
function promoteStaged(clientJs, hostJs) {
  mkdirSync(distDir, { recursive: true });
  renameSync(clientJs, join(distDir, 'client.js'));
  renameSync(hostJs, join(distDir, 'host.js'));
}

/** 非 watch 全量构建：staging 成功 → 原子替换；失败 → 丢弃 staging、dist/ 原样保留。 */
function runNonWatchBuild() {
  rmSync(stageDir, { recursive: true, force: true }); // staging 不参与宿主加载，可安全清理
  const clientJs = buildClientStaged();
  const hostJs = buildHostStaged();
  // 失败出口必须在任何 dist/ 动作之前：这里退出的代价只是「本轮产物没更新」
  if (!clientJs || !hostJs) {
    rmSync(stageDir, { recursive: true, force: true });
    console.error('[build-client] build failed — dist/ left untouched (staging discarded)');
    process.exit(1);
  }
  try {
    promoteStaged(clientJs, hostJs);
  } catch (e) {
    // rename 被占用/权限拒绝（如宿主正开着某个文件）时的诚实措辞：
    // dist/ 不会消失，但可能已替换了其中一个文件 —— 重跑 build 即可收敛。
    console.error(`[build-client] atomic replace interrupted: ${e instanceof Error ? e.message : String(e)}`);
    console.error('[build-client] dist/ still present (no delete window); re-run build to converge');
    rmSync(stageDir, { recursive: true, force: true });
    process.exit(1);
  }
  rmSync(stageDir, { recursive: true, force: true });
  // 中间产物收尾：client-cjs 只是 wrap 的输入（宿主不加载），且只在成品就位后才删
  rmSync(cjsDir, { recursive: true, force: true });
  console.log('[build-client] done: dist/client.js + dist/host.js');
}

if (watchMode) {
  rmSync(distDir, { recursive: true, force: true });
  const child = spawn(findTsdown(), [...CLIENT_ARGS, '--watch'], { cwd: pluginDir, stdio: 'inherit', shell: true });
  let timer = null;
  let watcherAttached = false;
  const attachWatcher = () => {
    if (watcherAttached || !existsSync(cjsDir)) return;
    watcherAttached = true;
    watch(cjsDir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        console.log('[build-client:watch] client-cjs changed → re-wrapping dist/client.js');
        wrapOnce();
      }, 400);
    });
    console.log('[build-client:watch] watching dist/client-cjs → dist/client.js (link: 安装下保存即热更新)');
  };
  const poll = setInterval(attachWatcher, 500);
  child.on('exit', (code) => {
    clearInterval(poll);
    clearTimeout(timer);
    process.exit(code ?? 0);
  });
} else {
  runNonWatchBuild();
}
