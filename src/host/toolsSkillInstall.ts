/**
 * Skill 安装域 DSH 工具——anic_install + anic_skill_repair。
 *
 * cycle-101 从 toolsSkillGateway.ts 拆出（T3 250 行守触线 256>250）：
 * 安装/修复是「技能工件管理」域，与「脚本调用网关」域（anic_skill）职责不同——
 * 一域一文件纪律。槽位形状（ToolRegistration/ToolsSlot）仍在 toolsSlot.ts。
 */

import { join } from 'node:path';
import type { ToolRegistration, ToolsSlot } from './toolsSlot.ts';
import { safeHandler, makeToolOutput } from './toolsSlot.ts';
import { autoInstallSkill, isSkillInstalled, inlineSkillRoot } from './skillInvoker.ts';
import { verifySkillInstall, repairSkillInstall } from './skillIntegrity.ts';
import { genericCall } from './presentation.ts';

/** 注册技能安装域 DSH 工具（anic_install/anic_skill_repair）。 */
export function registerSkillInstallTools(
  tools: ToolsSlot,
  deps: { getRoot: () => string | null; register: (tool: ToolRegistration) => (() => void) | null | undefined },
): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];
  const register = deps.register; // 调用方已在槽位守卫后收窄（tools.ts `!tools?.register`）

  // Tool: anic_install — install/update the bundled skill into workspace
  // （原生执行 autoInstallSkill，不再只回 URL——「所有内容脚本能原生调用」的
  //   前置：先把技能装进工作区；installUrl 保留作浏览器入口兼容。
  //   eco P0：安装即建锚——返回 integrity（inline 直比 + 清单兜底）。）
  disposers.push(register({
    name: 'anic_install',
    description: 'Use when a workspace lacks the ai-native-iteration-cycle skill or has an outdated version — '
      + 'before first use in a fresh project, or when skill scripts are not found. '
      + 'Triggers: 安装技能 / install skill / 初始化 anic / skill not found / 技能版本.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory' },
      },
    },
    presentCall: (args) => genericCall('anic_install', 'edit', { workspace: args.workspace }),
    presentResult: () => ({ card: 'generic' as const, title: 'anic_install ✓' }),
    execute: safeHandler(async (args) => {
      const root = (args.workspace as string) ?? deps.getRoot() ?? '';
      if (!root) return { error: 'no workspace' };
      // 只做形状校验（拒绝路径遍历），不要求目录已存在——安装本身就是
      // 把技能装进（可能尚不存在的）全新工作区的引导动作，autoInstallSkill
      // 会 mkdirSync recursive；先跑 validateWorkspace 会让安装永远无法
      // bootstrap 新目录（vitest 实测 installed=undefined）。
      if (root.includes('..')) return { error: 'path traversal not allowed' };
      const r = autoInstallSkill(root);
      return {
        installed: r.installed,
        path: r.path,
        error: r.error ?? null,
        skillInstalled: isSkillInstalled(root),
        // eco P0：安装后立即校验（inline 权威直比），漂移当场暴露而非潜伏到评估期
        integrity: r.installed ? verifySkillInstall(r.path, inlineSkillRoot()) : null,
        installUrl: `/anic/skill/install?workspace=${encodeURIComponent(root)}`,
      };
    }),
  }) ?? null);

  // Tool: anic_skill_repair — eco P0 repair 语义（doctor 见 anic_status/skill status）。
  // 只重装差异文件（缺失/尺寸/哈希不对），清单随修复重写；extras 只报告不删除。
  disposers.push(register({
    name: 'anic_skill_repair',
    description: 'Use when the installed ai-native-iteration-cycle skill copy is corrupted or drifted from the '
      + 'bundled original — after anic_status or skill status reports integrity mismatches, or skill scripts '
      + 'behave unexpectedly after manual edits. Triggers: 修复技能 / repair skill / 技能损坏 / 技能副本 / 完整性.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target project directory (default: current workspace)' },
      },
    },
    presentCall: (args) => genericCall('anic_skill_repair', 'edit', { workspace: args.workspace }),
    presentResult: () => ({ card: 'generic' as const, title: 'anic_skill_repair ✓' }),
    execute: safeHandler(async (args) => {
      const root = (args.workspace as string) ?? deps.getRoot() ?? '';
      if (!root) return { error: 'no workspace' };
      if (root.includes('..')) return { error: 'path traversal not allowed' };
      const installedDir = join(root, '.dsh', 'skills', 'ai-native-iteration-cycle');
      if (!isSkillInstalled(root)) return { error: 'skill not installed (run anic_install first)' };
      const r = repairSkillInstall(installedDir, inlineSkillRoot());
      return {
        repairedCount: r.repaired.length,
        repaired: r.repaired,
        integrity: r.verify,
      };
    }),
  }) ?? null);

  return disposers;
}
