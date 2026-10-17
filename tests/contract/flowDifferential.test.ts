/**
 * 差分契约（R3 阶段 2 核心验收判据）—— 同一 fixture 工作区上，
 * native 引擎判定与 script 正典实现（assets/skill/scripts/gate-check.mjs）
 * 逐字段比对：pass + detail 必须全等。
 *
 * 这是「双真相源」防线的机械守卫：任何一侧语义漂移（正则差异、路径差异、
 * 阈值差异）都会在这里现形。脚本侧真实 spawn node 运行（非 mock）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runNativeGateCheck } from '../../src/host/flows/gateEngine.ts';
import { invokeSkillScript } from '../../src/host/skillInvoker.ts';
import { parseGateLines, parseGateVerdict } from '../../src/host/runtime/scriptParsers.ts';

const SCRIPTS_DIR = fileURLToPath(new URL('../../assets/skill/scripts/', import.meta.url));
const GATES = ['G0', 'G1', 'G2', 'G3'] as const;

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'anic-flow-diff-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(buildCmd: string): void {
  const dir = join(tmp, '.cycles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yml'), `autonomy_level: L2\nbuild_cmd: ${buildCmd}\n`);
}
function writeCycle(files: Record<string, string>): void {
  const dir = join(tmp, '.cycles', 'cycles', 'cycle-1');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
}

/** 跑脚本正典实现并解析逐门禁行。 */
function runScriptSide(gate: string = 'all'): { result: ReturnType<typeof parseGateLines>; verdict: string; exitCode: number } {
  const r = invokeSkillScript(SCRIPTS_DIR, 'gate-check', ['--gate', gate, '--quality'], tmp, 60000);
  return { result: parseGateLines(r), verdict: parseGateVerdict(r), exitCode: r.exitCode };
}

describe('差分契约：native vs script 逐字段全等', () => {
  it('全绿工作区（四门 + 质量门全过）', () => {
    writeConfig('exit 0');
    writeCycle({
      '项目评估报告.md': [
        '| E1 | 意图对齐 | PASS | x |', '| E2 | 规格符合 | PASS | x |',
        '| E3 | 测试 | PASS | x |', '| E4 | 静态检查 | PASS | x |',
        '| E6 | 安全 | PASS | x |', '| E7 | 文档同步 | PASS | x |', '| E8 | 测试面 | PASS | x |',
        '| Q1 | 架构 | PASS | x |', '| Q2 | 测试 | PASS | x |', '| Q3 | 构建 | PASS | x |',
        '| Q4 | 依赖 | PASS | x |', '| Q5 | 复杂度 | PASS | x |', '| Q7 | 工程 | PASS | x |',
      ].join('\n'),
      '任务清单.md': '| T-01 | P0 | 任务 | 验证 | lead | 完成 |',
      'test-reports/test-report.md': '| 结果 | 数量 |\n| --- | --- |\n| 通过 | 10 |\n| 失败 | 0 |\n| 错误 | 0 |',
    });
    const script = runScriptSide();
    const native = runNativeGateCheck(tmp, { gate: 'all', quality: true });

    for (const g of GATES) {
      expect(native.gates[g]?.pass, `gate ${g} pass`).toBe(script.result.gates[g]?.pass);
      expect(native.gates[g]?.detail, `gate ${g} detail`).toBe(script.result.gates[g]?.detail);
    }
    expect(native.allPass).toBe(true);
    expect(script.verdict).toBe('PASS');
    expect(script.exitCode).toBe(0);
  });

  it('红工作区（G0 无报告 / G1 未完成 / G2 有失败 / G3 构建挂）', () => {
    writeConfig('exit 2');
    writeCycle({
      '任务清单.md': '| T-01 | P0 | a | b | c | 完成 |\n| T-02 | P1 | a | b | c | 待办 |',
      'test-reports/test-report.md': '| 结果 | 数量 |\n| --- | --- |\n| 通过 | 8 |\n| 失败 | 2 |\n| 错误 | 1 |',
    });
    const script = runScriptSide();
    const native = runNativeGateCheck(tmp, { gate: 'all', quality: true });

    for (const g of GATES) {
      expect(native.gates[g]?.pass, `gate ${g} pass`).toBe(script.result.gates[g]?.pass);
      expect(native.gates[g]?.detail, `gate ${g} detail`).toBe(script.result.gates[g]?.detail);
    }
    expect(native.allPass).toBe(false);
    expect(script.verdict).toBe('FAIL');
    expect(script.exitCode).toBe(1);
  });

  it('质量门三态差异面（SKIP / 行缺失不能关门）', () => {
    writeConfig('exit 0');
    writeCycle({
      // G0 报告存在但 Q5=SKIP、Q1=PASS；G2 的 Q2 行缺失
      '项目评估报告.md': '| E1 | 意图 | PASS | x |\n| Q1 | 架构 | PASS | x |\n| Q5 | 复杂度 | SKIP | 未评 |\n| Q2 | x | SKIP | 未评 |',
      '任务清单.md': '| T-01 | P0 | a | b | c | 完成 |',
      'test-reports/test-report.md': '| 结果 | 数量 |\n| --- | --- |\n| 通过 | 1 |\n| 失败 | 0 |\n| 错误 | 0 |',
    });
    const script = runScriptSide();
    const native = runNativeGateCheck(tmp, { gate: 'all', quality: true });

    for (const g of GATES) {
      expect(native.quality[g]?.pass, `quality ${g} pass`).toBe(script.result.quality[g]?.pass);
      expect(native.quality[g]?.detail, `quality ${g} detail`).toBe(script.result.quality[g]?.detail);
    }
    // G0 质量（Q5 SKIP）与 G2 质量（Q2 缺失行）两侧都必须 FAIL——无证据 ≠ 通过
    expect(native.quality.G0?.pass).toBe(false);
    expect(native.quality.G2?.pass).toBe(false);
  });

  it('config 缺失 → 两侧同为致命形态（脚本 exit 1，native fatal）', () => {
    const script = runScriptSide();
    expect(script.exitCode).toBe(1);
    expect(script.verdict).toBe('unknown'); // 致命路径无门禁行

    const native = runNativeGateCheck(tmp, { gate: 'all', quality: true });
    expect(native.fatal).toContain('No .cycles/config.yml found');
    expect(native.exitCode).toBe(1);
    expect(native.allPass).toBe(false);
  });

  it('单门模式（--gate G1）两侧逐字段全等', () => {
    writeConfig('exit 0');
    writeCycle({
      '任务清单.md': '| T-01 | P0 | a | b | c | 完成 |\n| T-02 | P1 | a | b | c | 进行中 |',
    });
    const script = runScriptSide('G1');
    const native = runNativeGateCheck(tmp, { gate: 'G1', quality: true });
    expect(native.gates.G1?.pass).toBe(script.result.gates.G1?.pass);
    expect(native.gates.G1?.detail).toBe(script.result.gates.G1?.detail);
    expect(native.gates.G1?.pass).toBe(false);
    expect(native.gates.G1?.detail).toContain('1 of 2 tasks not completed');
  });
});
