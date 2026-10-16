/**
 * 适配器层契约（Q5 外部服务隔离 + R19 子进程环境清洗）。
 *
 * sanitizeEnv 是安全边界：宿主进程环境里的凭据类变量不得进入技能脚本
 * 子进程（脚本是外部代码，按不可信处理）。核心断言：
 *   1. 敏感键（KEY/SECRET/TOKEN/PASSWORD，大小写不敏感）被剥除；
 *   2. 普通键（PATH/HOME/ANI C 自有变量）保留；
 *   3. undefined 值不产出键；
 *   4. createNodeAdapters() 的 exec.run 真的带 sanitized env（源码形状断言，
 *      不真起子进程——spawnSync 在测试环境慢且平台相关）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeEnv, createNodeAdapters } from '../../src/adapters/index.ts';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('sanitizeEnv (R19 子进程环境清洗)', () => {
  it('剥除命中敏感模式的键（大小写不敏感，四种模式）', () => {
    const env = {
      PATH: 'C:\\bin',
      OPENAI_API_KEY: 'sk-xxx',
      GITHUB_TOKEN: 'ghp_xxx',
      MY_SECRET: 'hush',
      USER_PASSWORD: 'pw',
      DeepSeek_Api_Key: 'sk-yyy', // 大小写混合
      ANIC_SKILL_DIR: 'D:\\skills', // 本插件自有变量，不含敏感词
    };
    const out = sanitizeEnv(env);
    expect(out.PATH).toBe('C:\\bin');
    expect('OPENAI_API_KEY' in out).toBe(false);
    expect('GITHUB_TOKEN' in out).toBe(false);
    expect('MY_SECRET' in out).toBe(false);
    expect('USER_PASSWORD' in out).toBe(false);
    expect('DeepSeek_Api_Key' in out).toBe(false);
    expect(out.ANIC_SKILL_DIR).toBe('D:\\skills');
  });

  it('undefined 值不产出键（Node env 的合法形态）', () => {
    const out = sanitizeEnv({ A: 'a', B: undefined });
    expect(out).toEqual({ A: 'a' });
  });

  it('缺省读 process.env（不炸、结果非空）', () => {
    const out = sanitizeEnv();
    expect(typeof out).toBe('object');
    expect(Object.keys(out).length).toBeGreaterThan(0);
    // 运行环境必有 PATH（Windows/Unix 均然）
    expect('PATH' in out).toBe(true);
  });

  it('空对象进空对象出', () => {
    expect(sanitizeEnv({})).toEqual({});
  });
});

describe('createNodeAdapters exec.run 的 env 接线（源码形状守卫）', () => {
  it('spawnSync 调用经 sanitizeEnv()，不是裸 env 透传', () => {
    // 行为断言（真起子进程打印 env）在 Windows/CI 上慢且脆；这里守源码形状：
    // 若有人把 env: sanitizeEnv() 删掉（回到继承完整父环境），这条红。
    const src = readFileSync(join(PLUGIN_ROOT, 'src', 'adapters', 'index.ts'), 'utf8');
    expect(src).toContain('env: sanitizeEnv()');
  });

  it('适配器集合三件齐备（fs/exec/http）', () => {
    const a = createNodeAdapters();
    expect(typeof a.fs.readText).toBe('function');
    expect(typeof a.exec.run).toBe('function');
    expect(typeof a.http.fetch).toBe('function');
  });

  it('fs.readText 对不存在路径返回 null 而不抛', () => {
    const a = createNodeAdapters();
    expect(a.fs.readText('Z:\\__anic_nonexistent__.txt')).toBeNull();
    expect(a.fs.exists('Z:\\__anic_nonexistent__.txt')).toBe(false);
    expect(a.fs.readDir('Z:\\__anic_nonexistent__')).toEqual([]);
  });
});
