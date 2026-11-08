/**
 * Skill 调用网关 DSH 工具——anic_skill（全白名单通用网关）。
 *
 * 拆分自 tools.ts（T3 ≤250 行模块化纪律，truthAudit T3 结构守卫实测拦截 320 行）。
 * cycle-101：安装/修复域（anic_install/anic_skill_repair）再拆至 toolsSkillInstall.ts
 * （一域一文件；本文件只留「脚本调用网关」单一职责，touch 256→186 行）。
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
  } from './skillInvoker.ts';
import { normalizeQuickValidateArgs } from './skillQuickValidateArgs.ts';
import { loadFlowTracker, startFlow, markRunning, finishFlow } from './runtime/flowTracker.ts';
// cycle-99c：anic_skill 超时预算接单一事实源 bootstrapBudget——旧自写 `?? 60000`
// 对实测 74–93s 的 eval-runner 必 TIMEOUT（flow #158/#159），且 Infinity/NaN 无收口
// （Node 把 Infinity 视为 1ms → 子进程秒杀）。
import { defaultSkillTimeout, resolveSkillInvokeTimeout, skillTimeoutCap, BOOTSTRAP_STEP_TIMEOUT_MS, LONG_SCRIPT_TIMEOUT_MS } from './runtime/bootstrapBudget.ts';
import { skillPresentCall, skillPresentResult, terminalResult, genericCall, skillResultWithMeta } from './presentation.ts';

/** 注册技能域 DSH 工具（anic_skill 网关；安装域在 toolsSkillInstall.ts）。 */
export function registerSkillGatewayTools(
  tools: ToolsSlot,
  deps: { getRoot: () => string | null; register: (tool: ToolRegistration) => (() => void) | null | undefined },
): Array<(() => void) | null> {
  const disposers: Array<(() => void) | null> = [];
  const register = deps.register; // 调用方已在槽位守卫后收窄（tools.ts `!tools?.register`）

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
            + 'NOTICE: quick-validate is the one script whose first positional is the SKILL DIR '
            + '(e.g. "assets/skill" — the gateway resolves it to the installed copy), not the project dir.',
        },
        timeout: { type: 'number', description: `Timeout ms (default per-script: long-running scripts (auto-fix-loop) get ${LONG_SCRIPT_TIMEOUT_MS}; others ${BOOTSTRAP_STEP_TIMEOUT_MS}; cap = the script's own budget)` },
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
      // 唯一例外（cycle-31 契约 + cycle-39 T-3902 修正）：quick-validate 的
      // 第一个位置参数**本来就是 SKILL DIR**（任何形态——"assets/skill" 相对 /
      // 绝对路径），绝不是工作区——不参与重定向判定。
      // cycle-112：判定不再要求 rawArgs 非空——**无参调用**此前把项目根当技能目录
      // 校验（真机实证 2026-11-02 flow：「Directory: D:\...\dsh-anic Total files:
      // 10226 ... 65 errors」⇒ 必 FAIL），被健康模型记成脚本失败（7/14）。
      // 现在无参 / 首参是旗标时自动补省缺技能根，首参是技能相对形态时照旧解析。
      const isQuickValidate = script === 'quick-validate';
      let effectiveWs = ws;
      let extraArgs = rawArgs;
      let workspaceRedirect: string | undefined;
      if (!isQuickValidate && rawArgs.length > 0) {
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
      // cycle-99c：默认与上限同源 bootstrapBudget（与同步/异步入口、bootstrap 网关一致）。
      // cycle-112：默认/上限按脚本分档——auto-fix-loop 的合法上限 = 长跑预算
      // （旧实现统一 240000 ⇒ 5/6 次真机 TIMEOUT，实测 durationMs=240020）。
      const timeout = resolveSkillInvokeTimeout(
        typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : defaultSkillTimeout(script),
        skillTimeoutCap(script),
      );

      // cycle-39 T-3902（flow #29 实证）：quick-validate 的 skill-dir 相对形态
      // （"assets/skill"——工具描述与 SKILL.md 教的正是这个形态）在 spawn
      // cwd=scriptsDir 下被解析成 `<scripts>/assets/skill` 幽灵路径 → 必 404。
      // 处置：网关把相对 skill-dir 解析为**目标工作区已装技能根**的绝对路径再传
      // （语义：校验那份副本；未装则回退内联根——永远存在）。绝对形态原样透传。
      // 解析逻辑提取至 skillInvoker.resolveQuickValidateSkillDir（T3 行数纪律）。
      // cycle-112：规范化收进纯函数 normalizeQuickValidateArgs（可单测；无参调用
      // 不再把项目根当技能目录校验——真机"65 errors"假失败的根因）。
      if (isQuickValidate) {
        extraArgs = normalizeQuickValidateArgs(effectiveWs, extraArgs);
      }

      // M10-a：每流程状态跟踪——为每次调用创建独立 FlowRecord，
      // 持久化到 {workspace}/.cycles/flow-tracker.json，供 anic_status 查询和大模型自举审计。
      // 注意：重定向后流程记账落在**目标工作区**（调用作用域在哪，证据就落哪）。
      const cyclesDir = join(effectiveWs, '.cycles');
      if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });
      // cycle-101：startedAt 锚定 meta.durationMs——完成瞬间才存在的耗时事实。
      const startedAtMs = Date.now();
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

      // cycle-101（presentationMeta 投影器）：应持久化的呈现事实打进 meta——
      // 宿主把它持久化到 result.meta，回放时 terminalResult 的 meta 通道重建
      // exitCode/durationMs（直播/回放双路径，marker 尾巴 grep 友好）。
      // aborted 语义映射 cancelled（工具级取消是事实，回放必须可见）。
      // InvokeResult 无 signal 字段（只有 aborted 布尔）——不伪造 signal。
      // 统一经 skillResultWithMeta 收口（单一生产端，避免两处手写 meta 漂移）。
      return skillResultWithMeta({
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
        // skillResultWithMeta 从这两个字段派生 meta（cancelled/exitCode）
        ...(result.aborted ? { cancelled: true } : {}),
      }, { script, startedAt: startedAtMs });
    }),
  }) ?? null);

  // Tool: anic_bootstrap_cycle + anic_bootstrap_analyze（M10-b/c 自举编排）
  // 已拆分至 toolsBootstrapGateway.ts（T3 254→169 行）。

  return disposers;
}
