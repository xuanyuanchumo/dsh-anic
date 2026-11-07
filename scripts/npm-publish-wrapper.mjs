/**
 * npm 发布包装（cycle-104 先例 · cycle-111 复用）——让 npm 进程 cwd 落在项目目录。
 *
 * vault_run 默认 cwd 是 desktop profile，直接跑 npm publish 会读错 package.json
 * （报 `Cannot read properties of null (reading 'prerelease')`，见
 * docs/agents/CI-CD与发布流程.md 实测坑位 1）。本脚本 execFileSync 指定 cwd 后
 * 交给 npm publish；NPM_TOKEN 由 vault_run 注入子进程环境变量，绝不落盘。
 */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = ['publish', '--access', 'public', '--userconfig', join(root, '.npmrc-publish'), ...process.argv.slice(2)];
console.log(`[npm-publish] cwd=${root}\n[npm-publish] npm ${args.join(' ')}`);
// Windows: .cmd 需要 shell:true（Node 24 EINVAL 修复——spawnSync 对 .cmd 直 spawn 拒绝）。
const r = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(r === null ? 0 : 0);
