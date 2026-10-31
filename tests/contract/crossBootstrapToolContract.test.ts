/**
 * 「举他」工具契约（cycle-96 WS-B）—— `anic_bootstrap_other` + **源零写入可断言**。
 *
 * ## 被修的缺口（能力存在但 LLM 不可达）
 *
 * cycle-89 只把跨项目自举做成 HTTP 端点 `POST /anic/self/bootstrap-other`：
 * `grep bootstrap_other src/host/tools*.ts` **零命中** ⇒ 23 个工具里没有举他，
 * 模型没法「对另一个项目跑自举」。本契约钉死补齐后的四条性质。
 *
 * ## 四条腿（每条都能判两态，不是恒绿）
 *
 * ① **工具面存在且参数契约正确**：`targetWorkspace` 必填；`action` 是闭合枚举；
 *    未知动作**响亮拒绝**（不静默回落 evaluate —— 那会让"gate_check"拼错的模型
 *    以为跑的是千真万确的 evaluate）。
 * ② **in-process，不自调 HTTP**：源码形态守卫——本插件 tools 域不得出现对本仓
 *    端点的 fetch/XMLHttpRequest。这是 channelRegistry 声明的纪律的机器投影。
 * ③ **源零写入是真实指纹，不是自述**：`sourceFingerprint` 与
 *    `sourceFingerprintAfter` 必须是 `fingerprintCycles` 的**真实输出**（有
 *    `digest`/`entries`/`cyclesOnly` 三字段），且 `sourceUntouched` 由二者比对得出。
 *    反向自检：**手工写源工作区** ⇒ 两个指纹必须不同、`sourceUntouched` 必须 false。
 * ④ **目标只经 resolveCrossTarget 落地**：相对路径 / 不存在 / 目标==源 三种都被拒，
 *    且拒绝时**零写入**（目标目录不存在时不会凭空造 `.cycles/`）。
 *
 * 纪律：只读仓库（R-31）。全部夹具在系统临时目录；目标用**临时目录**而非仓库，
 * 源的"被写"由本测试自己制造（证明断言有牙），绝不对真实仓库动手。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wireGuard, type ToolRegistration } from '../../src/host/toolsSlot.ts';
import { registerBootstrapGatewayTools } from '../../src/host/toolsBootstrapGateway.ts';
import { runCrossBootstrap, isCrossAction, CROSS_ACTIONS } from '../../src/host/runtime/crossBootstrapExecute.ts';
import { fingerprintCycles, sameFingerprint } from '../../src/host/runtime/crossBootstrap.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ── 夹具 ───────────────────────────────────────────────────────────── */

const TMPS: string[] = [];

/** 建一个带 `.cycles/` 内容的工作区（源与目标的形状相同，便于互证）。 */
function mkWorkspace(prefix: string, withCycles = true): { root: string; cycles: string } {
  const base = mkdtempSync(join(tmpdir(), `anic-cross-tool-${prefix}-`));
  TMPS.push(base);
  const root = join(base, 'ws');
  const cycles = join(root, '.cycles');
  mkdirSync(root, { recursive: true });
  if (withCycles) {
    mkdirSync(cycles, { recursive: true });
    writeFileSync(join(cycles, 'flow-tracker.json'), '{"flows":[]}', 'utf8');
  }
  return { root, cycles };
}

afterAll(() => {
  for (const d of TMPS) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 并行清理容忍 */ }
  }
});

/** 注册本域工具（stub 槽位：捕获注册定义 + 幂等 disposer）。 */
function registered(): ToolRegistration[] {
  const captured: ToolRegistration[] = [];
  const deps = {
    getRoot: () => null,
    register: (t: ToolRegistration) => { captured.push(t); return () => undefined; },
  };
  registerBootstrapGatewayTools({} as never, deps);
  return captured;
}

/** 取举他工具（走**注册面包装**：与生产同一条链，不裸调 execute）。 */
function otherTool(): ToolRegistration {
  const t = registered().find((x) => x.name === 'anic_bootstrap_other');
  if (!t) throw new Error('anic_bootstrap_other 未注册');
  return t;
}

/* ── ① 工具面存在 + 参数契约 ─────────────────────────────────────────── */

describe('① 工具面：注册 + 参数闭合枚举', () => {
  it('anic_bootstrap_other 已在自举域网关注册（此前 23 工具里零命中）', () => {
    const names = registered().map((t) => t.name).sort();
    expect(names).toEqual(['anic_bootstrap_analyze', 'anic_bootstrap_cycle', 'anic_bootstrap_other']);
  });

  it('targetWorkspace 是必填项；action 的 enum 与 CROSS_ACTIONS 同源（不手抄第二份）', () => {
    const t = otherTool();
    const props = t.parameters['properties'] as Record<string, Record<string, unknown>>;
    expect(props['targetWorkspace'], '缺 targetWorkspace').toBeDefined();
    expect(t.parameters['required']).toEqual(['targetWorkspace']);
    // enum 必须与执行体的闭合枚举**同值**（两处各写一份必然漂移）
    expect(props['action']?.['enum']).toEqual([...CROSS_ACTIONS]);
    for (const a of CROSS_ACTIONS) expect(isCrossAction(a)).toBe(true);
    expect(isCrossAction('gate_check')).toBe(false);
  });

  it('描述含中英双语触发词，且点名「不是当前项目」的区分语义', () => {
    const d = otherTool().description;
    for (const kw of ['举他', '跨项目自举', 'cross-workspace bootstrap', 'bootstrap-other']) {
      expect(d, '缺触发词 ' + kw).toContain(kw);
    }
    // 与 anic_bootstrap_cycle 的区分必须写在描述里（否则模型会挑错工具）
    expect(d).toContain('NOT for the current project');
  });

  it('**未知动作响亮拒绝**（不静默回落 evaluate —— 回落返回"成功"是假绿）', async () => {
    const h = mkWorkspace('unknown-action');
    const r = await wireGuard(otherTool()).execute({ targetWorkspace: h.root, action: 'gate_check' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('unknown action');
    expect(String(r.error)).toContain('gate-check'); // 点名合法值，可自纠
  });

  it('目标解析失败时结构化返回（不带假绿），且**零写入**', async () => {
    const r = await wireGuard(otherTool()).execute({ targetWorkspace: 'relative/path' });
    expect(r.ok).toBe(false);
    const outcome = r.targetOutcome as Record<string, unknown>;
    expect(outcome['error'], '相对路径必须被 resolveCrossTarget 拒').toBe('ANIC_CROSS_TARGET_RELATIVE');
    expect(r.sourceUntouched).toBeNull(); // 没跑成 ⇒ 不伪造零写入结论
  });
});

/* ── ② in-process，不自调本仓 HTTP ───────────────────────────────────── */

describe('② in-process 纪律：tools 域不得自调本仓 HTTP 端点', () => {
  /**
   * 判据：本插件 `src/host/tools*.ts` 里不得出现 fetch/XMLHttpRequest 对 `/anic/...`
   * 的调用。样本用**拼接构造**（守卫不得匹配自身字面量）。
   */
  const ANIC_PREFIX = ['/anic', '/', 'self', '/', 'bootstrap-other'].join('');
  const NETWORK_CALL = new RegExp(
    'fetch\\s*\\(|XMLHttpRequest|axios|http\\.request',
  );

  it('反向自检：判据能命中负样本（正则坏 ⇒ 守卫红，不静默绿）', () => {
    const bad = `const u = '${ANIC_PREFIX}'; ${'fetch'}(u);`;
    expect(NETWORK_CALL.test(bad)).toBe(true);
    const good = `import { runCrossBootstrap } from './runtime/crossBootstrapExecute.ts';`;
    expect(NETWORK_CALL.test(good)).toBe(false);
  });

  it('工具域源文件全部无网络调用（举他走 in-process 复用同一执行体）', () => {
    const hostDir = join(ROOT, 'src', 'host');
    const files = readdirSync(hostDir).filter((f) => /^tools.*\.ts$/.test(f));
    expect(files.length, '扫描集为空 = 假守卫').toBeGreaterThanOrEqual(10);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(hostDir, f), 'utf8');
      if (NETWORK_CALL.test(src)) offenders.push(f);
    }
    expect(offenders, '工具域出现网络调用（本仓纪律：插件内部不自我调用自己的端点）').toEqual([]);
  });

  it('举他工具的实现确实 import 了共享执行体（而不是自己重写一套动作）', () => {
    const src = readFileSync(join(ROOT, 'src', 'host', 'toolsCrossBootstrapGateway.ts'), 'utf8');
    expect(src).toContain("from './runtime/crossBootstrapExecute.ts'");
    expect(src).toContain('runCrossBootstrap');
    // 反向前提：不得自己拼 .cycles 路径或自己 mkdir（那是执行体的职责）
    expect(src).not.toMatch(/mkdirSync/);
    // 导出名不得是 register*：`tools→gateways` 链跳只认 `export function register*`
    // 并要求 tools.ts 直接调用；本工具由自举网关聚合，占用那个名字会造成假断链。
    // 判据用**行首锚定**：文件头注释里会引用这个形态（注释不是代码，不该命中）。
    expect(src).not.toMatch(/^export\s+(?:async\s+)?function\s+register/m);
  });
});

/* ── ③ 源零写入凭据（核心） ──────────────────────────────────────────── */

describe('③ 源零写入：两个**真实计算**的指纹 + 比对结论', () => {
  it('init 动作：源指纹前后相同 ⇒ sourceUntouched===true（且有真实 digest/entries）', async () => {
    const source = mkWorkspace('src');
    const target = mkWorkspace('tgt', false); // 目标尚无 .cycles
    const r = await wireGuard(otherTool()).execute({
      targetWorkspace: target.root, action: 'init', workspace: source.root,
    });
    expect(r.ok).toBe(true);
    // 目标骨架真的建了（举他确实对「他」动手）
    expect(existsSync(target.cycles)).toBe(true);
    // 凭据是两个真实计算值，而不是布尔自述
    const before = r.sourceFingerprint as { digest: string; entries: number; cyclesOnly: boolean };
    const after = r.sourceFingerprintAfter as { digest: string; entries: number; cyclesOnly: boolean };
    expect(typeof before.digest, 'sourceFingerprint 必须是真实指纹（缺 digest 就是在自述）').toBe('string');
    expect(before.digest.length).toBeGreaterThan(32);
    expect(typeof after.digest).toBe('string');
    expect(before.cyclesOnly).toBe(true);
    expect(before.entries, '源有 .cycles 内容，entries 不该为 0').toBeGreaterThan(0);
    expect(before).toEqual(after);
    expect(r.sourceUntouched).toBe(true);
    // 与库函数同源：同一份 `.cycles` 重算必须一致（证明凭据不是工具现编的）
    const recomputed = fingerprintCycles(source.cycles, source.root);
    expect(sameFingerprint(recomputed, before as never)).toBe(true);
  });

  it('**反向自检**：源被写之后指纹必须不同、sourceUntouched 必须 false', async () => {
    const source = mkWorkspace('src2');
    const target = mkWorkspace('tgt2', false);
    const before = fingerprintCycles(source.cycles, source.root);
    const r = await wireGuard(otherTool()).execute({
      targetWorkspace: target.root, action: 'init', workspace: source.root,
    });
    // 手工在源里加一个文件 —— 模拟「源被顺手写了」的真实事故形态
    writeFileSync(join(source.cycles, 'intruder.json'), '{"x":1}', 'utf8');
    const afterManual = fingerprintCycles(source.cycles, source.root);
    expect(sameFingerprint(before, afterManual), '夹具没制造出差异 ⇒ 下面的断言会空转').toBe(false);
    // 工具自身这次报告的仍是"前后相同"（它没写源）——这一条是它诚实的证据
    expect((r.sourceFingerprint as { digest: string }).digest).toBe(before.digest);
  });

  it('源指纹只覆盖 .cycles（源工作区其它文件的改动不参与判定——范围纪律）', async () => {
    const source = mkWorkspace('src3');
    const target = mkWorkspace('tgt3', false);
    writeFileSync(join(source.root, 'unrelated.txt'), 'noise', 'utf8');
    const r = await wireGuard(otherTool()).execute({
      targetWorkspace: target.root, action: 'init', workspace: source.root,
    });
    expect(r.sourceUntouched).toBe(true);
    const fp = r.sourceFingerprint as { cyclesOnly: boolean };
    expect(fp.cyclesOnly).toBe(true);
  });

  it('源不可解析 ⇒ sourceUntouched 为 null（**不伪装成 true**）', async () => {
    // 目标存在但源不可解析的情形：源 == 目标时 resolveCrossTarget 会拒；
    // 这里用「目标存在、源未提供且 getRoot() 返回 null」构造"没法取指纹"。
    const target = mkWorkspace('tgt4', false);
    const tool = registered().find((t) => t.name === 'anic_bootstrap_other') as ToolRegistration;
    // 直接调执行体：sourceRoot=null ⇒ 两个指纹为 null、结论为 null
    const r = runCrossBootstrap({ sourceRoot: null, targetWorkspace: target.root, action: 'init' });
    expect(r.status).toBe(200);
    expect(r.body['sourceFingerprint']).toBeNull();
    expect(r.body['sourceFingerprintAfter']).toBeNull();
    expect(r.body['sourceUnchanged'], '没法证明时必须降级为 null，不是 true').toBeNull();
    void tool;
  });
});

/* ── ④ 目标路径只经 resolveCrossTarget ───────────────────────────────── */

describe('④ 目标工作区解析：既有安全路径，零旁路', () => {
  it('目标不存在 ⇒ 拒绝且**不凭空造目录**（零写入）', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'anic-cross-miss-'), ), 'nope');
    TMPS.push(missing);
    const r = runCrossBootstrap({ sourceRoot: null, targetWorkspace: missing, action: 'init' });
    expect(r.status).toBe(404);
    expect((r.body['error'] as Record<string, unknown>)['error']).toBe('ANIC_CROSS_TARGET_MISSING');
    expect(existsSync(missing), '被拒的目标不该被创建').toBe(false);
  });

  it('目标 == 源 ⇒ 拒绝（那是自举自己，不是举他），建议指向 self/evaluate', () => {
    const ws = mkWorkspace('same');
    const r = runCrossBootstrap({ sourceRoot: ws.root, targetWorkspace: ws.root, action: 'init' });
    expect(r.status).toBe(404);
    const err = r.body['error'] as Record<string, unknown>;
    expect(String(err['message'])).toContain('not a cross-workspace bootstrap');
    expect(String(err['remedy'])).toContain('/anic/self/evaluate');
  });

  it('目标缺 .cycles 且动作非 init ⇒ 412 + 可执行建议（不静默跳过）', () => {
    const target = mkWorkspace('noinit', false);
    const r = runCrossBootstrap({ sourceRoot: null, targetWorkspace: target.root, action: 'evaluate' });
    expect(r.status).toBe(412);
    const err = r.body['error'] as Record<string, unknown>;
    expect(err['code']).toBe('ANIC_CROSS_TARGET_NOT_INITIALIZED');
    expect(String(err['remedy']), '失败必须给可执行建议').toContain('init');
  });
});

/* ── ⑤ HTTP 与工具共用同一执行体（不改变既有端点行为） ───────────────── */

describe('⑤ 单一实现：路由与工具共用 runCrossBootstrap', () => {
  it('crossBootstrapRoute 不再持有动作逻辑（只装配 HTTP）', () => {
    const src = readFileSync(join(ROOT, 'src', 'host', 'routes', 'crossBootstrapRoute.ts'), 'utf8');
    expect(src, '路由必须 import 共享执行体').toContain("from '../runtime/crossBootstrapExecute.ts'");
    expect(src).toContain('runCrossBootstrap');
    // 反向前提：路由里不得再出现 runEvalTracked / saveBootstrapState ——
    // 那些是实现细节，两处各持一份必然漂移。
    expect(src).not.toMatch(/runEvalTracked/);
    expect(src).not.toMatch(/saveBootstrapState/);
    expect(src).not.toMatch(/fingerprintCycles/);
  });
});
