#!/usr/bin/env node
/**
 * 能力索引生成器（cycle-73 T-7301）——从**真实注册面**投影两份产物。
 *
 * 为什么走注册而不是正则扫源码：索引要记 `parameters` 的 canonical 哈希做失效判定，
 * 而 `parameters` 是嵌套 JSON Schema——正则提取不可靠（trigger-eval 的 faces 只取
 * name+description 是有意为之）。此处直接调 `registerAnicTools` 并以 stub ctx 捕获
 * **宿主真正会收到的**定义，投影的是注册真相而不是源码文本。
 *
 * 产物（均写入 assets/index/，可重建、勿手改）：
 *   capability-index.json   注入面（进上下文，≤2 KB）
 *   capability-hashes.json  校验面（不进上下文）
 *
 * 用法：node scripts/generate-capability-index.mjs [--check]
 *   --check：只比对，不写盘；不一致则 exit 1（供 CI / 契约守卫调用）。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCapabilityIndex, indexContentDrift } from '../src/host/capabilityIndex.ts';
import { captureRegisteredFaces } from '../src/host/toolsFaceCapture.ts';
import { listSkillScripts } from '../src/host/skillInvoker.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(here, '..');
const OUT_DIR = join(PLUGIN_ROOT, 'assets', 'index');

// 注册面捕获走**共享实现**（src/host/toolsFaceCapture.ts）——生成器 / 契约测试 / P7 探针三方同源。
/** 取 HEAD commit 短号（stale 判定用；git 不可用则记 'unknown'）。 */
function headCommit() {
  try {
    return String(execSync('git rev-parse --short HEAD', { cwd: PLUGIN_ROOT, windowsHide: true })).trim();
  } catch {
    return 'unknown';
  }
}

const check = process.argv.includes('--check');
const faces = captureRegisteredFaces();
const scripts = listSkillScripts();
const build = buildCapabilityIndex(faces, scripts, headCommit());

const indexPath = join(OUT_DIR, 'capability-index.json');
const hashesPath = join(OUT_DIR, 'capability-hashes.json');
const idxJson = JSON.stringify(build.injectable, null, 2) + String.fromCharCode(10);
const hashJson = JSON.stringify(build.hashes, null, 2) + String.fromCharCode(10);

console.log('[capability-index] tools=' + String(faces.length) + ' scripts=' + String(scripts.length));
console.log('[capability-index] injected bytes=' + String(build.injectedBytes));

if (check) {
  // 判定口径（cycle-73 实测更正）：比较**内容**（id 集 / schema 哈希 / 脚本清单），
  // **不**比较 commit —— commit 是出处标注；让它参与判定会使索引每次提交都假性失效
  //（实证：仅新增一个测试文件的提交即触发 STALE，而工具注册面一字未动）。
  let diskInjectable = null;
  let diskHashes = null;
  try { diskInjectable = JSON.parse(readFileSync(indexPath, 'utf8')); } catch (e) { diskInjectable = null; }
  try { diskHashes = JSON.parse(readFileSync(hashesPath, 'utf8')).hashes ?? null; } catch (e) { diskHashes = null; }
  const drift = indexContentDrift(diskInjectable, diskHashes, faces, scripts);
  if (drift.length > 0) {
    for (const d of drift) console.error('[capability-index] DRIFT ' + d);
    console.error('[capability-index] 索引与注册面内容不一致——跑 node scripts/generate-capability-index.mjs 重建');
    process.exit(1);
  }
  console.log('[capability-index] OK（内容一致；commit 仅作出处标注，不参与判定）');
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(indexPath, idxJson, 'utf8');
writeFileSync(hashesPath, hashJson, 'utf8');
console.log('[capability-index] wrote ' + indexPath);
console.log('[capability-index] wrote ' + hashesPath);
