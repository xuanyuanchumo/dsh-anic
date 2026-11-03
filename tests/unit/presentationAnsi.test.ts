/**
 * cycle-99c：终端呈现净化回归钉（命令窗口显示问题）。
 *
 * 被守卫缺陷：terminalResult 把子进程 stdout 原样塞进 TerminalResultView.output，
 * vitest 等工具在非 TTY 下写入的 ANSI 转义码（flow 记录实证 `\u001b[32m✓`）在
 * 终端卡片渲染成乱码；超长输出也无诚实截断声明。
 *
 * 修复面（presentation.ts）：显示侧剥离 SGR/OSC/DCS/单字符 Esc 序列与孤立 \r，
 * 诚实截断带 omitted 计数；模型可见的 execute 返回值（stdout/stderr 原文）不动。
 */
import { describe, it, expect } from 'vitest';
import {
  stripAnsiEscapeSequences,
  truncateWithNotice,
  terminalResult,
} from '../../src/host/presentation.ts';

const ESC = String.fromCharCode(0x1b);

describe('stripAnsiEscapeSequences（显示净化纯函数）', () => {
  it('剥离 SGR 颜色序列（vitest ✓ 实证形态）', () => {
    const raw = `${ESC}[32m✓${ESC}[39m tests/unit/x.test.ts ${ESC}[2m(4 tests)${ESC}[22m${ESC}[32m 6ms${ESC}[39m`;
    expect(stripAnsiEscapeSequences(raw)).toBe('✓ tests/unit/x.test.ts (4 tests) 6ms');
  });

  it('剥离光标/滚动 CSI 与单字符 Esc 序列', () => {
    expect(stripAnsiEscapeSequences(`${ESC}[2K${ESC}[1A redraw`)).toBe(' redraw');
    expect(stripAnsiEscapeSequences(`${ESC}=${ESC}>ok`)).toBe('ok');
  });

  it('剥离 OSC（BEL 终结与 ST 终结两种形态）', () => {
    expect(stripAnsiEscapeSequences(`${ESC}]0;title${String.fromCharCode(7)}body`)).toBe('body');
    expect(stripAnsiEscapeSequences(`${ESC}]8;;http://x${ESC}\\link${ESC}[0m`)).toBe('link');
  });

  it('孤立 \\r 剥离（进度条回车重绘），\\r\\n 保留', () => {
    expect(stripAnsiEscapeSequences('a\rb\rc\nx\r\ny')).toBe('abc\nx\r\ny');
  });

  it('普通文本与多行 UTF-8 原样通过（幂等）', () => {
    const plain = '评估报告\n全部 16 维通过 ✓ 中文';
    expect(stripAnsiEscapeSequences(plain)).toBe(plain);
    expect(stripAnsiEscapeSequences(stripAnsiEscapeSequences(plain)))
      .toBe(stripAnsiEscapeSequences(plain));
  });
});

describe('truncateWithNotice（诚实截断）', () => {
  it('未超限原样返回；超限追加 omitted 计数声明', () => {
    expect(truncateWithNotice('abc', 10)).toBe('abc');
    const cut = truncateWithNotice('x'.repeat(100), 10);
    expect(cut.startsWith('x'.repeat(10))).toBe(true);
    expect(cut).toContain('90 chars omitted');
  });
});

describe('terminalResult 呈现面（乱码修复回归）', () => {
  it('ANSI 输出经呈现视图后无转义码残留（模型侧 execute 原文不受影响）', () => {
    const view = terminalResult({ exitCode: 0, stdout: `${ESC}[32mPASS${ESC}[39m` });
    expect(view.card).toBe('terminal');
    expect(view.output).toBe('PASS');
    expect(view.output).not.toContain(ESC);
  });

  it('stderr 拼接段同样净化；退出码/信号不吞', () => {
    const view = terminalResult({ exitCode: 1, stdout: 'o', stderr: `${ESC}[31mE${ESC}[39m` });
    expect(view.output).toBe('o\n-- stderr --\nE');
    expect(view.exitCode).toBe(1);
    const sig = terminalResult({ exitCode: null, stdout: '', stderr: '', signal: 'SIGTERM' });
    expect(sig.signal).toBe('SIGTERM');
  });

  it('空输出仍规范化为 undefined（既有契约不回归）', () => {
    expect(terminalResult({ exitCode: 0, stdout: '', stderr: '' }).output).toBeUndefined();
  });
});
