/**
 * 备份可见与回滚测试（cycle-83）。
 *
 * ## 守什么（每条配反向自检）
 *
 * ① 回滚后值 == 备份值，且**注释逐字节相同**（行级手术式写入器的回滚必须保住注释）；
 * ② 回滚**前**的当前态也进 .bak（否则回滚是不可逆操作）——并且那份能再回滚回去；
 * ③ 回滚复用同一写入器：静态断言 `config.yml` 正文只由 configCommit 的
 *    `atomicWriteFileSync` 写（不出现第二份写路径），且 rollback 走 commitConfigContent；
 * ④ .bak 只为**自己前缀**内的文件生成，只接受裸文件名（拒绝路径/..）；
 * ⑤ diff 摘要给的是字段级（用户能理解的单位是「L4 会变成 L3」）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_PREFIX, applyConfigPatch, listBackups,
} from '../../src/host/configEdit/configWriter.ts';
import {
  diffFields, listBackupsWithDiff, planRollback, readbackAfterRollback, rollbackConfig, stampToIso,
} from '../../src/host/configEdit/configBackup.ts';
import { commentLines, splitLines } from '../../src/host/configEdit/yamlText.ts';
import { readFieldValue } from '../../src/host/configEdit/configRead.ts';
import { fieldById } from '../../src/host/configEdit/configSchema.ts';
import { stripComments } from '../../src/host/closureAudit/scanPrimitives.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'anic-config-backup-'));
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理竞态容忍 */ } });

/** 带注释的样本（回滚必须把这些注释原样带回——注释是用户资产）。 */
const SAMPLE = [
  'project:',
  '  name: "demo"',
  '  tech_stack: ["typescript"]',
  '',
  'macro_cycle:',
  '  # 为什么显式写预算：默认值会让「超预算」淹没在告警疲劳里',
  '  autonomy_level: L4',
  '  complexity_budget: 100',
  '',
  'build:',
  '  build_cmd: "node scripts/build.mjs"',
  '  test_cmd: node scripts/run-tests.mjs',
  '',
].join('\n');

let seq = 0;
function makeCycles(content = SAMPLE): string {
  seq += 1;
  const dir = join(TMP, `ws-${String(seq)}`, '.cycles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yml'), content, 'utf-8');
  return dir;
}

const readCfg = (cycles: string): string => readFileSync(join(cycles, 'config.yml'), 'utf-8');
const fieldOf = (content: string, id: string): unknown => readFieldValue(content, fieldById(id) as never);

describe('stampToIso：从备份名还原时刻（解析不了就不猜）', () => {
  it('紧凑时间戳（含毫秒）还原成 ISO', () => {
    expect(stampToIso(`${BACKUP_PREFIX}20261027T030002000Z`)).toBe('2026-10-27T03:00:02.000Z');
    // 序号后缀也认（同毫秒多次写入的兜底命名）
    expect(stampToIso(`${BACKUP_PREFIX}20261027T030002000Z-3`)).toBe('2026-10-27T03:00:02.000Z');
  });

  it('畸形名一律 null，不编一个时刻出来', () => {
    for (const bad of ['config.yml.bak.x', `${BACKUP_PREFIX}20261327T030002000Z`, 'other.txt', `${BACKUP_PREFIX}2026`]) {
      expect(stampToIso(bad)).toBeNull();
    }
    // 反向自检：合法名必须返回非 null（判据不是恒空）
    expect(stampToIso(`${BACKUP_PREFIX}20260101T000000000Z`)).not.toBeNull();
  });
});

describe('diffFields：字段级摘要（用户能理解的单位）', () => {
  it('只报真变的字段，两侧值都给', () => {
    const next = SAMPLE.replace('autonomy_level: L4', 'autonomy_level: L3')
      .replace('complexity_budget: 100', 'complexity_budget: 250');
    const d = diffFields(SAMPLE, next);
    expect(d.changedFields).toEqual(['macro_cycle.autonomy_level', 'macro_cycle.complexity_budget']);
    expect(d.values['macro_cycle.autonomy_level']).toEqual({ backup: 'L4', current: 'L3' });
    expect(d.values['macro_cycle.complexity_budget']).toEqual({ backup: 100, current: 250 });
  });

  it('完全相同 ⇒ 空摘要（不是"全字段都算变了"）', () => {
    expect(diffFields(SAMPLE, SAMPLE)).toEqual({ changedFields: [], values: {} });
    // 反向自检：改一个字符必须被看见
    expect(diffFields(SAMPLE, SAMPLE.replace('demo', 'demo2')).changedFields).toEqual(['project.name']);
  });
});

describe('listBackupsWithDiff：清单新到旧 + 每份摘要', () => {
  it('连写两次：清单两份（新在前），每份都带相对当前的 changedFields', () => {
    const cycles = makeCycles();
    applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L3' }, { now: new Date(Date.UTC(2026, 9, 27, 5, 0, 0)) });
    applyConfigPatch(cycles, { 'macro_cycle.complexity_budget': 150 }, { now: new Date(Date.UTC(2026, 9, 27, 5, 0, 1)) });
    const views = listBackupsWithDiff(cycles);
    expect(views).toHaveLength(2);
    // 新到旧：名字降序（第二份写入的备份在前）
    expect(views[0]!.name).toContain('050001000Z');
    expect(views[1]!.name).toContain('050000000Z');
    // 每份都有时刻与摘要（摘要可以为空 = 该份内容就等于当前）
    for (const v of views) {
      expect(v.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Array.isArray(v.changedFields)).toBe(true);
    }
    // 最旧那份必然与当前不同（当前已改过两次）
    expect(views[1]!.changedFields.length).toBeGreaterThan(0);
  });

  it('无备份 ⇒ 空清单（不编造）', () => {
    expect(listBackupsWithDiff(makeCycles())).toEqual([]);
  });

  it('config.yml 缺失 ⇒ 空清单（没有"当前"就没有 diff 可算）', () => {
    seq += 1;
    const dir = join(TMP, `empty-${String(seq)}`, '.cycles');
    mkdirSync(dir, { recursive: true });
    expect(listBackupsWithDiff(dir)).toEqual([]);
  });
});

describe('planRollback：只接受清单内的裸文件名（不接受路径）', () => {
  it('合法名 → 读到备份内容与 diff', () => {
    const cycles = makeCycles();
    applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L2' }, { now: new Date(Date.UTC(2026, 9, 27, 6, 0, 0)) });
    const name = listBackups(cycles)[0]!;
    const plan = planRollback(cycles, name);
    expect(plan.ok).toBe(true);
    expect(plan.name).toBe(name);
    expect(plan.content).toBe(SAMPLE);
    expect(plan.changedFields).toEqual(['macro_cycle.autonomy_level']);
  });

  it('路径形态（../、分隔符）一律拒绝——不给任意文件读取入口', () => {
    const cycles = makeCycles();
    applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L2' });
    const name = listBackups(cycles)[0]!;
    // 反斜杠形态单独构造：备份名里本就没有 `/`，对它 replace 会得到同一个字符串
    // （那条输入其实是合法的裸名字，拿它断言「应拒绝」会让用例自身说错话）。
    const withSlash = `sub\\${name}`;
    for (const bad of [`../${name}`, `.cycles/${name}`, withSlash, '../etc/passwd', '']) {
      const plan = planRollback(cycles, bad);
      expect(plan.ok, `应拒绝 ${bad}`).toBe(false);
    }
    // 反向自检：同一份文件用**裸名字**时被接受（判据不是恒假）
    expect(planRollback(cycles, name).ok).toBe(true);
  });

  it('不在清单内的名字（哪怕前缀对）拒绝：不能恢复不存在的备份', () => {
    const cycles = makeCycles();
    const plan = planRollback(cycles, `${BACKUP_PREFIX}20200101T000000000Z`);
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain('unknown backup');
    // 反向自检：真正存在的同前缀名被接受
    applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L1' });
    expect(planRollback(cycles, listBackups(cycles)[0]!).ok).toBe(true);
  });

  it('非字符串/空串拒绝（形状守卫）', () => {
    const cycles = makeCycles();
    for (const bad of [null, undefined, 42, {}, '   ']) {
      expect(planRollback(cycles, bad).ok).toBe(false);
    }
  });
});

describe('rollbackConfig：值回来 + 注释逐字节回来', () => {
  it('回滚后值 == 备份值，注释集合与原文完全一致', () => {
    const cycles = makeCycles();
    const originalComments = commentLines(splitLines(SAMPLE));
    expect(originalComments.length).toBeGreaterThan(0);
    applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L2', 'build.test_cmd': 'node fast.mjs' });
    const changed = readCfg(cycles);
    expect(fieldOf(changed, 'macro_cycle.autonomy_level')).toBe('L2');
    const name = listBackups(cycles).slice(-1)[0]!; // 最早的备份 = 原文
    const out = rollbackConfig(cycles, name);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    // ① 值回来
    const restored = readCfg(cycles);
    expect(fieldOf(restored, 'macro_cycle.autonomy_level')).toBe('L4');
    expect(fieldOf(restored, 'build.test_cmd')).toBe('node scripts/run-tests.mjs');
    // ② 注释逐字节回来（回滚不是"恢复了值但丢了理由"）
    expect(commentLines(splitLines(restored))).toEqual(originalComments);
    // ③ 最强的一条：整体逐字节等于原文
    expect(restored).toBe(SAMPLE);
  });

  it('回滚**前**的当前态也进 .bak，且那份能再回滚回去（不可逆性的补救）', () => {
    const cycles = makeCycles();
    applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L2' });
    const beforeRollback = readCfg(cycles);
    const name = listBackups(cycles).slice(-1)[0]!;
    const out = rollbackConfig(cycles, name, { now: new Date(Date.UTC(2026, 9, 27, 7, 0, 0)) });
    expect(out.ok).toBe(true);
    // 安全备份存在且内容是**回滚前**的正文
    expect(out.safetyBackupPath).not.toBeNull();
    expect(readFileSync(out.safetyBackupPath as string, 'utf-8')).toBe(beforeRollback);
    // 用那份安全备份能回滚回去（回滚本身可再回滚）
    const back = rollbackConfig(cycles, listBackups(cycles).find((n) => join(cycles, n) === out.safetyBackupPath)!);
    expect(back.ok).toBe(true);
    expect(readCfg(cycles)).toBe(beforeRollback);
  });

  it('反向自检：不先备份当前态的实现会把"回滚前状态"永久丢掉', () => {
    // 模拟错误实现：直接覆写、不留安全备份
    const cycles = makeCycles();
    applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L2' });
    const beforeRollback = readCfg(cycles);
    const backupsBefore = listBackups(cycles).length;
    // 错误实现只做 writeFileSync（无备份步骤）
    const name = listBackups(cycles).slice(-1)[0]!;
    writeFileSync(join(cycles, 'config.yml'), readFileSync(join(cycles, name), 'utf-8'), 'utf-8');
    expect(readCfg(cycles)).toBe(SAMPLE);
    // 此刻没有任何文件保存着 beforeRollback —— 已不可逆
    expect(listBackups(cycles).every((n) => readFileSync(join(cycles, n), 'utf-8') !== beforeRollback)).toBe(true);
    // 而正确实现（同一初始态）**会**留下那份内容
    const cycles2 = makeCycles();
    applyConfigPatch(cycles2, { 'macro_cycle.autonomy_level': 'L2' });
    const before2 = readCfg(cycles2);
    const name2 = listBackups(cycles2).slice(-1)[0]!;
    const out2 = rollbackConfig(cycles2, name2);
    expect(listBackups(cycles2).some((n) => readFileSync(join(cycles2, n), 'utf-8') === before2)).toBe(true);
    expect(out2.ok).toBe(true);
    expect(backupsBefore).toBeGreaterThan(0);
  });

  it('回滚后用唯一 loader 能解析（语义层证据，与字节层互补）', () => {
    const cycles = makeCycles();
    applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L1' });
    const out = rollbackConfig(cycles, listBackups(cycles).slice(-1)[0]!);
    expect(out.ok).toBe(true);
    expect(readbackAfterRollback(cycles)).toEqual({ ok: true, error: '' });
  });

  it('空内容备份被拒（回滚成空配置比不回滚更糟）', () => {
    const cycles = makeCycles();
    const emptyName = `${BACKUP_PREFIX}20260101T000000000Z`;
    writeFileSync(join(cycles, emptyName), '   \n', 'utf-8');
    const plan = planRollback(cycles, emptyName);
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain('empty');
    // 反向自检：非空内容的同前缀备份会被接受
    writeFileSync(join(cycles, `${BACKUP_PREFIX}20260102T000000000Z`), SAMPLE, 'utf-8');
    expect(planRollback(cycles, `${BACKUP_PREFIX}20260102T000000000Z`).ok).toBe(true);
  });
});

describe('G-SINGLE：回滚复用同一写入器（静态断言）', () => {
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

  it('config.yml 正文只由 configCommit.ts 的 atomicWriteFileSync 写（唯一写路径）', () => {
    const commit = stripComments(read('src/host/configEdit/configCommit.ts'));
    // 动作层里出现 atomicWriteFileSync 是**唯一允许**的一处（正文）+ 一处（备份文件）
    const hits = commit.match(/atomicWriteFileSync\(/g) ?? [];
    // 扫描集非空下限 + 落点只有三个：备份候选、正文、回滚正文。
    // （第四个命中在去注释后仍可能残留于块注释正文行，故先断言"至少三个落点"再逐个点名。）
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(commit).toContain('atomicWriteFileSync(configPath');
    expect(commit).toContain('atomicWriteFileSync(candidate');
    // 正文落点恰好两处：写入（②）与回滚（④）——它们同在一个函数体内。
    expect((commit.match(/atomicWriteFileSync\(configPath/g) ?? []).length).toBe(2);
    // 备份落点恰好一处
    expect((commit.match(/atomicWriteFileSync\(candidate/g) ?? []).length).toBe(1);
  });

  it('configBackup.ts **不**直接写 config.yml（它只算，提交给 commitConfigContent）', () => {
    const backup = stripComments(read('src/host/configEdit/configBackup.ts'));
    // 反向自检：这条断言有牙——若真有第二份写路径，正则必须能命中它
    expect(/atomicWriteFileSync\(/.test('atomicWriteFileSync(tmp, x)')).toBe(true);
    expect(backup).not.toMatch(/atomicWriteFileSync\(/);
    expect(backup).not.toMatch(/writeFileSync\(/);
    // 而且它确实调用同一提交器
    expect(backup).toContain('commitConfigContent(');
  });

  it('configCommit.ts 对 config.yml 的原子写只有一处（回滚也在同一函数里）', () => {
    const commit = stripComments(read('src/host/configEdit/configCommit.ts'));
    const writeCalls = [...commit.matchAll(/atomicWriteFileSync\(configPath/g)];
    // 写入正文一处（②）与回滚写正文一处（④）——它们是**同一个**动作的两半，
    // 都在 commitConfigContent 内，共用同一个 verify/backup 变量。
    expect(writeCalls.length).toBe(2);
    expect(commit).toContain('export function commitConfigContent');
    // 回滚用的内容来自同一份备份（不是另算一份"原值"）
    expect(commit).toMatch(/atomicWriteFileSync\(configPath, readFileSync\(/);
  });

  it('configWriter 不再自带写入动作，只做 patch 策略（拆分后仍导出既有名字）', () => {
    const writer = stripComments(read('src/host/configEdit/configWriter.ts'));
    expect(writer).not.toMatch(/atomicWriteFileSync\(/);
    for (const name of ['BACKUP_KEEP', 'BACKUP_PREFIX', 'backupFileName', 'compactStamp', 'listBackups', 'pruneBackups', 'applyConfigPatch', 'configFileStat']) {
      expect(writer).toContain(name);
    }
  });
});

describe('备份目录纪律：只认自己前缀，绝不误伤用户文件', () => {
  it('用户自命名文件不进清单、回滚也不接受', () => {
    const cycles = makeCycles();
    writeFileSync(join(cycles, 'config.yml.old-my-backup'), SAMPLE, 'utf-8');
    writeFileSync(join(cycles, 'config.yml.bak_NOT_MINE'), SAMPLE, 'utf-8');
    applyConfigPatch(cycles, { 'macro_cycle.autonomy_level': 'L3' });
    const names = listBackups(cycles);
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((n) => n.includes('NOT_MINE'))).toBe(false);
    const listed = listBackupsWithDiff(cycles).map((v) => v.name);
    expect(listed.some((n) => n.includes('NOT_MINE'))).toBe(false);
    // 用户文件仍在
    expect(existsSync(join(cycles, 'config.yml.old-my-backup'))).toBe(true);
    expect(readdirSync(cycles).includes('config.yml.old-my-backup')).toBe(true);
  });
});
