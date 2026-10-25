/**
 * npx 技能-only 分发入口测试（cycle-25）。
 *
 * 纪律：tests/ 下 import 到 src/ 统一 '../../src'（G-IND 独立性守卫）；
 * 本测试的对象是 bin/anic-init.mjs（零依赖脚本），用 execFileSync 子进程
 * 真跑（与 skillReplaceE2E 同款 e2e 手法），每个用例独立临时目录。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const BIN = join(ROOT, 'bin', 'anic-init.mjs');
const SKILL_SRC = join(ROOT, 'assets', 'skill');

/** 技能版本从**独立锚点**（技能包 CHANGELOG 首条）派生，不写死字面量——
 * 版本号是发行源属性，写死在测试里等于每次发版都要改测试（cycle-78 实测：
 * v2.6.0 升级时两处 2.5.2 断言同步变红，是本轮唯一的非缺陷红）。 */
const SKILL_VERSION = /^##\s+(\d+\.\d+\.\d+)/m.exec(readFileSync(join(SKILL_SRC, 'CHANGELOG.md'), 'utf-8'))?.[1] ?? '';

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'anic-npx-test-'));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function run(args: string[]): string {
  return execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf-8' });
}

describe('npx anic-init（技能-only 分发入口）', () => {
  it('全新目录：安装技能 64 文件 + 脚手架 .cycles/ + CLAUDE.md 仓库记忆', () => {
    const dir = freshDir();
    const out = run(['init', dir, '--name', 'demo-project']);
    expect(SKILL_VERSION, '技能 CHANGELOG 首条版本必须可解析（版本锚点下限）').not.toBe('');
    expect(out).toContain(`installing skill v${SKILL_VERSION}`);
    // 技能落点与 DSH 插件 anic_install 同构
    const skillDst = join(dir, '.dsh', 'skills', 'ai-native-iteration-cycle');
    expect(existsSync(join(skillDst, 'SKILL.md'))).toBe(true);
    // 全量文件数与源一致（64 文件——递归计数口径，含子目录；cycle-27 +lib/args.mjs）
    let fileCount = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else fileCount += 1;
      }
    };
    walk(skillDst);
    expect(fileCount).toBe(64);
    // .cycles 骨架
    expect(existsSync(join(dir, '.cycles', 'config.yml'))).toBe(true);
    expect(existsSync(join(dir, '.cycles', 'intent', 'intent.md'))).toBe(true);
    // CLAUDE.md 仓库记忆 + --name 落盘
    const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('# demo-project');
    const cfg = readFileSync(join(dir, '.cycles', 'config.yml'), 'utf-8');
    expect(cfg).toContain('demo-project');
  });

  it('幂等：已装同版本跳过复制，已初始化跳过脚手架', () => {
    const dir = freshDir();
    run(['init', dir]);
    const out2 = run(['init', dir]);
    expect(out2).toContain(`already installed (v${SKILL_VERSION}), skipping copy`);
    expect(out2).toContain('already initialized, skipping scaffold');
  });

  it('dry-run：打印动作但零写盘', () => {
    const dir = freshDir();
    const out = run(['init', dir, '--dry-run']);
    expect(out).toContain('installing skill');
    expect(out).toContain('(dry-run: nothing was written)');
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, '.dsh'))).toBe(false);
    expect(existsSync(join(dir, '.cycles'))).toBe(false);
  });

  it('--framework codex：仓库记忆落 AGENTS.md', () => {
    const dir = freshDir();
    run(['init', dir, '--framework', 'codex']);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('--help：用法说明含 MCP server 注册指引，exit 0', () => {
    const out = run(['--help']);
    expect(out).toContain('Usage: npx dsh-anic init');
    expect(out).toContain('mcp-server.mjs');
  });

  it('版本锚点：源与安装副本的 SKILL.md 版本一致（MCP Tools (vX.Y.Z) 锚）', () => {
    const dir = freshDir();
    run(['init', dir]);
    const srcV = /MCP Tools\s*\(v(\d+\.\d+\.\d+)\)/.exec(
      readFileSync(join(SKILL_SRC, 'SKILL.md'), 'utf-8'),
    );
    const dstV = /MCP Tools\s*\(v(\d+\.\d+\.\d+)\)/.exec(
      readFileSync(join(dir, '.dsh', 'skills', 'ai-native-iteration-cycle', 'SKILL.md'), 'utf-8'),
    );
    expect(srcV).not.toBeNull();
    expect(dstV).not.toBeNull();
    expect(dstV?.[1]).toBe(srcV?.[1]);
  });
});
