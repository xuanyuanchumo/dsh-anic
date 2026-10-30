/**
 * 跨工作区自举（cycle-89 · 「举他」）—— 在**目标项目**上跑同一套自举循环。
 *
 * ## 要解决的缺口
 *
 * dsh-anic 此前只有「自举自己」：`/anic/self/evaluate` 等端点的作用域是
 * **宿主当前工作区**（`resolveWorkspaceRoots(ctx)`）。用户点名要「举他」——
 * 能对**另一个项目**跑同一循环，且两个项目互不污染。
 *
 * ## 三条硬约束（每条都对应一个可断言的事实）
 *
 * 1. **源工作区零写入**：跨项目自举**只**在目标工作区写 `.cycles/**`。
 *    源工作区的任何文件都不得被改 —— 这不是「小心一点」，而是**可断言**的：
 *    `sourceFingerprint` 在调用前后取源工作区的文件指纹，调用方可比对。
 * 2. **目标工作区独立**：目标有自己的 `.cycles/`，自己的账本、自己的自举状态。
 *    与源**不共享任何状态文件**（不读源的 `self-bootstrap.json` 当自己的）。
 * 3. **目标缺 `.cycles` → 明确初始化，不静默跳过**：目标项目还没装过
 *    ai-native-iteration-cycle 技能时，用户得到的是「先装技能 + 跑
 *    init-workflow」的**可执行建议**，而不是一个含糊的失败码。
 *
 * ## 为什么不复用「源工作区的 scriptsDir」
 *
 * 技能脚本目录（`resolveSkillScriptsDir(roots)`）是**技能副本**的位置 ——
 * 目标项目未必装过技能。若目标没装，就用**插件自带的技能副本**
 * （`assets/skill/`）来跑，因为「举他」的语义是「把这个项目的流程跑起来」，
 * 而不是「把目标项目的技能升级掉」。目标若自己装了技能，优先用目标的
 * （它可能更新）—— 这个优先级写在 `resolveTargetScriptsDir` 的注释里。
 *
 * ## 边界
 *
 * - **只读**源工作区（取指纹），不写。
 * - 目标路径必须是**绝对路径**且**存在**（避免在错误的地方凭空造 `.cycles/`）。
 * - 不做「递归举他」（在目标项目里再举第三个项目）—— 那是另一件事。
 */
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSkillScriptsDir } from '../skillInvoker.ts';
import { pluginAssetDir } from '../pluginRoot.ts';
// 指纹实现已拆至 crossFingerprint.ts（T3 ≤250 行）；此处再导出保持导入路径不变。
export { fingerprintCycles, sameFingerprint } from './crossFingerprint.ts';
export type { FingerprintEntry, WorkspaceFingerprint } from './crossFingerprint.ts';

/** 跨项目自举的靶标解析结果。 */
export interface CrossTarget {
  /** 目标工作区根（绝对路径）。 */
  targetRoot: string;
  /** 目标 `.cycles` 目录。 */
  targetCyclesDir: string;
  /** 目标上的技能脚本目录（目标自带优先，否则用插件自带副本）。 */
  scriptsDir: string;
  /** 技能来源：'target' = 目标自己装了；'plugin' = 用插件自带副本。 */
  scriptsSource: 'target' | 'plugin';
}

/** 靶标解析失败的原因。 */
export type CrossTargetError =
  | 'ANIC_CROSS_TARGET_MISSING'
  | 'ANIC_CROSS_TARGET_NOT_DIR'
  | 'ANIC_CROSS_TARGET_RELATIVE'
  | 'ANIC_CROSS_NO_SKILL';

/** 解析失败的详情。 */
export interface CrossTargetFailure {
  error: CrossTargetError;
  message: string;
  /** 可执行的补救建议（不是含糊的「失败了」）。 */
  remedy: string;
}

/**
 * 解析跨项目自举的靶标。
 *
 * @param targetWorkspace 目标工作区（**绝对路径**）
 * @param currentRoot 当前（源）工作区 —— 用于「目标==源」的短路判定
 */
export function resolveCrossTarget(
  targetWorkspace: string,
  currentRoot: string | null,
): { ok: true; target: CrossTarget } | { ok: false; failure: CrossTargetFailure } {
  if (typeof targetWorkspace !== 'string' || targetWorkspace.trim() === '') {
    return {
      ok: false,
      failure: {
        error: 'ANIC_CROSS_TARGET_MISSING',
        message: 'target workspace is required',
        remedy: '提供 targetWorkspace（绝对路径），例如 { "targetWorkspace": "<项目根绝对路径>" }',
      },
    };
  }
  const trimmed = targetWorkspace.trim();
  if (!path.isAbsolute(trimmed)) {
    return {
      ok: false,
      failure: {
        error: 'ANIC_CROSS_TARGET_RELATIVE',
        message: `target workspace must be an absolute path: ${trimmed}`,
        remedy: '改传绝对路径（相对路径会随宿主 cwd 漂移，可能在错误的地方创建 .cycles/）',
      },
    };
  }
  const targetRoot = path.resolve(trimmed);
  if (!existsSync(targetRoot)) {
    return {
      ok: false,
      failure: {
        error: 'ANIC_CROSS_TARGET_MISSING',
        message: `target workspace does not exist: ${targetRoot}`,
        remedy: '先创建目标目录（或指向已存在的项目根）再发起跨项目自举',
      },
    };
  }
  if (!statSync(targetRoot).isDirectory()) {
    return {
      ok: false,
      failure: {
        error: 'ANIC_CROSS_TARGET_NOT_DIR',
        message: `target workspace is not a directory: ${targetRoot}`,
        remedy: 'targetWorkspace 必须是项目目录，不是文件路径',
      },
    };
  }
  // 目标 == 源：这不是「举他」，是自举自己。明确区分，避免用户以为跨了项目。
  if (currentRoot !== null && path.resolve(currentRoot) === targetRoot) {
    return {
      ok: false,
      failure: {
        error: 'ANIC_CROSS_TARGET_MISSING',
        message: 'target workspace is the current workspace (not a cross-workspace bootstrap)',
        remedy: '若要对当前项目自举，请用 /anic/self/evaluate',
      },
    };
  }

  const targetCyclesDir = join(targetRoot, '.cycles');
  // 技能来源优先级：目标自带的 > 插件自带副本。
  // 理由：目标自带的可能更新；没有则用插件随附的副本，语义是「把这个项目
  // 的流程跑起来」，不是「升级目标项目的技能」。
  //
  // ⚠️ `resolveSkillScriptsDir` 的候选链**不止目标自带**：它还会回落到
  // cwd 与 inline（插件内置）副本。所以它的返回值**不能**直接当作
  // 「目标自带」——必须**逐候选**判定来源，否则 scriptsSource 会说谎
  // （实测：临时工作区在 cwd 有 `.dsh/skills/...` 时会被标成 'target'）。
  const targetOwn = join(targetRoot, '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts');
  const resolved = resolveSkillScriptsDir(targetRoot);
  let scriptsDir: string | null = null;
  let scriptsSource: CrossTarget['scriptsSource'] = 'plugin';
  if (resolved !== null && resolved === targetOwn) {
    scriptsDir = resolved;
    scriptsSource = 'target';
  } else if (resolved !== null) {
    // 命中的是 cwd / inline / 仓库父目录候选 —— 归为 'plugin'（非目标自带）。
    scriptsDir = resolved;
    scriptsSource = 'plugin';
  } else {
    let pluginScripts: string | null = null;
    try {
      const assetDir = pluginAssetDir('skill');
      const candidate = join(assetDir, 'scripts');
      if (existsSync(candidate)) pluginScripts = candidate;
    } catch {
      pluginScripts = null;
    }
    scriptsDir = pluginScripts;
  }
  if (!scriptsDir) {
    return {
      ok: false,
      failure: {
        error: 'ANIC_CROSS_NO_SKILL',
        message: 'no skill scripts available for the target workspace',
        remedy: '在目标项目安装 ai-native-iteration-cycle 技能，或确认插件自带的 assets/skill/scripts 存在',
      },
    };
  }
  return {
    ok: true,
    target: { targetRoot, targetCyclesDir, scriptsDir, scriptsSource },
  };
}
