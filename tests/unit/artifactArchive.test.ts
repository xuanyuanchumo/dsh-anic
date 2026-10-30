/**
 * 归档基线重置单测（cycle-83 · 产物治理）。
 *
 * ## 这个文件守的唯一不可逆风险
 *
 * 归档是写动作：一旦账本被碰，整条哈希链从此不可信（`verifyLedger` 必报 CHAIN_BREAK），
 * 而且**不可恢复**。所以本文件的第一条断言不是"归档成功"，而是
 * **归档前后账本字节完全相同 + 哈希链仍然有效**。
 *
 * ## 两态可判（每条断言都有牙）
 *
 * - 账本不变：正向断言 `before === after`，反向自检**篡改副本账本**证明比对判据有判别力
 *   （不篡改源码，只在内存/临时文件上做）；
 * - `total = 0` 死锁：同一份夹具里三种原因各自出现，并证明"若按旧判据（rows.length>0）
 *   全部回 false"，该轮永远不会被归档；
 * - 可重入：第二次调用的 `archived` 必须为空且 `alreadyArchived === true`，
 *   且 manifest 条目数不增长。
 *
 * ## 全部在临时工作区跑（绝不碰真实 `.cycles/`）
 *
 * 本仓有前科：契约测试经 cwd 兜底真写了真实账本 4 条（cycle-82 审计日志 H3 行）。
 * 所以本文件每个用例都 `mkdtempSync`，`afterEach` 清理，且**不 chdir**。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  archiveBaseline,
  isCycleCompleteForArchive,
  listActiveCycles,
  listArchivedCycles,
  readLedgerFacts,
  readManifest,
  BASELINE_AUDIT_FILE,
} from '../../src/host/runtime/artifactArchive.ts';
import { verifyLedger, type LedgerEntry } from '../../src/host/runtime/ledger.ts';

const CLEANUPS: string[] = [];
afterEach(() => {
  while (CLEANUPS.length > 0) {
    const d = CLEANUPS.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const HDR = '| 编号 | 优先级 | 任务 | 验证 | 责任 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n';
const DONE = HDR + '| T-01 | P0 | 任务 | 测试 | lead | 完成 |';
const PENDING = HDR + '| T-01 | P0 | 任务 | 测试 | lead | 待办 |';

/** 临时工作区（`.cycles/` 已建）。 */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-archive-unit-'));
  CLEANUPS.push(root);
  mkdirSync(join(root, '.cycles'), { recursive: true });
  return root;
}

/** 造一轮（tasks===null ⇒ 不写任务清单）。 */
function seedCycle(root: string, num: number, tasks: string | null, extras: Record<string, string> = {}): void {
  const dir = join(root, '.cycles', 'cycles', `cycle-${num}`);
  mkdirSync(dir, { recursive: true });
  if (tasks !== null) writeFileSync(join(dir, '任务清单.md'), tasks);
  for (const [f, content] of Object.entries(extras)) {
    const p = join(dir, f);
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(p, content);
  }
}

/** 写一条**真实合法**的哈希链账本（与 ledger.ts canonical 同算法）。 */
function writeValidLedger(root: string, count = 3): string {
  const mk = (gate: string, result: 'PASS' | 'FAIL', prev: string | null, i: number): LedgerEntry => {
    const full = { gate, gateName: gate, result, detail: `fixture ${String(i)}`, timestamp: new Date(2026, 0, 1, 0, i).toISOString(), previousHash: prev };
    return { ...full, hash: createHash('sha256').update(JSON.stringify(full)).digest('hex') };
  };
  const entries: LedgerEntry[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i += 1) {
    const e = mk(i % 2 === 0 ? 'G0' : 'G1', 'PASS', prev, i);
    entries.push(e);
    prev = e.hash ?? null;
  }
  mkdirSync(join(root, '.cycles', 'gates'), { recursive: true });
  const path = join(root, '.cycles', 'gates', 'ledger.json');
  const body = JSON.stringify({ entries, chainHead: prev }, null, 2);
  writeFileSync(path, body);
  return body;
}

describe('归档后账本一字节不变（本任务唯一的不可逆风险点）', () => {
  it('归档 2 轮后：账本字节全等 + 哈希链仍有效 + 条目数不变', () => {
    const root = workspace();
    seedCycle(root, 2, DONE);
    seedCycle(root, 3, DONE);
    const before = writeValidLedger(root, 3);
    const beforeFacts = readLedgerFacts(join(root, '.cycles'));
    expect(verifyLedger(join(root, '.cycles')).ok).toBe(true);

    const r = archiveBaseline(join(root, '.cycles'), { actor: 'unit-test' });
    expect(r.ok).toBe(true);
    expect(r.archived).toEqual(['cycle-2', 'cycle-3']);
    expect(r.ledger?.unchanged).toBe(true);

    // 最硬的一条：**逐字节**相等（不是"条目数相等"——顺序/空白/格式化变了也是破坏）
    const after = readFileSync(join(root, '.cycles', 'gates', 'ledger.json'), 'utf8');
    expect(after).toBe(before);
    expect(readLedgerFacts(join(root, '.cycles'))).toEqual(beforeFacts);
    const verify = verifyLedger(join(root, '.cycles'));
    expect(verify.ok).toBe(true);
    expect(verify.total).toBe(3);
  });

  it('反向自检：篡改副本账本 ⇒ 上面的"字节相等"判据必红（判据不是恒真）', () => {
    const root = workspace();
    seedCycle(root, 2, DONE);
    const before = writeValidLedger(root, 3);
    const abs = join(root, '.cycles', 'gates', 'ledger.json');
    // 模拟"归档顺手删了一条"这类事故：改一个字
    writeFileSync(abs, before.replace('"G0"', '"G9"'));
    expect(readFileSync(abs, 'utf8')).not.toBe(before);
    // 且链校验必须报断（证明第二道守卫也是真的）
    expect(verifyLedger(join(root, '.cycles')).ok).toBe(false);
  });

  it('归档不动 archive 之外的任何目录（只移动 cycle 目录本身）', () => {
    const root = workspace();
    seedCycle(root, 2, DONE, { '交付清单.md': '# 交付' });
    writeValidLedger(root, 1);
    const beforeTop = readdirSync(join(root, '.cycles')).sort();
    archiveBaseline(join(root, '.cycles'));
    const afterTop = readdirSync(join(root, '.cycles')).sort();
    // 唯一新增的是 archive/（cycles 仍在，只是少了那一轮）
    expect(afterTop.filter((n) => !beforeTop.includes(n))).toEqual(['archive']);
    expect(readdirSync(join(root, '.cycles', 'cycles'))).toEqual([]);
    expect(readdirSync(join(root, '.cycles', 'archive', 'cycle-2')).sort()).toEqual(['交付清单.md', '任务清单.md']);
  });
});

describe('total = 0 死锁修复（三种原因可区分，不是一句 false）', () => {
  it('零任务行 ⇒ empty-task-list（旧判据下永久不可归档）', () => {
    const root = workspace();
    seedCycle(root, 1, HDR); // 只有表头，零任务行
    const v = isCycleCompleteForArchive(join(root, '.cycles'), 'cycle-1');
    expect(v.complete).toBe(false);
    expect(v.reason).toBe('empty-task-list');
    expect(v.total).toBe(0);
    // 反向自检：旧判据 = rows.length > 0 && pending === 0 → 这三种形态全都是 false，
    // 且**无法区分**。这里证明三种原因确实被分成了三个不同字符串。
    seedCycle(root, 2, null);
    seedCycle(root, 3, PENDING);
    const reasons = ['cycle-1', 'cycle-2', 'cycle-3'].map((n) => isCycleCompleteForArchive(join(root, '.cycles'), n).reason);
    expect(new Set(reasons).size).toBe(3);
    expect(reasons).toEqual(['empty-task-list', 'missing-task-list', 'has-pending']);
  });

  it('empty-task-list 不阻塞基线重置：其余可完成轮照常归档，且原因被点名', () => {
    const root = workspace();
    seedCycle(root, 1, HDR);      // 空清单
    seedCycle(root, 2, DONE);     // 可归档
    seedCycle(root, 4, PENDING);  // 有未完成
    const dry = archiveBaseline(join(root, '.cycles'), { dryRun: true });
    expect(dry.archived).toEqual(['cycle-2']);
    expect(dry.kept.map((k) => `${k.name}:${k.reason}`)).toEqual(['cycle-1:empty-task-list', 'cycle-4:has-pending']);
    // detail 必须是人能读的一句（"为什么这轮没归上"）
    expect(dry.kept[0]?.detail).toContain('0 task rows');
    expect(dry.kept[1]?.detail).toContain('pending');
    // 真写：只有 cycle-2 走了，另两轮原样留在活跃区
    archiveBaseline(join(root, '.cycles'));
    expect(readdirSync(join(root, '.cycles', 'cycles')).sort()).toEqual(['cycle-1', 'cycle-4']);
  });

  it('全部轮次都不可完成 ⇒ no-op，且 dry run 不建 archive 目录', () => {
    const root = workspace();
    seedCycle(root, 1, HDR);
    seedCycle(root, 2, null);
    const dry = archiveBaseline(join(root, '.cycles'), { dryRun: true });
    expect(dry.archived).toEqual([]);
    expect(dry.alreadyArchived).toBe(true);
    expect(existsSync(join(root, '.cycles', 'archive'))).toBe(false);
  });
});

describe('可重入（重复归档是 no-op，manifest 不重复记）', () => {
  it('第二次调用：archived 为空、alreadyArchived=true、manifest 条目数不变', () => {
    const root = workspace();
    seedCycle(root, 2, DONE);
    seedCycle(root, 3, DONE);
    const first = archiveBaseline(join(root, '.cycles'));
    expect(first.archived).toEqual(['cycle-2', 'cycle-3']);
    const manifestAfterFirst = readManifest(join(root, '.cycles'));
    expect(manifestAfterFirst?.cycles.map((c) => c.name)).toEqual(['cycle-2', 'cycle-3']);

    const second = archiveBaseline(join(root, '.cycles'));
    expect(second.archived).toEqual([]);
    expect(second.alreadyArchived).toBe(true);
    const manifestAfterSecond = readManifest(join(root, '.cycles'));
    expect(manifestAfterSecond?.cycles.length).toBe(2); // 没长第二条
    // archivedAt 是**首次**归档时间（重复调用不改写"这条什么时候归的"）
    expect(manifestAfterSecond?.archivedAt).toBe(manifestAfterFirst?.archivedAt);
  });

  it('第二次调用不再写审计文件以外的东西：归档目录内容逐项稳定', () => {
    const root = workspace();
    seedCycle(root, 2, DONE);
    archiveBaseline(join(root, '.cycles'));
    const snapshot1 = readdirSync(join(root, '.cycles', 'archive')).sort();
    archiveBaseline(join(root, '.cycles'));
    const snapshot2 = readdirSync(join(root, '.cycles', 'archive')).sort();
    expect(snapshot2).toEqual(snapshot1);
    expect(snapshot1).toContain('cycle-2');
    expect(snapshot1).toContain(BASELINE_AUDIT_FILE);
  });

  it('反向自检：若 no-op 判据写成"数量相同即已完成"，漏归档会被吞掉', () => {
    // 构造：归档区已有 cycle-9，活跃区有 cycle-2 可归档（1 vs 1 ⇒ 数量相同但**名字不同**）。
    const root = workspace();
    seedCycle(root, 2, DONE);
    mkdirSync(join(root, '.cycles', 'archive', 'cycle-9'), { recursive: true });
    const r = archiveBaseline(join(root, '.cycles'));
    // 正确判据（看候选集）必须归档 cycle-2；按数量判会误判成 no-op
    expect(r.archived).toEqual(['cycle-2']);
    expect(r.alreadyArchived).toBe(false);
  });
});

describe('dryRun 与真写共用同一条判据（预览 == 执行）', () => {
  it('dryRun 预览的 archived 集合与真写的 archived 集合逐项相等', () => {
    const root = workspace();
    seedCycle(root, 1, HDR);
    for (const n of [2, 3, 5, 7]) seedCycle(root, n, DONE);
    seedCycle(root, 9, PENDING);
    const dry = archiveBaseline(join(root, '.cycles'), { dryRun: true });
    const real = archiveBaseline(join(root, '.cycles'));
    expect(real.archived).toEqual(dry.archived);
    expect(real.kept.map((k) => k.name)).toEqual(dry.kept.map((k) => k.name));
    // 反向：待归档集合确实非空（否则"相等"是 0==0 的恒真）
    expect(dry.archived.length).toBe(4);
  });

  it('dryRun 零写：目录、manifest、审计文件都不产生', () => {
    const root = workspace();
    seedCycle(root, 2, DONE);
    archiveBaseline(join(root, '.cycles'), { dryRun: true });
    expect(existsSync(join(root, '.cycles', 'archive'))).toBe(false);
    expect(existsSync(join(root, '.cycles', 'cycles', 'cycle-2'))).toBe(true);
  });
});

describe('审计与清单读数', () => {
  it('baseline-reset.json 记录 actor/时间/移了哪些/为什么，且声明账本未动', () => {
    const root = workspace();
    seedCycle(root, 2, DONE);
    seedCycle(root, 4, PENDING);
    writeValidLedger(root, 2);
    archiveBaseline(join(root, '.cycles'), { actor: 'unit-actor' });
    const audit = JSON.parse(readFileSync(join(root, '.cycles', 'archive', BASELINE_AUDIT_FILE), 'utf8')) as {
      actor: string; archived: string[]; kept: Array<{ name: string; reason: string }>;
      ledgerBefore: unknown; ledgerAfter: unknown; note: string;
    };
    expect(audit.actor).toBe('unit-actor');
    expect(audit.archived).toEqual(['cycle-2']);
    expect(audit.kept.map((k) => k.name)).toEqual(['cycle-4']);
    expect(audit.ledgerBefore).toEqual(audit.ledgerAfter); // 只作证据，绝不修改
    expect(audit.note).toContain('INV-9');
  });

  it('活跃/归档清单带体积读数，归档后计数发生迁移', () => {
    const root = workspace();
    seedCycle(root, 2, DONE, { '交付清单.md': 'x'.repeat(100) });
    seedCycle(root, 3, PENDING);
    const activeBefore = listActiveCycles(join(root, '.cycles'));
    expect(activeBefore.map((c) => c.name)).toEqual(['cycle-2', 'cycle-3']);
    expect(activeBefore[0]?.bytes).toBeGreaterThan(100); // 真读了文件大小，不是恒 0
    archiveBaseline(join(root, '.cycles'));
    expect(listActiveCycles(join(root, '.cycles')).map((c) => c.name)).toEqual(['cycle-3']);
    const archived = listArchivedCycles(join(root, '.cycles'));
    expect(archived.map((c) => c.name)).toEqual(['cycle-2']);
    expect(archived[0]?.files).toBeGreaterThan(0);
    expect(archived[0]?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
