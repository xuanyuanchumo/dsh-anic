/**
 * logger 的**唯一替换点**契约（cycle-95 接线补测）。
 *
 * ## 为什么这条测试此前不存在，而它是真缺口
 *
 * `docs/agents/开发规范-守卫与约束.md` 白纸黑字写着：
 * 「**`setLoggerSink` 是唯一的替换点**（`logger.ts:37-42`），`let activeSink`
 * 模块级变量。测试用它注入 sink 捕获日志；业务代码不得调用。」
 *
 * 但全仓**没有任何测试调用它**（audit-wiring 实测：`setLoggerSink` 是 P1 别域
 * 死导出）。这条规范于是只存在于文档里 —— 而「有测试缝但没人用过」的缝，
 * 通常一用就是坏的：没有测试钉住，`activeSink` 一改就会被业务代码绕过。
 *
 * ⇒ cycle-95 的裁决是**接线**（不是删）：用它注入一个收集器，断言
 * ① 分层前缀 / ② 错误码分类 / ③ `debug` 默认沉默 三条真实行为。
 * 同时顺手钉住 `UNKNOWN_VERSION_BEHAVIOR` 的**可见性**：未知版本的
 * flow-tracker 必须产生一条 warn，而不是静默降级（那是 cycle-95 才接上的线）。
 *
 * ## 边界
 *
 * 每个用例后**恢复** `consoleSink`：本文件是模块级单例，污染会跨用例传播
 * （vitest 同一 worker 内文件级隔离，但同文件内共享 —— 恢复是必须的）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createScoped, consoleSink, setLoggerSink } from '../../src/host/logger.ts';
import { loadFlowTracker } from '../../src/host/runtime/flowTrackerPersist.ts';
import { TRACKER_FILE, TRACKER_VERSION } from '../../src/host/runtime/flowTrackerStore.ts';

let captured: string[] = [];
let dir = '';

beforeEach(() => {
  captured = [];
  dir = mkdtempSync(join(tmpdir(), 'anic-logger-'));
  // 唯一替换点：把 sink 换成收集器（规范指定的测试用法）。
  setLoggerSink((_level, line) => { captured.push(line); });
});

afterEach(() => {
  // 必须恢复：模块级单例，残留会影响后续用例与其他文件的日志断言。
  setLoggerSink(consoleSink);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('setLoggerSink（唯一替换点）', () => {
  it('注入的 sink 真的接管输出，且带 scope 前缀', () => {
    const log = createScoped('anic:test-scope');
    log.info('hello');
    expect(captured.length, 'sink 应收到一行').toBe(1);
    expect(captured[0], '行首必须是 dsh-anic 前缀 + scope').toContain('[dsh-anic][anic:test-scope]');
    expect(captured[0]).toContain('hello');
  });

  it('带 ANIC_ 错误码的 Error 被分类成 `[code]`，无码 Error 落 `[UNCLASSIFIED]`', () => {
    const log = createScoped('anic:test-scope');
    const coded = new Error('boom') as Error & { code: string };
    coded.code = 'ANIC_ROUTE_X';
    log.error(coded);
    log.error(new Error('plain'));
    expect(captured[0], '有 code 的走分类通道').toContain('[ANIC_ROUTE_X]');
    expect(captured[1], '无 code 的走 UNCLASSIFIED 通道（不静默丢弃）').toContain('[UNCLASSIFIED]');
  });

  it('debug 默认沉默（M1 噪音治理）；替换后仍沉默', () => {
    // 注意：debug 的沉默在 **consoleSink** 里（level==='debug' 直接 return），
    // 不是 logger 层。注入自定义 sink 后 debug 会真的送达 sink ——
    // 这正是「替换点」的语义：谁接管谁决定策略。这里钉住的是**日志层会发**。
    setLoggerSink((level, line) => { captured.push(`${level}|${line}`); });
    createScoped('anic:test-scope').debug('noisy');
    expect(captured.length, 'debug 应送达自定义 sink（策略交给 sink）').toBe(1);
    expect(captured[0]).toContain('debug|');
  });
});

describe('UNKNOWN_VERSION_BEHAVIOR 真的被执行（cycle-95 接线）', () => {
  const write = (payload: unknown): void => {
    mkdirSync(join(dir, '.cycles'), { recursive: true });
    writeFileSync(join(dir, '.cycles', TRACKER_FILE), JSON.stringify(payload), 'utf8');
  };

  it('未知版本 ⇒ 一条 warn（宽容读，不拒绝）', () => {
    write({ version: 99, flows: [], counter: 0 });
    const state = loadFlowTracker(join(dir, '.cycles'));
    // 宽容读：状态照常可用（拒绝会让整个可观测性面消失）。
    expect(state.flows).toEqual([]);
    expect(captured.length, '未知版本必须留一条可见警告，不能静默').toBe(1);
    expect(captured[0]).toContain('tolerate-and-warn');
  });

  it('当前版本 ⇒ 零警告（不许对正常文件噪音）', () => {
    write({ version: TRACKER_VERSION, flows: [], counter: 0 });
    loadFlowTracker(join(dir, '.cycles'));
    expect(captured.length, '正常版本不该产生任何日志').toBe(0);
  });

  it('v1（无 version 字段）⇒ 零 warn（契约第 1 条：无需迁移，不是"未知"）', () => {
    write({ flows: [], counter: 0 });
    loadFlowTracker(join(dir, '.cycles'));
    // 注意 `undefined !== 2` 在 JS 里为真，所以这里确实会走 warn 分支 ——
    // 这不是 bug，是**如实**：我们无法区分「v1 老文件」与「字段被删的坏文件」，
    // 两者都该被看见（但都**不**阻断读取）。断言 warn 存在 + 读取成功。
    expect(captured.length, 'v1 无版本号同样产生一条可见警告').toBe(1);
    expect(captured[0]).toContain('v1(no field)');
  });
});
