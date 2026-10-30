/**
 * 原子写（M2-a 雏形，M2-b 升级为分段）。
 *
 * write-then-rename 模式：先写临时文件，再 rename 覆盖。
 * 防止并发读看到半写文件（INV-7 head/seg 一致性守卫的前置）。
 *
 * F-T1（cycle-13 抖动加固）：Windows 重负载下 rename 覆盖既有文件可能被
 * 杀软/搜索索引器短暂持有句柄而瞬时 EPERM/EACCES（cycle-12 全量跑
 * flowTracker 滚动淘汰用例 205 次连续原子写曾偶现一次，单跑无法复现——
 * 本机最高写密度的用例，与该理论一致）。对该类瞬时错误重试（1ms/5ms/25ms
 * 同步退避），非瞬时错误立即抛，重试耗尽抛原始错误。
 */
import { writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs';

/** rename 覆盖时的瞬时错误类（外部句柄短暂持有目标/临时文件）。 */
export function isTransientRenameError(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY' || code === 'EEXIST';
}

/** 同步微睡眠（Atomics.wait——Node 主线程可用，零依赖）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 原子写文件：写临时文件 → rename 覆盖（瞬时锁冲突重试）。 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmp = filePath + '.tmp-' + process.pid;
  writeFileSync(tmp, content, 'utf-8');
  const delays = [1, 5, 25];
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      renameSync(tmp, filePath);
      return;
    } catch (e) {
      lastError = e;
      if (!isTransientRenameError((e as NodeJS.ErrnoException).code)) throw e;
      const backoff = delays[attempt];
      if (backoff === undefined) break;
      sleepSync(backoff);
    }
  }
  throw lastError;
}

/** 安全读（不存在返回 fallback）。 */
export function safeReadFileSync(filePath: string, fallback = ''): string {
  if (!existsSync(filePath)) return fallback;
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return fallback;
  }
}

/**
 * **带瞬时重试的 rename**（cycle-91）—— 目录移动与文件覆盖共用。
 *
 * ## 为什么需要（cycle-91 实测缺陷）
 *
 * `atomicWriteFileSync` 早就有了瞬时重试（cycle-13 抖动加固），但**目录级
 * rename 没有** ⇒ 三处归档路径（`archiveEngine.ts` / `artifactArchiveBaseline.ts`
 * / `artifactArchiveRestore.ts`）在 Windows 上会被杀软/搜索索引器短暂持句柄
 * 而 **EPERM**。
 *
 * **实测反例**（cycle-91 收口，真机）：`anic_flows_archive --cycle 90` ⇒
 * ```
 * Error: EPERM: operation not permitted,
 *   rename 'D:\...\cycles\cycle-90' -> 'D:\...\archive\cycle-90'
 * ```
 * ⇒ **归档功能在真机上不可用**（且失败是硬错误，无优雅降级）。
 *
 * ## 为什么不是"忽略 EPERM"
 *
 * 归档是**移动**（不是复制）⇒ 失败意味着循环目录留在原地而 archive 下没有它
 * ⇒ 状态是"半完成"（manifest 说归档了，实际没归档）⇒ **比抛错更糟**
 * （撒谎）。⇒ 必须**重试到成功或抛出真实错误**。
 *
 * ## 退避参数
 *
 * 与 `atomicWriteFileSync` 同款（1ms/5ms/25ms）：Windows 的句柄占用窗口
 * 实测在**毫秒级**（杀软扫描 / 索引器 stat），三次退避共 31ms 足够覆盖；
 * 再长会拖慢**每次**归档（正常路径零延迟）。
 */
export function safeRenameSync(from: string, to: string): void {
  const delays = [1, 5, 25];
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      lastError = e;
      if (!isTransientRenameError((e as NodeJS.ErrnoException).code)) throw e;
      const backoff = delays[attempt];
      if (backoff === undefined) break;
      sleepSync(backoff);
    }
  }
  throw lastError;
}
