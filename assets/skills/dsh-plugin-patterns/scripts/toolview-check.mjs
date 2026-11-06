#!/usr/bin/env node
/**
 * toolview 契约检查（dsh-plugin-patterns P04 守卫脚本）。
 *
 * 机械验证三件事（都失败级，exit 1）：
 *   1. client 半部存在 tool.call.toolview 注册（ToolViewIntegration）；
 *   2. 注册的 key 集合 == 共享清单 ANIC_TOOL_IDS（双向比对，单一真相源投影）；
 *   3. dist/client.js 含 toolview CSS 类（构建面真带了卡片样式）。
 *
 * 用法：node assets/skills/dsh-plugin-patterns/scripts/toolview-check.mjs [plugin-dir]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..', '..', '..', '..', process.argv[2] ?? '.');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// 1. 共享清单（真相源）
const sharedPath = join(pluginDir, 'src', 'shared', 'anicToolIds.ts');
if (!existsSync(sharedPath)) {
  console.error(`[toolview-check] 共享清单不存在: ${sharedPath}`);
  process.exit(1);
}
const sharedSrc = readFileSync(sharedPath, 'utf8');
const truthIds = [...sharedSrc.matchAll(/'(anic_[a-z0-9_]+)'/g)].map((m) => m[1]);
check('共享清单 anic_* id 数 >= 1', truthIds.length >= 1, `got ${truthIds.length}`);

// 2. client 集成存在且引用 tool.call.toolview + shared 清单
const integPath = join(pluginDir, 'src', 'client', 'integrations', 'ToolViewIntegration.ts');
check('ToolViewIntegration.ts 存在', existsSync(integPath));
if (existsSync(integPath)) {
  const src = readFileSync(integPath, 'utf8');
  check('集成引用 tool.call.toolview 席位', src.includes("'tool.call.toolview'"));
  check('集成从共享清单取工具名', src.includes('ANIC_TOOL_IDS'));
  check('集成有幂等守卫（entries 反查）', /entries\s*\?\.\s*\(/.test(src));
  check('集成有 disposer 回滚（逆序释放路径）', src.includes('disposers'));
}

// 3. dist 构建面（若存在）真带了卡片样式
const distPath = join(pluginDir, 'dist', 'client.js');
if (existsSync(distPath)) {
  const dist = readFileSync(distPath, 'utf8');
  check('dist/client.js 含 anic-toolview-card 样式类', dist.includes('anic-toolview-card'));
  check('dist/client.js 含 tool.call.toolview 注册字符串', dist.includes('tool.call.toolview'));
} else {
  console.log('SKIP  dist/client.js 不存在（未构建）——只查源码面');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
