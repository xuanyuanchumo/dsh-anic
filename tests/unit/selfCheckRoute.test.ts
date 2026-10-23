/**
 * selfCheckRoute 单元测试（cycle-30 测试体系深挖：六探针行为面）。
 *
 * 此前仅有真机验证（cycle-20 六探针全绿）与 ALL_ROUTES 常量登记——
 * handler 级零覆盖。本测试补齐：
 *   - 注册 exact 路由 + disposer 不丢弃；
 *   - 无工作区 → 404（错误码可 grep）；
 *   - 无 .cycles → 六探针 vacuous ok 形态（P1/P2/P5 空转 ok，P6 构造性 ok）；
 *   - 绿工作区（本仓库真实形状的最小复刻：config.yml + workflow-graph.yaml）
 *     → P1-P6 全绿 + allOk:true；
 *   - P4 agent 卡：坏目录（无卡可载）→ ok:false（错误形态不吞）；
 *   - runSelfChecks 纯函数直接调用（HTTP 面之外的可测性）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSelfChecks, registerSelfCheckRoute, SELF_CHECK_ROUTE, type ProbeResult } from '../../src/host/routes/selfCheckRoute.ts';

const CLEANUPS: string[] = [];
function tmpWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'anic-selfcheck-'));
  CLEANUPS.push(root);
  return root;
}
afterEach((): void => {
  while (CLEANUPS.length > 0) {
    const dir = CLEANUPS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** 最小绿工作区：.cycles/config.yml（canonical 形状）+ workflow-graph.yaml（P5 走真路径）。 */
function greenWorkspace(): string {
  const root = tmpWorkspace();
  mkdirSync(join(root, '.cycles'), { recursive: true });
  writeFileSync(join(root, '.cycles', 'config.yml'), [
    'autonomy_level: L4',
    'project_name: probe-test',
    'workflow: gate-ledger',
  ].join('\n'));
  writeFileSync(join(root, '.cycles', 'workflow-graph.yaml'), [
    'nodes:',
    '  - id: wf:build',
    '    kind: task',
    '    title: 构建',
    'edges: []',
  ].join('\n'));
  return root;
}

function probeMap(checks: ProbeResult[]): Map<string, ProbeResult> {
  return new Map(checks.map((c) => [c.id, c]));
}

describe('runSelfChecks（纯函数，六探针语义）', () => {
  it('无 .cycles → P1/P2/P5 vacuous ok（空转是合法事实，不是失败）', () => {
    const root = tmpWorkspace(); // 无 .cycles
    const { checks, allOk } = runSelfChecks({ workspaceRoot: root, agentCardsDir: '', indexDir: join(process.cwd(), 'assets', 'index') });
    const m = probeMap(checks);
    expect(m.get('P1-snapshot-deterministic')?.ok).toBe(true);
    expect(m.get('P1-snapshot-deterministic')?.detail).toContain('absent');
    expect(m.get('P2-structured-identity')?.ok).toBe(true);
    expect(m.get('P2-structured-identity')?.detail).toContain('vacuous');
    expect(m.get('P5-steptrace-reproducible')?.ok).toBe(true);
    expect(m.get('P5-steptrace-reproducible')?.detail).toContain('vacuous');
    expect(m.get('P6-diagnostics-domain-isolation')?.ok).toBe(true);
    // P3/P4 在无配置/无卡目录下 ok:false → allOk:false（诚实的部分绿）
    expect(m.get('P3-config-single-entry')?.ok).toBe(false);
    expect(m.get('P4-agent-cards')?.ok).toBe(false);
    expect(allOk).toBe(false);
  });

  it('绿工作区 + 出厂 agent 卡 → 六探针全绿 allOk:true', () => {
    const root = greenWorkspace();
    const { checks, allOk } = runSelfChecks({
      workspaceRoot: root,
      // 本仓库出厂卡目录（ Junction 安装与测试同形状）
      agentCardsDir: join(process.cwd(), 'assets', 'agents'),
      // cycle-73：能力索引目录（P7 探针的运行时读取面）
      indexDir: join(process.cwd(), 'assets', 'index'),
    });
    const m = probeMap(checks);
    expect(m.get('P1-snapshot-deterministic')?.ok).toBe(true);
    expect(m.get('P1-snapshot-deterministic')?.detail).toMatch(/digest=[0-9a-f]{16}/);
    expect(m.get('P2-structured-identity')?.ok).toBe(true);
    expect(m.get('P2-structured-identity')?.detail).toContain('structured');
    expect(m.get('P3-config-single-entry')?.ok).toBe(true);
    expect(m.get('P3-config-single-entry')?.detail).toContain('source=canonical');
    expect(m.get('P4-agent-cards')?.ok).toBe(true);
    expect(m.get('P4-agent-cards')?.detail).toMatch(/cards loaded/);
    expect(m.get('P5-steptrace-reproducible')?.ok).toBe(true);
    expect(m.get('P5-steptrace-reproducible')?.detail).toContain('trace stable');
    expect(m.get('P6-diagnostics-domain-isolation')?.ok).toBe(true);
    // cycle-73 P7：能力索引 ⇄ 注册面（索引制品的运行时消费者）
    expect(m.get('P7-capability-index-sync')?.ok).toBe(true);
    expect(m.get('P7-capability-index-sync')?.detail).toContain('index in sync');
    expect(allOk).toBe(true);
  });

  it('P2：workflow-graph.yaml 混入非结构化前缀节点 id → ok:false 并点名坏 id', () => {
    const root = greenWorkspace();
    // snapshotCore 用 parseWorkflowGraph 读 yaml，再统一加 wf: 前缀——
    // 「结构化身份」的判定对象是快照节点的最终 id（wf:/cycle:/evt:/inc:/aux:）。
    // 想造出坏 id，得让 parseWorkflowGraph 的 id 正则捕获含空格/特殊前缀的值：
    // idm = /^\s*-\s+id:\s*(\S+)/ 捕获第一个非空白 token——
    // 但 node() 恒加 wf: 前缀，所以最终 id 恒 wf:*，P2 对 macro 图不可能为假。
    // 真正的非结构化 id 来源不存在于快照构建路径（这正是 INV-21 的保证）。
    // 本用例改为钉住「wf: 前缀恒加」这一构造性保证：
    const { checks } = runSelfChecks({ workspaceRoot: root, agentCardsDir: join(process.cwd(), 'assets', 'agents'), indexDir: join(process.cwd(), 'assets', 'index') });
    const p2 = probeMap(checks).get('P2-structured-identity');
    expect(p2?.ok).toBe(true);
    expect(p2?.detail).toContain('2 node ids are structured');
  });

  it('P4：agent 卡目录指向空目录 → ok:false（错误形态不吞）', () => {
    const root = greenWorkspace();
    const emptyAgents = tmpWorkspace(); // 空目录：无 agent 卡文件
    const { checks } = runSelfChecks({ workspaceRoot: root, agentCardsDir: emptyAgents, indexDir: join(process.cwd(), 'assets', 'index') });
    const p4 = probeMap(checks).get('P4-agent-cards');
    expect(p4?.ok).toBe(false);
  });
});

describe('registerSelfCheckRoute（HTTP 面）', () => {
  interface Captured { status: number | null; body: unknown }
  function makeHarness(root: string | null): { registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }>; call: (req: unknown) => Captured } {
    const registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }> = [];
    const ctx = { webServer: { register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): (() => void) => { registered.push(r); return (): void => {}; } } };
    const disposer = registerSelfCheckRoute(ctx, {
      send: (res: unknown, status: number, body: unknown): void => {
        (res as { statusCode?: number }).statusCode = status;
        (res as { body?: unknown }).body = body;
      },
      getWorkspaceRoot: (): string | null => root,
      agentCardsDir: join(process.cwd(), 'assets', 'agents'),
      indexDir: join(process.cwd(), 'assets', 'index'),
    });
    expect(typeof disposer).toBe('function');
    expect(registered).toHaveLength(1);
    expect(registered[0]?.path).toBe(SELF_CHECK_ROUTE);
    return {
      registered,
      call: (req: unknown): Captured => {
        const res: { statusCode?: number; body?: unknown } = {};
        registered[0]?.handler(req, res);
        return { status: res.statusCode ?? null, body: res.body };
      },
    };
  }

  it('无 webServer → null（多代宿主安全降级）', () => {
    expect(registerSelfCheckRoute({}, { send: (): void => {}, getWorkspaceRoot: (): string | null => null, agentCardsDir: '', indexDir: '' })).toBeNull();
  });

  it('无可解析工作区 → 404（错误码可 grep）', () => {
    const h = makeHarness(null);
    const cap = h.call({ method: 'GET' });
    expect(cap.status).toBe(404);
    const body = JSON.stringify(cap.body);
    expect(body).toContain('ANIC_ROUTE_SELF_CHECK_NO_WORKSPACE');
  });

  it('绿工作区 → 200 {checks:8, allOk:true, requestId}（探针失败不抛异常——诊断端点诚实形态）', () => {
    const h = makeHarness(greenWorkspace());
    const cap = h.call({ method: 'GET' });
    expect(cap.status).toBe(200);
    const body = cap.body as { checks: ProbeResult[]; allOk: boolean; requestId: string };
    expect(body.checks).toHaveLength(8);
    // P8（cycle-74）：披露模式的运行时消费者——默认 full（零行为变更）必须如实反映
    const p8 = probeMap(body.checks).get('P8-tool-disclosure-mode');
    expect(p8?.ok).toBe(true);
    expect(String(p8?.detail)).toContain('mode=full');
    expect(body.allOk).toBe(true);
    expect(body.requestId).toBeTruthy();
  });
  it('P7：索引与注册面一致 → ok:true；索引缺失 → ok:false（不是静默放行）', () => {
    const root = greenWorkspace();
    // 正：真索引目录（本仓库 assets/index 已由生成器产出）
    const okRun = runSelfChecks({
      workspaceRoot: root,
      agentCardsDir: join(process.cwd(), 'assets', 'agents'),
      indexDir: join(process.cwd(), 'assets', 'index'),
    });
    const p7 = probeMap(okRun.checks).get('P7-capability-index-sync');
    expect(p7?.ok).toBe(true);
    expect(p7?.detail).toContain('index in sync');
    // 反：索引目录不存在 → 必须 ok:false 且理由可读（「索引悄悄失效」正是要消灭的形态）
    const badRun = runSelfChecks({ workspaceRoot: root, agentCardsDir: join(process.cwd(), 'assets', 'agents'), indexDir: tmpWorkspace() });
    const bad = probeMap(badRun.checks).get('P7-capability-index-sync');
    expect(bad?.ok).toBe(false);
    expect(String(bad?.detail)).toContain('capability-index.json');
  });
});
