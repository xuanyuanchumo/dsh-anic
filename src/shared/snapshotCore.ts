/**
 * ANIC 工作流快照构建器 —— 唯一实现（generate-snapshot.mjs 与宿主路由共用；
 * 「同一语义的两条数据路径必须共享一个实现」，父工程 buildFilePairAggregate 教训）。
 *
 * 输入：真实 `.cycles/` 目录（结构化字段 only，INV-21 合规——cycle/事件身份绝不从
 * detail 自由文本解析）。输出：分层布局节点/边 + autonomy + counts。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal YAML extraction for the skill's workflow-graph.yaml shape only. */
export function parseWorkflowGraph(text: string): { nodes: { id: string; type: string; label: string }[]; edges: { from: string; to: string; type: string }[] } {
  const nodes: { id: string; type: string; label: string }[] = [];
  const edges: { from: string; to: string; type: string }[] = [];
  let cur: { id: string; type: string; label: string } | null = null;
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^nodes:/.test(line)) { section = 'nodes'; continue; }
    if (/^edges:/.test(line)) { section = 'edges'; continue; }
    if (/^\S/.test(line)) { section = ''; continue; }
    if (section === 'nodes') {
      const idm = line.match(/^\s*-\s+id:\s*(\S+)/);
      if (idm) { cur = { id: idm[1] ?? '', type: 'phase', label: idm[1] ?? '' }; nodes.push(cur); continue; }
      if (cur) {
        const t = line.match(/^\s*type:\s*(\S+)/);
        if (t?.[1]) cur.type = t[1];
        const l = line.match(/^\s*label:\s*"([^"]*)"/);
        if (l?.[1]) cur.label = l[1];
      }
    }
    if (section === 'edges') {
      const m = line.match(/^\s*-\s*\{\s*from:\s*(\S+?),\s*to:\s*(\S+?)(?:,\s*type:\s*"([^"]+)")?\s*\}/);
      if (m) edges.push({ from: m[1] ?? '', to: m[2] ?? '', type: m[3] ?? 'flow' });
    }
  }
  return { nodes, edges };
}

export interface SnapshotNode { id: string; type: string; label: string; x: number; y: number; result?: string; detail?: string; testReport?: { report: string; passed: number; failures: number; errors: number; layers: string[] } }
export interface SnapshotEdge { from: string; to: string; type: string }
export interface WorkflowSnapshotData {
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  autonomy: string;
  counts: { nodes: number; edges: number; cycles: number; ledgerEntries: number; incidents: number };
}

function dirExists(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 从真实 .cycles/ 构建快照。任一数据源缺失都安全降级（少一类节点），绝不 throw ——
 * 宿主路由对未 init 的项目必须返回可用（空）图而不是 500。
 */
export function buildWorkflowSnapshot(cyclesDir: string, generatedAt = new Date().toISOString()): WorkflowSnapshotData & { generatedAt: string; source: 'live' } {
  // 1) macro graph
  const wfPath = join(cyclesDir, 'workflow-graph.yaml');
  const wf = existsSync(wfPath)
    ? parseWorkflowGraph(readFileSync(wfPath, 'utf8'))
    : { nodes: [], edges: [] };

  // 2) cycle dirs (numeric order — lib/cycle.mjs semantics)
  const cyclesRoot = join(cyclesDir, 'cycles');
  const cycleDirs = dirExists(cyclesRoot)
    ? readdirSync(cyclesRoot)
        .filter((n) => /^cycle-\d+$/.test(n))
        .map((n) => ({ name: n, num: Number(n.slice(6)) }))
        .sort((a, b) => a.num - b.num)
    : [];

  // 3) ledger (structured fields) — cycle-38 W-3 快档：detail 一并提取（此前被
  //    丢弃），供节点详情抽屉回答「这一门为什么 PASS/FAIL」——白盒的「为什么」层。
  const ledgerPath = join(cyclesDir, 'gates', 'ledger.json');
  let entries: { gate?: string; result?: string; detail?: string }[] = [];
  if (existsSync(ledgerPath)) {
    try {
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { entries?: { gate?: string; result?: string; detail?: string }[] };
      entries = ledger.entries ?? [];
    } catch { entries = []; }
  }

  // 4) incidents (filenames as facts)
  const incidentsRoot = join(cyclesDir, 'incidents');
  const incidents = dirExists(incidentsRoot)
    ? readdirSync(incidentsRoot).filter((f) => f.endsWith('.md'))
    : [];

  // 4b) W-3 全档（cycle-39 T-3904）：最新 test-report 摘要投影进快照——
  //     gate-event 节点携带，节点详情抽屉可答「这轮测试什么状态」。
  //     解析语义与 gateArtifacts.parseTestSummary 同构（§2 汇总表契约），
  //     但本文件是 shared（client 可用），不 import host 模块——正则复制
  //     + flowDifferential 差分已钉死双侧一致。
  let testReport: { report: string; passed: number; failures: number; errors: number; layers: string[] } | null = null;
  if (cycleDirs.length > 0) {
    const latestCycleDirPath = join(cyclesRoot, cycleDirs[cycleDirs.length - 1]?.name ?? '', 'test-reports');
    if (dirExists(latestCycleDirPath)) {
      const reports = readdirSync(latestCycleDirPath).filter((f) => f.endsWith('.md'))
        .map((f) => ({ f, m: statSync(join(latestCycleDirPath, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      const latest = reports[0]?.f;
      if (latest) {
        try {
          const content = readFileSync(join(latestCycleDirPath, latest), 'utf8');
          if (/^\|\s*(通过|失败|错误)\s*\|/m.test(content)) {
            const num = (label: string): number => {
              const m = content.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|`));
              return m ? parseInt(m[1] ?? '0', 10) : 0;
            };
            // 分层结果行（| 层 | 结果 | 关键数字 | 形态）
            const layers = content.split('\n')
              .filter((l) => /^\|\s*(validate|vitest|smoke|trigger|typecheck|build|L\d)\b/i.test(l.trim()))
              .map((l) => l.trim().replace(/\|/g, '·').replace(/\s+/g, ' ').slice(0, 120))
              .slice(0, 8);
            testReport = {
              report: latest,
              passed: num('通过'),
              failures: num('失败'),
              errors: num('错误'),
              layers,
            };
          }
        } catch { /* unreadable → skip */ }
      }
    }
  }

  // 5) autonomy scalar
  let autonomy = 'L?';
  const configPath = join(cyclesDir, 'config.yml');
  if (existsSync(configPath)) {
    const m = readFileSync(configPath, 'utf8').match(/^\s*autonomy_level:\s*["']?(L[1-4])["']?/m);
    if (m?.[1]) autonomy = m[1];
  }

  // ---- assemble layered nodes/edges ----
  const nodes: SnapshotNode[] = [];
  const edges: SnapshotEdge[] = [];
  const COL = { macro: 0, gate: 1, cycle: 2, event: 3, aux: 4 };
  const counters = { macro: 0, gate: 0, cycle: 0, event: 0, aux: 0 };
  const node = (id: string, group: keyof typeof COL, type: string, label: string, extra?: Partial<SnapshotNode>): void => {
    nodes.push({ id, type, label, x: COL[group] * 380, y: counters[group]++ * 46, ...extra });
  };
  const edge = (from: string, to: string, type: string): void => { edges.push({ from, to, type }); };

  for (const n of wf.nodes) node(`wf:${n.id}`, n.type === 'gate' || n.type === 'human-gate' ? 'gate' : 'macro', n.type, n.label || n.id);
  for (const e of wf.edges) edge(`wf:${e.from}`, `wf:${e.to}`, e.type);

  // O(1) cycle lookup by number (was O(n) find per cycle → O(n²) total)
  const cycleByNum = new Map<number, { name: string; num: number }>();
  for (const c of cycleDirs) cycleByNum.set(c.num, c);

  for (const c of cycleDirs) {
    node(`cycle:${c.name}`, 'cycle', 'cycle', c.name);
    const prev = cycleByNum.get(c.num - 1);
    if (prev) edge(`cycle:${prev.name}`, `cycle:${c.name}`, 'cycle-seq');
  }

  // O(1) node-id lookup (was O(n) some per entry → O(n*m) total)
  const nodeIdSet = new Set<string>();
  for (const n of nodes) nodeIdSet.add(n.id);

  entries.forEach((e, i) => {
    const id = `evt:${String(i)}`;
    // W-3 全档：G2 相关事件节点携带最新测试报告摘要（节点详情的 why 层）
    const isG2Event = String(e.gate ?? '').toUpperCase() === 'G2';
    node(id, 'event', 'gate-event', `${String(e.gate ?? '?')} ${String(e.result ?? '?')}`, {
      result: e.result,
      detail: e.detail,
      ...(isG2Event && testReport ? { testReport } : {}),
    });
    if (i > 0) edge(`evt:${String(i - 1)}`, id, 'event-seq');
    const gateId = `wf:gate-${String(e.gate ?? '').toLowerCase()}`;
    if (nodeIdSet.has(gateId)) edge(id, gateId, 'evidences');
    else nodeIdSet.add(gateId); // track newly added
  });

  for (const f of incidents) node(`inc:${f}`, 'aux', 'incident', f);
  if (incidents.length > 0) edge(`inc:${incidents[0] ?? ''}`, 'aux:auto', 'reports');
  node('aux:auto', 'aux', 'autonomy', `autonomy ${autonomy}`);

  return {
    nodes,
    edges,
    autonomy,
    counts: { nodes: nodes.length, edges: edges.length, cycles: cycleDirs.length, ledgerEntries: entries.length, incidents: incidents.length },
    generatedAt,
    source: 'live',
  };
}
