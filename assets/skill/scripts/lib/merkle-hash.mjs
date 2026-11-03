// merkle-hash.mjs — Merkle Tree 哈希计算用于增量缓存基线检测
// 实现策略 A：基于 Merkle Tree 的文件系统状态变化检测

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// 原子写纪律（quick-validate [ERROR] Non-atomic write 守卫）：缓存文件承载的是
// 门禁证据，半截 JSON 会被下次读到并造成「损坏 → 回退全量」之外的第二种结局
// ——读到旧格式误判。统一走 fs-safe 的原子写（temp + rename）。
import { atomicWriteFileSync } from './fs-safe.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * 计算单个文件的 SHA-256 哈希（16 字节前缀）
 */
export function calculateFileHash(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * 递归构建目录树的 Merkle Root
 * @param {string} dirPath - 目录路径
 * @param {string[]} extensions - 文件扩展名过滤器
 * @returns {string} Merkle root hash (32 bytes hex)
 */
export function calculateDirMerkleRoot(dirPath, extensions = ['.ts', '.js', '.mjs']) {
  let combined = '';
  const entries = [];

  function walk(dir) {
    if (!existsSync(dir)) return;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        // 跳过常见非源码目录
        if (['node_modules', '.git', 'dist', 'build', '.cache'].includes(entry.name)) {
          continue;
        }
        walk(full);
        continue;
      }

      if (extensions.some(ext => entry.name.endsWith(ext))) {
        const hash = calculateFileHash(full);
        if (hash) {
          entries.push({ path: relative(dirPath, full), hash });
        }
      }
    }
  }

  walk(dirPath); // ← cycle-97 缺陷修复：walk 只有定义没有调用（entries 恒空 ⇒ 根恒为 SHA256('')），改代码也「命中」缓存的假绿根因

  // 按路径排序保证确定性（同一文件不同顺序应得相同 hash）
  entries.sort((a, b) => a.path.localeCompare(b.path));

  for (const e of entries) {
    combined += `${e.path}:${e.hash}`;
  }

  return createHash('sha256').update(combined).digest('hex');
}

/**
 * 快速比较两个目录的差异（返回变更比例）
 * @param {string} oldHash - 上次运行时的 Merkle root
 * @param {string} newHash - 当前 Merkle root
 * @returns {number} Change ratio (0.0 = no change, 1.0 = all changed)
 */
export function getChangeRatio(oldHash, newHash) {
  if (oldHash === newHash) return 0;
  
  // 粗略估计：比较前 16 位是否相似
  // 更精确的方法需要存储每个文件的 hash（见 detailed-changes.mjs）
  const prefixMatch = Math.min(oldHash.length, newHash.length);
  let matchLength = 0;
  
  for (let i = 0; i < prefixMatch; i++) {
    if (oldHash[i] === newHash[i]) matchLength++;
    else break;
  }
  
  // 简单启发式：前缀匹配度越高，变更越小
  const similarity = matchLength / prefixMatch;
  return 1 - similarity;
}

/**
 * 详细变更检测（返回变更文件列表）
 * 需要存储每个文件的 hash 而不是仅 Merkle root
 * 同步实现——内部全是 readFileSync/readdirSync，async 是设计遗留
 * （cycle-97 缺陷：eval-runner 同步调用拿到 Promise，.changedFiles 恒 undefined）
 */
export function detectDetailedChanges(currentProjectDir, previousCacheFile) {
  if (!previousCacheFile || !existsSync(previousCacheFile)) {
    return { totalFiles: 0, changedFiles: [], unchangedFiles: [] };
  }

  const cache = JSON.parse(readFileSync(previousCacheFile, 'utf-8'));
  const fileHashes = cache.fileHashes || {};
  
  const currentFiles = new Map();
  
  function scanDir(dir) {
    if (!existsSync(dir)) return;
    
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
          continue;
        }
        scanDir(full);
        continue;
      }
      
      if (['.ts', '.js', '.mjs'].some(ext => entry.name.endsWith(ext))) {
        const hash = calculateFileHash(full);
        if (hash) {
          currentFiles.set(relative(cache.projectDir, full), hash);
        }
      }
    }
  }
  
  scanDir(currentProjectDir);
  
  const changedFiles = [];
  const unchangedFiles = [];
  
  for (const [path, currentHash] of currentFiles) {
    const prevHash = fileHashes[path];
    if (prevHash !== currentHash) {
      changedFiles.push(path);
    } else {
      unchangedFiles.push(path);
    }
  }
  
  return {
    totalFiles: currentFiles.size,
    changedFiles,
    unchangedFiles
  };
}

/**
 * 更新缓存中的文件哈希映射
 */
export function updateCacheFileHashes(cacheFile, projectDir) {
  const fileHashes = {};
  
  function scanDir(dir) {
    if (!existsSync(dir)) return;
    
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
          continue;
        }
        scanDir(full);
        continue;
      }
      
      if (['.ts', '.js', '.mjs'].some(ext => entry.name.endsWith(ext))) {
        const hash = calculateFileHash(full);
        if (hash) {
          fileHashes[relative(projectDir, full)] = hash;
        }
      }
    }
  }
  
  scanDir(projectDir);
  
  return fileHashes;
}

/**
 * 检查缓存是否有效
 * @param {string} cacheFile - 缓存文件路径
 * @param {string} projectDir - 项目根目录
 * @param {string} dshVersion - dsh-anic 版本号
 * @param {number} maxAgeMs - 最大年龄（毫秒），默认 7 天
 * @param {string} expectedRootOverride - 可选：调用方期望的指纹根。缓存里存的
 *   root 必须与**比对方**（调用方）用同一范围算出的值比对——调用方对 src/ 子树
 *   做指纹时传它；缺省退回「整项目根」自算（与 saveCache 缺省对称）。
 *   （cycle-97 缺陷三根因：存 src/ 子树根、验整项目根，永不等。）
 */
export function isCacheValid(cacheFile, projectDir, dshVersion, maxAgeMs = 7 * 24 * 60 * 60 * 1000, expectedRootOverride) {
  if (!existsSync(cacheFile)) return false;

  try {
    const cache = JSON.parse(readFileSync(cacheFile, 'utf-8'));

    // 1. Version check
    if (cache.version !== dshVersion) return false;

    // 2. Project directory consistency
    if (cache.projectDir !== projectDir) return false;

    // 3. Hash validation — 比对范围必须与存入范围一致（同根才可比）
    const currentHash = expectedRootOverride ?? calculateDirMerkleRoot(projectDir);
    if (currentHash !== cache.merkleRoot) return false;

    // 4. Freshness check
    const age = Date.now() - cache.timestamp;
    if (age > maxAgeMs) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * 加载缓存数据（解析失败 = 缓存损坏 = 返回 null，调用方诚实回退全量执行）。
 */
export function loadCache(cacheFile) {
  if (!existsSync(cacheFile)) return null;
  try {
    return JSON.parse(readFileSync(cacheFile, 'utf-8'));
  } catch {
    return null; // 半截 JSON / 编码坏 → 与「无缓存」同语义（宁可重跑不可假绿）
  }
}

/**
 * 保存缓存数据（原子写：先写临时文件再 rename，避免半截 JSON 被下次读到）。
 * 同步实现——调用方是 CLI 主流程，无并发写竞争。
 * @param {string} merkleRootOverride - 可选：调用方计算的指纹根。调用方可能只对
 *   src/ 子树做指纹（eval-runner 的语义），与「整项目根」不同——存哪个必须由
 *   比对方决定，否则存取两侧各算各的，永远对不上（cycle-97 缺陷二根因）。
 */
export function saveCache(cacheFile, projectDir, dshVersion, resultData, merkleRootOverride, cfgFingerprint) {
  const cache = {
    version: dshVersion,
    projectDir,
    merkleRoot: merkleRootOverride ?? calculateDirMerkleRoot(projectDir),
    // P3-3（cycle-97）：命令配置指纹入缓存键。缺省空串 = 调用方未启用配置
    // 校验（向后兼容旧调用方）；命中侧比对空串 === 空串恒真，行为不变。
    cfgFingerprint: cfgFingerprint ?? '',
    fileHashes: updateCacheFileHashes(cacheFile, projectDir),
    timestamp: Date.now(),
    results: {
      build: resultData.build,
      test: resultData.test,
      lint: resultData.lint
    },
    durationMs: resultData.duration
  };

  const dir = dirname(cacheFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  atomicWriteFileSync(cacheFile, JSON.stringify(cache, null, 2));
  return cache;
}
