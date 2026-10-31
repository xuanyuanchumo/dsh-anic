/**
 * 闭环体检契约守卫（cycle-72 T-7207）——注册↔生产↔消费 三态矩阵的机械钉。
 *
 * 缺陷类：**「注册了但没人消费 / 产出了但没人读」在本仓无法被机器回答**。
 * 现存的守卫各管一段，都答不了这个整体问题：
 *   toolIdsContract.ts   —— 工具清单 ⇄ 注册代码（只问「登记一致吗」）
 *   readmeNumbers.ts     —— README 数字 ⇄ 实测计数（只问「文档数字对吗」）
 *   apiDocShapeContract  —— 文档字段表 ⇄ 源码接口（只问「协议形状同步吗」）
 * 它们都不回答「这份资产有人读吗」——本守卫补的正是这一层。
 *
 * 三条硬断言（对应任务 D 的 (1)(2)(3)）：
 *   ① 工具域可完整枚举（19 项，与 tools*.ts 注册代码双向相等）；
 *   ② 至少一个**真实未消费项**必须被报出（先跑出真实清单再钉基线）；
 *   ③ 幽灵消费数如实钉住（当前 0；不为 0 时本守卫红——不允许沉默）。
 *
 * 守卫四条纪律（docs/agents/开发规范-守卫与约束 §10）：
 *   ① 反向自检：判定器与集合比较必须先证明能判「有/无」两态；
 *   ② 不匹配自身：基线里的缺口项一律字符串拼接构造——测试自己成为消费方
 *      会把缺口掩盖掉（本文件是缺口名的「第二消费者」，必须避免自指假绿）；
 *   ③ 扫描集非空下限：三族各 ≥10，空扫描直接 FAIL；
 *   ④ 棘轮语义：缺口修好后必须**收紧**断言，不允许放宽（注释写明改法）。
 */
import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertClustersPresent,
  bucketsOf,
  CHANNEL_DECLARATIONS,
  clustersConsistent,
  runClosureAudit,
  toClosureView,
  validateDeclarationDocs,
  validateDeclarations,
} from '../../src/host/closureAudit/registryClosure.ts';
import { CLOSURE_BUCKETS, bucketOf } from '../../src/host/closureAudit/closureBuckets.ts';
// 去注释判定原语（cycle-76 下沉到 textScan；scanPrimitives 再导出）。
import { buildFileIndex, buildTextMap, stripComments } from '../../src/host/closureAudit/scanPrimitives.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const summary = runClosureAudit(ROOT);

/** 缺口项拼接构造（守卫纪律②：不匹配自身）。 */
const gk = (...p: string[]) => p.join('.');
const gr = (...p: string[]) => p.join('/');

/** 腿 1：注册代码（真相源）——src/host/tools*.ts 的 name 字面量。 */
function registeredToolIds(): string[] {
  const hostDir = join(ROOT, 'src', 'host');
  const ids = new Set<string>();
  for (const f of readdirSync(hostDir).filter((x) => /^tools.*\.ts$/.test(x))) {
    const src = readFileSync(join(hostDir, f), 'utf-8');
    const re = new RegExp('name:' + String.fromCharCode(92) + 's*[' + String.fromCharCode(39, 34) + '](anic_[a-z0-9_]+)[' + String.fromCharCode(39, 34) + ']', 'g');
    for (const m of src.matchAll(re)) if (m[1]) ids.add(m[1]);
  }
  return [...ids].sort();
}

const tcl = summary.clusters.find((x) => x.cluster === 'tools');
const i18nCl = summary.clusters.find((x) => x.cluster === 'i18n');
const routeCl = summary.clusters.find((x) => x.cluster === 'routes');
/** cycle-75 第四族：技能脚本 + MCP 传输层（此前三族对该面零覆盖）。 */
const skillCl = summary.clusters.find((x) => x.cluster === 'skills');

describe('cycle-72 T-7207 闭环体检契约（注册↔生产↔消费）', () => {
  it('纪律③ 扫描集非空下限：四族各 ≥10（空扫描 = 永久假绿，直接 FAIL）', () => {
    expect(tcl?.total ?? 0).toBeGreaterThanOrEqual(15);
    expect(i18nCl?.total ?? 0).toBeGreaterThanOrEqual(100);
    expect(routeCl?.total ?? 0).toBeGreaterThanOrEqual(40);
    // cycle-75 接线第四族（skills/MCP）：此前该面零覆盖却不被任何断言发现。
    expect(skillCl?.total ?? 0).toBeGreaterThanOrEqual(10);
    expect(summary.scannedFiles).toBeGreaterThanOrEqual(200);
  });

  it('四族齐备（cycle-75 新增 skills）：缺族由 assertClustersPresent 响亮抛错', () => {
    // 反向自检：抹掉任一族都必须抛错（否则「族在场」是恒真装饰）
    for (const missing of ['tools', 'i18n', 'routes', 'skills']) {
      const subset = summary.clusters.filter((c) => c.cluster !== missing);
      expect(() => assertClustersPresent(subset), '抹掉 ' + missing + ' 族后未抛错').toThrow();
    }
    expect(() => assertClustersPresent(summary.clusters)).not.toThrow();
  });

  it('断言① 工具域可完整枚举：体检枚举集 ⇄ tools*.ts 注册代码集 双向相等', () => {
    const enumerated = (tcl?.items ?? []).map((x) => x.id).sort();
    const registered = registeredToolIds();
    expect(registered.length).toBeGreaterThanOrEqual(15);
    expect([...enumerated].sort()).toEqual(registered);
  });

  it('断言② 至少一个真实未消费项能被报出（棘轮基线，先跑真实清单再钉）', () => {
    const ids = new Set(summary.unconsumed.map((x) => x.cluster + '|' + x.id));
    const baseline = [
      // cycle-79（WS-3 死键清理）：i18n 侧 4 条基线（state.retry / techdebt.title /
      // panel.refreshing / gate.PASS）已按"多余键"删除 ⇒ 从基线移除（收紧）。
      // meta.description 是 RESERVED（类元数据，非 t() 键），仍必须被报为未消费；
      // i18n 族的零死键由 tests/contract/i18nDeadKeyContract.test.ts 以**集合相等**独立钉住。
      'i18n|' + gk('meta', 'description'),
      'routes|' + gr('/anic', 'flows', 'gate-check', 'run'),
      'routes|' + gr('/anic', 'self', 'gate-check'),
      'routes|' + gr('/anic', 'api', 'trust'),
      'routes|' + gr('/anic', 'cycle', 'init'),
    ];
    const reported = baseline.filter((k) => ids.has(k));
    expect(reported.length, '报告器失效：基线缺口一个都没报出').toBeGreaterThanOrEqual(5);
    // 棘轮：这些缺口当前必须仍然未消费——修好后把它们从基线移到「已消费」断言
    expect(baseline.filter((k) => !ids.has(k)), '这些缺口已修复——请更新棘轮基线（收紧而非放宽）').toEqual([]);
  });

  it('断言③ 幽灵消费如实钉住（当前实测 0；不为 0 时必须红，不允许沉默）', () => {
    const ghosts = summary.ghost.map((x) => x.cluster + '|' + x.id);
    console.log('CLOSURE_GHOSTS ' + JSON.stringify(ghosts));
    expect(ghosts).toEqual([]);
  });

  it('口径自洽 + 分族计数双向（consumed/unconsumed/codeConsumed 无漂移）', () => {
    expect(clustersConsistent(summary.clusters)).toEqual([]);
    for (const cl of summary.clusters) {
      const consumed = cl.items.filter((x) => x.consumed).length;
      const code = cl.items.filter((x) => x.evidenceKind === 'code').length;
      expect(cl.consumed).toBe(consumed);
      expect(cl.codeConsumed).toBe(code);
      expect(cl.unconsumed).toBe(cl.total - consumed);
    }
  });

  it('工具消费面分级：22 项（cycle-77）按 code/channel 如实分级，不变量不依赖具体条数', () => {
    const channelOnly = (tcl?.items ?? []).filter((x) => x.evidenceKind === 'channel').map((x) => x.id).sort();
    const codeLevel = (tcl?.items ?? []).filter((x) => x.evidenceKind === 'code').length;
    console.log('CLOSURE_TOOL_EVIDENCE ' + JSON.stringify({ codeLevel, channelOnly: channelOnly.length }));
    // 基线：code 级 >0（确有生产代码消费方）；channel-only 如实计数。
    // cycle-75 同步：旧标题「13 项仅 channel」是陈旧描述——实测 codeLevel=21 / channelOnly=0。
    // cycle-77：工具面 21 → 22（新增 anic_autonomy_upgrade），故标题不再写死条数。
    // 断言本体（分级不变量）未变，此处补齐逐项分级自洽。
    expect(codeLevel).toBeGreaterThan(0);
    expect(codeLevel + channelOnly.length).toBe(tcl?.total ?? 0);
    for (const it2 of tcl?.items ?? []) {
      // 分级自洽：code 项必有 src/ 证据；channel 项必无 src/ 证据（不许混同）
      if (it2.evidenceKind === 'code') expect(it2.evidence.some((h) => h.startsWith('src/'))).toBe(true);
      else if (it2.evidenceKind === 'channel') expect(it2.evidence.some((h) => h.startsWith('src/'))).toBe(false);
    }
  });

  it('路由 → 客户端消费面在场：全部客户端 fetch 常量都能在注册表里找到（幽灵为 0 的另一半）', () => {
    // 反向腿：客户端源码里出现的 /anic/... 字面量必须都有注册来源。
    // 这一半与 summary.ghost 同源但独立重算——防止报告器整体失效时静默通过。
    const ids = new Set((routeCl?.items ?? []).map((x) => x.id));
    const clientDir = join(ROOT, 'src', 'client');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const f of walk(clientDir)) {
      const text = readFileSync(f, 'utf-8');
      text.split(/\r?\n/).forEach((line, i) => {
        const re = new RegExp('[' + String.fromCharCode(39, 34, 96) + '](/anic/[A-Za-z0-9_/.\\-]+)', 'g');
        for (const m of line.matchAll(re)) {
          const p = m[1] ?? '';
          if (p === '' || p === '/anic/') continue;
          if (!ids.has(p)) offenders.push(f.slice(ROOT.length + 1) + ':' + String(i + 1) + ' ' + p);
        }
      });
    }
    expect(offenders, '客户端引用了未注册端点：\n' + offenders.join('\n')).toEqual([]);
  });

  it('纪律① 反向自检：集合比较与判定器能判「缺一个/多一个」（先证明有牙）', () => {
    const ids = (tcl?.items ?? []).map((x) => x.id);
    const corrupted = ids.filter((x) => x !== ids[0]);
    expect([...corrupted].sort()).not.toEqual(registeredToolIds());
    const fabricated = [...ids, 'anic_phantom_tool'];
    expect([...fabricated].sort()).not.toEqual(registeredToolIds());
  });

  it('客户端投影安全：无本地绝对路径、无绝对 http(s) URL（面板数据面可直接消费）', () => {
    const view = toClosureView(summary);
    expect(JSON.stringify(view)).not.toContain(':' + String.fromCharCode(92));
    // 绝对 URL 的判据是 scheme://，不是子串 'http'（cluster 的 unit 文案里有 'anic http route'）。
    const scheme = 'http' + '://';
    expect(JSON.stringify(view)).not.toContain(scheme);
  });

  /*
   * cycle-72 追加（真实缺口回归钉）：面板分区**有壳无表体**。
   *
   * 缺口形态：ClosureSection 装配腿接了（createElement 存在、契约绿），但数据腿没接
   * ——closureTarget.ts 零调用方 ⇒ store 切片恒 null ⇒ 分区照常渲染标题与折叠壳，
   * 表体一个字没有、失败行也不出现。守着「分区存在」的绿，白盒面却是空的。
   * 现有守卫只断言「分区存在 + 锚点 + 装配序列」，抓不到这类。
   *
   * 钉法：分区组件 + 它的 target 工厂必须**同时**被面板入口引用（缺任一即红）。
   */
  it('装配完整性：分区组件与其数据腿 target 必须同时被面板入口接线（有壳无表体即红）', () => {
    /*
     * 扫描面：面板装配面 = `WorkflowGraphPanel.ts`（容器/数据腿/工具栏）+
     * `panelSectionOrder.ts`（分区编排）。
     *
     * cycle-95 拆出编排层后，`ClosureSection` 的 `createElement` 落在编排层、
     * 而 `closureTarget` 的数据腿仍在根组件——**这是一次正确的职责拆分**
     * （编排层不该知道数据从哪来），但把本契约「同一文件里同时出现四件」的
     * 判据从"钉住接线"变成了"钉住不许拆文件"。
     *
     * 正确形态：判据仍是四件齐备（组件 import / 组件装配 / 数据腿 import / 数据腿调用），
     * 但允许它们分布在**装配面的任一文件**里；反向自检改为「删掉任一件即翻假」，
     * 且变异施加在整个装配面上（不再只是单文件），证明判据不是被拆文件救了。
     */
    const ASSEMBLY_FILES = [
      join(ROOT, 'src', 'client', 'WorkflowGraphPanel.ts'),
      join(ROOT, 'src', 'client', 'panelSectionOrder.ts'),
    ];
    const assemblySrc = ASSEMBLY_FILES.map((f) => readFileSync(f, 'utf8')).join('\n');
    const component = 'Closure' + 'Section';
    const targetFactory = 'closure' + 'Target';
    const importedComponent = 'import { ' + component + " } from './features/closure/ClosureSection.ts'";
    const importedTarget = 'import { ' + targetFactory + " } from './features/closure/closureTarget.ts'";
    // 数据腿的接线形态容错：`...closureTarget(bindPanelActions(store))` 与 `...closureTarget({…})` 都认
    const dataLegCall = '...' + targetFactory + '(';
    /*
     * 钉子本体抽成纯函数——**这样反向自检才有牙**。
     *
     * verifier-evidence 复核发现首版反向自检退化：旧写法删掉片段后
     * `stillHasTarget` 恒 false ⇒ `expect(… && …).toBe(false)` **恒真、永不可能失败**，
     * 属「恒真装饰」（与本仓「告警级守卫等于没有守卫」同族）。
     * 正确形态：断言「同一判据在原始树上通过、在变异树上必须不通过」。
     */
    const pinPasses = (src: string): boolean =>
      src.includes(importedComponent)
      && src.includes(importedTarget)
      && src.includes('createElement(' + component + ', {')
      && src.includes(dataLegCall);
    // 前向：原始装配面必须通过
    expect(pinPasses(assemblySrc)).toBe(true);
    // 反向：分别删掉「组件 import」「组件装配」「数据腿 import」「数据腿调用」，判据都必须翻假
    for (const mutant of [
      assemblySrc.replace(importedTarget, ''),
      assemblySrc.replace(dataLegCall, ''),
      assemblySrc.replace('createElement(' + component + ', {', 'createElement(Fake' + 'Section, {'),
      assemblySrc.replace(importedComponent, ''),
    ]) {
      expect(pinPasses(mutant)).toBe(false);
    }
  });
});
describe('cycle-74 T-7410 未消费棘轮（防静默堆积——直接服务「确保生产与消费」）', () => {
  /**
   * 为什么需要「不增长」棘轮（而非只钉几条样例）：
   * 原有断言只要求「基线里**某些**缺口仍被报出」。于是新增 100 个无人消费的键/路由
   * 也能全绿——**未消费面可以静默膨胀**，正是用户诉求点名的「产物未使用却无人察觉」。
   * 本棘轮把**分族计数**钉成上限：只许降（修掉缺口）、不许升；
   * 一旦升级（新增未消费资产）立刻红，迫使改动者显式面对。
   *
   * 为什么按**族**钉而非逐项：逐项清单会让每次新增工具/键都要改这一个大数组，
   * 易漏易冲突；分族计数是紧的上界且维护成本低，配合既有逐项基线已足够。
   *
   * ## cycle-76 调整（routes 44 → 46，i18n 42 → 39）——**不是放宽，是修正**
   *
   * 引入证据倒排索引后，路由/工具族的证据**开始统一去注释**（i18n 族一直是这么做的）。
   * 复核旧 19 条「已消费」路由，其中 **2 条的唯一证据是注释行**：
   *   · `/anic/self/evaluate` ← `selfBootstrapFlow.ts:4`（JSDoc 头注里的端点清单）
   *   · `/anic/self/status`   ← `selfBootstrap.ts:12`（JSDoc 头注里的 `GET /anic/self/status`）
   * 按判定纪律⑥「注释里的示例路径不是消费」，它们本就该是未消费 ⇒ routes 44 → 46 是**纠正**。
   * i18n 42 → 39 则因 cycle-75/76 新增的 17 个键全部有消费方（渲染层在用）。
   *
   * 该结论有**独立守卫**兜住（下方「证据锚点不得落在注释行」用例）——若将来又有人把
   * 注释当证据，那条会红，所以这里的上调不是「让套件变绿」的妥协。
   */
  // cycle-80：routes 46 → 47 —— 新增 `POST /anic/api/reload` 是**通道独占**（外部运维/脚本调用；
  // 本仓消费方是 anic_reload_self 工具 in-process，HTTP 面自身无调用点）。已按纪律补 owner/docRef/reason
  // 声明（channelRegistry），故按本文件自身要求「显式上调基线并说明理由」上调，不是放宽。
  //
  // cycle-83：routes 47 → 49 —— 新增 `/anic/api/archive/baseline` 与 `/anic/api/archive/inventory`
  // 两条产物治理面（本轮交付要求新建）。两者同样是**通道独占**：消费者是面板的"重置基线"按钮
  // 与运维 curl，本仓代码不自调（自调会让基线重置失去运维留痕的意义）。已各自补
  // owner/docRef/reason 声明，docRef 指向 `docs/agents/API参考-数据面.md` §7/§8——那两节写明了
  // "为什么移动而不是删除（INV-9）"与准入判据，声明有据（validateDeclarationDocs 逐条校验通过）。
  // 性质说明：这是**新增路由的必然结果**，不是"缺口变多"——两条都归入 declaredChannel，
  // consumedGap 仍为 0。按棘轮纪律显式上调基线并说明理由（上调是义务面对，不是放宽判据）。
  const BASELINE: Record<string, number> = { i18n: 39, routes: 49 };

  /**
   * 棘轮判据（**抽成纯函数**，好让反向自检能对着同一判据证明它两态可分）。
   * `null` = 未超限（合规）；否则返回一句人话理由。
   */
  function growthViolation(cl: { cluster: string; unconsumed: number }): string | null {
    const limit = BASELINE[cl.cluster];
    if (limit === undefined) return null;
    return cl.unconsumed > limit
      ? `族 ${cl.cluster} 未消费数 ${cl.unconsumed} 超过基线 ${limit}——新增了无人消费的资产。`
        + '要么补消费方，要么显式上调基线并说明理由。'
      : null;
  }

  it('分族未消费数**不得超过**基线（只许降不许升）', () => {
    for (const cl of summary.clusters) {
      expect(growthViolation(cl), '未消费面静默膨胀').toBeNull();
    }
  });

  it('总量未消费数不得超过基线之和（86）', () => {
    const limit = Object.values(BASELINE).reduce((a, b) => a + b, 0);
    expect(summary.totals.unconsumed).toBeLessThanOrEqual(limit);
  });

  /**
   * ★cycle-76 新增：**证据锚点不得来自注释**（判定纪律⑥的机器守卫）。
   *
   * 本轮实测抓到的真实假阳性来源：旧路由/工具族在**原始文本**上取证据，于是 JSDoc
   * 头注里列举的端点被算成「有人消费」。该形态极隐蔽——注释是给**人**看的，
   * 却被当成**调用方**；白盒面因此把未消费报成已消费（比漏报更危险：它让人放心）。
   *
   * 判据按**扫描器能保证的不变式**定义：该行**去注释后**仍含被引用的 token ⇒ 真消费；
   * 去注释后 token 消失 ⇒ 它原本只在注释里 ⇒ 违规。
   *
   * ## 已知边界（诚实标注，不是放宽）
   *
   * `scripts/generate-snapshot.mjs` 在**模板字符串**里生成一段 JSDoc，其中提到
   * `/anic/api/workflow-snapshot`。`stripComments` 正确地不去动字符串内容，故该 token
   * 在去注释文本中仍存在、按本判据**合规**。但语义上它是「被生成的文档文本」而非调用方——
   * 属**词法扫描无法区分**的一类（文档写进字符串）。已登记为已知限制（CHANGELOG 遗留段），
   * 不在本守卫的判据范围内，也不因此放宽本判据。
   */
  it('证据锚点不得来自注释（去注释后 token 必须仍在）', () => {
    const offenders: string[] = [];
    for (const cl of summary.clusters) {
      for (const it of cl.items) {
        if (!it.consumed) continue;
        // `dynamic=true` 是**计算键认领**：证据按设计指向**模板行**（如
        // t(`budget.status_${x}`)），该行不含完整键名 —— 显式跳过（语义已由
        // evidenceKind='code' + dynamic 标注，不是「注释造出来的消费」）。
        if (it.dynamic) continue;
        const token = it.id;
        for (const at of it.evidence) {
          const idx = at.lastIndexOf(':');
          const rel = at.slice(0, idx);
          const line = Number(at.slice(idx + 1));
          const rawLine = (readFileSync(join(ROOT, rel), 'utf8').split('\n')[line - 1] ?? '');
          // 去注释后仍在 ⇒ 证据真实存在（不是注释造出来的）
          if (!stripComments(rawLine).includes(token)) {
            offenders.push(it.cluster + '|' + it.id + ' ← ' + at);
          }
        }
      }
    }
    expect(offenders, '注释被当成消费方：' + offenders.slice(0, 5).join(' ; ')).toEqual([]);
  });

  it('反向自检：同一判据能判「合规/违规」两态（不是恒真断言）', () => {
    // 对着**生产判据本身**证明它两态可分——而非另写一段模仿逻辑（那样证明不了真判定器）。
    expect(growthViolation({ cluster: 'i18n', unconsumed: BASELINE.i18n ?? 0 }), '等于基线应合规').toBeNull();
    expect(growthViolation({ cluster: 'i18n', unconsumed: (BASELINE.i18n ?? 0) - 1 }), '低于基线应合规').toBeNull();
    expect(growthViolation({ cluster: 'i18n', unconsumed: (BASELINE.i18n ?? 0) + 1 }), '+1 必须被判违规').not.toBeNull();
    // 未列入基线的族不参与棘轮（新增族由人显式登记，不静默判违规）
    expect(growthViolation({ cluster: 'unknown-cluster', unconsumed: 9999 })).toBeNull();
  });
});
/*
 * ★cycle-78 WS-D：把「通道独占」变成机器可读声明 + **未声明棘轮**。
 *
 * ## 被修的缺口（本轮实测）
 * `routes: 63 注册 / 17 代码消费 / 46 未消费`——46 条全是通道独占（外部 curl /
 * 运维脚本 / MCP 客户端 / 人工面），功能上合法，但机器面前它们与「死代码」无法
 * 区分：面板只能显示「46 条未消费」，人分不清哪条是已声明的运维通道、哪条是
 * 忘了接线的真缺口。
 *
 * ## 声明 ≠ 豁免（本组断言的核心语义）
 * 声明三元组（owner 谁维护 / docRef 哪份文档 / reason 为什么没有本仓消费方）
 * **不改变** consumed=false，也不减少 unconsumed 计数；它只把该路由从
 * 「未知缺口」（consumedGap/producedGap）搬到「已知通道」（declaredChannel）。
 * 新增未消费路由**不声明即棘轮红** —— 声明是义务，不是白名单。
 *
 * ## 为什么 docRef 要机器校验
 * 「指向某份文档」是最容易伪造的证据：写个不存在的锚点肉眼看不出来。
 * validateDeclarationDocs 要求 文件存在 + 锚点命中真实标题 + 该章节正文含路由
 * 字面量，三者同真才算出据；⑤ 用内存副本证明它真能判红。
 */
describe('cycle-78 通道声明（声明 ≠ 豁免）+ 未声明棘轮', () => {
  const routeCl = summary.clusters.find((c) => c.cluster === 'routes');
  const routeItems = routeCl?.items ?? [];
  const registeredRoutes = routeItems.map((x) => x.id);
  const unconsumedRouteItems = routeItems.filter((x) => !x.consumed);
  const unconsumedRoutes = unconsumedRouteItems.map((x) => x.id);
  const FILES = buildTextMap(ROOT, buildFileIndex(ROOT));

  it('① 未消费路由**全部**有机器可读声明（owner/docRef/reason 非空），docRef 逐条有据', () => {
    // 空集下限：未消费路由为 0 时下面的逐条断言全部空转（假守卫）。
    expect(unconsumedRoutes.length, '未消费路由为 0 —— 声明断言空转').toBeGreaterThanOrEqual(40);
    for (const item of unconsumedRouteItems) {
      const decl = item.declaredChannel;
      expect(decl, '未消费路由没有注入声明（面板将把它当未知缺口）：' + item.id).toBeDefined();
      expect(decl?.owner ?? '', item.id + ' owner 为空（等于没人负责）').not.toBe('');
      expect(decl?.docRef ?? '', item.id + ' docRef 为空（等于没文档）').not.toBe('');
      expect(decl?.reason ?? '', item.id + ' reason 为空（等于没解释）').not.toBe('');
      // 归类必须落在「已声明通道」，不是真缺口（否则 46 条运维通道会被当红点）。
      expect(bucketOf(item), item.id + ' 未归入 declaredChannel').toBe('declaredChannel');
    }
    // docRef 机器校验：文件在扫描集 + 锚点命中真实标题 + 该章节正文含路由字面量。
    expect(validateDeclarationDocs(FILES, CHANNEL_DECLARATIONS), 'docRef 不成立（无法追到真实文档章节）').toEqual([]);
    console.log('CLOSURE_CHANNEL_DECLARED ' + JSON.stringify({
      declarations: CHANNEL_DECLARATIONS.length, unconsumedRoutes: unconsumedRoutes.length,
    }));
  });

  it('② 两组成分恒等式成立 + 六分类互斥穷尽（合计恒 = total）', () => {
    const tot = summary.totals;
    // 未消费 = 已声明通道 + 两缺口；已消费 = 生产代码 + 计算键 + 仅通道。
    expect(tot.channelDeclared + tot.consumedGap + tot.producedGap, 'unconsumed 三键恒等式破').toBe(tot.unconsumed);
    expect(tot.consumed, 'consumed = codeConsumed + channelOnly 破').toBe(tot.codeConsumed + tot.channelOnly);
    expect(tot.registered, 'registered = consumed + unconsumed 破').toBe(tot.consumed + tot.unconsumed);
    for (const cl of summary.clusters) {
      const b = bucketsOf(cl.items);
      expect(CLOSURE_BUCKETS.reduce((s, k) => s + b[k], 0), cl.cluster + ' 六分类合计 != total').toBe(cl.total);
      expect(b.declaredChannel + b.consumedGap + b.producedGap, cl.cluster + ' 未消费恒等式破').toBe(cl.unconsumed);
      expect(b.code + b.dynamicClaimed + b.channelOnly, cl.cluster + ' 已消费恒等式破').toBe(cl.consumed);
    }
  });

  it('③ 未声明棘轮：未消费路由的未声明集合必须为空（新增未声明路由 ⇒ 红并点名）', () => {
    const m2 = validateDeclarations(registeredRoutes, unconsumedRoutes);
    expect(
      m2.undeclaredRoutes,
      '未声明路由（新增路由必须补 owner/docRef/reason，或补真消费方）：\n' + m2.undeclaredRoutes.join('\n'),
    ).toEqual([]);
  });

  it('④ 声明表与注册面双向一致：声明了不存在的路由（幽灵声明）⇒ 红', () => {
    const m2 = validateDeclarations(registeredRoutes, unconsumedRoutes);
    expect(m2.staleDeclarations, '声明了注册面不存在的路由：' + m2.staleDeclarations.join(', ')).toEqual([]);
  });

  it('⑤ 反向自检：删一条声明 ⇒ ③ 必红；篡改 docRef ⇒ ① 必红（判据不是恒真）', () => {
    const sample = unconsumedRoutes[0] ?? '';
    expect(sample, '没有未消费路由 —— 下面的变异断言空转').not.toBe('');
    // 变异 1：内存副本删掉一条声明 ⇒ 棘轮必须点名这一条（而不是静默通过）。
    const trimmed = CHANNEL_DECLARATIONS.filter((d) => d.route !== sample);
    expect(validateDeclarations(registeredRoutes, unconsumedRoutes, trimmed).undeclaredRoutes,
      '删掉一条声明后棘轮没红 —— 该断开是装饰').toEqual([sample]);
    // 变异 2：把 docRef 锚点改成不存在的章节 ⇒ docRef 校验必须红。
    const source = CHANNEL_DECLARATIONS.find((d) => d.route === sample);
    expect(source, '样本路由不在声明表里：' + sample).toBeDefined();
    const tampered = [{ ...(source as { route: string; owner: string; docRef: string; reason: string }),
      docRef: 'docs/agents/API参考-周期面.md#99.99-no-such-anchor' }];
    expect(validateDeclarationDocs(FILES, tampered).length, '篡改 docRef 后没红 —— docRef 校验是装饰')
      .toBeGreaterThan(0);
    // 对照：原表仍然全绿（证明变异不是「判据整体失效」造出来的红）。
    expect(validateDeclarationDocs(FILES, CHANNEL_DECLARATIONS)).toEqual([]);
    // 变异 3：模拟「新增了一条没人声明的新路由」⇒ 棘轮必须点名它（这是棘轮的本义）。
    const fabricated = gr('/anic', 'fixture', 'undeclared-route');
    expect(
      validateDeclarations([...registeredRoutes, fabricated], [...unconsumedRoutes, fabricated]).undeclaredRoutes,
      '新增未声明路由未被棘轮抓到 —— 棘轮对新路由无效',
    ).toEqual([fabricated]);
  });
});
