/**
 * `.cycles` 文档生命周期族（第五族）单测（cycle-82 可观测性收口）。
 *
 * ## 守卫纪律（本仓通用）
 *
 *   ① **反向自检**：每条判据都要能判两态（有/无），不写恒真断言；
 *   ② **空扫描集必须抛错**：空集恒绿是假守卫——一个"什么都没扫到"的全绿比报错危险；
 *   ③ **不抽样**：15 个模板逐个断言，不只看"总体 15 条"。
 *
 * ## 为什么这组断言值得存在
 *
 * 这一族回答的是用户点名的诉求「.cycles 各文档的生命周期」。它最容易退化成
 * "有/没有"一句空话——所以这里的核心断言是**矩阵的形状**：
 * 每个 cycle 级模板的 `cycles` 数组长度必须等于扫描到的循环数，且缺失能点名到
 * `cycle-N/文件名`。少了这条，"矩阵"就只是个数组。
 *
 * 只读：夹具写在系统临时目录，真实仓库只读扫描。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACTS_VIEW_CYCLES,
  TEMPLATE_DIR_REL,
  TEMPLATE_SPECS,
  scanArtifacts,
  toArtifactsView,
} from '../../src/host/closureAudit/artifactsClosure.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 真实仓库扫描（只读；多次复用同一结果避免重复 IO）。 */
let REAL: ReturnType<typeof scanArtifacts>;

/** 夹具仓根（最小可扫描结构：模板目录 + 两个循环 + 一个消费者脚本）。 */
let FIX: string;

beforeAll(() => {
  REAL = scanArtifacts(REPO_ROOT);
  FIX = mkdtempSync(join(tmpdir(), 'anic-artifacts-'));
  // 模板目录：全部 15 个模板名（只写空文件，内容与本族无关）
  const tdir = join(FIX, TEMPLATE_DIR_REL);
  mkdirSync(tdir, { recursive: true });
  for (const spec of TEMPLATE_SPECS) writeFileSync(join(tdir, spec.template), '# tpl\n', 'utf8');
  // 两个循环：cycle-1 完整、cycle-2 只有任务清单（用来测缺失点名）
  const c1 = join(FIX, '.cycles', 'cycles', 'cycle-1');
  const c2 = join(FIX, '.cycles', 'cycles', 'cycle-2');
  mkdirSync(c1, { recursive: true });
  mkdirSync(c2, { recursive: true });
  for (const spec of TEMPLATE_SPECS) {
    if (spec.scope !== 'cycle') continue;
    const target = spec.pattern.endsWith('/')
      ? join(c1, spec.pattern, 'r.md')
      : join(c1, spec.pattern);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, '# artifact\n', 'utf8');
  }
  writeFileSync(join(c2, '任务清单.md'), '# tasks\n', 'utf8');
  // 消费者脚本（让 consumed 有据可查；内容只含一个产物名）
  const scripts = join(FIX, 'assets', 'skill', 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'probe.mjs'), "const p = '任务清单.md';\n", 'utf8');
  // 宿主源码面（consumer 扫描要求非空）
  const host = join(FIX, 'src', 'host');
  mkdirSync(host, { recursive: true });
  writeFileSync(join(host, 'probe.ts'), "export const p = '任务清单.md';\n", 'utf8');
});

afterAll(() => {
  if (FIX !== '' && existsSync(FIX)) rmSync(FIX, { recursive: true, force: true });
});

describe('口径守卫：空扫描集必须响亮抛错（空集恒绿 = 假守卫）', () => {
  it('模板目录不存在 ⇒ 抛错（不是"15 个模板全缺"）', () => {
    const empty = mkdtempSync(join(tmpdir(), 'anic-empty-'));
    expect(() => scanArtifacts(empty)).toThrow(/template scan empty/i);
    rmSync(empty, { recursive: true, force: true });
  });

  it('模板在、活跃区与归档区都无循环 ⇒ 抛错（矩阵没有行是无法判定的）', () => {
    const noCycles = mkdtempSync(join(tmpdir(), 'anic-nocycle-'));
    const tdir = join(noCycles, TEMPLATE_DIR_REL);
    mkdirSync(tdir, { recursive: true });
    for (const spec of TEMPLATE_SPECS) writeFileSync(join(tdir, spec.template), '# t\n', 'utf8');
    // cycle-101：判据从「活跃区空即抛」放宽为「活跃区 + 归档区**都**空才抛」——
    // 全部归档是 archive-cycle 的合法收口态（旧判据把正常状态报成故障）。
    // 空集恒绿风险仍在：两处都空依然响亮抛错（本用例继续守这条）。
    expect(() => scanArtifacts(noCycles)).toThrow(/no cycle dirs/i);
    rmSync(noCycles, { recursive: true, force: true });
  });

  it('②b 活跃区空但归档区有循环 ⇒ **不**抛（回退归档区扫描）', () => {
    const archOnly = mkdtempSync(join(tmpdir(), 'anic-archonly-'));
    const tdir = join(archOnly, TEMPLATE_DIR_REL);
    mkdirSync(tdir, { recursive: true });
    for (const spec of TEMPLATE_SPECS) writeFileSync(join(tdir, spec.template), '# t\n', 'utf8');
    mkdirSync(join(archOnly, '.cycles', 'archive', 'cycle-1'), { recursive: true });
    // consumer 扫描非空前置（真实仓形态：assets/skill/scripts 下的 .mjs 消费者）
    const scripts = join(archOnly, 'assets', 'skill', 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'a.mjs'), '// consumer\n', 'utf8');
    expect(() => scanArtifacts(archOnly)).not.toThrow();
    rmSync(archOnly, { recursive: true, force: true });
  });

  it('反面对照：夹具齐备时**不**抛（证明上面的 throw 不是"逢调必抛"）', () => {
    expect(() => scanArtifacts(FIX)).not.toThrow();
  });
});

describe('逐模板三态：registered / 逐循环矩阵 / consumed（不抽样）', () => {
  it('15 个模板逐个在场，且每个都有 id/label/gate/scope', () => {
    expect(REAL.items).toHaveLength(15);
    expect(REAL.templatesScanned).toHaveLength(15);
    for (const it of REAL.items) {
      expect(it.id.length, 'empty id').toBeGreaterThan(0);
      expect(it.label.length, it.id + ' 缺中文名').toBeGreaterThan(0);
      // gate 归属必须有（回答"这份文档缺失会红哪道门"）
      expect(it.gate.length, it.id + ' 缺门禁归属').toBeGreaterThan(0);
      expect(['cycle', 'project', 'ondemand']).toContain(it.scope);
    }
    // 规格表与真实模板目录双向一致（表漂移即红）
    const specTemplates = TEMPLATE_SPECS.map((s) => s.template).sort();
    expect(specTemplates).toEqual([...REAL.templatesScanned].sort());
    expect(REAL.totals.registered).toBe(15);
  });

  it('cycle 级模板的矩阵长度 === 扫描到的循环数（矩阵不是随便一个数组）', () => {
    const cycleItems = REAL.items.filter((i) => i.scope === 'cycle');
    expect(cycleItems.length, '没有 cycle 级模板 —— 矩阵断言空转').toBeGreaterThan(0);
    expect(REAL.cyclesScanned.length, '循环数为零').toBeGreaterThan(0);
    for (const it of cycleItems) {
      expect(it.cycles.length, it.id + ' 矩阵行数与循环数不等').toBe(REAL.cyclesScanned.length);
      // 每个循环恰好出现一次（不重不漏）
      const names = it.cycles.map((c) => c.cycle).sort();
      expect(names).toEqual([...REAL.cyclesScanned].sort());
      // coverage 必须由矩阵推出（自报数字要有比对面）
      const present = it.cycles.filter((c) => c.present).length;
      expect(it.coverage).toBeCloseTo(present / it.cycles.length, 10);
    }
  });

  /**
   * cycle-87 修正：cycle 级点名必须在**夹具**上证明，不能依赖真实仓库里"恰好有缺口"。
   *
   * 原实现要求"真实仓至少有一条 cycle 级缺失"。cycle-86 归档 82 轮后活跃只剩 cycle-86
   * （一个完整的轮），该下限立刻归零 → 假红。而"点名粒度"是**判据性质**，与仓库此刻
   * 健不健康无关：健康的仓库本来就不该有 cycle 级缺口。
   *
   * 现在：夹具 FIX 里 cycle-2 只有任务清单、缺其余 cycle 级模板 ⇒ 必然产生
   * `cycle-2/<文件>` 形态的点名，用它钉死"可行动粒度"；真实仓库侧只校验
   * **形状合法性**（不要求非空）。
   */
  it('缺失能点名到 `cycle-N/文件名`（夹具证明可行动粒度）', () => {
    const fix = scanArtifacts(FIX);
    const cycleMissing = fix.items
      .filter((i) => i.scope === 'cycle')
      .flatMap((i) => i.missing.map((m) => ({ id: i.id, m })));
    expect(cycleMissing.length, '夹具里 cycle-2 缺模板却没点名 —— 判据空转').toBeGreaterThan(0);
    for (const { id, m } of cycleMissing) {
      const mm = /^(cycle-\d+)\/(.+)$/.exec(m);
      expect(mm, id + ' 缺失点名形态不对：' + m).not.toBeNull();
      expect(fix.cyclesScanned, id + ' 点名了未扫描的循环：' + m).toContain(mm?.[1]);
      // 点名与矩阵同源（不各说各话）
      const item = fix.items.find((i) => i.id === id);
      const cell = item?.cycles.find((c) => c.cycle === mm?.[1]);
      expect(cell?.present, id + ' 点名缺失但矩阵说存在：' + m).toBe(false);
    }
    // 且确实点名到了 cycle-2（夹具里唯一不完整的轮）
    expect(cycleMissing.some((x) => x.m.startsWith('cycle-2/'))).toBe(true);
    // 完整的 cycle-1 不该被点名（反向对照：证明不是"每个轮都报")
    expect(cycleMissing.some((x) => x.m.startsWith('cycle-1/'))).toBe(false);
  });

  it('真实仓库的缺失项形状合法（不要求非空——健康仓库本就没有 cycle 级缺口）', () => {
    for (const it of REAL.items.filter((i) => i.missing.length > 0)) {
      // 按需触发类（事故/复盘）零发生是健康的，**永远不该**进缺失清单。
      expect(it.scope, it.id + '（按需触发）被当成缺失').not.toBe('ondemand');
      if (it.scope === 'project') {
        expect(it.missing).toHaveLength(1);
        expect(it.missing[0], it.id + ' 项目级缺失不该带 cycle 前缀').not.toMatch(/^cycle-\d+\//);
        expect(it.projectPresent, it.id + ' 点名缺失却说 projectPresent=true').toBe(false);
        continue;
      }
      for (const m of it.missing) {
        const mm = /^(cycle-\d+)\/(.+)$/.exec(m);
        expect(mm, it.id + ' 缺失点名形态不对：' + m).not.toBeNull();
        expect(REAL.cyclesScanned, it.id + ' 点名了未扫描的循环：' + m).toContain(mm?.[1]);
        const cell = it.cycles.find((c) => c.cycle === mm?.[1]);
        expect(cell?.present, it.id + ' 点名缺失但矩阵说存在：' + m).toBe(false);
      }
    }
  });

  it('project / ondemand 作用域**不**进缺失清单（否则每个健康循环都背假待办）', () => {
    for (const it of REAL.items) {
      if (it.scope === 'cycle') continue;
      expect(it.cycles, it.id + ' 非 cycle 级不该有逐循环矩阵').toHaveLength(0);
      expect(it.coverage, it.id + ' 非 cycle 级不该报覆盖率').toBeNull();
      if (it.scope === 'ondemand') {
        // 零发生是健康的：occurrences 是数字，missing 必须为空
        expect(typeof it.occurrences, it.id + ' 缺 occurrences').toBe('number');
        expect(it.missing, it.id + '（按需触发）被当成缺失').toEqual([]);
      } else {
        expect(typeof it.projectPresent, it.id + ' 缺 projectPresent').toBe('boolean');
      }
    }
  });

  it('consumed 逐模板：证据非空且行号保真（file:line 形态）', () => {
    const consumed = REAL.items.filter((i) => i.consumed);
    expect(consumed.length, '零消费者 —— 消费断言空转').toBeGreaterThan(0);
    for (const it of consumed) {
      expect(it.consumedEvidence.length, it.id + ' 标了 consumed 却无证据').toBeGreaterThan(0);
      for (const e of it.consumedEvidence) {
        expect(/:\d+$/.test(e), it.id + ' 证据缺行号：' + e).toBe(true);
      }
    }
  });
});

describe('夹具两态：缺失点名与"空目录不算产出"', () => {
  const FIXED = (): ReturnType<typeof scanArtifacts> => scanArtifacts(FIX);

  it('cycle-1 完整 / cycle-2 只一份 ⇒ cycle-2 的其余模板全部被点名', () => {
    const rep = FIXED();
    expect(rep.cyclesScanned).toEqual(['cycle-1', 'cycle-2']);
    const task = rep.items.find((i) => i.id === 'task-list');
    expect(task?.cycles.find((c) => c.cycle === 'cycle-1')?.present).toBe(true);
    expect(task?.cycles.find((c) => c.cycle === 'cycle-2')?.present).toBe(true);
    const evalReport = rep.items.find((i) => i.id === 'eval-report');
    expect(evalReport?.missing).toEqual(['cycle-2/项目评估报告.md']);
    // 反向：cycle-1 不得被点名（不误伤）
    expect(evalReport?.cycles.find((c) => c.cycle === 'cycle-1')?.present).toBe(true);
  });

  it('空 test-reports 目录**不算**产出（脚手架残留不是证据）', () => {
    const dir = join(FIX, '.cycles', 'cycles', 'cycle-1', 'test-reports');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true }); // 只建空目录
    const rep = scanArtifacts(FIX);
    const tr = rep.items.find((i) => i.id === 'test-report');
    expect(tr?.cycles.find((c) => c.cycle === 'cycle-1')?.present, '空目录被算成产出').toBe(false);
    expect(tr?.missing).toContain('cycle-1/test-reports/');
    // 复原：放回一份报告（后续断言依赖）
    writeFileSync(join(dir, 'r.md'), '# test\n', 'utf8');
    expect(scanArtifacts(FIX).items.find((i) => i.id === 'test-report')
      ?.cycles.find((c) => c.cycle === 'cycle-1')?.present).toBe(true);
  });
});

describe('投影：紧凑矩阵 + 缺失窗口收敛 + 体积可控', () => {
  it('矩阵编码为 `cycle-N:1|0`，长度 = min(循环数, 窗口)', () => {
    const v = toArtifactsView(REAL);
    const expected = Math.min(REAL.cyclesScanned.length, ARTIFACTS_VIEW_CYCLES);
    expect(v.cyclesScanned).toHaveLength(expected);
    expect(v.cyclesScanned).toEqual(REAL.cyclesScanned.slice(-ARTIFACTS_VIEW_CYCLES));
    for (const it of v.items.filter((i) => i.scope === 'cycle')) {
      expect(it.matrix).toHaveLength(expected);
      for (const cell of it.matrix) expect(/^cycle-\d+:[01]$/.test(cell), '编码不对：' + cell).toBe(true);
    }
  });

  it('缺失点名只留窗口内（窗口外是历史，不推成待办）', () => {
    const v = toArtifactsView(REAL);
    const keep = new Set(v.cyclesScanned);
    for (const it of v.items) {
      for (const m of it.missing) {
        const mm = /^(cycle-\d+)\//.exec(m);
        if (mm) expect(keep.has(mm[1] as string), '窗口外的缺失被推成待办：' + m).toBe(true);
      }
    }
  });

  it('确定性：两次投影逐字段相等（矩阵顺序依赖 Map 遍历即不稳定）', () => {
    const a = JSON.stringify(toArtifactsView(scanArtifacts(FIX)));
    const b = JSON.stringify(toArtifactsView(scanArtifacts(FIX)));
    expect(a).toBe(b);
  });

  it('投影**不含绝对路径**（服务端本地路径不出网）', () => {
    const json = JSON.stringify(toArtifactsView(REAL));
    expect(json).not.toContain(String.fromCharCode(58, 92)); // ":\"
    expect(json).not.toContain(REPO_ROOT.replace(/\\/g, '/'));
  });

  it('totals 自洽：registered/consumed 由明细推出（自报数字必须有比对面）', () => {
    const v = toArtifactsView(REAL);
    expect(v.totals.registered).toBe(v.items.filter((i) => i.registered).length);
    expect(v.totals.consumed).toBe(v.items.filter((i) => i.consumed).length);
    expect(v.totals.templates).toBe(v.items.length);
    expect(v.totals.uncovered).toBe(0);
  });
});
