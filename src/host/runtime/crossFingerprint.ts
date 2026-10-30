/**
 * 工作区指纹（cycle-89 · 从 `crossBootstrap.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 用途：源零写入断言的**凭据**
 *
 * 跨项目自举（「举他」）会在**目标**工作区跑自举循环。调用方需要知道
 * 「源工作区有没有被顺手写坏」——本模块提供的指纹就是那个证据：
 * 调用前后各取一次，`digest` 相同即证明未被触碰。
 *
 * ## 为什么只覆盖 `.cycles/**`（而不是整个工作区）
 *
 * 整个工作区指纹会把 `node_modules/`（几十万文件）算进来：
 *   - **慢**：每次跨项目自举都扫一遍，代价与项目规模成正比；
 *   - **脆**：用户在这期间跑一次 build / install，指纹就变了 →
 *     断言误报「源被写了」→ 真信号被噪声淹没。
 *
 * 而跨项目自举**只可能**写 `.cycles/**`（本仓所有写路径都锚在
 * `{workspace}/.cycles/`），所以覆盖它就足够精确地证明「源没被写」。
 * 这个范围纪律本身也要可断言 —— 故 `cyclesOnly` 字段把范围写进返回值。
 *
 * ## 边界
 *
 * - **不排除任何文件**（含 `flow-tracker.json`）：源工作区在本操作中
 *   **完全不被触碰**，包括它的记账文件。若它变了，就是真的被写了。
 * - 目录不可读 → 当作空（读不到 ≠ 有文件）。
 * - 纯读取，无写盘。
 */
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { safeReadFileSync } from '../../shared/fs-safe.ts';

/** 指纹条目：相对路径 + 内容哈希 + 大小。 */
export interface FingerprintEntry {
  /** 相对 `.cycles` 根的正斜杠路径。 */
  path: string;
  /** 内容 sha256。 */
  sha256: string;
  /** 字节数。 */
  bytes: number;
}

/** 工作区指纹：源零写入断言的**凭据**。 */
export interface WorkspaceFingerprint {
  /** 工作区根（绝对路径）。 */
  root: string;
  /** 参与指纹的文件条目数。 */
  entries: number;
  /** 全量聚合哈希（entries 的有序拼接再哈希）。 */
  digest: string;
  /** 是否**只**覆盖 `.cycles/**`（当前恒为 true —— 范围纪律本身可断言）。 */
  cyclesOnly: boolean;
}

/**
 * 取 `.cycles/**` 的指纹。
 *
 * @param cyclesDir `.cycles` 目录绝对路径
 * @param root 工作区根（缺省 = cyclesDir 的父目录）
 */
export function fingerprintCycles(cyclesDir: string, root?: string): WorkspaceFingerprint {
  const absRoot = root ?? path.dirname(cyclesDir);
  const entries: FingerprintEntry[] = [];
  collectFiles(cyclesDir, cyclesDir, entries);
  // 排序 → 确定性摘要（目录遍历顺序随文件系统而变）。
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash('sha256');
  for (const e of entries) {
    digest.update(e.path);
    digest.update(' ');
    digest.update(e.sha256);
    digest.update(' ');
    digest.update(String(e.bytes));
    digest.update(' ');
  }
  return { root: absRoot, entries: entries.length, digest: digest.digest('hex'), cyclesOnly: true };
}

/** 递归收集文件（目录本身不作为条目，只收文件）。 */
function collectFiles(dir: string, base: string, out: FingerprintEntry[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // 目录不可读 → 当作空（不是「有文件」，是「读不到」）
  }
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectFiles(full, base, out);
      continue;
    }
    if (!st.isFile()) continue;
    const rel = path.relative(base, full).split(path.sep).join('/');
    const raw = safeReadFileSync(full);
    out.push({
      path: rel,
      sha256: createHash('sha256').update(raw ?? '').digest('hex'),
      bytes: st.size,
    });
  }
}

/** 两个指纹是否相同（源零写入断言）。 */
export function sameFingerprint(a: WorkspaceFingerprint, b: WorkspaceFingerprint): boolean {
  return a.digest === b.digest && a.entries === b.entries;
}
