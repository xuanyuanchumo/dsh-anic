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
import { runClosureAudit, clustersConsistent, toClosureView } from '../../src/host/closureAudit/registryClosure.ts';

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

describe('cycle-72 T-7207 闭环体检契约（注册↔生产↔消费）', () => {
  it('纪律③ 扫描集非空下限：三族各 ≥10（空扫描 = 永久假绿，直接 FAIL）', () => {
    expect(tcl?.total ?? 0).toBeGreaterThanOrEqual(15);
    expect(i18nCl?.total ?? 0).toBeGreaterThanOrEqual(100);
    expect(routeCl?.total ?? 0).toBeGreaterThanOrEqual(40);
    expect(summary.scannedFiles).toBeGreaterThanOrEqual(200);
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
      'i18n|' + gk('state', 'retry'),
      'i18n|' + gk('techdebt', 'title'),
      'i18n|' + gk('panel', 'refreshing'),
      'i18n|' + gk('gate', 'PASS'),
      'i18n|' + gk('budget', 'status_alert'),
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

  it('工具消费面分级：13 项仅 channel 证据（测试/agent 卡），不冒充生产消费', () => {
    const channelOnly = (tcl?.items ?? []).filter((x) => x.evidenceKind === 'channel').map((x) => x.id).sort();
    const codeLevel = (tcl?.items ?? []).filter((x) => x.evidenceKind === 'code').length;
    console.log('CLOSURE_TOOL_EVIDENCE ' + JSON.stringify({ codeLevel, channelOnly: channelOnly.length }));
    // 基线：code 级 >0（确有生产代码消费方）；channel-only 剩余项如实计数
    expect(codeLevel).toBeGreaterThan(0);
    expect(codeLevel + channelOnly.length).toBe(tcl?.total ?? 0);
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
    const panelSrc = readFileSync(join(ROOT, 'src', 'client', 'WorkflowGraphPanel.ts'), 'utf8');
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
      && src.includes('createElement(' + component + ', { store })')
      && src.includes(dataLegCall);
    // 前向：原始树必须通过
    expect(pinPasses(panelSrc)).toBe(true);
    // 反向：分别删掉「数据腿 import」与「数据腿调用」，判据都必须翻假（两条独立变异）
    for (const mutant of [
      panelSrc.replace(importedTarget, ''),
      panelSrc.replace(dataLegCall, ''),
      panelSrc.replace('createElement(' + component + ', { store })', ''),
      panelSrc.replace(importedComponent, ''),
    ]) {
      expect(pinPasses(mutant)).toBe(false);
    }
  });
});
