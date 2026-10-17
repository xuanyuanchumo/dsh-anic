/**
 * eval-runner 质量子检查集成测试（D-1403/D-1404/D-1408 回归钉）
 *
 * 背景：Q4 秘密扫描 / Q6 a11y+响应式 / Q7 错误处理原先 shell 出
 * `grep -rn ... | wc -l`——DSH 宿主主平台 Windows（cmd.exe）无 grep/wc，
 * 四项子检查永远 catch → SKIP，质量门永远缺证据。D-1404 改纯 Node
 * scanSourceLines；D-1403 补 DSH 生态位置（根 locale/、.ts 客户端代码）。
 *
 * D-1408（cycle-14）：Q5 环检测原 `npx madge ... || true` 双重致命伤——
 * Windows 上 npx madge 交互下载提示恒失败；`|| true` 在 cmd.exe 无 true，
 * madge 非零退出（真发现环）时 execSync 抛错进 catch → 环被吞成 SKIP
 * （fail-open）。改纯 Node importGraph（scripts/lib/importGraph.mjs）。
 *
 * 本测试 spawn 真实 eval-runner.mjs 跑最小夹具（--dimensions 部分运行，
 * 避开 E3/npm audit 之外的慢路径），钉四件事：
 *  1. Windows 上子检查产出真实裁决（带计数），不再是 "grep failed"；
 *  2. 根 locale/ 被 Q6 i18n 识别（DSH 插件规范位置）；
 *  3. 秘密扫描双通道：干净源 PASS、硬编码秘钥 FAIL 带计数；
 *  4. 环检测双通道：无环 PASS（带文件计数）、a↔b 环 FAIL 带成员路径。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_RUNNER = join(__dirname, '../../assets/skill/scripts/eval-runner.mjs');

const TMP = join(tmpdir(), `anic-evalq-${Date.now()}`);

/** 建最小夹具：src/（.ts 客户端约定）+ locale/ + .cycles 骨架，返回夹具根。 */
function seedFixture(dir: string, { secret, cycle }: { secret: boolean; cycle?: boolean }): string {
  mkdirSync(join(dir, 'src', 'client'), { recursive: true });
  mkdirSync(join(dir, 'locale'), { recursive: true });
  mkdirSync(join(dir, '.cycles', 'intent'), { recursive: true });
  mkdirSync(join(dir, '.cycles', 'cycles', 'cycle-1'), { recursive: true });

  // DSH 客户端约定：.ts + createElement（无 JSX）；aria/@media 都在 .ts 里
  writeFileSync(
    join(dir, 'src', 'client', 'ui.ts'),
    [
      '// DSH 客户端约定演示：无 .tsx，aria 写在 .ts',
      "export const btn = { 'aria-label': 'ok', role: 'button' } as const;",
      '@media (prefers-reduced-motion: reduce) { /* panelCss 同款 */ }',
      'export function safe(): string {',
      '  try {',
      "    return 'fine';",
      '  } catch {',
      "    return 'fallback';",
      '  }',
      '}',
      // D-1405 假阳性免疫钉：design-token 行业惯用形态——
      // token('x') 调用与 TOKEN_SCOPE 常量（关键词后随 _SCOPE 非紧邻 =）。
      // 旧宽匹配（行含 token 即计）会把这两行计为可疑：本仓 138/138 全假阳性的缩影。
      "export const color = token('anic-border');",
      "export const TOKEN_SCOPE = '[data-anic-workflow]';",
      secret ? 'const api_key = "sk-hardcoded-123";' : 'const apiKey = process.env.API_KEY;',
      secret ? "const cfg = { token: 'abc123' };" : '',
      'const note = "// token: 仅注释行的豁免路径";',
    ].join('\n'),
  );

  writeFileSync(join(dir, 'locale', 'zh.json'), JSON.stringify({ ok: '好' }));
  writeFileSync(join(dir, 'locale', 'en.json'), JSON.stringify({ ok: 'ok' }));
  writeFileSync(join(dir, '.cycles', 'intent', 'intent.md'), '# 意图\n测试夹具');

  // D-1408 环夹具：a ↔ b 相互 import（fail-open 回归钉——旧 madge 实现里
  // 真发现环时非零退出被 '|| true' 吞成 SKIP，恰是最需要报警的时刻）。
  if (cycle) {
    writeFileSync(join(dir, 'src', 'client', 'a.ts'), "import { b } from './b';\nexport const a = 1;\n");
    writeFileSync(join(dir, 'src', 'client', 'b.ts'), "import { a } from './a';\nexport const b = 1;\n");
  }
  // lint_cmd 供 Q7 的 lintResult 子项（node --version 秒回）
  writeFileSync(
    join(dir, '.cycles', 'config.yml'),
    ['project:', '  name: "fixture"', 'build:', '  lint_cmd: "node --version"'].join('\n'),
  );
  return dir;
}

/** spawn eval-runner 部分运行（dimensions 可配），返回报告全文。 */
function runEval(dir: string, dimensions: string): string {
  const r = spawnSync('node', [EVAL_RUNNER, dir, '--dimensions', dimensions], {
    encoding: 'utf-8',
    timeout: 120000,
  });
  return readFileSync(join(dir, '.cycles', 'cycles', 'cycle-1', '项目评估报告.md'), 'utf-8');
}

function reportRow(content: string, dim: string): string {
  const m = content.match(new RegExp(`^\\| ${dim} \\|.*$`, 'm'));
  return m ? m[0] : '';
}

describe('eval-runner 质量子检查（D-1403/D-1404/D-1408 回归钉，Windows 主平台）', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it(
    '干净夹具：Q4/Q6/Q7 子检查真实裁决而非 grep-fail SKIP；locale/ 被识别（D-1403）',
    { timeout: 90000 },
    () => {
      seedFixture(TMP, { secret: false });
      const content = runEval(TMP, 'Q4,Q6,Q7');

      // D-1404 核心断言：不再出现 unavailable (grep failed)
      expect(content).not.toContain('grep failed');

      const q4 = reportRow(content, 'Q4');
      expect(q4).toContain('No hardcoded secrets detected');

      const q6 = reportRow(content, 'Q6');
      // D-1403：根 locale/ 命中；.ts 里的 aria/@media 被扫到（带计数）
      expect(q6).toContain('locale');
      expect(q6).toMatch(/ARIA attributes found/);
      expect(q6).toMatch(/responsive breakpoints found/);

      const q7 = reportRow(content, 'Q7');
      expect(q7).toMatch(/error handling patterns found/);
    },
  );

  it(
    '硬编码秘钥夹具：Q4 检出且带计数（检测通道在 Windows 上复活）',
    { timeout: 90000 },
    () => {
      seedFixture(TMP, { secret: true });
      const content = runEval(TMP, 'Q4,Q6,Q7');

      const q4 = reportRow(content, 'Q4');
      // api_key 字面量赋值 + { token: 'abc' } 对象键字面量 = 2 处真阳性；
      // 上方 design-token 惯用形态（token('x')/TOKEN_SCOPE）不计入。
      expect(q4).toMatch(/2 potential hardcoded secrets found/);
    },
  );

  it(
    '环检测夹具：Q5 检出 a↔b 相互 import 且 FAIL（D-1408 fail-open 回归钉）',
    { timeout: 90000 },
    () => {
      seedFixture(TMP, { secret: false, cycle: true });
      const content = runEval(TMP, 'Q5');

      const q5 = reportRow(content, 'Q5');
      // 旧 madge 实现此场景会吐 SKIP（非零退出被 shell-ism 吞掉）——现在必须 FAIL
      expect(q5).toMatch(/FAIL/);
      expect(q5).toMatch(/1 circular dependencies? detected/);
      expect(q5).toContain('src\\client\\a.ts');
      expect(q5).toContain('src\\client\\b.ts');
    },
  );

  it(
    '无环夹具：Q5 PASS 且带源文件计数（纯 Node importGraph 通道）',
    { timeout: 90000 },
    () => {
      seedFixture(TMP, { secret: false });
      const content = runEval(TMP, 'Q5');

      const q5 = reportRow(content, 'Q5');
      expect(q5).toMatch(/PASS/);
      expect(q5).toMatch(/No circular dependencies \(\d+ source files\)/);
    },
  );
});
