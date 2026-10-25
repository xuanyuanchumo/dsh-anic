/**
 * Skill script invoker — runs ai-native-iteration-cycle scripts via spawnSync.
 * Security: script whitelist + workspace path validation + timeout.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
// Q5 断环（cycle-16）：InvokeResult 的单一实现在异步伴生文件里，本文件只
// import type 单向引入（注意：静态 import 图扫描器按文本匹配 from-字面量，
// 注释里不要写带引号的相对路径，否则会被当成真实边）。
import type { InvokeResult } from './skillInvokerAsync.ts';
export type { InvokeResult } from './skillInvokerAsync.ts';
import { writeSkillManifest } from './skillIntegrity.ts';
// cycle-78 WS-B（原 cycle-77 F-06 遗留）：超时上限与自举每步预算**单一事实源**。
// 被修缺陷：本文件 spawnSync 原写死 Math.min(timeoutMs, 120000)，而异步伴生文件按
// 传入值执行 ⇒ 同一份 240000ms 自举预算在同步入口被砍成 120000ms（eval-runner 整
// 金字塔实测 57s+，冷启动余量被吃掉），两入口语义不对称。现在上限只有一处定义。
import { resolveSkillInvokeTimeout } from './runtime/bootstrapBudget.ts';

const SKILL_SCRIPTS = [
  'init-workflow',
  'init-cycle',
  'eval-runner',
  'gate-check',
  'auto-fix-loop',
  'multi-agent-gate',
  'hitl-audit',
  'band-detector',
  'gate-ledger',
  'workflow-state',
  'org-status',
  'quick-validate',
  'fact-base-verify',
  'plan-sync-check',
  'archive-cycle',
] as const;

export type SkillScriptName = (typeof SKILL_SCRIPTS)[number];

// （InvokeResult 形状见 skillInvokerAsync.ts —— Q5 断环后类型的单一实现处）

export function isAllowedScript(name: string): name is SkillScriptName {
  return (SKILL_SCRIPTS as readonly string[]).includes(name);
}

export function listSkillScripts(): SkillScriptName[] {
  return [...SKILL_SCRIPTS];
}

/** 技能 scripts 目录哨兵：任何有效技能 scripts 目录必含 init-workflow.mjs
 * （引导脚本 + 15 个白名单业务脚本的共同存在性证明；只查目录会接受损坏安装）。 */
const SKILL_DIR_SENTINEL = 'init-workflow.mjs';

/** Inline skill scripts bundled in dsh-anic/assets/skill/scripts/ (方案 C 底座). */
function inlineSkillScriptsDir(): string | null {
  // dist/host.js → ../../assets/skill/scripts (production)
  // src/host/skillInvoker.ts → ../../assets/skill/scripts (dev)
  const thisFile = typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
  for (const up of ['..', '../..', '../../..']) {
    const p = path.join(thisFile, up, 'assets', 'skill', 'scripts');
    if (fs.existsSync(path.join(p, SKILL_DIR_SENTINEL))) return p;
  }
  return null;
}

/**
 * 技能 scripts 目录解析 — **全插件唯一实现**（12 §1.3 路径无关；C 域一致性）。
 * 方案 C 混合查找：显式环境变量 → 外部（可升级）→ 内联底座（开箱即用）。
 * 每个候选都必须通过 init-workflow.mjs 哨兵检查，绝不接受裸目录。
 */
export function resolveSkillScriptsDir(workspaceDir: string): string | null {
  const candidates = [
    // 0. ANIC_SKILL_DIR 显式覆盖（用户明确意图 > 自动发现）
    process.env.ANIC_SKILL_DIR
      ? path.join(process.env.ANIC_SKILL_DIR, 'scripts')
      : null,
    // 1. workspace/.dsh/skills/ai-native-iteration-cycle/scripts（外部最新，优先）
    path.join(workspaceDir, '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts'),
    // 2. Repo root (parent of workspace，workspace 为仓库子目录时)
    path.join(workspaceDir, '..', '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts'),
    // 3. process.cwd()/.dsh/...（宿主进程从仓库根启动时的兼容候选）
    path.join(process.cwd(), '.dsh', 'skills', 'ai-native-iteration-cycle', 'scripts'),
    // 4. Inline bundled skill scripts（内联底座，兜底）
    inlineSkillScriptsDir(),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, SKILL_DIR_SENTINEL))) return c;
  }
  return null;
}

/** 检查技能是否已安装在工作区 .dsh/skills/ 中。 */
export function isSkillInstalled(workspaceDir: string): boolean {
  return fs.existsSync(
    path.join(workspaceDir, '.dsh', 'skills', 'ai-native-iteration-cycle', 'SKILL.md'),
  );
}

/** 将内联技能复制到工作区 .dsh/skills/（自动安装）。 */
export function autoInstallSkill(workspaceDir: string): { installed: boolean; path: string; error?: string; manifest?: { ok: boolean; fileCount: number } } {
  const targetDir = path.join(workspaceDir, '.dsh', 'skills', 'ai-native-iteration-cycle');
  const inlineDir = inlineSkillScriptsDir();
  if (!inlineDir) return { installed: false, path: targetDir, error: 'inline skill not bundled' };
  const skillRoot = path.join(inlineDir, '..'); // assets/skill/
  if (!fs.existsSync(skillRoot)) return { installed: false, path: targetDir, error: 'skill root not found' };

  // 创建目标目录
  fs.mkdirSync(targetDir, { recursive: true });

  // 递归复制
  function copyRecursive(src: string, dst: string): void {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copyRecursive(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }
  copyRecursive(skillRoot, targetDir);
  // eco P0：安装即建锚——清单（path+size+sha256+版本）随安装落盘，
  // 把完整性对比从评估期提前到安装期（doctor/repair 见 skillIntegrity.ts）。
  const manifest = writeSkillManifest(skillRoot, targetDir);
  return { installed: true, path: targetDir, manifest };
}

/** 插件内联技能根目录（assets/skill/）——真内联解析，绝不落入外部副本。
 * （skillInstallRoute 此前借 resolveSkillScriptsDir(cwd) 间接取内联，cwd 邻近
 * 存在外部副本时会解析到非内联目录——修复：以本函数为单一事实源。） */
export function inlineSkillRoot(): string | null {
  const scriptsDir = inlineSkillScriptsDir();
  return scriptsDir ? path.join(scriptsDir, '..') : null;
}

/**
 * quick-validate 相对 skill-dir 解析（cycle-39 T-3902，flow #29 实证修复）。
 *
 * 工具描述与 SKILL.md 教的 `args: ["assets/skill"]` 相对形态在 spawn
 * cwd=scriptsDir 下会被解析成 `<scripts>/assets/skill` 幽灵路径 → 必 404。
 * 本函数把相对 skill-dir 映射为**目标工作区已装技能根**的绝对路径：
 * - "assets/skill" → 技能根（repo 视角 assets/skill 装到工作区就是根本身）
 * - "assets/skill/scripts" → 根/scripts（子路径剥前缀）
 * - 绝对路径 / 其他形态 → 原样返回（null 表示无需重写）
 * 未装技能时回退内联根（永远存在）。纯函数（除 existsSync 探测）。
 */
export function resolveQuickValidateSkillDir(
  workspaceDir: string,
  arg: string,
): string | null {
  const looksAbsolute = /^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith('/') || arg.startsWith('\\');
  if (looksAbsolute) return null;
  const norm = arg.replace(/\\/g, '/').replace(/^\.\//, '');
  let rel = norm;
  if (norm === 'assets/skill') rel = '';
  else if (norm.startsWith('assets/skill/')) rel = norm.slice('assets/skill/'.length);
  else if (!norm.startsWith('.')) return null; // 非技能相对形态（如普通旗标误传）不动
  const installed = path.join(workspaceDir, '.dsh', 'skills', 'ai-native-iteration-cycle');
  const root = fs.existsSync(installed) ? installed : (inlineSkillRoot() ?? installed);
  return path.join(root, rel);
}

export function validateWorkspace(ws: string): { ok: boolean; error?: string } {
  if (!ws || typeof ws !== 'string') return { ok: false, error: 'workspace is required' };
  const resolved = path.resolve(ws);
  // Path traversal protection
  if (ws.includes('..')) return { ok: false, error: 'path traversal not allowed' };
  if (!fs.existsSync(resolved)) return { ok: false, error: 'workspace does not exist' };
  if (!fs.statSync(resolved).isDirectory()) return { ok: false, error: 'workspace is not a directory' };
  return { ok: true };
}

export function invokeSkillScript(
  scriptsDir: string,
  script: string,
  args: string[] = [],
  workspace: string,
  timeoutMs = 30000,
): InvokeResult {
  const scriptPath = path.join(scriptsDir, `${script}.mjs`);
  const start = Date.now();

  if (!fs.existsSync(scriptPath)) {
    return {
      script,
      exitCode: -1,
      stdout: '',
      stderr: `Script not found: ${scriptPath}`,
      timedOut: false,
      durationMs: Date.now() - start,
    };
  }

  // 项目目录 = 第一个位置参数（SKILL_SCRIPTS 白名单 15 个脚本的约定 args._[0]，
  // 转录自 mcp-server.mjs 的参考调用形态 `node <script> "<projectDir>" <args...>`；
  // cycle-27 后脚本总数 16——多出的 mcp-server 不在本白名单）。
  // 此前错误地追加 `--project-dir <ws>`：脚本不认识该旗标，把它当位置参数收进
  // args._[0]，解析出 <scriptsDir>/--project-dir 幽灵目录 —— 无任何测试变红
  // （单元测试只测状态机，从不真正调用脚本）。
  const result = spawnSync('node', [scriptPath, workspace, ...args], {
    // 上限 = MAX_SKILL_INVOKE_TIMEOUT_MS（= 自举每步预算 240000），与异步入口一致；
    // 非法值（NaN/Infinity/非正）由纯函数兜到上限，绝不把「永不超时」交给 spawnSync。
    timeout: resolveSkillInvokeTimeout(timeoutMs),
    encoding: 'utf-8',
    cwd: scriptsDir,
  });

  return {
    script,
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.signal === 'SIGTERM' || (result.status === null && result.signal !== null),
    durationMs: Date.now() - start,
  };
}

// 异步版（P1-EXEC-SIGNAL / P1-EVENT-LOOP）拆分至 skillInvokerAsync.ts；
// re-export 保持既有 import 路径稳定（tools*.ts / flows / orchestrator 均可两选一）。
export { invokeSkillScriptAsync, type InvokeOptions } from './skillInvokerAsync.ts';