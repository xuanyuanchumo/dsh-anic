/**
 * 工具出口 **无损 JSON** 契约（cycle-82 · 真机事故回归钉）。
 *
 * ## 被守卫的缺陷（真实宿主实测，不是推断）
 *
 * 调用 `anic_status` 得到：
 * `Error: tool "anic_status" returned invalid output: value is not lossless JSON`
 *
 * 根因：`analyzeSkillHealth()` 的 `ScriptHealth.recentSuccessRate?: number` 在
 * 「近 7 天无调用」时是 `undefined`（该字段语义就是"不可判定"，见 continuousLearning
 * 的 cycle-57 注释），被原样写进工具 canonical value；宿主 `visitJsonValue` 递归校验，
 * 遇 undefined 判非法 ⇒ **整个返回值被丢弃**，模型什么也看不到。
 *
 * ## 为什么必须是「逐个工具」而不是抽样
 *
 * 抽样只能证明被抽到的那个当前写法干净。本仓已有的同类教训：`truthAudit T4` 硬编码
 * 单文件计数漏报、`closure` 三族 → 四族时纯新面零覆盖。这里的要求更硬：
 * **每一个**注册工具都必须 `execute` 一遍并做 roundtrip 深比较 ——
 * 这样「新工具没走统一出口」「新字段又漏了」两类回归都会红。
 *
 * ## 反向自检（本仓纪律：恒绿守卫等于没有守卫）
 *
 * ① 未包装直通（绕过 wireGuard）时，含 undefined 的值必须被判非法 ——
 *    证明下面的绿不是「判定器哑了」；
 * ② `anic_status` 用**近 7 天无调用**的 FlowTracker 夹具，其原始返回值**确实**含
 *    undefined（先断言这一点），再断言包装后合法 —— 两态都要有。
 *
 * 只读：夹具写在系统临时目录下的 .cycles/，不触碰仓库（R-31）。
 *
 * ## ⚠ 脚本执行类工具的**危险面**（本轮实测踩到，必须写下来）
 *
 * 第一版把 `anic_bootstrap: [{}]` 直接喂给 execute（它内部用 `getRoot()`，而
 * `resolveWorkspaceRoots` 的最终兜底是 `process.cwd()`）——在仓库根跑测试时，
 * 它**真的**在 `.cycles/gates/ledger.json` 里追加了 4 条 `--record` 门禁记录。
 * `.cycles/**` 是本任务的禁改面：一次"只读"契约测试写出了真实审计证据。
 *
 * 处置（两层）：
 *   ① 造一个**带哨兵脚本**的假技能根并注入 `ANIC_SKILL_DIR` —— 该类工具在夹具
 *      workspace 里找到"/不存在"，`resolveSkillScriptsDir` 拒绝后返回 `{error}`，
 *      既不跑真脚本也不写任何账本。这样"执行类工具也有构造输入"与"只读"两者兼得；
 *   ② 末尾断言 `.cycles` 台账未被本次运行追加（用 mtime 与条数双证）——下次谁
 *      再往契约里塞真跑用例，这一条直接红。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLosslessJson } from '../../src/host/runtime/jsonSanitize.ts';
import { sanitizeToolValue, wireGuard, type ToolRegistration } from '../../src/host/toolsSlot.ts';
import { registerAnicTools } from '../../src/host/tools.ts';
import { registerStatusTool } from '../../src/host/toolsStatusGateway.ts';
import { analyzeSkillHealth } from '../../src/host/runtime/continuousLearning.ts';
import { initialFlowTrackerState, type FlowTrackerState } from '../../src/host/runtime/flowTracker.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REAL_LEDGER = join(REPO_ROOT, '.cycles', 'gates', 'ledger.json');

/** 记账快照（只读；用于收尾断言本次运行没有追加真实门禁记录）。 */
function ledgerFingerprint(): { size: number; entries: number } | null {
  try {
    const raw = readFileSync(REAL_LEDGER, 'utf8');
    const parsed = JSON.parse(raw) as { entries?: unknown[] };
    return { size: statSync(REAL_LEDGER).size, entries: Array.isArray(parsed.entries) ? parsed.entries.length : -1 };
  } catch {
    return null;
  }
}

/** 注册全部工具（stub 宿主：捕获注册定义，返回幂等 disposer）。 */
function registeredTools(): ToolRegistration[] {
  const captured: ToolRegistration[] = [];
  const ctx = {
    tools: {
      register: (t: ToolRegistration) => { captured.push(t); return () => undefined; },
    },
    workspaceRegistry: { list: () => [] },
  };
  registerAnicTools(ctx);
  return captured;
}

const TOOLS = registeredTools();

/** 夹具工作区（系统临时目录；仅 .cycles 结构，绝不写仓库）。 */
let WS = '';
/** 假技能根（有哨兵、**没有**可执行脚本 → 执行类工具走 error 分支，不真跑）。 */
let FAKE_SKILL = '';
/** 记账快照（beforeAll 取一次）。 */
let LEDGER_BEFORE: { size: number; entries: number } | null = null;

/**
 * 近 7 天无调用的 FlowTracker 夹具 —— 真机事故的**最小复现**。
 *
 * `startedAt` 取 30 天前 ⇒ `inAge` 窗口为空 ⇒ `recentSuccessRate: undefined`。
 * 这正是 cycle-57 的诚实语义（"当前状态不可判定"），也正是宿主拒绝的形态。
 */
function idleTracker(): FlowTrackerState {
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const state = initialFlowTrackerState();
  state.flows = [
    { flowId: 'eval-runner-1', script: 'eval-runner', workspace: WS, args: [], status: 'DONE', startedAt: old, endedAt: old, exitCode: 0, durationMs: 12 },
    { flowId: 'gate-check-1', script: 'gate-check', workspace: WS, args: [], status: 'FAILED', startedAt: old },
  ];
  state.counter = 2;
  return state;
}

let PREV_SKILL_DIR: string | undefined;

beforeAll(() => {
  LEDGER_BEFORE = ledgerFingerprint();
  WS = mkdtempSync(join(tmpdir(), 'anic-lossless-'));
  mkdirSync(join(WS, '.cycles', 'gates'), { recursive: true });
  // 夹具只给"能被 execute 正常读"的最小结构；不存在的文件由各工具自己兜底成 error 值。
  writeFileSync(join(WS, '.cycles', 'flow-tracker.json'), JSON.stringify(idleTracker()), 'utf8');
  writeFileSync(join(WS, '.cycles', 'workflow-state.json'), JSON.stringify({ currentCycle: 1, phase: 'build' }), 'utf8');
  writeFileSync(join(WS, '.cycles', 'gates', 'ledger.json'), JSON.stringify([]), 'utf8');
  // 假技能根：哨兵 `init-workflow.mjs` 在 ⇒ 解析器"认可"该目录（skillInvoker 的
  // SKILL_DIR_SENTINEL），但**没有** eval-runner/gate-check 等脚本 ⇒ 执行类工具
  // 全部走 "Script not found" 分支，既不跑真脚本也不写任何账本。
  FAKE_SKILL = mkdtempSync(join(tmpdir(), 'anic-fakeskill-'));
  mkdirSync(join(FAKE_SKILL, 'scripts'), { recursive: true });
  writeFileSync(join(FAKE_SKILL, 'scripts', 'init-workflow.mjs'), '// fake skill sentinel (no real scripts)\n', 'utf8');
  PREV_SKILL_DIR = process.env.ANIC_SKILL_DIR;
  // ★关键：把"内联/兜底真脚本"从解析链里摘掉——只留本假根（candidate 0）。
  process.env.ANIC_SKILL_DIR = FAKE_SKILL;
});

afterAll(() => {
  if (PREV_SKILL_DIR === undefined) delete process.env.ANIC_SKILL_DIR;
  else process.env.ANIC_SKILL_DIR = PREV_SKILL_DIR;
  for (const dir of [WS, FAKE_SKILL]) {
    if (dir !== '' && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('反向自检：未走统一出口的值确实非法（证明下面的绿不是判定器哑了）', () => {
  it('近 7 天无调用 ⇒ recentSuccessRate===undefined（夹具先自证形态）', () => {
    const report = analyzeSkillHealth(idleTracker());
    expect(report.scripts.length).toBeGreaterThan(0);
    const idle = report.scripts.filter((s) => s.recentSuccessRate === undefined);
    expect(idle.length, '夹具没有制造出 undefined —— 下面的回归断言会空转').toBeGreaterThan(0);
    expect(idle[0]?.level).toBe('insufficient');
  });

  it('该原始值被判非法；经 sanitizeToolValue 后合法（同一对象的两态对照）', () => {
    const raw = { health: analyzeSkillHealth(idleTracker()) };
    expect(isLosslessJson(raw), '原始值竟然合法 —— 夹具没复现真机形态').toBe(false);
    const safe = sanitizeToolValue(raw);
    expect(isLosslessJson(safe)).toBe(true);
    // 语义保留：脚本仍在，只是"没有 recentSuccessRate 这个字段"
    const scripts = (safe as { health: { scripts: Array<Record<string, unknown>> } }).health.scripts;
    expect(scripts.length).toBeGreaterThan(0);
    expect(Object.hasOwn(scripts[0] as object, 'recentSuccessRate')).toBe(false);
  });

  it('wireGuard 缺位 ⇒ 直通 execute 的返回值非法（包装确实在起作用）', async () => {
    const dirty: ToolRegistration = {
      name: 'anic_probe_dirty',
      description: 'probe',
      parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({ ok: 1, maybe: undefined }) as unknown as Record<string, unknown>,
    };
    // 未包装：值里有 undefined（宿主会拒）
    expect(isLosslessJson(await dirty.execute({}))).toBe(false);
    // 包装后：合法
    expect(isLosslessJson(await wireGuard(dirty).execute({}))).toBe(true);
  });
});

describe('anic_status 真机事故回归（近 7 天无调用的 FlowTracker）', () => {
  it('execute 返回值必须无损，且保留 statusUrl/flows/flowStats/health 四类事实', async () => {
    const registered: ToolRegistration[] = [];
    const dispose = registerStatusTool((t) => { registered.push(t); return () => undefined; }, () => WS);
    const tool = registered.find((x) => x.name === 'anic_status');
    expect(tool, 'anic_status 未注册').toBeDefined();
    // ★关键：走**注册面包装**（与生产路径同一条链），不是裸 execute
    const wrapped = wireGuard(tool as ToolRegistration);
    const value = await wrapped.execute({ workspace: WS });
    expect(isLosslessJson(value), 'anic_status 仍然返回非法值：' + JSON.stringify(value).slice(0, 400)).toBe(true);
    expect(typeof value.statusUrl).toBe('string');
    expect(Array.isArray(value.flows)).toBe(true);
    // health 在场（夹具里有 flows）且每个脚本项合法
    expect(value.health).not.toBeNull();
    const health = value.health as { scripts: Array<Record<string, unknown>> };
    expect(health.scripts.length).toBeGreaterThan(0);
    for (const s of health.scripts) expect(isLosslessJson(s)).toBe(true);
    // 可选字段的裁决语义：删除而不是 null
    const firstIdle = health.scripts.find((s) => s.level === 'insufficient');
    expect(firstIdle, '夹具未产生 insufficient 脚本').toBeDefined();
    expect(Object.hasOwn(firstIdle as object, 'recentSuccessRate')).toBe(false);
    for (const d of dispose) d?.();
  }, 30_000);
});

describe('逐个工具：execute → roundtrip 深比较（不抽样）', () => {
  /** 每个工具一组构造输入（只读面用 fixture 工作区；写侧面保持空输入以走守卫分支）。 */
  const CASES: Record<string, Array<Record<string, unknown>>> = {
    anic_status: [{ workspace: WS }, { workspace: WS, flowLimit: 3 }],
    anic_snapshot: [{ workspace: WS }],
    anic_self_check: [{ workspace: WS }],
    anic_hitl: [{ workspace: WS }],
    anic_evaluate: [{ workspace: WS }],
    anic_iterate: [{ workspace: WS, timeout: 5000 }],
    anic_gate_check: [{ workspace: WS, gate: 'G0' }],
    anic_bootstrap: [{}],
    anic_install: [{}, { workspace: '' }],
    anic_skill: [{}, { script: 'not-whitelisted' }],
    anic_skill_repair: [{ workspace: WS }, {}],
    anic_bootstrap_cycle: [{ workspace: WS, maxRounds: 1 }],
    anic_bootstrap_analyze: [{ workspace: WS, maxRounds: 1 }],
    // cycle-96 举他：目标用夹具工作区（= 会话工作区时会被 resolveCrossTarget 判「那是自举自己」
    // 而走 error 分支——这里用**不存在的目标**，保证只走守卫分支、不真跑脚本、不写仓库）。
    anic_bootstrap_other: [{ targetWorkspace: join(tmpdir(), 'anic-lossless-target-missing') }, {}],
    anic_flows_advance: [{ workspace: WS }],
    anic_flows_archive: [{ workspace: WS, list: true }],
    anic_flows_auto_fix: [{ workspace: WS, maxRetries: 0 }],
    anic_flows_gate_check: [{ workspace: WS, gate: 'G0' }],
    anic_flows_hitl: [{ workspace: WS, gate: 'H1' }],
    anic_tool_detail: [{ name: 'anic_status' }],
    anic_tools_search: [{ keyword: '' }],
    anic_autonomy_upgrade: [{ workspace: WS, target: 'L3', reason: 'probe' }],
    anic_autonomy_downgrade: [{ workspace: WS }],
    anic_reload_self: [{ workspace: WS, reason: 'probe' }],
  };

  it('注册面覆盖：每个注册工具都在 CASES 里有构造输入（漏一个即红——不抽样）', () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names.length).toBeGreaterThanOrEqual(20);
    const missing = names.filter((n) => CASES[n] === undefined);
    expect(missing, '新工具未纳入无损契约（出口防线可能被绕过）：' + missing.join(', ')).toEqual([]);
    // 反向：CASES 不得包含未注册的幽灵工具（防"加了用例没加工具"的假覆盖）
    const phantom = Object.keys(CASES).filter((n) => !names.includes(n));
    expect(phantom, 'CASES 引用了不存在的工具：' + phantom.join(', ')).toEqual([]);
  });

  it.each(TOOLS.map((t) => t.name))('%s：每次 execute 的返回值可无损回合', async (name) => {
    const base = TOOLS.find((t) => t.name === name) as ToolRegistration;
    const wrapped = wireGuard(base);
    const inputs = CASES[name] ?? [];
    expect(inputs.length, name + ' 没有构造输入').toBeGreaterThan(0);
    for (const args of inputs) {
      const value = await wrapped.execute(args);
      // ① 无损判定（宿主 visitJsonValue 同口径）
      expect(isLosslessJson(value), name + ' 返回值非无损 JSON：' + safePreview(value)).toBe(true);
      // ② roundtrip 深比较：JSON 文本 → 解析 → 与原值**深等**
      const roundtrip = JSON.parse(JSON.stringify(value)) as unknown;
      expect(roundtrip, name + ' roundtrip 不深等（丢了/改了字段）').toEqual(value);
      // ③ render 的模型可见文本也必须可解析且同形（ContentBlock[] 契约的下游）
      const blocks = base.output.render(args, value);
      expect(Array.isArray(blocks)).toBe(true);
      const text = (blocks[0] as { text: string }).text;
      expect(JSON.parse(text), name + ' render 文本不可还原返回值').toEqual(value);
    }
  }, 120_000);
});

/** 失败信息里给出可读预览（完整值可能很大）。 */
function safePreview(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 300);
  } catch {
    return String(v);
  }
}

/**
 * 只读自检：本契约**自己**不得在仓库 `.cycles/` 留下任何痕迹。
 *
 * 为什么必须自带这一条：第一版就是这么翻的 —— `anic_bootstrap: [{}]` 走了
 * `getRoot() → process.cwd()` 的兜底，在仓库根真跑了 `gate-check --record`，
 * 往 `.cycles/gates/ledger.json` 追加了 4 条 FAIL 记录。夹具层已经堵住了这条路径
 * （假技能根 + 无脚本），但**堵住不等于守得住**：下次谁再加一个执行类用例，
 * 这条断言会立刻红，而不是等人在审计日志里发现多出来的门禁记录。
 */
describe('只读自检：契约测试不得改写仓库 .cycles', () => {
  it('真实 ledger.json 的条数与字节数在本次运行前后不变', () => {
    if (LEDGER_BEFORE === null) {
      // 仓库里没有账本（干净检出）⇒ 本次运行也不得凭空造一个
      expect(ledgerFingerprint(), '本次运行凭空创建了 .cycles/gates/ledger.json').toBeNull();
      return;
    }
    const after = ledgerFingerprint();
    expect(after, '.cycles/gates/ledger.json 被本次测试删除/破坏').not.toBeNull();
    expect(after?.entries, '本次测试向真实门禁账本追加了记录（--record 真跑了）').toBe(LEDGER_BEFORE.entries);
    expect(after?.size, '真实门禁账本字节数变化').toBe(LEDGER_BEFORE.size);
  });
});
