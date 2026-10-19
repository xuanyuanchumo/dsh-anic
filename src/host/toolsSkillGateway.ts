/**
 * Skill-domain DSH tools — anic_install（原生安装引导）+ anic_skill（全白名单通用网关）。
 *
 * 拆分自 tools.ts（T3 ≤250 行模块化纪律，truthAudit T3 结构守卫实测拦截 320 行）。
 * 工具域拆分与「路由按端点拆」同构：eval/gate 命名工具留 tools.ts，
 * 技能调用域（安装 + 通用网关）独立成文件。
 *
 * 用户需求契约：**所有 15 个功能业务内容脚本必须能在 DSH 里原生调用** ——
 * anic_skill 的 script 枚举在运行时取自 listSkillScripts()（单一事实源），
 * 由 tests/unit/skillToolNative.test.ts 钉死（白名单 ⇄ 内联底座集合恰好相等）。
 *
 * SDO 纪律（superpowers writing-skills）：全部工具 description 只写触发条件
 * （Use when + 症状 + 触发词），不总结内部工作流——防 agent 抄 description 捷径。
 */
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { ToolRegistration, ToolsSlot } from './toolsSlot.ts';
import { safeHandler, makeToolOutput } from './toolsSlot.ts';
import {
  resolveSkillScriptsDir,
  invokeSkillScriptAsync,
  validateWorkspace,
  isAllowedScript,
  listSkillScripts,
  autoInstallSkill,
  isSkillInstalled,
  inlineSkillRoot,
} from './skillInvoker.ts';
import { verifySkillInstall, repairSkillInstall } from './skillIntegrity.ts';
import {
  loadFlowTracker,
  startFlow,
  markRunning,
  finishFlow,
} from './runtime/flowTracker.ts';
import {
  skillPresentCall,
  skillPresentResult,
  terminalResult,
  genericCall,
} from './presentation.ts';

/** 注册技能域 DSH 工具（anic_install/anic_skill）。 */
export function registerSkillGatewayTools(
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

  // Tool: anic_skill — 全部 15 个白名单业务脚本的原生 DSH 调用网关。
  // 覆盖性契约：脚本枚举在运行时取自 listSkillScripts()（单一事实源，
  // 绝不在 schema 里手抄第二份数组——两份有序列表必然漂移）。
  // 安全模型与 HTTP 网关 /anic/skill/invoke 一致：白名单 + workspace 校验 +
  // 超时上限；stdout/stderr 截断防超大响应。
  disposers.push(register({
    name: 'anic_skill',
    description: 'Use when a specific whitelisted ai-native-iteration-cycle skill script must be invoked natively — '
      + 'e.g. init-workflow, org-status, band-detector, multi-agent-gate, quick-validate, fact-base-verify, '
      + 'or any script needing custom CLI args. Triggers: 调用技能脚本 / run skill script / 技能脚本名 / '
      + '点名脚本带自定义参数 / 脚本跑一下.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'Skill script name (whitelisted, without .mjs)',
          enum: listSkillScripts(),
        },
        workspace: { type: 'string', description: 'Target project directory (default: current workspace)' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra CLI args appended after the positional project dir. '
            + 'NOTICE (cycle-31): quick-validate is the one script whose first positional is the SKILL DIR '
            + '(assets/skill), not the project dir — pass it here as args: ["assets/skill"]',
        },
        timeout: { type: 'number', description: 'Timeout ms (default 60000, hard cap 120000)' },
      },
      required: ['script'],
    },
    presentCall: skillPresentCall,
    presentResult: skillPresentResult,
    execute: safeHandler(async (args, exec) => {
      const script = String(args.script ?? '');
      if (!isAllowedScript(script)) {
        return { error: `script not whitelisted: ${script}`, allowed: listSkillScripts() };
      }
      const ws = (args.workspace as string) ?? deps.getRoot() ?? '';
      const check = validateWorkspace(ws);
      if (!check.ok) return { error: check.error };
      const scriptsDir = resolveSkillScriptsDir(ws);
      if (!scriptsDir) {
        return { error: 'skill scripts not found (run anic_install first, or set ANIC_SKILL_DIR)' };
      }
      const rawArgs = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
      // cycle-38（T-3805）跨项目调用人体工学：真机 flow #22-27 六连失败实证——
      // 调用方把目标项目绝对路径放进 args（如 args:["D:\\...\\dsh-codegraph-visualizer","status"]），
      // 而网关已把 workspace 作为第一个位置参数前置，脚本收到 2 个位置参数即拒绝。
      // 唯一例外：quick-validate 的第一个位置参数本来就是 SKILL DIR（cycle-31 契约，
      // "assets/skill" 相对形态），不能误吞。
      // 处置：args 首位是绝对路径形态（盘符/反斜杠/正斜杠开头）且非 quick-validate 时，
      // 视为「调用方想换目标工作区」——把它移到 workspace 参数并告警说明（不静默：
      // 告警行进入 stdout 让调用方看见发生了什么）。
      const quickValidateSkillDir = script === 'quick-validate' && rawArgs.length > 0 && /^[.]/.test(rawArgs[0] ?? '');
      let effectiveWs = ws;
      let extraArgs = rawArgs;
      let workspaceRedirect: string | undefined;
      if (!quickValidateSkillDir && rawArgs.length > 0) {
        const first = rawArgs[0] ?? '';
        const looksLikePath = /^[A-Za-z]:[\\/]/.test(first) || first.startsWith('/') || first.startsWith('\\');
        if (looksLikePath) {
          const redirect = validateWorkspace(first);
          if (redirect.ok) {
            effectiveWs = first;
            extraArgs = rawArgs.slice(1);
            workspaceRedirect = first;
          }
          // 非法路径（不存在/不是目录）→ 不吞，让脚本侧的数量守卫报错（更精确的失败信息）。
        }
      }
      const timeout = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 60000;

      // M10-a：每流程状态跟踪——为每次调用创建独立 FlowRecord，
      // 持久化到 {workspace}/.cycles/flow-tracker.json，供 anic_status 查询和大模型自举审计。
      // 注意：重定向后流程记账落在**目标工作区**（调用作用域在哪，证据就落哪）。
      const cyclesDir = join(effectiveWs, '.cycles');
      if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });
      let trackerState = loadFlowTracker(cyclesDir);
      const { state: startedState, flowId } = startFlow(cyclesDir, trackerState, script, effectiveWs, extraArgs);
      trackerState = startedState;

      // P3：INVOKING → RUNNING 的真实分界——脚本目录已解析、spawn 即将发生。
      trackerState = markRunning(cyclesDir, trackerState, flowId);

      // P1-EXEC-SIGNAL：异步调用 + exec.signal 传播（不阻塞宿主事件循环；可取消）。
      // 重定向后技能脚本目录也按目标工作区解析（workdir 本地副本优先语义不变）。
      const effectiveScriptsDir = workspaceRedirect ? (resolveSkillScriptsDir(effectiveWs) ?? scriptsDir) : scriptsDir;
      const result = await invokeSkillScriptAsync(effectiveScriptsDir, script, extraArgs, effectiveWs, timeout, { signal: exec?.signal });

      trackerState = finishFlow(cyclesDir, trackerState, flowId, result);

      return {
        flowId,
        script: result.script,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        ...(result.aborted ? { aborted: true } : {}),
        ...(workspaceRedirect ? { workspaceRedirected: workspaceRedirect } : {}),
        ...(workspaceRedirect
          ? { note: 'first positional arg looked like a project dir — moved to workspace parameter and removed from args (see workspaceRedirected)' }
          : {}),
        durationMs: result.durationMs,
        stdout: result.stdout.slice(0, 8000),
        stderr: result.stderr.slice(0, 4000),
      };
    }),
  }) ?? null);

  // Tool: anic_bootstrap_cycle + anic_bootstrap_analyze（M10-b/c 自举编排）
  // 已拆分至 toolsBootstrapGateway.ts（T3 254→169 行）。

  return disposers;
}
