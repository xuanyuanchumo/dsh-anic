// ledger.mjs — 哈希链门禁账本核心（进化 iteration-1：从 gate-ledger.mjs 抽出，修 S-5 / S-6）
// 设计约束（兼容铁律）：
//   1. hash 计算 = sha256(JSON.stringify(entryData))，entryData 六字段键序
//      { gate, gateName, result, detail, timestamp, previousHash } —— 一个字符都不能动，
//      否则既有账本（如本仓库 56 条历史记录）全部 HASH_MISMATCH。
//   2. verify 用每条 entry 自身字段重算，因此新 entry 允许附加新字段，旧账本依然验证通过。
//   3. saveLedger 走原子写（修 S-6：原先裸 writeFileSync，中断留半写文件毁链）。
//
// cycle-79 O-04（形状硬化）：`loadLedger` 原先只认包裹形态 `{ entries: [...] }`。
// 遇**裸数组**账本时 `.entries` 不是 undefined，而是 `Array.prototype.entries` 这个
// **函数**——于是 `gate-ledger --list/--verify` 实测输出「No gate entries recorded」/
// 「Total entries: 0, Valid: YES」（函数没有元素、`.length` 恰好是形参个数 0），
// 也就是**把坏形状静默说成健康**（fail-open，比崩溃更危险：坏账本看起来全绿）。
// 宿主侧 src/host/evolution/breakerSignals.ts 已做双形状归一，技能侧必须同语义。
//
// 归一语义（readLedger；**必须在取 .entries 之前判 Array.isArray**，避免原型方法遮蔽）：
//   · 包裹 `{ entries: [...] }` → shape='wrapped'，chainHead 取字段（缺失则 null）
//   · 裸数组 → shape='array'，链头由**末条 hash 重建**（账本的 chainHead 按定义等于末条
//     hash，重建是等价还原，不改写任何条目内容；这样 verify 结论与包裹形态一致）
//   · 文件缺失 → shape='missing'、ok=true、空账本（"还没记录过" ≠ "账本损坏"）
//   · 坏 JSON / 形状不认识 → shape='unparsable'|'unknown'、ok=false + reason（不抛）
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from './fs-safe.mjs';

export const GATE_NAMES = {
  G0: '评估收敛门',
  G1: '任务收敛门',
  G2: '测试收敛门',
  G3: '构建收敛门',
};

export const VALID_GATES = Object.keys(GATE_NAMES);

export function ledgerPathFor(projectDir) {
  return join(projectDir, '.cycles', 'gates', 'ledger.json');
}

export function computeHash(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 读取账本并做形状归一（cycle-79 O-04）——账本读取的**唯一实现**。
 *
 * @returns {{ ok: boolean, shape: 'wrapped'|'array'|'missing'|'unparsable'|'unknown',
 *            entries: unknown[], chainHead: string|null, reason: string|null }}
 *   ok=false 表示「读到了但用不了」（坏 JSON / 形状不认识）：调用方必须明确报告不可用，
 *   不得当成空账本（那是 fail-open，也正是本轮修掉的缺陷）。
 */
export function readLedger(projectDir) {
  const ledgerPath = ledgerPathFor(projectDir);
  if (!existsSync(ledgerPath)) {
    return { ok: true, shape: 'missing', entries: [], chainHead: null, reason: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
  } catch (err) {
    return {
      ok: false, shape: 'unparsable', entries: [], chainHead: null,
      reason: `ledger unparsable: ${err && err.message ? err.message : String(err)}`,
    };
  }
  // 先判数组：裸数组的 `.entries` 命中 Array.prototype.entries（函数），绝不能直接取
  if (Array.isArray(parsed)) {
    const last = parsed[parsed.length - 1];
    const head = last && typeof last === 'object' && typeof last.hash === 'string' ? last.hash : null;
    return { ok: true, shape: 'array', entries: parsed, chainHead: head, reason: null };
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
    return {
      ok: true, shape: 'wrapped', entries: parsed.entries,
      chainHead: typeof parsed.chainHead === 'string' ? parsed.chainHead : null, reason: null,
    };
  }
  return {
    ok: false, shape: 'unknown', entries: [], chainHead: null,
    reason: 'ledger shape not recognized (expected { entries: [...] } or an array of entries)',
  };
}

/** 兼容旧签名（gate-check.mjs 等既有消费方）：返回 `{ entries, chainHead }` 形状。
 * 坏形状下**不抛**，返回空账本；写路径（appendEntry）会用 readLedger 的 ok 拒绝写入，
 * 因此「读容忍、写拒绝」——绝不把不可读账本覆盖掉（那会静默丢历史）。 */
export function loadLedger(projectDir) {
  const r = readLedger(projectDir);
  return { entries: r.entries, chainHead: r.chainHead };
}

export function saveLedger(projectDir, ledger) {
  const gatesDir = join(projectDir, '.cycles', 'gates');
  if (!existsSync(gatesDir)) mkdirSync(gatesDir, { recursive: true });
  atomicWriteFileSync(ledgerPathFor(projectDir), JSON.stringify(ledger, null, 2));
}

export function appendEntry(projectDir, gate, result, detail, extra = {}) {
  // 写前先归一（cycle-79 O-04）：账本损坏/形状不认识时**拒绝写入**——否则会把不可读的
  // 历史整份覆盖成只有一条新记录的账本（静默数据丢失）。裸数组是合法形状，正常追加。
  const read = readLedger(projectDir);
  if (!read.ok) {
    throw new Error(
      `Refusing to append gate entry: ${read.reason}. ` +
      `Repair or remove ${ledgerPathFor(projectDir)} first — appending would overwrite unreadable history.`,
    );
  }
  const ledger = { entries: read.entries, chainHead: read.chainHead };
  const timestamp = new Date().toISOString();
  const gateName = GATE_NAMES[gate] || gate;

  const entryData = JSON.stringify({
    gate,
    gateName,
    result: result.toUpperCase(),
    detail: detail || 'N/A',
    timestamp,
    previousHash: ledger.chainHead,
  });

  const hash = computeHash(entryData);

  // extra 只进入 entry 本体（不进入 entryData/hash）——哈希形状保持与历史账本逐字节一致
  const entry = {
    gate,
    gateName,
    result: result.toUpperCase(),
    detail: detail || 'N/A',
    timestamp,
    previousHash: ledger.chainHead,
    hash,
    ...extra,
  };

  ledger.entries.push(entry);
  ledger.chainHead = hash;
  saveLedger(projectDir, ledger);

  return entry;
}

export function verifyLedger(projectDir) {
  const ledger = readLedger(projectDir);
  // 不可用 ≠ 空账本：明确返回 unavailable，让 CLI 打印「[SKIP] … 原因」而不是 Valid: YES
  if (!ledger.ok) {
    return {
      valid: false,
      unavailable: true,
      shape: ledger.shape,
      issues: [{ index: -1, type: 'LEDGER_UNAVAILABLE', message: ledger.reason }],
      totalEntries: 0,
    };
  }
  const issues = [];

  let expectedPrevHash = null;
  for (let i = 0; i < ledger.entries.length; i++) {
    const entry = ledger.entries[i];

    if (entry.previousHash !== expectedPrevHash) {
      issues.push({
        index: i,
        type: 'CHAIN_BREAK',
        message: `Entry ${i}: previousHash mismatch (expected ${expectedPrevHash}, got ${entry.previousHash})`,
      });
    }

    const entryData = JSON.stringify({
      gate: entry.gate,
      gateName: entry.gateName,
      result: entry.result,
      detail: entry.detail,
      timestamp: entry.timestamp,
      previousHash: entry.previousHash,
    });

    const computedHash = computeHash(entryData);
    if (computedHash !== entry.hash) {
      issues.push({
        index: i,
        type: 'HASH_MISMATCH',
        message: `Entry ${i}: hash mismatch (expected ${computedHash}, got ${entry.hash})`,
      });
    }

    expectedPrevHash = entry.hash;
  }

  if (ledger.chainHead !== expectedPrevHash && ledger.entries.length > 0) {
    issues.push({
      index: -1,
      type: 'HEAD_MISMATCH',
      message: `Chain head mismatch (expected ${expectedPrevHash}, got ${ledger.chainHead})`,
    });
  }

  return { valid: issues.length === 0, unavailable: false, shape: ledger.shape, issues, totalEntries: ledger.entries.length };
}

export function listEntries(projectDir) {
  return readLedger(projectDir).entries;
}
