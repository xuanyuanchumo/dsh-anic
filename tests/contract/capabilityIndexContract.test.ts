/**
 * 能力索引契约（cycle-73 T-7301）——「注册面 ⇄ 索引」双向一致 + 体积棘轮。
 *
 * 缺陷类：**索引与注册面漂移**——索引里少一个工具 = 「注册了但不被发现」；
 * 多一个 = 臆造能力（模型会去找一个不存在的工具）。两者都必须红。
 * 本守卫钉 design §4 里**可离线机器验证**的那些判据（A2/A3/A5/A8/A9 的索引侧）：
 *   A2 注入面体积 ≤ 2 KB；
 *   A5 索引 ⇄ 源码双向一致（id 集 / 逐条 schemaHash / 脚本 15 且不含 mcp-server）；
 *   A8 默认模式（full）零行为变更——本守卫不改任何注册行为，只读；
 *   A9 体积棘轮——注入面不得随工具变胖而失控。
 *
 * 未在本守卫内的判据（**必须诚实标注为未验证**）：A0（scoped restrict 真机）、
 * A1（prompt cache 影响）、A3/A4 的「激活后」侧、A6/A7 的降级侧——
 * 它们都需要真机探针，见 design §3.4/§4。**SKIP ≠ PASS**。
 *
 * 守卫纪律（沿 docs/agents/开发规范-守卫与约束）：
 *   ① 反向自检：变异体（多一个/少一个 id）必须使断言翻假；
 *   ② 扫描集非空下限：19 工具 / 15 脚本，空集即假守卫；
 *   ③ 不匹配自身：本测试只读制品，不参与注册（避免自指假绿）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANIC_TOOL_IDS } from '../../src/host/toolIds.ts';
import { listSkillScripts } from '../../src/host/skillInvoker.ts';
import {
  TOOL_SUMMARIES,
  SUMMARY_MAX_CHARS,
  buildCapabilityIndex,
  indexContentDrift,
  schemaHash,
  summaryIssues,
  type ToolFace,
} from '../../src/host/capabilityIndex.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');

// 注册面捕获走**共享实现**（src/host/toolsFaceCapture.ts）——生成器 / 本契约 / P7 探针三方同源，
// 不写第二份捕获逻辑（单一实现纪律；捕获方式一变即三处同步，不会互相漂移）。
import { captureRegisteredFaces } from '../../src/host/toolsFaceCapture.ts';

const faces = captureRegisteredFaces();
const scripts = listSkillScripts();
const built = buildCapabilityIndex(faces, scripts, 'test');

/** 读盘上的注入面制品（生成器产物）。 */
function readInjectable(): { v: number; commit: string; tools: Array<[string, string]>; scripts: string[] } {
  return JSON.parse(readFileSync(join(ROOT, 'assets', 'index', 'capability-index.json'), 'utf8'));
}
function readHashes(): { v: number; commit: string; hashes: Record<string, string> } {
  return JSON.parse(readFileSync(join(ROOT, 'assets', 'index', 'capability-hashes.json'), 'utf8'));
}

describe('cycle-73 T-7301 能力索引契约（注册面 ⇄ 索引）', () => {
  it('纪律② 扫描集非空下限：注册面 19 工具 / 脚本清单 15（空集 = 假守卫）', () => {
    expect(faces.length).toBeGreaterThanOrEqual(19);
    expect(scripts.length).toBeGreaterThanOrEqual(15);
  });

  it('A5① 索引 tools 的 id 集 == 注册面（双向，多一个/少一个都红）', () => {
    const fromIndex = readInjectable().tools.map((p) => p[0]).sort();
    const fromReg = faces.map((f) => f.name).sort();
    expect(fromIndex).toEqual(fromReg);
    // 与正典 id 清单（toolIds.ts）三方对账
    expect(fromIndex).toEqual([...ANIC_TOOL_IDS].sort());
  });

  it('A5② hashes sidecar 每条 == 从注册面重算（键排序 canonical）', () => {
    const hashes = readHashes().hashes;
    for (const f of faces) {
      expect(hashes[f.name], f.name + ' 缺哈希').toBe(schemaHash(f));
    }
    expect(Object.keys(hashes).sort()).toEqual(faces.map((f) => f.name).sort());
  });

  it('A5③ 索引 scripts == listSkillScripts()（15），且不含 mcp-server（差集纪律）', () => {
    const idxScripts = readInjectable().scripts;
    expect([...idxScripts].sort()).toEqual([...scripts].sort());
    expect(idxScripts).toHaveLength(15);
    // mcp-server 是传输层不是被调脚本——它进了索引即红（不得把三集合差集抹平）
    expect(idxScripts).not.toContain('mcp-server');
  });

  it('A2 注入面体积 ≤ 2 KB（实测 1512 B，基线 11738 B → 净减 ≈87%）', () => {
    const bytes = Buffer.byteLength(JSON.stringify(readInjectable()), 'utf8');
    expect(bytes).toBeLessThanOrEqual(2048);
    // 净减硬下界：至少砍掉 75%（收益不足即本设计无意义）
    expect(bytes).toBeLessThan(11738 * 0.25);
  });

  it('A9 体积棘轮：注入面不得超 2304 B（防索引本身变胖）', () => {
    expect(built.injectedBytes).toBeLessThanOrEqual(2304);
  });

  it('纪律④ 摘要策展表与注册面一致：无缺失、≤40 字符、且不等于 description', () => {
    expect(summaryIssues(faces)).toEqual([]);
    expect(Object.keys(TOOL_SUMMARIES)).toHaveLength(faces.length);
    for (const f of faces) {
      const s = TOOL_SUMMARIES[f.name];
      expect(s.length, f.name + ' 摘要超长').toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
      // 最强的一条：摘要不得等于 description（防「派生冒充策展」）
      expect(s).not.toBe(f.description);
    }
  });

  it('A8 索引制品可重建且幂等：同一注册面两次构建字节相同', () => {
    const a = buildCapabilityIndex(faces, scripts, 'test');
    const b = buildCapabilityIndex(faces, scripts, 'test');
    expect(JSON.stringify(a.injectable)).toBe(JSON.stringify(b.injectable));
    expect(JSON.stringify(a.hashes)).toBe(JSON.stringify(b.hashes));
  });

  it('纪律① 反向自检：变异体（少一个 id / 多一个 id / 改摘要）必须使对账翻假', () => {
    const fromIndex = readInjectable().tools.map((p) => p[0]).sort();
    const fromReg = faces.map((f) => f.name).sort();
    // 少一个
    expect(fromIndex.slice(1)).not.toEqual(fromReg);
    // 多一个（臆造）
    expect([...fromIndex, 'anic_phantom_tool'].sort()).not.toEqual(fromReg);
    // 摘要被改成 description（派生冒充）必须被 summaryIssues 抓到
    const corrupted: ToolFace[] = faces.map((f, i) =>
      i === 0 ? { ...f, description: TOOL_SUMMARIES[f.name] as string } : f
    );
    const phantom: ToolFace = { name: faces[0]?.name as string, description: TOOL_SUMMARIES[faces[0]?.name as string] as string, parameters: {} };
    expect(summaryIssues([phantom]).length).toBeGreaterThan(0);
    // 缺摘要的工具必须被点名（fail-closed，不是静默跳过）
    expect(summaryIssues([{ name: 'anic_no_such', description: 'x', parameters: {} }]).length).toBeGreaterThan(0);
    void corrupted;
  });
});

describe('cycle-73 实测更正：commit 不参与失效判定（防「每次提交都假性 stale」）', () => {
  it('同内容不同 commit → 无漂移（索引不因提交而失效）', () => {
    // 复现本次真实缺陷：仅新增一个测试文件的提交（注册面一字未动）
    // 曾让 --check 报 STALE —— 根因是 commit 参与了失效判定。
    const idx = {
      v: 1,
      commit: 'deadbee',
      tools: faces.map((f) => [f.name, TOOL_SUMMARIES[f.name] as string] as [string, string]),
      scripts: [...scripts],
    };
    const hashes = Object.fromEntries(faces.map((f) => [f.name, schemaHash(f)]));
    expect(indexContentDrift(idx, hashes, faces, scripts)).toEqual([]);
  });

  it('实例级复现：盘上真实制品与注册面内容一致（--check 语义的纯函数版）', () => {
    expect(indexContentDrift(readInjectable(), readHashes().hashes, faces, scripts)).toEqual([]);
  });

  it('反向自检：注册面改一个工具的 schema → 漂移必须被报出（防恒真）', () => {
    const mutated = faces.map((f, i) => (i === 0 ? { ...f, description: f.description + ' (mutated)' } : f));
    const drift = indexContentDrift(readInjectable(), readHashes().hashes, mutated, scripts);
    expect(drift.length).toBeGreaterThan(0);
    expect(drift.some((d) => d.includes('schema 已改'))).toBe(true);
  });

  it('反向自检：脚本清单增减必须被报出', () => {
    expect(indexContentDrift(readInjectable(), readHashes().hashes, faces, [...scripts, 'phantom-script']).length).toBeGreaterThan(0);
  });

  it('反向自检：索引缺工具 / 臆造工具必须被报出', () => {
    const idx = readInjectable();
    const hashes = readHashes().hashes;
    const short = { ...idx, tools: idx.tools.slice(1) };
    expect(indexContentDrift(short, hashes, faces, scripts).some((d) => d.includes('索引缺工具'))).toBe(true);
    const extra = { ...idx, tools: [...idx.tools, ['anic_phantom', 'x'] as [string, string]] };
    expect(indexContentDrift(extra, hashes, faces, scripts).some((d) => d.includes('臆造'))).toBe(true);
  });
});
