/**
 * 项目事实采集的**读盘面**（cycle-89 · 从 bootstrapFacts.ts 拆出，守 T3 ≤250 行）。
 *
 * 纯 IO 函数集中在此，使 `bootstrapFacts.ts` 的 `collectProjectFacts` 只剩编排，
 * 纯函数（`diffFacts` / `factsDigest` / `activeVsArchived`）因此可被确定性单测
 * 钉死而不需要造磁盘 fixture。
 *
 * ## 边界（与 bootstrapFacts.ts 同口径）
 *
 * - 全部**只读**，不写任何文件。
 * - 采不到 → `null`/`false`/`[]`，绝不猜默认值（理由见 bootstrapFacts.ts 头注）。
 * - 归档只当历史：`readLatestEvalReport` 只扫活跃面（`cycles/`），绝不扫 `archive/`。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { safeReadFileSync } from '../../shared/fs-safe.ts';
import type { EvalReportFacts } from './bootstrapFacts.ts';

/** 读 JSON；缺失/坏形状 → null（不抛、不猜）。 */
export function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(safeReadFileSync(file));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 只认 `cycle-<n>` 形态的目录（`archive/` 里还有 manifest.json 等非循环文件）。 */
const CYCLE_DIR_RE = /^cycle-(\d+)$/;

/** 列出某目录下的循环目录名（升序按编号，而非字典序：cycle-10 不能排在 cycle-2 前）。 */
export function listCycleDirNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => CYCLE_DIR_RE.test(n))
      .filter((n) => {
        try { return statSync(join(dir, n)).isDirectory(); } catch { return false; }
      })
      .sort((a, b) => Number(CYCLE_DIR_RE.exec(a)![1]) - Number(CYCLE_DIR_RE.exec(b)![1]));
  } catch {
    return [];
  }
}

/** `git rev-parse HEAD` 的失败面必须被吃掉：非 git 工作区是**正常**形态，不是错误。 */
export function readGit(workspace: string): { head: string | null; dirty: boolean | null } {
  const run = (args: string[]): string | null => {
    try {
      const r = spawnSync('git', args, {
        cwd: workspace,
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      if (r.error || r.status !== 0) return null;
      return typeof r.stdout === 'string' ? r.stdout : null;
    } catch {
      return null;
    }
  };
  const headOut = run(['rev-parse', 'HEAD']);
  const head = headOut === null ? null : headOut.trim() || null;
  const statusOut = run(['status', '--porcelain']);
  // head 取不到就不是 git 仓库：此时连 dirty 也无意义（null，而不是 false）。
  const dirty = head === null || statusOut === null ? null : statusOut.trim().length > 0;
  return { head, dirty };
}

/** 技能版本：CHANGELOG 第一条 `## x.y.z` 标题。装好的副本优先，内联副本兜底。 */
export function readSkillVersion(workspace: string): string | null {
  const candidates = [
    join(workspace, '.dsh', 'skills', 'ai-native-iteration-cycle', 'CHANGELOG.md'),
    join(workspace, 'assets', 'skill', 'CHANGELOG.md'),
  ];
  for (const file of candidates) {
    const raw = safeReadFileSync(file);
    if (!raw) continue;
    const m = /^##\s+(\d+\.\d+\.\d+)/m.exec(raw);
    if (m && m[1] !== undefined) return m[1];
  }
  return null;
}

/**
 * 最新活跃循环的评估报告指纹。
 *
 * **只扫活跃面**（`cycles/`），绝不扫 `archive/`：归档循环的评估报告是历史证据，
 * 拿它当"最新评估"会把一个已被移出主视图的旧结论重新变成当前判据。
 */
export function readLatestEvalReport(
  cyclesDir: string,
  activeNames: string[],
): EvalReportFacts | null {
  for (let i = activeNames.length - 1; i >= 0; i--) {
    const name = activeNames[i];
    if (name === undefined) continue;
    const abs = join(cyclesDir, 'cycles', name, '项目评估报告.md');
    if (!existsSync(abs)) continue;
    try {
      const buf = readFileSync(abs);
      return {
        path: `.cycles/cycles/${name}/项目评估报告.md`,
        sha256: createHash('sha256').update(buf).digest('hex'),
        mtime: statSync(abs).mtime.toISOString(),
      };
    } catch {
      continue;
    }
  }
  return null;
}
