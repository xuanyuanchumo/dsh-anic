/**
 * cliArgsGuard.test.ts — cycle-27 统一 CLI 参数防护库（lib/args.mjs）数据驱动契约
 *
 * 测试策略：进程内 import parseCliArgs 直接断言 + 关键脚本真实子进程抽验。
 * 三防线（--help 短路 / 未知旗标拒绝 / 位置参数契约）+ 类型解析 + kebab→camel。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const LIB_ARGS = join(here, '../../assets/skill/scripts/lib/args.mjs');
const SCRIPTS = join(here, '../../assets/skill/scripts');

async function loadLib() {
  return import(LIB_ARGS);
}

function run(script: string, args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [join(SCRIPTS, `${script}.mjs`), ...args], {
      encoding: 'utf-8',
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    // 拒绝路径输出在 stderr
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

const SPEC = {
  script: 'test-probe',
  usage: 'Usage: node test-probe.mjs <project-dir> [--max-retries N] [--dry-run]',
  flags: {
    'max-retries': { type: 'int', default: 3 },
    'test-cmd': { type: 'string' },
    threshold: { type: 'float', default: 0.15 },
    verbose: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  } as Record<string, { type: string; default?: unknown }>,
  positionals: { min: 1, max: 1, name: 'project-dir' },
};

describe('lib/args.mjs parseCliArgs 契约', () => {
  it('正常路径：旗标解析 + kebab→camel + 位置参数', async () => {
    const { parseCliArgs } = await loadLib();
    const a = parseCliArgs(
      ['node', 'x', '/tmp/proj', '--max-retries', '7', '--test-cmd', 'pnpm test', '--verbose'],
      SPEC,
    );
    expect(a._).toEqual(['/tmp/proj']);
    expect(a.maxRetries).toBe(7);
    expect(a.testCmd).toBe('pnpm test');
    expect(a.verbose).toBe(true);
  });

  it('默认值：缺省旗标取 spec 默认', async () => {
    const { parseCliArgs } = await loadLib();
    const a = parseCliArgs(['node', 'x', '/tmp/p'], SPEC) as Record<string, unknown>;
    expect(a.maxRetries).toBe(3);
    expect(a.threshold).toBe(0.15);
    expect(a.verbose).toBe(false);
    expect(a.dryRun).toBe(false);
  });

  /** 捕获 console.error + process.exit(1) 的拒绝路径消息 */
  async function captureReject(argv: string[], spec = SPEC): Promise<string> {
    const { parseCliArgs } = await loadLib();
    const lines: string[] = [];
    const origErr = console.error;
    const origExit = process.exit;
    console.error = (...xs: unknown[]) => {
      lines.push(xs.join(' '));
    };
    process.exit = (() => {
      throw new Error('EXIT_REJECT');
    }) as typeof process.exit;
    try {
      parseCliArgs(argv, spec);
    } catch {
      /* 预期 EXIT_REJECT */
    } finally {
      console.error = origErr;
      process.exit = origExit;
    }
    return lines.join('\n');
  }

  it('未知旗标拒绝：报旗标名 + usage（exit 1）', async () => {
    const msg = await captureReject(['node', 'x', '/tmp/p', '--bogus']);
    expect(msg).toContain('未知旗标: --bogus');
    expect(msg).toContain('Usage:');
  });

  it('值旗标缺参拒绝：--max-retries 落单报错', async () => {
    const msg = await captureReject(['node', 'x', '/tmp/p', '--max-retries']);
    expect(msg).toContain('--max-retries 需要一个值');
  });

  it('int/float NaN 拒绝：--max-retries abc 报错', async () => {
    const msg = await captureReject(['node', 'x', '/tmp/p', '--max-retries', 'abc']);
    expect(msg).toContain('需要整数');
  });

  it('位置参数契约：恰 1 个（min===max）多给拒绝', async () => {
    const msg = await captureReject(['node', 'x', '/a', '/b']);
    expect(msg).toContain('只接受 1 个位置参数');
    expect(msg).toContain('收到 2 个');
  });

  it('零位置参数拒绝（min=1）', async () => {
    const msg = await captureReject(['node', 'x']);
    expect(msg).toContain('收到 0 个');
  });

  it('min=0/max=0 契约：不接受任何位置参数', async () => {
    const zeroSpec = { ...SPEC, positionals: { min: 0, max: 0, name: '' } };
    const msg = await captureReject(['node', 'x', 'extra'], zeroSpec);
    expect(msg).toContain('不接受位置参数');
  });

  it('范围契约 min<max：数量越界拒绝，范围内通过', async () => {
    const { parseCliArgs } = await loadLib();
    const rangeSpec = { ...SPEC, positionals: { min: 1, max: 2, name: '<dir> <cmd>' } };
    const ok = parseCliArgs(['node', 'x', '/a', 'status'], rangeSpec);
    expect(ok._).toEqual(['/a', 'status']);
    const msg = await captureReject(['node', 'x', '/a', 'status', 'x'], rangeSpec);
    expect(msg).toContain('需要 1..2 个');
  });

  it('--help 短路：exit 0 哨兵（先于位置参数分派）', async () => {
    const { parseCliArgs } = await loadLib();
    let helped = false;
    const origLog = console.log;
    const origExit = process.exit;
    console.log = () => {};
    process.exit = ((code?: number) => {
      helped = code === 0;
      throw new Error('EXIT_HELP');
    }) as typeof process.exit;
    try {
      parseCliArgs(['node', 'x', '--help'], SPEC);
    } catch {
      /* 预期 EXIT_HELP */
    } finally {
      console.log = origLog;
      process.exit = origExit;
    }
    expect(helped).toBe(true);
  });
});

describe('全量脚本子进程抽验（真实 exit code）', () => {
  const SAMPLES = [
    'gate-check',
    'eval-runner',
    'band-detector',
    'hitl-audit',
    'init-cycle',
    'init-workflow',
    'archive-cycle',
    'multi-agent-gate',
    'plan-sync-check',
    'fact-base-verify',
    'gate-ledger',
    'org-status',
    'workflow-state',
    'auto-fix-loop',
    'quick-validate',
  ] as const;

  it.each(SAMPLES)('%s --help → usage + exit 0', (script) => {
    const r = run(script, ['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage:');
  });

  it.each(SAMPLES)('%s --zzz 拒绝 exit 1', (script) => {
    const r = run(script, ['--zzz']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('未知旗标: --zzz');
  });

  it('kebab→camel 真实脚本贯通：auto-fix-loop --max-retries 2 被正确消费（不报未知旗标）', () => {
    const r = run('auto-fix-loop', ['--max-retries', '2']);
    // 无 project-dir → 位置参数拒绝（而非旗标解析失败）
    expect(r.code).toBe(1);
    expect(r.out).toContain('位置参数');
    expect(r.out).not.toContain('未知旗标');
  });
});
