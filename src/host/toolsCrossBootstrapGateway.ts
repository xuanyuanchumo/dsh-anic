/**
 * 「举他」工具（cycle-96 WS-B）—— `anic_bootstrap_other`：跨项目自举的工具面入口。
 *
 * ## 补的缺口（能力存在但 LLM 不可达）
 *
 * cycle-89 把跨项目自举做成 HTTP 端点 `POST /anic/self/bootstrap-other`，消费方只有
 * 外部调度器与运维 curl。实测 `grep bootstrap_other src/host/tools*.ts` **零命中**
 * ⇒ 模型没法「对另一个项目跑自举」。本文件把那项能力接进工具面。
 *
 * ## 三条不可让步的实现纪律
 *
 * 1. **in-process，绝不自调本仓 HTTP**：执行体 `runtime/crossBootstrapExecute.ts` 与路由
 *    用的是同一个 `runCrossBootstrap`。`closureAudit/channelRegistry.ts` 对每条通道
 *    声明的 reason 都写着「插件内部不自我调用该端点」——自调会让「源零写入」退化成
 *    「对自己发了个请求」的副作用，也让端点失去运维留痕的意义。
 * 2. **源零写入是**真实指纹**，不是自述**：`sourceFingerprint` / `sourceFingerprintAfter`
 *    都是 `fingerprintCycles('.cycles/**')` 的实际输出；`sourceUntouched` 由二者比对得出。
 *    源不可解析时为 `null`（降级），**绝不伪造成 true**。
 * 3. **目标路径只经 `resolveCrossTarget` 落地**：绝对路径 + 存在 + 是目录 + 非源工作区，
 *    四条判据都在那一处（本文件不自己拼路径）。
 *
 * ## 为什么从 `toolsBootstrapGateway.ts` 拆到本文件，且导出名**不以 register 开头**
 *
 * 拆文件：单文件 ≤250 行是本仓机械守卫（T3 / objectiveConformanceContract ⑪），
 * 塞回自举网关会让那个文件越线。拆出来仍是**同一域**（`tools*.ts` glob 覆盖，工具 id
 * 清单 / 能力索引 / 接线审计 / trigger-eval 四处扫描器都自动看见它）。
 *
 * 导出名 `buildCrossBootstrapTool`（**不是** `registerCrossBootstrapTool`）是刻意的：
 * `closureAudit/connectivity.ts` 的 `tools→gateways` 链跳会把每个 `tools*.ts` 里的
 * `export function register*` 枚举为**必须由 tools.ts 直接调用的注册器**。本工具的
 * 注册由自举网关聚合（一域一入口），若这里也叫 register*，那根链就会把「已聚合」
 * 误判成「断链」。取名区分的是**职责**（本文件只构造定义，不做注册编排）。
 */
import type { ToolRegistration, ToolsSlot } from './toolsSlot.ts';
import { safeHandler, makeToolOutput } from './toolsSlot.ts';
import { terminalCall, genericResult } from './presentation.ts';
import {
  runCrossBootstrap,
  resolveCrossSource,
  isCrossAction,
  CROSS_ACTIONS,
} from './runtime/crossBootstrapExecute.ts';

/**
 * 工具面对执行体结果的**显式投影**。
 *
 * 为什么不原样返回 HTTP 体：那里有 `target`/`stdout`/`stderr` 这类运维字段（最多 4KB
 * stdout），而模型需要的是「成功吗 / 目标裁决是什么 / **源有没有被写**」。投影是显式
 * 的一层，于是「工具返回什么」可以被契约逐字段断言，而不是从 HTTP 体里猜。
 *
 * `sourceUntouched` 三态：true = 两个真实指纹相同（得证）；false = 源被改了（响亮暴露）；
 * null = 源解析不到（没法证明）——「没法证明」与「证明了没写」是两件事。
 */
function projectCrossResult(
  action: string,
  targetWorkspace: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const error = body['error'];
  if (error !== undefined) {
    // 失败面：错误对象原样上抬（模型据此决定「改参数」还是「先 init 目标」）。
    return {
      ok: false, action, targetWorkspace, targetOutcome: error,
      exitCode: null, sourceFingerprint: null, sourceFingerprintAfter: null, sourceUntouched: null,
    };
  }
  return {
    ok: true,
    action: body['action'] ?? action,
    targetWorkspace,
    /** 目标裁决：只给结论与定位信息（stdout 留在 HTTP 面给运维看）。 */
    targetOutcome: {
      status: 'ran',
      flowId: body['flowId'] ?? null,
      score: body['score'] ?? null,
      verdict: body['verdict'] ?? null,
      scriptOutcome: body['outcome'] ?? null,
      bootstrapStatus: body['status'] ?? null,
      exitCode: body['exitCode'] ?? null,
      timedOut: body['timedOut'] ?? null,
      durationMs: body['durationMs'] ?? null,
      scriptsSource: (body['target'] as { scriptsSource?: unknown } | undefined)?.scriptsSource ?? null,
      // cycle-101：init 动作的诚实回报 —— 旧实现只 mkdir 就报 ok（假成功）。
      // 这里透出「脚本退出码 + 三个关键工件是否存在」，调用方可判真伪而不必再探目录。
      ...(action === 'init'
        ? {
            initOk: body['initOk'] ?? null,
            initExitCode: body['initExitCode'] ?? null,
            artifacts: body['artifacts'] ?? null,
          }
        : {}),
    },
    sourceFingerprint: body['sourceFingerprint'] ?? null,
    sourceFingerprintAfter: body['sourceFingerprintAfter'] ?? null,
    sourceUntouched: body['sourceUnchanged'] ?? null,
  };
}

/** 失败面返回值（三处提前返回共用，避免键集分叉）。 */
function failure(
  action: string, targetWorkspace: string, error: string, remedy?: string,
): Record<string, unknown> {
  return {
    ok: false, action, targetWorkspace, targetOutcome: null,
    exitCode: null, sourceFingerprint: null, sourceFingerprintAfter: null, sourceUntouched: null,
    error,
    ...(remedy === undefined ? {} : { remedy }),
  };
}

/** 构造 `anic_bootstrap_other` 定义（由自举网关聚合注册，保证注册序稳定）。
 *
 *  命名不用 `register*`：见文件头的「导出名」说明——`tools→gateways` 链跳只认
 *  `export function register*`，本文件不做注册编排，故不占用那个名字。 */
export function buildCrossBootstrapTool(
  _tools: ToolsSlot,
  deps: { getRoot: () => string | null; register: (tool: ToolRegistration) => (() => void) | null | undefined },
): (() => void) | null {
  return deps.register({
    name: 'anic_bootstrap_other',
    // SDO 纪律：description 只写触发条件与症状，不总结工作流。
    // 关键区分点写进正文：**不是当前项目**（那是 anic_bootstrap_cycle 的语义）。
    description: 'Use when the bootstrap/quality cycle must run on ANOTHER project (cross-workspace, '
      + '"举他") instead of the current one — e.g. initializing or evaluating a different repo, '
      + 'or proving the source workspace was left untouched. NOT for the current project '
      + '(use anic_bootstrap_cycle for that). '
      + 'Triggers: 举他 / 跨项目自举 / 另一个项目 / 那个项目 / 目标项目 / 源工作区零写入 / '
      + '证明没被写 / bootstrap another project / cross-workspace bootstrap / bootstrap-other.',
    output: makeToolOutput(),
    parameters: {
      type: 'object',
      properties: {
        targetWorkspace: {
          type: 'string',
          description: 'Target project directory (REQUIRED; absolute path; must already exist)',
        },
        action: {
          type: 'string',
          enum: [...CROSS_ACTIONS],
          description: `Action on the target: ${CROSS_ACTIONS.join(' | ')} (default evaluate)`,
        },
        workspace: {
          type: 'string',
          description: 'Source workspace (absolute; defaults to the current session workspace) '
            + '— only used to compute the "source untouched" fingerprints',
        },
      },
      required: ['targetWorkspace'],
    },
    // 呈现：终端卡片显示目标项目 + 动作（与既有脚本类工具同形态）。
    // 文案一律走 ASCII 标识符而非新增中文串：本工具不新增 locale 键（locale/*.json
    // 有单写权归属与 zh/en parity 契约），presentCall 里的中文硬编码会绕过 t()。
    presentCall: (args) => terminalCall(
      `anic_bootstrap_other: ${typeof args.action === 'string' ? args.action : 'evaluate'}`,
      typeof args.targetWorkspace === 'string' ? args.targetWorkspace : '?',
      `target=${typeof args.targetWorkspace === 'string' ? args.targetWorkspace : '?'}`,
    ),
    presentResult: () => genericResult('anic_bootstrap_other ✓'),
    // 脚本执行类：evaluate/gate-check 会跑真实技能脚本（可能数分钟）。
    timeoutMs: 300000,
    execute: safeHandler(async (args) => {
      const targetWorkspace = typeof args.targetWorkspace === 'string' ? args.targetWorkspace.trim() : '';
      // 动作面：未知动作**响亮拒绝**而不是回落 evaluate。
      // 工具面比 HTTP 面更严：模型把 "gate-check" 拼成 "gate_check" 时，静默跑成
      // evaluate 会返回「成功」而实际做的事完全不同——那是本仓最忌讳的假绿。
      const actionRaw = typeof args.action === 'string' ? args.action.trim() : 'evaluate';
      if (!isCrossAction(actionRaw)) {
        return failure(actionRaw, targetWorkspace,
          `unknown action "${actionRaw}"; expected one of: ${CROSS_ACTIONS.join(', ')}`);
      }
      // 源工作区：缺省 = 会话工作区；显式给了就必须绝对且存在（见 resolveCrossSource 注释）。
      const src = resolveCrossSource(args.workspace, deps.getRoot);
      if (!src.ok) return failure(actionRaw, targetWorkspace, src.message, src.remedy);

      const r = runCrossBootstrap({ sourceRoot: src.sourceRoot, targetWorkspace, action: actionRaw });
      return projectCrossResult(actionRaw, targetWorkspace, r.body);
    }),
  }) ?? null;
}
