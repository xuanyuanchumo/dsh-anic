// fs-parallel.mjs — eval-runner 并行收割器的文件原语（cycle-97 P1）
//
// 为什么独立成文件：并行收割器还需要「不存在即忽略」的安全删除原语；
// 原子写本身不重复造轮子——re-export fs-safe.mjs 的权威实现（quick-validate
// 的非原子写守卫把 writeFileSync 直调视为缺陷，所有写盘必须走该闸门）。
import { existsSync, mkdirSync, rmSync } from 'node:fs';

// 原子写唯一事实源（temp + rename，含失败清理）。fsync 语义由 OS 层保证
// rename 的可见性（Windows NTFS 上 rename 是元数据操作，同卷原子）。
export { atomicWriteFileSync as writeFileSyncParallel } from './fs-safe.mjs';

/** 安全删除：不存在时静默（并行启动前清理上一轮残留）。 */
export function rmFileSyncSafe(filePath) {
  try {
    rmSync(filePath, { force: true });
  } catch {
    // 删除失败不致命：残留文件会被子进程的原子写覆盖
  }
}

/** 目录确保（幂等）。 */
export function mkdirSyncSafe(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
