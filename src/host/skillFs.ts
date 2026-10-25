/**
 * 技能目录树原语（cycle-77 T3 从 skillIntegrity.ts 拆出，以守住「单文件 ≤250 行」纪律）。
 *
 * 被拆原因与守卫缺陷无关，纯属模块纪律：F-07/F-08 判定逻辑加入后 skillIntegrity.ts
 * 越过 250 行上限（truthAudit T3）。这里只放「目录树遍历 + sha256」三个无状态原语，
 * 不持有任何判定语义 —— 判定留在 skillIntegrity.ts（doctor/repair）与 skillDrift.ts
 * （双轨/extras 判定）。sha256 实现全仓唯一（G-SINGLE 语义），避免出现第二套哈希源。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const SKILL_MANIFEST_FILE = '.anic-manifest.json';

/** 清单元数据视图（path + size + sha256；版本锚点由 SkillManifest 承载）。 */
export interface SkillFileEntry {
  path: string;
  size: number;
  sha256: string;
}

/** 文件 sha256（唯一哈希实现；调用方不要另起一套）。 */
export function hashFile(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/** 递归收集相对 POSIX 路径（排序保确定性；排除清单文件自身）。 */
export function walkRelPaths(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === SKILL_MANIFEST_FILE) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(relative(root, abs).split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}

/** 单个相对路径的清单条目（大小 + 哈希）。 */
export function entryOf(root: string, rel: string): SkillFileEntry {
  const abs = join(root, ...rel.split('/'));
  return { path: rel, size: statSync(abs).size, sha256: hashFile(abs) };
}
