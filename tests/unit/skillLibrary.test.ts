/**
 * 内部技能库读数单元测试（cycle-109）—— 每种 issue **各有一条会判红的用例**。
 *
 * 为什么必须逐 kind 覆盖：`ok:false` 只说明"有问题"，而补救动作由 kind 决定
 * （`missing-dir` 补目录、`unregistered-dir` 改注册表、`registry-parse` 修 JSON）。
 * 把六种问题压成一个布尔，读者拿到红也不知道该改哪边 —— 等于没报。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSkillLibrary, summarizeSkillLibrary } from '../../src/host/runtime/skillLibrary.ts';

const CLEAN: string[] = [];
function fixture(index: unknown, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'anic-skilllib-'));
  CLEAN.push(dir);
  if (index !== null) writeFileSync(join(dir, 'skills.index.json'), typeof index === 'string' ? index : JSON.stringify(index));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}
afterEach((): void => { while (CLEAN.length > 0) { const d = CLEAN.pop(); if (d) rmSync(d, { recursive: true, force: true }); } });

const REG = { version: '0.3.0', updatedAt: '2026-11-06', skills: [{ name: 'leaf-a', dir: 'leaf-a', version: '0.1.0', tier: 'leaf', anchors: ['SKILL.md'] }] };
const CLEAN_FILES = { 'leaf-a/SKILL.md': '# a\n' };

describe('干净夹具 → ok:true（守卫不能恒红）', () => {
  it('全部命中 ⇒ issues=[]、ok=true、锚点计数正确', () => {
    const r = readSkillLibrary(fixture(REG, CLEAN_FILES), '2026-11-06T00:00:00.000Z');
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.skills[0]?.anchorsPresent).toBe(1);
    expect(r.skills[0]?.anchorsTotal).toBe(1);
    expect(summarizeSkillLibrary(r)).toContain('0 issues');
  });
});

describe('六种 issue 各自可判红（kind 分流，不合并）', () => {
  it('库根不存在 ⇒ registry-absent + present:false', () => {
    const r = readSkillLibrary(join(fixture(REG), 'nope'));
    expect(r.present).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.kind).toBe('registry-absent');
  });

  it('注册表缺失 ⇒ registry-absent（present:true 区分「库在、表没了」）', () => {
    const r = readSkillLibrary(fixture(null, CLEAN_FILES));
    expect(r.present).toBe(true);
    expect(r.issues[0]?.kind).toBe('registry-absent');
  });

  it('注册表 JSON 损坏 ⇒ registry-parse（点名解析错误）', () => {
    const r = readSkillLibrary(fixture('{ not json', CLEAN_FILES));
    expect(r.issues[0]?.kind).toBe('registry-parse');
    expect(r.issues[0]?.detail.length).toBeGreaterThan(0);
  });

  it('条目目录不存在 ⇒ missing-dir', () => {
    const r = readSkillLibrary(fixture(REG));
    expect(r.issues.map((i) => i.kind)).toContain('missing-dir');
    expect(r.skills[0]?.skillMdPresent).toBe(false);
  });

  it('目录在但缺 SKILL.md ⇒ missing-skill-md（与 missing-dir 分开）', () => {
    const r = readSkillLibrary(fixture(REG, { 'leaf-a/references/x.md': '# x\n' }));
    expect(r.issues.map((i) => i.kind)).toContain('missing-skill-md');
  });

  it('锚点声明了但文件不在 ⇒ missing-anchor（detail 给出相对路径）', () => {
    const reg = { ...REG, skills: [{ ...REG.skills[0], anchors: ['SKILL.md', 'scripts/missing.mjs'] }] };
    const r = readSkillLibrary(fixture(reg, CLEAN_FILES));
    const hit = r.issues.find((i) => i.kind === 'missing-anchor');
    expect(hit?.detail).toContain('scripts/missing.mjs');
    expect(r.skills[0]?.anchorsPresent).toBe(1);
    expect(r.skills[0]?.anchorsTotal).toBe(2);
  });

  it('磁盘有目录但注册表没登记 ⇒ unregistered-dir（幽灵技能）', () => {
    const r = readSkillLibrary(fixture(REG, { ...CLEAN_FILES, 'ghost/SKILL.md': '# g\n' }));
    const hit = r.issues.find((i) => i.kind === 'unregistered-dir');
    expect(hit?.subject).toBe('ghost');
  });

  it('_meta 容器目录只要子目录已登记就不算幽灵（防假阳性）', () => {
    const reg = { ...REG, skills: [...REG.skills, { name: 'meta-x', dir: '_meta/meta-x', version: '0.1.0', tier: 'meta', anchors: ['SKILL.md'] }] };
    const r = readSkillLibrary(fixture(reg, { ...CLEAN_FILES, '_meta/meta-x/SKILL.md': '# m\n' }));
    expect(r.issues.filter((i) => i.kind === 'unregistered-dir')).toEqual([]);
  });

  it('条目的 anchors 缺失不算错（0/0 合法；不声明锚点不等于坏）', () => {
    const reg = { version: '1', updatedAt: 'x', skills: [{ name: 'a', dir: 'a', version: '1', tier: 'leaf' }] };
    const r = readSkillLibrary(fixture(reg, { 'a/SKILL.md': '# a\n' }));
    expect(r.ok).toBe(true);
    expect(r.skills[0]?.anchorsTotal).toBe(0);
  });
});

describe('摘要措辞：问题按 kind 计数（不合并成一个 not-ok）', () => {
  it('多种问题同时出现时逐类计数', () => {
    // 夹具：leaf-a 目录在但缺 SKILL.md（missing-skill-md）+ ghost 未登记（unregistered-dir）。
    const r = readSkillLibrary(fixture(REG, { 'leaf-a/references/x.md': '# x\n', 'ghost/SKILL.md': '# g\n' }));
    const s = summarizeSkillLibrary(r);
    expect(s).toContain('missing-skill-md');
    expect(s).toContain('unregistered-dir');
  });
});