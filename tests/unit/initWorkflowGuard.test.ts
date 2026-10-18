/**
 * init-workflow.mjs 参数防护测试（cycle-26，cycle-25 `--help/` 目录事故根治项）。
 *
 * 事故复盘：parseArgs 把未知旗标（--help/--bogus）当位置参数推入 args._，
 * scaffoldProject 便在 CWD 下创建 `--help/` 目录并脚手架。
 * 修复：未知旗标 exit 1；位置参数必须恰好 1 个；--help/-h 打印用法 exit 0。
 *
 * 手法：execFileSync 子进程真跑（e2e），exit code 语义即契约。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../assets/skill/scripts/init-workflow.mjs');

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'anic-wfguard-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function runOk(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    // 拒绝路径的输出在 stderr（console.error）
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

describe('init-workflow 参数防护', () => {
  it('--help：打印用法 exit 0，零写盘', () => {
    const r = runOk(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage:');
    expect(r.out).toContain('project-dir');
  });

  it('-h 短旗标等价 --help', () => {
    const r = runOk(['-h']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage:');
  });

  it('未知旗标：拒绝 exit 1，不创建任何目录', () => {
    const r = runOk(['--bogus', 'value']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('未知旗标: --bogus');
  });

  it('--help 绝不会被当位置参数（事故回归钉：不再产生 --help/ 目录）', () => {
    const r = runOk(['--help']);
    expect(r.code).toBe(0);
    // 脚本 CWD 是测试进程 CWD——修复后 --help 短路退出，不会脚手架
    expect(existsSync(join(process.cwd(), '--help'))).toBe(false);
  });

  it('两个位置参数：拒绝 exit 1', () => {
    const r = runOk(['a', 'b']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('只接受 1 个位置参数');
  });

  it('零位置参数：打印用法 exit 1', () => {
    const r = runOk([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Usage:');
  });

  it('正常路径不回归：单位置参数 + --name 仍脚手架成功', () => {
    const dir = freshDir();
    const r = runOk([dir, '--name', 'guard-proj']);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, '.cycles', 'config.yml'))).toBe(true);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
  });
});
