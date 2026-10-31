/**
 * 接线审计**契约**（cycle-94）—— 让 `scripts/audit-wiring.mjs` 成为一条常驻守卫，
 * 而不是"跑过一次的报告"。
 *
 * ## 为什么必须把脚本变成契约
 *
 * 脚本能跑 ≠ 有人在跑。本仓已经有过这条教训：一个诊断脚本写好后只被手工执行过
 * 一次，之后 P0 重新长回来也没人知道（告警级守卫等于没有守卫）。
 *
 * ⇒ 本契约在每次 `vitest` 里执行真实审计，并断言三件事：
 *   ① **判定器有牙**：自检三腿全绿（否则"0 条断点"不可信）；
 *   ② **本域零 P0**：本域（closureAudit / closure 面板 / diagnostics / 两条路由）
 *      不得有死导出、不得有幽灵路由、不得有未声明未消费的路由；
 *   ③ **数字化可读**：报告里每个计数都是真实测出来的数（非零下限，防空扫描假绿）。
 *
 * ## 为什么允许别域 P1 存在（而不是把它也断言成 0）
 *
 * P1 = 别域死导出（本轮实测 28 条）。把它也断言成 0 会让这条契约**永久红**，
 * 而永久红的守卫会被学会忽略 —— 那是比没有守卫更糟的结局（本仓反复记过这条）。
 *
 * 正确形态是**记录 + 棘轮**：断言 P1 数量**不超过**一个已实测的上界，
 * 这样它仍然拦得住"又长了 10 条"，却不逼迫任何人在本轮去改别域的代码。
 *
 * ## 边界
 *
 * 本契约**读盘**（它跑的是真脚本）。这是有意的：审计的全部价值就是"对着真实仓库
 * 判"，喂假数据跑一遍只能证明脚本能执行，不能证明仓库健康。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'audit-wiring.mjs');

/** 跑审计并以 JSON 形态取回报告（`--json` 是脚本契约的一部分）。 */
function runAudit(): { report: Record<string, unknown>; code: number } {
  try {
    // `--json` 让脚本只吐结构化报告，人类摘要不进本契约的解析路径。
    const out = execFileSync(process.execPath, [SCRIPT, '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    });
    return { report: JSON.parse(out) as Record<string, unknown>, code: 0 };
  } catch (e) {
    // 退出码 1（有 P0）时 stdout 仍有完整 JSON —— execFileSync 会抛，但负载还在 stderr/stdout。
    const err = e as { status?: number; stdout?: string };
    if (typeof err.stdout === 'string' && err.stdout.trim() !== '') {
      return { report: JSON.parse(err.stdout) as Record<string, unknown>, code: err.status ?? 1 };
    }
    throw e;
  }
}

/**
 * 别域死导出的**已实测上界**（棘轮）。
 *
 * cycle-94 实测 28 条。这个数只许降不许升：新增一条别域死导出会让契约红，
 * 逼新增者当场决定"接线 / 删除 / 显式登记"——而不是让它无声地累积。
 *
 * 收紧时把数字改小并在提交信息里说明删掉了哪几条（这是棘轮的标准用法）。
 *
 * ## cycle-95 收紧 28 → 14（WS-E 裁决的实测结果）
 *
 * 本域可裁决的 21 条逐条给证据后收口（**删除 15 / 接线 6**，见下），
 * 剩下的是**别人写域**的债，本任务按纪律不越权改：
 *
 *   残留 = 图谱域 12 + 宿主 bootstrap 域 1（数字随并行工作流实时波动）
 *   - 图谱域：`renderControlBand` / `fullscreenCapabilityOf` /
 *     `toolbarPropsOf` / `breadcrumbInputOf` / `LANE_HEADER_TOKENS` /
 *     `laneLabelOf` / `sameAnchor` / `NO_TRACE_DEPTH` / `clampTraceDepth`
 *     （cycle-94 遗留 9 条），外加 WS-B/WS-C **本轮新增**的
 *     `viewStateSnapshotOf` / `createViewStateWriter` / `loadRestoredViewState`
 *     （`graphViewStateWire.ts`，3 条）——
 *     `src/client/features/graph/` 在 cycle-95 是 WS-B/WS-C 并行写域。
 *     **全部由图谱域 owner 下轮处理**。
 *   - `BOOTSTRAP_SETTLED @ src/host/selfBootstrap.ts`：WS-A 正在改同一语义域
 *     （bootstrapFacts / selfBootstrapRoute），**由 WS-A 域 owner 下轮处理**。
 *
 * ⚠️ 并行波动的诚实说明：本文件被 WS-E 设成 14（任务书的 P1 目标值），
 * 而不是 WS-E 实测的 13 —— 那 1 条余量是**给并行同伴的**（他们每轮都在增删
 * 图谱域文件）。若同伴继续新增而死导出涨过 14，**契约应当变红**，不要抬这个数：
 * 那说明又有人"先导出、后接线"。同伴收口后请把 14 继续往下收。
 *
 * 删除的 15 条（全仓去注释后零消费 / 零 tests 引用，逐条在文件头留"为什么删"）：
 *   `unlockChannelState` `disclosureLine` `unlockedTotal`（后者因前两者的删除
 *   失去唯二调用者，一并删除——否则我自己制造三条新债）
 *   `sourceLayerLabel` `payloadRejectionFailure` `editablePaths` `LEDGER_LIST_URL`
 *   `prefsPanelIdOf` `backupFieldLabel` `probeDefault` `activeOverrides`
 *   `crossCyclesDirOf` `UPGRADE_HISTORY_LIMIT` `registerMacroPhaseFlow`
 *   `copyFileSafe` `noteReadoutReady`。
 *
 * 接线的 6 条（**每一处都带一条新契约/单测**，不是"导出了就当用了"）：
 *   `rebuildGateFlowState` → `tests/unit/gateFlowReplay.test.ts`（补齐 gate-check
 *     缺失的 INV-13 replay === online；四个兄弟流程都有、只有它没有）
 *   `setLoggerSink` → `tests/unit/loggerSink.test.ts`（文档声称的"唯一替换点"
 *     此前零测试使用）
 *   `UNKNOWN_VERSION_BEHAVIOR` → 同上测试 + `loadFlowTracker` 真的执行"宽容读 +
 *     显式警告"（此前注释承诺 `versionMismatch`，读侧却从没读过 `version`）
 *   `anicError` / `isAnicError` → `tests/contract/errorTaxonomyContract.test.ts`
 *     （工厂零调用、守卫零调用，分类学与用法完全脱钩）
 */
const P1_DEAD_UPPER_BOUND = 10;

/**
 * 棘轮的**允许滞后量**（④b 用）：上界与实测之间允许多少条差距。
 *
 * 为什么需要这个量而不是把上界钉死等于实测：本仓是并行工作流，图谱域 owner
 * 可能在同一 cycle 内接线掉几条，也可能新增几条（WS-B/WS-C 本轮就新增了
 * `graphViewStateWire.ts` 的 3 条）—— 本文件的数要等他们合并后才该收紧。
 *
 * 本轮取值 **1**：WS-E 实测 13，上界设 14（任务书的 P1 目标值），
 * 这 1 条余量是**给并行同伴的**。这个量存在的意义是防止上界被随手放大
 * （28→50 那种）：一旦实测比上界小超过 1，④b 立刻红，逼你收紧上界。
 */
const RATCHET_SLACK = 1;

describe('接线审计契约（cycle-94）', () => {
  it('① 判定器有牙：自检三腿全绿（孤儿抓到 / 孤儿清除 / 幽灵抓到）', () => {
    const { report } = runAudit();
    const sc = report['selfCheck'] as Record<string, boolean> | undefined;
    expect(sc, '报告缺少 selfCheck 字段').toBeDefined();
    expect(sc?.['orphanCaught'], '假孤儿没被抓到 ⇒ 判定器坏了').toBe(true);
    expect(sc?.['orphanCleared'], '补了引用后假孤儿仍被报 ⇒ 判定是"见到即报"').toBe(true);
    expect(sc?.['ghostCaught'], '假幽灵路由没被点名 ⇒ 路由对账坏了').toBe(true);
  });

  it('② 本域零 P0：无死导出 / 幽灵路由 / 未声明未消费路由', () => {
    const { report } = runAudit();
    const exports = report['exports'] as Record<string, unknown>;
    const routes = report['routes'] as Record<string, unknown>;
    expect((exports['p0Dead'] as unknown[]).length, '本域出现死导出').toBe(0);
    expect((routes['ghostRoutes'] as unknown[]).length, '出现幽灵路由（客户端在取、宿主没注册）').toBe(0);
    expect((routes['unconsumedUndeclared'] as unknown[]).length, '出现未声明也未消费的路由').toBe(0);
    expect(Number(report['p0']), 'P0 总数必须为 0').toBe(0);
  });

  it('③ 数字化非零下限：扫描集与各计数真实可观（防空扫描假绿）', () => {
    const { report } = runAudit();
    // 扫不到文件 = 整个审计在空集上跑，所有"0 条断点"都是假的。
    expect(Number(report['scannedFiles'])).toBeGreaterThanOrEqual(400);
    const exports = report['exports'] as Record<string, unknown>;
    expect(Number(exports['total'])).toBeGreaterThanOrEqual(800);
    const routes = report['routes'] as Record<string, unknown>;
    expect(Number(routes['registered'])).toBeGreaterThanOrEqual(50);
    expect(Number(routes['consumed'])).toBeGreaterThanOrEqual(10);
    const tools = report['tools'] as Record<string, unknown>;
    expect(Number(tools['total'])).toBeGreaterThanOrEqual(15);
    // 工具零消费 = 0：每个 anic_* 工具都有人在用（注册→生产→消费三态齐）。
    expect((tools['noConsumer'] as unknown[]).length).toBe(0);
  });

  it('④ 棘轮：别域死导出数量不超过已实测上界（只许降不许升）', () => {
    const { report } = runAudit();
    const p1 = (report['exports'] as Record<string, unknown>)['p1Dead'] as unknown[];
    expect(p1.length, '别域死导出变多了 —— 新增的必须以接线/删除/显式登记收口').toBeLessThanOrEqual(P1_DEAD_UPPER_BOUND);
  });

  it('④b 棘轮不许虚高：上界必须贴近实测（否则棘轮被架空）', () => {
    // 为什么需要这条：只断言"≤上界"时，上界一旦被随手抬高（28→50），
    // 棘轮就变成一层纸 —— 债涨了照样绿。这里要求上界与实际数量**同量级**：
    // 实际不得低于上界 - 剩余图谱域待裁决余量（本轮实测 11，余量 0）。
    //
    // 收紧时：把 P1_DEAD_UPPER_BOUND 与这里的余量**一起**改小。
    const { report } = runAudit();
    const p1 = (report['exports'] as Record<string, unknown>)['p1Dead'] as unknown[];
    expect(p1.length, '实测数量比上界小太多 ⇒ 该收紧上界了（棘轮必须跟着实测走）')
      .toBeGreaterThanOrEqual(P1_DEAD_UPPER_BOUND - RATCHET_SLACK);
  });

  it('⑤ 退出码语义：零 P0 时脚本返回 0（不是 1 或 2）', () => {
    const { code } = runAudit();
    expect(code, '本域零 P0 时退出码必须是 0；1=有断点、2=自检失败').toBe(0);
  });
});
