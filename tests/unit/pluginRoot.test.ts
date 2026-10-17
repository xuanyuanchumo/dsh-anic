/**
 * pluginRoot 布局自适应解析回归钉（P0-DIR-ROOT，cycle-15）。
 *
 * 背景：truthAuditRoute 的 `resolve(file, '../../../')` 与 routes/index.ts 的
 * `new URL('../../../')` 都是固定层级推导——源码布局（src/host/routes/，三层深）
 * 与真机单文件 bundle（dist/host.js，一层深）只能满足其一。真实宿主实测：
 * truth-audit 在 3080 上审计了 D:\Projects\TraeProjects\（仓库父目录）——
 * T1-T4 全 MISSING、version vunknown。本测试把两种布局 + junction 形态
 * 全部钉死在仓库根。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePluginRoot, pluginAssetDir } from '../../src/host/pluginRoot.ts';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TMP = join(tmpdir(), `anic-proot-${Date.now()}`);

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('resolvePluginRoot 布局自适应（P0-DIR-ROOT 回归钉）', () => {
  it('真机布局：dist/host.js（一层深）解析到仓库根——修复前此形态落到仓库父目录', () => {
    const startUrl = pathToFileURL(join(REPO_ROOT, 'dist', 'host.js')).href;
    expect(resolvePluginRoot(startUrl)).toBe(REPO_ROOT);
  });

  it('源码布局：src/host/routes/index.ts（三层深）解析到仓库根——修复前此形态落到 src/', () => {
    const startUrl = pathToFileURL(join(REPO_ROOT, 'src', 'host', 'routes', 'index.ts')).href;
    expect(resolvePluginRoot(startUrl)).toBe(REPO_ROOT);
  });

  it('junction 布局：profile node_modules 链接内一层即命中标记（安装形态）', () => {
    const startUrl = pathToFileURL(join(REPO_ROOT, 'dist', 'host.js')).href;
    // junction 情形在真机上是 dist/host.js 的父级即 package.json——同第一用例路径形态
    expect(resolvePluginRoot(startUrl)).toBe(REPO_ROOT);
  });

  it('任意打包深度：五层深嵌套仍向上命中标记', () => {
    // 夹具：<TMP>/pkg/a/b/c/d/e/file.js，标记在 <TMP>/pkg
    mkdirSync(join(TMP, 'pkg', 'a', 'b', 'c', 'd', 'e'), { recursive: true });
    writeFileSync(join(TMP, 'pkg', 'package.json'), JSON.stringify({ name: 'dsh-anic', version: '0.0.0' }));
    writeFileSync(join(TMP, 'pkg', 'a', 'b', 'c', 'd', 'e', 'file.js'), 'x');
    const startUrl = pathToFileURL(join(TMP, 'pkg', 'a', 'b', 'c', 'd', 'e', 'file.js')).href;
    expect(resolvePluginRoot(startUrl)).toBe(join(TMP, 'pkg'));
  });

  it('中途损坏的 package.json 不阻断向上查找', () => {
    mkdirSync(join(TMP, 'pkg', 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(TMP, 'pkg', 'package.json'), JSON.stringify({ name: 'dsh-anic' }));
    writeFileSync(join(TMP, 'pkg', 'nested', 'package.json'), '{ corrupted json!!');
    writeFileSync(join(TMP, 'pkg', 'nested', 'deeper', 'file.js'), 'x');
    const startUrl = pathToFileURL(join(TMP, 'pkg', 'nested', 'deeper', 'file.js')).href;
    expect(resolvePluginRoot(startUrl)).toBe(join(TMP, 'pkg'));
  });

  it('无标记目录链：返回空串（调用方须显式失败，绝不静默审计错误目录）', () => {
    mkdirSync(join(TMP, 'plain', 'sub'), { recursive: true });
    writeFileSync(join(TMP, 'plain', 'sub', 'file.js'), 'x');
    const startUrl = pathToFileURL(join(TMP, 'plain', 'sub', 'file.js')).href;
    expect(resolvePluginRoot(startUrl)).toBe('');
  });

  it('非本插件的 package.json（name 不匹配）不当作根', () => {
    mkdirSync(join(TMP, 'other', 'sub'), { recursive: true });
    writeFileSync(join(TMP, 'other', 'package.json'), JSON.stringify({ name: 'some-other-pkg' }));
    writeFileSync(join(TMP, 'other', 'sub', 'file.js'), 'x');
    const startUrl = pathToFileURL(join(TMP, 'other', 'sub', 'file.js')).href;
    expect(resolvePluginRoot(startUrl)).toBe('');
  });
});

describe('pluginAssetDir（skill/agents 资产目录统一解析）', () => {
  it('两种布局都解析到 <root>/assets/<asset>', () => {
    const fromDist = pathToFileURL(join(REPO_ROOT, 'dist', 'host.js')).href;
    const fromSrc = pathToFileURL(join(REPO_ROOT, 'src', 'host', 'skillRegistration.ts')).href;
    expect(pluginAssetDir('skill', fromDist)).toBe(join(REPO_ROOT, 'assets', 'skill'));
    expect(pluginAssetDir('agents', fromSrc)).toBe(join(REPO_ROOT, 'assets', 'agents'));
  });

  it('根未解析时返回空串（调用方以 falsy 跳过注册）', () => {
    mkdirSync(join(TMP, 'plain'), { recursive: true });
    writeFileSync(join(TMP, 'plain', 'file.js'), 'x');
    const startUrl = pathToFileURL(join(TMP, 'plain', 'file.js')).href;
    expect(pluginAssetDir('skill', startUrl)).toBe('');
  });
});
