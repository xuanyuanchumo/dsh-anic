/**
 * scriptBudgetContract —— 技能脚本超时预算的**单一事实源**回归钉（cycle-96 WS-C）。
 *
 * 被守卫的缺陷（实测，不是推测）：
 *   1. `auto-fix-loop.mjs` 写死 120000 跑 test_cmd，而 `.cycles/flow-tracker.json`
 *      里 auto-fix-loop 四次运行 = DONE 26995 / TIMEOUT 240145 / 240711 / 243876
 *      ⇒ `anic_status.health` 报 timeoutRate 0.75。**不是机器慢，是预算写错。**
 *   2. 同一语义的预算在 eval-runner 写 300000 —— 同一条 test_cmd 在一处被杀、
 *      在另一处不会。两处无依据、无对照（"魔法数散落"）。
 *   3. 超时与测试失败在下游不可区分 ⇒ 重试策略对超时无效（重试同一超只会再超时）。
 *
 * 本测试钉四件事，且每件都配**反向自检**（喂已知错误形态必须变红），
 * 否则守卫失效后会永久假绿：
 *   ① 预算只在 lib/budget.mjs 定义，三个脚本的调用点必须引用它（无裸数字）；
 *   ② DEFAULT ≥ 基线实测 × 1.5（任务硬约束），且也盖住本仓当前实测；
 *   ③ 超时/失败分类判据在真实 Windows 错误形态上成立、真实失败形态上不成立；
 *   ④ 配置可覆盖（config > default；显式入参 > config）—— 预算必须按项目可调。
 *
 * ## 本轮最贵的一条教训（留在这里，因为下次一定还会遇到同型）
 *
 * **守卫生效的标准是能区分代码形态与文案形态，而不是让实现改文案。**
 *
 * 具体经过：① 组的属性位检测器第一版写成 `timeout:\s*([^,\s}]*)`，它命中
 * **任何文本**里的 `timeout:`，包括日志里的 `Test timeout: ${ms}ms` —— 抓到的
 * rhs 是模板插值开头 `${ms`，不在白名单，于是报红。当时的"修法"是把日志改写成
 * `Test budget:` 绕开守卫，还在注释里把这件事包装成"有意的严格，不是脆弱的巧合"。
 *
 * 那是双重的坏留痕：**实现让步于守卫**，且**把让步写成了纪律**——下一个人读到
 * 那段注释，只会学会"改文案绕过守卫"，而不是"修守卫"。现已收窄为只认属性位
 * （`PROP_TIMEOUT`），并用四条负样本 + 三条正样本把这条判据钉死。
 *
 * 同型自检问句（任何守卫都该先问自己）：
 *   我的判据是在**区分**「我要禁的东西」与「合法的东西」，
 *   还是在**禁止所有长得像的东西**？
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const SCRIPTS = join(ROOT, 'assets/skill/scripts');
const BUDGET = join(SCRIPTS, 'lib/budget.mjs');

interface BudgetModule {
  TIMEOUT_MS: Record<string, number>;
  BUDGET_CONFIG_KEYS: Record<string, string>;
  timeoutFor: (kind: string) => number;
  resolveTimeout: (kind: string, opts?: { override?: number; configMs?: number }) => number;
  timeoutFromConfig: (content: string | undefined, kind: string) => number | null;
  isTimeoutError: (err: unknown) => boolean;
  isBufferOverflowError: (err: unknown) => boolean;
  loopBudgetMs: (maxRetries: number, perCommandMs?: number) => number;
  knownKinds: () => string[];
}

async function load(): Promise<BudgetModule> {
  return (await import(BUDGET)) as unknown as BudgetModule;
}

/** 去注释后的源码（守卫只看代码：注释里必须允许写「原先写死 120000」这类历史说明）。 */
function codeOf(file: string): string {
  const src = readFileSync(file, 'utf-8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

/** 本仓三个预算消费脚本（写域内）。列出即契约：新增消费方必须同时加入此处。 */
const CONSUMERS = ['auto-fix-loop.mjs', 'eval-runner.mjs', 'gate-check.mjs'];

/** 裸超时数字检测器：只判 timeout 位（不误伤 maxBuffer / 阈值 / 时间窗）。 */
const BARE_TIMEOUT = /timeout\s*:\s*(\d{4,})/;

/**
 * 「属性位」检测器（职责：禁随手算式，只许 timeoutFor()/resolveTimeout()/变量）。
 *
 * **它曾经写得太宽，并被实现让步过一次——这是本文件最贵的一条教训。**
 * 原形态是 `timeout:\s*([^,\s}]*)`，会命中**任何文本**里的 `timeout:`，包括
 * 人读日志 `console.log(\`Test timeout: ${ms}ms per run\`)` —— 抓到的 rhs 是
 * 模板插值的开头 `${ms`，自然不在白名单里，于是报红。当时的"修法"是把日志
 * 改写成 `Test budget:` 来绕开守卫，还在注释里把它包装成"有意的严格"。
 *
 * 那是**实现让步于守卫**，而守卫本身是错的：`xxx timeout:` 是散文/文案形态，
 * `{ ..., timeout: 120000 }` 才是属性赋值位。判据必须能区分二者。
 *
 * 现形态只认属性位：前置 `{`、`,`（对象字面量/参数对象），或行首缩进（多行对象）。
 * 实测收窄前后三个脚本的真实调用点命中数**一个不少**（eval-runner 5→5、
 * auto-fix-loop 1→1、gate-check 1→1）——只去掉假阳性，没去掉真阳性。
 *
 * **守卫生效的标准是能区分代码形态与文案形态，而不是让实现改文案。**
 */
const PROP_TIMEOUT = /(?:[{,]|^[ \t]*)\s*timeout:\s*([^,\s}]*)/gm;

describe('① 预算单一事实源：定义只在 lib/budget.mjs，调用点必须引用', () => {
  it('lib/budget.mjs 存在且导出契约形状', async () => {
    expect(existsSync(BUDGET), 'budget.mjs 缺失——预算又回到散落魔法数').toBe(true);
    const mod = await load();
    for (const fn of ['timeoutFor', 'resolveTimeout', 'timeoutFromConfig', 'isTimeoutError', 'loopBudgetMs', 'knownKinds']) {
      expect(typeof (mod as unknown as Record<string, unknown>)[fn], `${fn} 必须是函数`).toBe('function');
    }
    expect(typeof mod.TIMEOUT_MS).toBe('object');
  });

  it.each(CONSUMERS)('%s 的 timeout 调用点无裸数字', (file) => {
    const code = codeOf(join(SCRIPTS, file));
    const hits = code.match(new RegExp(BARE_TIMEOUT, 'g')) ?? [];
    expect(hits, `${file} 仍有裸 timeout 数字 ${hits.join(', ')}——预算必须走 lib/budget.mjs`).toEqual([]);
    expect(code, `${file} 未引用 lib/budget.mjs`).toContain("from './lib/budget.mjs'");
  });

  it('反向自检：裸数字检测器在真裸数字上必须命中（防 regex 失效假绿）', () => {
    expect('timeout: 120000'.match(BARE_TIMEOUT)?.[1]).toBe('120000');
    expect('timeout: 300000'.match(BARE_TIMEOUT)?.[1]).toBe('300000');
    // 反例：注释/已引用形态**不得**命中——否则守卫会变成"必须不写 timeout"的噪声
    expect("timeout: timeoutFor('test')".match(BARE_TIMEOUT)).toBeNull();
    expect("timeout: resolveTimeout('build', {})".match(BARE_TIMEOUT)).toBeNull();
    expect('maxBuffer: 16 * 1024 * 1024'.match(BARE_TIMEOUT)).toBeNull();
    // 去注释后历史说明不再命中（这是 codeOf 的职责，也是「注释可留真话」的前提）
    expect(codeOf(join(SCRIPTS, 'auto-fix-loop.mjs')).includes('timeout: 120000')).toBe(false);
  });

  it.each(CONSUMERS)('%s 的每个 timeout 值在属性位上是 kind 调用或变量（不是随手算式）', (file) => {
    const code = codeOf(join(SCRIPTS, file));
    for (const m of code.matchAll(PROP_TIMEOUT)) {
      const rhs = m[1]!;
      expect(
        rhs.startsWith('timeoutFor(') || rhs.startsWith('resolveTimeout(') || /^[A-Za-z_$][\w$]*$/.test(rhs),
        `${file} 的 timeout 表达式不可识别：${rhs || '(空)'}——改用 timeoutFor()/resolveTimeout()/变量`,
      ).toBe(true);
    }
  });

  /**
   * 反向自检：**属性位检测器必须能区分代码形态与文案形态**。
   *
   * 这正是它上一版失败的判断题——上一版把日志文案当成了赋值位，逼得实现
   * 改文案（`Test timeout:` → `Test budget:`）。下面四条同时钉住两个方向：
   * 文案形态必须放行（否则守卫又会逼实现让步），代码形态必须拦住
   * （否则收窄过头变成无守卫）。
   */
  it('反向自检：属性位检测器放行文案形态 / 拦住代码形态（且不靠"只认行首"侥幸）', () => {
    // 注意：PROP_TIMEOUT 带 `g` 旗标。`String.match(/g)` 返回**完整匹配**数组
    // （不含捕获组），而 `String.matchAll(/g)` 保留捕获组——本组断言取 rhs 必须用
    // matchAll，否则永远拿到 undefined。这本身也是个真实踩过的坑，故在此显式记录。
    const rhsOf = (s: string): string | undefined => [...s.matchAll(PROP_TIMEOUT)][0]?.[1];
    const hitOf = (s: string): string | undefined => [...s.matchAll(PROP_TIMEOUT)][0]?.[0];

    // —— 负样本（文案/散文形态）：**必须不**命中 ——
    expect(rhsOf('`Test timeout: ${ms}ms per run`'), '日志文案被误判成属性位').toBeUndefined();
    expect(rhsOf('`Test timeout: ${a ? "x" : "y"} per run`'), '含三元的日志文案被误判').toBeUndefined();
    expect(rhsOf('// the default timeout: 120000'), '注释散文被误判').toBeUndefined();
    expect(rhsOf('cmd timeout: worked around'), '普通散文被误判').toBeUndefined();

    // —— 正样本（代码形态）：**必须**命中 ——
    // ① 对象字面量（单行参数对象）
    expect(rhsOf('execSync(cmd, { cwd: d, timeout: 120000 })'), '对象字面量里的裸数字必须被抓到').toBe('120000');
    // ② 前置逗号（多行对象的非首行属性）
    expect(rhsOf('  stdio: "pipe", timeout: 60000,'), '逗号前置的裸数字必须被抓到').toBe('60000');
    // ③ 行首缩进（多行对象首行属性）——专门防「只认 { 或 , 就用行首缩进侥幸通过」，
    //    以及反过来防「只认行首」的伪收窄：这条与 ①② 同时成立才说明两种定位都活
    expect(rhsOf('    timeout: 120000,'), '行首缩进的裸数字必须被抓到').toBe('120000');

    // —— 合法形态仍放行（收窄不得变成"必须不写 timeout"的噪声）——
    expect(rhsOf("execSync(cmd, { timeout: timeoutFor('test') })")).toBe("timeoutFor('test')");
    expect(rhsOf('execSync(cmd, { timeout: timeoutMs })')).toBe('timeoutMs');

    // —— 反向自检的反向：确认 hitOf 真的锚到了属性位（而非兜底匹配整行）——
    expect(hitOf('execSync(cmd, { cwd: d, timeout: 120000 })')).toContain('120000');
  });

  it('反向自检：收窄正则没丢掉任何真实调用点（覆盖率不缩水）', () => {
    // eval-runner 的 5 个调用点必须全被属性位检测器命中（数字与 kind 都在），
    // 否则"收窄"只是把守卫变没了。
    const code = codeOf(join(SCRIPTS, 'eval-runner.mjs'));
    const hits = [...code.matchAll(PROP_TIMEOUT)].map((m) => m[1]!);
    expect(hits.length, `eval-runner 的 timeout 调用点应被全部覆盖，实得 ${JSON.stringify(hits)}`).toBe(5);
    expect(hits).toEqual(expect.arrayContaining([
      "resolveTimeout('test'", "resolveTimeout('lint'", "resolveTimeout('build'", "timeoutFor('audit')", "timeoutFor('script')",
    ]));
  });
});

describe('② 预算数值有依据：DEFAULT ≥ 基线实测 × 1.5', () => {
  // 基线事实：`.cycles/performance-baseline.md` 记录全量测试时长实测 33.1s
  // （阈值 60s，负载区间 36.5–69.2s）。写进测试 = 「数字有依据」的锚。
  const BASELINE_TEST_S = 33.1;
  // 本仓 cycle-96 实测（只读取证）：test 73.9s / lint 0.277s / build 3.173s / script 0.180s
  const MEASURED: Record<string, number> = { test: 73.9, lint: 0.277, build: 3.173, script: 0.180 };

  it('test 预算 ≥ 基线 × 1.5，且也覆盖本仓**当前**实测', async () => {
    const mod = await load();
    const test = mod.TIMEOUT_MS['test']!;
    expect(test).toBeGreaterThanOrEqual(BASELINE_TEST_S * 1000 * 1.5);
    // 更强的一层：也要盖住本仓当前真实工作量（否则「按基线算」却当场超时）
    expect(test).toBeGreaterThanOrEqual(MEASURED['test']! * 1000);
  });

  it.each(['lint', 'build', 'script', 'audit'])('%s 预算 ≥ 该 kind 实测 × 1.5', async (kind) => {
    const mod = await load();
    const ms = mod.TIMEOUT_MS[kind]!;
    const measured = MEASURED[kind];
    if (measured !== undefined) expect(ms).toBeGreaterThanOrEqual(measured * 1000 * 1.5);
    expect(ms).toBeGreaterThan(0);
  });

  it('未知 kind 响亮失败（静默回退默认值正是预算写错却无人发现的温床）', async () => {
    const mod = await load();
    expect(() => mod.timeoutFor('tests')).toThrow(/unknown/i);
    expect(() => mod.timeoutFor('')).toThrow(/unknown/i);
    expect(mod.knownKinds()).toEqual(expect.arrayContaining(['test', 'lint', 'build', 'probe']));
  });

  it('loopBudgetMs 覆盖「每轮两跑 × 重试数」（内外层预算可对照）', async () => {
    const mod = await load();
    expect(mod.loopBudgetMs(3)).toBe(mod.TIMEOUT_MS['test']! * 6);
    expect(mod.loopBudgetMs(1)).toBe(mod.TIMEOUT_MS['test']! * 2);
    // 非法/越界入参落回缺省，不得返回 NaN/0（NaN 在 execSync 里等于永不等超时）
    expect(mod.loopBudgetMs(0)).toBe(mod.TIMEOUT_MS['test']! * 6);
    expect(Number.isFinite(mod.loopBudgetMs(Number.NaN))).toBe(true);
  });

  it('loopBudgetMs 与宿主侧 spawn 上限的关系是可解释的（不是恰好没炸）', async () => {
    const mod = await load();
    // 缺省 3 轮 × 两跑 × 120s = 720s > 宿主 240s cap（bootstrapBudget.ts）。
    // 这意味着**宿主会先掐断内层预算调大之后的循环**——这是真实的上游约束，
    // 本测试如实记录数字，防止有人只看内层数字就以为"调大就万事大吉"。
    const perLoop = mod.loopBudgetMs(3);
    expect(perLoop).toBeGreaterThan(240_000);
  });
});

describe('③ 超时必须独立分类（C3 真实逻辑缺陷的判据层守卫）', () => {
  it('真实 Windows execSync 超时形态 → 判超时', async () => {
    const mod = await load();
    // 真机实测形态（本仓 Node 24 / Windows cmd.exe 取证）：
    //   { name:'Error', code:'ETIMEDOUT', status:null, signal:'SIGTERM', killed:undefined }
    expect(mod.isTimeoutError({ name: 'Error', code: 'ETIMEDOUT', status: null, signal: 'SIGTERM', killed: undefined })).toBe(true);
  });

  it('反向自检：真实测试失败形态 → **不得**判超时', async () => {
    const mod = await load();
    // 真机实测形态：{ code:undefined, status:1, signal:null }
    expect(mod.isTimeoutError({ code: undefined, status: 1, signal: null, killed: undefined })).toBe(false);
    expect(mod.isTimeoutError({ status: 2 })).toBe(false);
    expect(mod.isTimeoutError(undefined)).toBe(false);
    expect(mod.isTimeoutError(null)).toBe(false);
    expect(mod.isTimeoutError({})).toBe(false);
    // ENOBUFS 是「看不见输出」，不是「没跑完」——两者都不可判，但不是同一类
    expect(mod.isTimeoutError({ code: 'ENOBUFS' })).toBe(false);
    expect(mod.isBufferOverflowError({ code: 'ENOBUFS' })).toBe(true);
    expect(mod.isBufferOverflowError({ code: 'ETIMEDOUT' })).toBe(false);
  });

  it('killed/SIGTERM 形态也判超时（POSIX 形态，两平台都要成立）', async () => {
    const mod = await load();
    expect(mod.isTimeoutError({ killed: true, signal: 'SIGTERM', status: null })).toBe(true);
    expect(mod.isTimeoutError({ signal: 'SIGTERM', status: null })).toBe(true);
    // 关键反例：SIGTERM 但**有数字退出码** = 进程自己退出过，不是超时
    expect(mod.isTimeoutError({ signal: 'SIGTERM', status: 143 })).toBe(false);
  });

  it('auto-fix-loop 源码里超时是独立类型，且不复用失败类型名', () => {
    const code = codeOf(join(SCRIPTS, 'auto-fix-loop.mjs'));
    expect(code, '超时必须有自己的失败类型').toContain('test-command-timeout');
    // 反向自检：超时不得被写成既有的 test-command-failure
    expect(code).not.toMatch(/timedOut[\s\S]{0,200}type:\s*'test-command-failure'/);
    // 超时轮次必须能提前停止（不再空转重试）
    expect(code).toContain('budgetExhausted');
  });
});

describe('④ 预算可配置：config 覆盖与显式入参优先', () => {
  it('timeoutFromConfig 解析引号/注释/缺键三态', async () => {
    const mod = await load();
    for (const kind of Object.keys(mod.BUDGET_CONFIG_KEYS)) {
      const key = mod.BUDGET_CONFIG_KEYS[kind]!;
      expect(mod.timeoutFromConfig(`${key}: 45000`, kind)).toBe(45000);
      expect(mod.timeoutFromConfig(`${key}: "45000" # tuned`, kind)).toBe(45000);
      expect(mod.timeoutFromConfig(`${key}: '45000'`, kind)).toBe(45000);
      // 缺键 / 空配置 / 非数字 → null（不是 0，0 会被当成"未设置"以外的语义）
      expect(mod.timeoutFromConfig('test_cmd: "x"', kind)).toBeNull();
      expect(mod.timeoutFromConfig(undefined, kind)).toBeNull();
      expect(mod.timeoutFromConfig(`${key}: abc`, kind)).toBeNull();
      expect(mod.timeoutFromConfig(`${key}: 0`, kind)).toBeNull();
    }
  });

  it('优先级：显式入参 > config > DEFAULT（反向自检：逐级回落必须可观测）', async () => {
    const mod = await load();
    const def = mod.TIMEOUT_MS['test']!;
    expect(mod.resolveTimeout('test')).toBe(def);
    expect(mod.resolveTimeout('test', { configMs: 45000 })).toBe(45000);
    expect(mod.resolveTimeout('test', { configMs: 45000, override: 9000 })).toBe(9000);
    // 非法值不得劫持（NaN/0/负数一律落回上一级）
    expect(mod.resolveTimeout('test', { configMs: 45000, override: Number.NaN })).toBe(45000);
    expect(mod.resolveTimeout('test', { configMs: 0, override: -1 })).toBe(def);
  });

  it('三个消费脚本都真的把 config 覆盖接进了调用点（不是只导入了函数）', () => {
    for (const file of ['eval-runner.mjs', 'gate-check.mjs']) {
      const code = codeOf(join(SCRIPTS, file));
      expect(code, `${file} 导入了 timeoutFromConfig 却没在调用点用`).toContain('timeoutFromConfig(');
    }
    const afl = codeOf(join(SCRIPTS, 'auto-fix-loop.mjs'));
    // auto-fix-loop 是配置解析集中处（变量名 configMs 走 testTimeoutMs 中转）
    expect(afl).toContain('timeoutFromConfig(');
    expect(afl).toContain('--timeout-ms');
  });
});
