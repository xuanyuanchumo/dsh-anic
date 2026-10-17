/**
 * truthAuditRoute 行为级测试（P0-DIR-ROOT，cycle-15）。
 *
 * 背景：旧测试只断言路由「已注册」（snapshotRoute.test.ts 路径清单），从不断言
 * 审计目标——导致 PLUGIN_DIR 落到仓库父目录的缺陷在单测里永远绿、真机上
 * T1-T4 全 MISSING（vunknown + 0 files + 0 cards）。本测试直接调 handler，
 * 断言审计结果来自**正确的插件根**：T2 的 version detail 必须等于本仓
 * package.json 的真实版本号。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTruthAuditRoute } from '../../src/host/routes/truthAuditRoute.ts';
import type { TruthAuditSummary } from '../../src/host/evolution/truthAuditTypes.ts';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** stub webServer：捕获注册的 handler 与 send 输出。 */
function makeStubServer() {
  let handler: ((req: unknown, res: unknown) => void) | null = null;
  let captured: { code: number; body: unknown } = { code: -1, body: null };
  const webServer = {
    register(opts: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) {
      if (opts.path === '/anic/api/truth-audit') handler = opts.handler;
      return () => { handler = null; };
    },
  };
  const send = (_res: unknown, code: number, body: unknown): void => {
    captured = { code, body };
  };
  return {
    webServer,
    send,
    invoke(): { code: number; body: unknown } {
      captured = { code: -1, body: null };
      if (!handler) throw new Error('handler not registered');
      handler({}, {});
      return captured;
    },
  };
}

describe('GET /anic/api/truth-audit 行为（审计目标必须是插件根）', () => {
  it('T2 version detail 等于本仓 package.json 真实版本——修复前此断言红（vunknown）', () => {
    const server = makeStubServer();
    registerTruthAuditRoute({ webServer: server.webServer }, server.send);
    const { code, body } = server.invoke();

    expect(code).toBe(200);
    const summary = body as TruthAuditSummary;
    // 四维齐备（T1-T4 都跑了——模块加载即 PLUGIN_DIR 计算，走 pluginRoot 标记解析）
    expect(summary.results.map((r) => r.dimension)).toEqual([
      'T1_truthfulness', 'T2_accuracy', 'T3_structure', 'T4_logic',
    ]);

    // 关键断言：T2 的 version detail 是真实版本号——审计了正确目录的直接证据
    const pkgVersion = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
    const t2 = summary.results.find((r) => r.dimension === 'T2_accuracy');
    const versionFinding = t2?.findings.find((f) => f.check === 'package version');
    expect(versionFinding?.detail).toBe(`v${pkgVersion}`);
    expect(versionFinding?.status).toBe('pass');
  });

  it('T2 agent card 计数为 15——审计目标目录含真实资产（修复前 0 cards）', () => {
    const server = makeStubServer();
    registerTruthAuditRoute({ webServer: server.webServer }, server.send);
    const { code, body } = server.invoke();

    expect(code).toBe(200);
    const summary = body as TruthAuditSummary;
    // agent card count 属于 T2_accuracy（auditAccuracy）
    const t2 = summary.results.find((r) => r.dimension === 'T2_accuracy');
    const cardFinding = t2?.findings.find((f) => f.check === 'agent card count');
    expect(cardFinding?.detail).toMatch(/15 cards/);
    expect(cardFinding?.status).toBe('pass');
  });
});
