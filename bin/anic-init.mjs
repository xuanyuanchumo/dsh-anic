#!/usr/bin/env node
/**
 * bin/anic-init.mjs — npx 技能-only 分发入口（cycle-25，eco 研究报告 P1）。
 *
 * 面向不用 DSH 宿主的 Claude Code / Codex / 任意 MCP 客户端用户：
 *   npx dsh-anic init <project-dir> [--name "<项目名>"] [--framework claude|codex] [--dry-run]
 *
 * 只做两件事（「插件装引擎，本入口装工作流」的分层）：
 *   1. 把 assets/skill/ 整目录复制到 <project-dir>/.dsh/skills/ai-native-iteration-cycle/
 *      （与 DSH 插件内 anic_install 的落点同构——DSH 用户无需本入口）；
 *   2. 调 init-workflow.mjs 生成 .cycles/ 骨架（幂等：已有文件不覆盖）。
 *
 * 之后用户可：
 *   - 让模型读 .dsh/skills/ai-native-iteration-cycle/SKILL.md 采用本技能；
 *   - 或把 scripts/mcp-server.mjs 注册为 MCP server（node <skill>/scripts/mcp-server.mjs）。
 *
 * 纪律：
 *   - 零依赖（只用 node: 内置模块）——npx 下载即用，不装依赖树；
 *   - 幂等：技能目录已存在且版本相同 → 跳过复制只汇报；.cycles 已初始化 → 不覆盖；
 *   - dry-run：只打印将要发生的动作，不写盘；
 *   - 版本锚点：从 SKILL.md MCP Tools vX 读取，汇报装的是什么版本。
 */
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
/** 内联技能根：bin/ 的上一级就是包根（npx 缓存布局与源码布局同构）。 */
const PKG_ROOT = resolve(__dirname, '..');
const SKILL_SRC = join(PKG_ROOT, 'assets', 'skill');

/** 与技能侧 quick-validate 同一锚点：SKILL.md 正文「MCP Tools (vX.Y.Z)」。 */
function readSkillVersion(skillDir) {
  try {
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
    const m = /MCP Tools\s*\(v(\d+\.\d+\.\d+)\)/.exec(md);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { _: [], name: null, framework: 'claude', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') args.name = argv[++i];
    else if (a === '--framework') args.framework = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === 'init') { /* npx dsh-anic init <dir> 的子命令词，忽略 */ }
    else args._.push(a);
  }
  return args;
}

function help() {
  console.log(`Usage: npx dsh-anic init <project-dir> [options]

Install the ai-native-iteration-cycle skill (assets/skill/) into a project
and scaffold its .cycles/ workflow skeleton.

Options:
  --name "<name>"        Project name written into .cycles/config.yml
  --framework <name>     claude (CLAUDE.md) or codex (AGENTS.md) repo memory
  --dry-run              Print planned actions without writing

What you get:
  .dsh/skills/ai-native-iteration-cycle/   the skill (SKILL.md + 15 scripts + MCP server)
  .cycles/                                 workflow skeleton (intent/config/graph)

Then either:
  - let your model read .dsh/skills/ai-native-iteration-cycle/SKILL.md, or
  - register the MCP server: node .dsh/skills/ai-native-iteration-cycle/scripts/mcp-server.mjs`);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || args._.length === 0) {
    help();
    process.exit(args.help ? 0 : 1);
  }
  const projectDir = resolve(args._[0]);
  const skillDst = join(projectDir, '.dsh', 'skills', 'ai-native-iteration-cycle');

  if (!existsSync(SKILL_SRC)) {
    console.error(`[anic-init] internal error: bundled skill not found at ${SKILL_SRC}`);
    process.exit(1);
  }
  const srcVersion = readSkillVersion(SKILL_SRC);
  const alreadyInstalled = existsSync(join(skillDst, 'SKILL.md'));
  const installedVersion = alreadyInstalled ? readSkillVersion(skillDst) : null;

  console.log(`[anic-init] project: ${projectDir}`);

  // ── 1. 技能安装（幂等：同版本跳过，异版本重装覆盖） ─────────────────
  if (alreadyInstalled && installedVersion === srcVersion) {
    console.log(`[anic-init] skill already installed (v${installedVersion ?? '?'}), skipping copy`);
  } else if (alreadyInstalled) {
    console.log(`[anic-init] skill v${installedVersion ?? '?'} -> v${srcVersion ?? '?'}, reinstalling`);
    if (!args.dryRun) {
      mkdirSync(join(projectDir, '.dsh', 'skills'), { recursive: true });
      cpSync(SKILL_SRC, skillDst, { recursive: true });
    }
  } else {
    console.log(`[anic-init] installing skill v${srcVersion ?? '?'} -> ${skillDst}`);
    if (!args.dryRun) {
      mkdirSync(join(projectDir, '.dsh', 'skills'), { recursive: true });
      cpSync(SKILL_SRC, skillDst, { recursive: true });
    }
  }

  // ── 2. .cycles/ 骨架（init-workflow.mjs 自身幂等：已存在不覆盖） ────
  if (existsSync(join(projectDir, '.cycles', 'config.yml'))) {
    console.log('[anic-init] .cycles/ already initialized, skipping scaffold');
  } else {
    console.log('[anic-init] scaffolding .cycles/ workflow skeleton');
    if (!args.dryRun) {
      const initScript = join(skillDst, 'scripts', 'init-workflow.mjs');
      // init-workflow 落盘后从已装副本执行（npx 缓存生命周期不可依赖）。
      const fwd = ['--framework', args.framework];
      if (args.name) fwd.push('--name', args.name);
      execFileSync(process.execPath, [initScript, projectDir, ...fwd], { stdio: 'inherit' });
    }
  }

  console.log(`\n[anic-init] done. Next:`);
  console.log(`  1. point your model at ${alreadyInstalled || !args.dryRun ? skillDst : '<project>/.dsh/skills/ai-native-iteration-cycle'}/SKILL.md`);
  console.log(`  2. or register MCP: node "<skill>/scripts/mcp-server.mjs"`);
  if (args.dryRun) console.log('  (dry-run: nothing was written)');
}

main();
