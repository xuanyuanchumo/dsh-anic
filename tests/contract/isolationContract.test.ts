/**
 * 跨项目隔离**契约**（cycle-82 可观测性收口）——真实仓库的不变量钉。
 *
 * ## 被守卫的缺陷类
 *
 * ANIC 是"一个插件服务多个项目"：同一宿主进程里，`.cycles/` 数据来自用户选中的
 * workspace。任何一处路径不是从 workspace 根推导出来，就会出现：
 *   - **串项目**：A 项目的门禁记录写进 B 项目账本；
 *   - **写坏插件自身**：路径兜底到 `process.cwd()`（宿主从仓库根启动 = 插件自己）。
 * 两者都**不会让测试变红**，只有人某天发现"账本里多了别家的记录"。
 *
 * ## 本契约的四条腿（每条都必须能判两态）
 *
 *   ① 真实仓基线：全部 12 条持久化路径都在工作区内，零绝对路径泄漏；
 *   ② **反向自检**：注入 workspace 外的绝对路径 ⇒ 必须被点名（用户点名的底线）；
 *   ③ 反向自检（路径来源）：`..` 逃逸与 `process.cwd()` 形态各有一条真夹具；
 *   ④ 投影安全：响应里不出现任何本地绝对路径。
 *
 * 纪律：只读扫描（R-31）；不写工作区、不改源码。
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_PATHS,
  checkIsolation,
  inWorkspace,
  judgePath,
  scanAbsoluteLiterals,
  toIsolationView,
} from '../../src/host/closureAudit/isolation.ts';
import { runClosureAudit, toClosureView } from '../../src/host/closureAudit/registryClosure.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BS = String.fromCharCode(92);

/** 真实仓报告（只读；一次构建多次复用）。 */
const REPORT = checkIsolation(ROOT, ROOT);

describe('① 真实仓基线：持久化路径全部落在工作区内', () => {
  it('登记表覆盖 12 条持久化面（少一条即覆盖缺口）', () => {
    const ids = WORKSPACE_PATHS.map((p) => p.id).sort();
    expect(ids).toEqual([
      'autonomy-history', 'band-history', 'config', 'evals', 'flow-tracker', 'flows',
      'gates', 'ledger', 'reload-history', 'self-bootstrap', 'tech-debt', 'workflow-state',
    ]);
    // 每条都是工作区相对（`.cycles/…`）——不是绝对路径、不是 ../ 逃逸
    for (const p of WORKSPACE_PATHS) {
      expect(p.rel.startsWith('.cycles/'), p.id + ' 不在 .cycles 下：' + p.rel).toBe(true);
      expect(p.rel.includes('..'), p.id + ' 含 .. 逃逸').toBe(false);
    }
  });

  it('零污染违规（violations 为空）——这是隔离的**主读数**', () => {
    expect(REPORT.violations, JSON.stringify(REPORT.violations, null, 1)).toEqual([]);
    expect(REPORT.scannedFiles, '源码扫描集为空 = 假守卫').toBeGreaterThan(50);
    expect(REPORT.items).toHaveLength(WORKSPACE_PATHS.length);
    for (const i of REPORT.items) {
      expect(i.inWorkspace, i.id + ' 越出工作区').toBe(true);
      expect(i.source, i.id + ' 路径来源不是 ok').toBe('ok');
    }
  });

  it('死登记（dangling）：登记了但源码无锚点——如实暴露，不静默', () => {
    /*
     * cycle-82 先后两次实测，值得记下来：
     *
     * ① 首测：`.cycles/evals` 报为死登记。当时判为"登记表与源码漂移"。
     * ② 复查（真机 `GET /anic/api/closure-audit` 仍报 `ok:false` + dangling `evals`）
     *    揪出**真正原因是扫描器失明**：`sourceFiles()` 的扫描面是硬编码的五个目录
     *    `['src/host','src/host/routes','src/host/runtime','src/host/evolution','src/host/flows']`，
     *    且 `readdirSync` **不递归** —— 只扫到 `src/host/*.ts` 一层。
     *    `configEdit/paths.ts` 里**明明有** `.cycles/evals` 的读取锚点，却没被看见。
     *
     * 这条教训（与 cycle-72「只扫单文件漏掉拆出去的分区」、cycle-75「tools.ts 单文件计数」
     * 同族）：**扫描器的域必须由"源码在哪"决定，不能由"历史上哪几个目录存在"决定**。
     * 修法是把扫描面改成 `src/host/` 递归全量（见 isolationScan.sourceFiles）。同一失明
     * 也作用于 `absolute-literal` 扫描——新子目录里的写死绝对路径此前也不会被报。
     *
     * 现在：**零死登记**。断言直接钉 `[]`，因为"如实暴露事实"已经不再需要豁免——
     * 若未来某条登记真的失去锚点，这里立刻红，而那是**应当**被看见的信号。
     */
    expect(REPORT.dangling, '死登记（登记表有、源码无读写锚点）').toEqual([]);
    // 扫描集必须真实覆盖到子目录（防"递归又退回单层"的回归）
    expect(REPORT.scannedFiles, '扫描面回退到单层（漏子目录）').toBeGreaterThan(100);
  });

  it('源码零写死绝对路径（注释里的"实测踩坑"例子不算）', () => {
    expect(scanAbsoluteLiterals(ROOT).map((v) => v.target)).toEqual([]);
  });
});

describe('② 反向自检：注入 workspace 外绝对路径必须被点名（用户底线）', () => {
  it('judgePath 对 workspace 外绝对路径判 escape 且 inWorkspace=false', () => {
    const ws = join(tmpdir(), 'anic-contract-ws');
    const other = join(tmpdir(), 'anic-contract-other', '.cycles', 'gates', 'ledger.json');
    const j = judgePath(ws, other, 'probe:1');
    expect(j.source).toBe('escape');
    expect(j.inWorkspace).toBe(false);
    // 反向：同一个 judgePath 对工作区内路径必须放行（证明判据不是"逢调必红"）
    expect(judgePath(ws, '.cycles/gates/ledger.json', 'probe:1').source).toBe('ok');
  });

  it('§`..` 逃逸被点名（即使解析后仍在工作区内）', () => {
    const ws = join(tmpdir(), 'anic-contract-ws');
    expect(judgePath(ws, '.cycles/../workflow-state.json', 'probe:2').source).toBe('escape');
  });

  it('§cwd 兜底形态：把 workspace 当 "当前目录" 的假设不能凭证通过', () => {
    /*
     * cwd 兜底的本质是"路径不来自 workspace，而来自进程启动目录"。判据上它表现为
     * **路径与 workspace 无关**（绝对路径落在别处）——即 escape。
     * 这里用两个不同的绝对根模拟：宿主从仓库根启动时的 cwd ≠ 用户 workspace。
     */
    const repoAsCwd = ROOT;
    const userWs = join(tmpdir(), 'anic-contract-user-project');
    const resolvedFromCwd = join(repoAsCwd, '.cycles', 'gates', 'ledger.json');
    const j = judgePath(userWs, resolvedFromCwd, 'src/host/probe.ts:9');
    expect(j.source, 'cwd 兜底解析出的路径未被判红').toBe('escape');
    expect(inWorkspace(userWs, resolvedFromCwd)).toBe(false);
  });

  it('前缀碰撞不得蒙混（`proj-evil` 不在 `proj` 内）', () => {
    const base = join(tmpdir(), 'anic-contract-proj');
    expect(inWorkspace(base, join(tmpdir(), 'anic-contract-proj-evil', 'x'))).toBe(false);
    expect(inWorkspace(base, join(base, 'x'))).toBe(true);
  });
});

describe('③ 接进闭环体检响应：isolation 键在场且去绝对路径', () => {
  it('runClosureAudit 汇总带 isolation；投影**不含** rootDir / workspace 绝对路径', () => {
    const summary = runClosureAudit(ROOT);
    expect(summary.isolation, '汇总缺 isolation 面').toBeDefined();
    expect(summary.isolation.items.length).toBe(WORKSPACE_PATHS.length);
    const view = toClosureView(summary);
    expect(view.isolation, '投影缺 isolation 键（面板取不到）').toBeDefined();
    const json = JSON.stringify(view.isolation);
    // 投影里不得出现本地绝对路径（含 Windows 盘符形态）
    expect(json).not.toContain(ROOT);
    expect(json).not.toContain(ROOT.replace(/\\/g, '/'));
    expect(json).not.toContain(':' + BS);
    // 服务端字段 workspace 必须被投影剥掉
    expect(view.isolation).not.toHaveProperty('workspace');
    // 投影保留判定结论与逐项事实
    const iso = view.isolation as NonNullable<typeof view.isolation>;
    expect(typeof iso.ok).toBe('boolean');
    expect(iso.items.length).toBe(WORKSPACE_PATHS.length);
    expect(Array.isArray(iso.violations)).toBe(true);
    expect(Array.isArray(iso.dangling)).toBe(true);
  });

  it('既有键不变（纯增量：五族 + 连通性 + 截断仍在）', () => {
    const view = toClosureView(runClosureAudit(ROOT));
    for (const k of ['generatedAt', 'totals', 'clusters', 'unconsumed', 'ghost', 'notes', 'connectivity', 'truncation']) {
      expect(view, '既有键被移除：' + k).toHaveProperty(k);
    }
    // 四族齐备（新面不得挤掉旧族）
    expect(view.clusters.map((c) => c.cluster).sort()).toEqual(['i18n', 'routes', 'skills', 'tools']);
  });

  it('投影可无损往返（面板数据面直接消费）', () => {
    const view = toClosureView(runClosureAudit(ROOT));
    const roundtrip = JSON.parse(JSON.stringify(view)) as unknown;
    expect(roundtrip).toEqual(view);
  });
});

describe('④ 与第五族共存：artifacts 键在场且矩阵非空', () => {
  it('artifacts 投影在场，且每个 cycle 级模板矩阵非空', () => {
    const view = toClosureView(runClosureAudit(ROOT));
    expect(view.artifacts, '投影缺 artifacts 键').toBeDefined();
    const a = view.artifacts as NonNullable<typeof view.artifacts>;
    expect(a.items.length).toBe(15);
    expect(a.cyclesScanned.length, '矩阵窗口为空').toBeGreaterThan(0);
    for (const it of a.items.filter((i) => i.scope === 'cycle')) {
      expect(it.matrix.length, it.id + ' 矩阵为空').toBe(a.cyclesScanned.length);
    }
  });
});
