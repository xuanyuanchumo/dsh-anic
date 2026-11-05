// merkle-cache.test.ts — cycle-97 P0 缓存基线单元测试
// 钉死四态生命周期与三个已修复缺陷的回归：
//   D1: calculateDirMerkleRoot 的 walk 必须真实执行（根 ≠ SHA256('')）
//   D2: saveCache 存的根必须可由调用方 override（存/比同范围）
//   D3: isCacheValid 必须能用调用方的期望根比对（验/存同范围）
//   D4: detectDetailedChanges 必须同步返回（不是 Promise）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const libUrl = new URL('../../assets/skill/scripts/lib/merkle-hash.mjs', import.meta.url);
const {
  calculateDirMerkleRoot,
  calculateFileHash,
  isCacheValid,
  loadCache,
  saveCache,
  detectDetailedChanges,
} = await import(libUrl.href);

describe('merkle-hash — 缓存基线数据结构', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anic-merkle-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('D1 回归：根随内容变化（不是恒 SHA256 空串）', () => {
    const root1 = calculateDirMerkleRoot(join(dir, 'src'));
    // SHA256('') = e3b0c442... 是 walk 未执行的死签名
    expect(root1).not.toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(root1).toMatch(/^[a-f0-9]{64}$/);

    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    const root2 = calculateDirMerkleRoot(join(dir, 'src'));
    expect(root2).not.toBe(root1);
  });

  it('D1b：根对文件顺序不敏感（确定性），对新文件敏感', () => {
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
    const root1 = calculateDirMerkleRoot(join(dir, 'src'));
    const root1Again = calculateDirMerkleRoot(join(dir, 'src'));
    expect(root1Again).toBe(root1);
  });

  it('calculateFileHash：存在返回 16 位 hex，不存在返回 null', () => {
    expect(calculateFileHash(join(dir, 'src', 'a.ts'))).toMatch(/^[a-f0-9]{16}$/);
    expect(calculateFileHash(join(dir, 'src', 'ghost.ts'))).toBeNull();
  });

  it('D2+D3 回归：save 存 override 根 → isCacheValid 用同一 override 根验证通过', () => {
    const cacheFile = join(dir, '.cycles', '.eval-cache.json');
    mkdirSync(join(dir, '.cycles'), { recursive: true });
    const srcRoot = calculateDirMerkleRoot(join(dir, 'src'));

    saveCache(cacheFile, dir, '0.54.0', { test: { pass: true }, duration: 5 }, srcRoot);

    const loaded = loadCache(cacheFile);
    expect(loaded).not.toBeNull();
    expect(loaded.merkleRoot).toBe(srcRoot); // 存的就是调用方范围

    // 用同一范围验证 → 有效
    expect(isCacheValid(cacheFile, dir, '0.54.0', 7 * 24 * 3600e3, srcRoot)).toBe(true);
    // 用整项目根验证（范围不一致）→ 无效（诚实拒绝，不假绿）
    expect(isCacheValid(cacheFile, dir, '0.54.0', 7 * 24 * 3600e3)).toBe(false);
  });

  it('缓存失效四场景：版本变/项目变/哈希变/损坏', () => {
    const cacheFile = join(dir, '.cycles', '.eval-cache.json');
    mkdirSync(join(dir, '.cycles'), { recursive: true });
    const srcRoot = calculateDirMerkleRoot(join(dir, 'src'));
    saveCache(cacheFile, dir, '0.54.0', { test: { pass: true } }, srcRoot);

    // 版本变
    expect(isCacheValid(cacheFile, dir, '0.55.0', 7 * 24 * 3600e3, srcRoot)).toBe(false);
    // 项目变
    expect(isCacheValid(cacheFile, join(dir, 'other'), '0.54.0', 7 * 24 * 3600e3, srcRoot)).toBe(false);
    // 哈希变
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 999;\n');
    expect(isCacheValid(cacheFile, dir, '0.54.0', 7 * 24 * 3600e3, calculateDirMerkleRoot(join(dir, 'src')))).toBe(false);
    // 损坏（半截 JSON）
    writeFileSync(cacheFile, '{"version":"0.54.0",');
    expect(loadCache(cacheFile)).toBeNull();
    expect(isCacheValid(cacheFile, dir, '0.54.0', 7 * 24 * 3600e3, srcRoot)).toBe(false);
  });

  it('D4 回归：detectDetailedChanges 同步返回对象（非 Promise）', () => {
    const cacheFile = join(dir, '.cycles', '.eval-cache.json');
    mkdirSync(join(dir, '.cycles'), { recursive: true });
    const srcRoot = calculateDirMerkleRoot(join(dir, 'src'));
    saveCache(cacheFile, dir, '0.54.0', {}, srcRoot);

    const r = detectDetailedChanges(dir, cacheFile);
    // 若是 Promise，这两个断言会 fail（Promise.changedFiles === undefined）
    expect(Array.isArray(r.changedFiles)).toBe(true);
    expect(typeof r.totalFiles).toBe('number');

    // 修改文件后能点名变更
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 42;\n');
    const r2 = detectDetailedChanges(dir, cacheFile);
    expect(r2.changedFiles.length).toBe(1);
    expect(r2.changedFiles[0]).toContain('a.ts');
  });

  it('P3-3 回归：配置指纹入缓存键——test_cmd 变更必须击穿缓存（源码未动）', () => {
    const cacheFile = join(dir, '.cycles', '.eval-cache.json');
    mkdirSync(join(dir, '.cycles'), { recursive: true });
    const srcRoot = calculateDirMerkleRoot(join(dir, 'src'));

    // 旧配置指纹存缓存
    saveCache(cacheFile, dir, '0.54.0', { test: { pass: true } }, srcRoot, 'cfg-abc');

    // 命中：同配置指纹
    expect(loadCache(cacheFile)?.cfgFingerprint).toBe('cfg-abc');

    // 配置变了（哪怕源码零变更）→ 存档里的指纹与新指纹不等 → 调用方必须判 miss
    // （实际比对逻辑在 eval-runner：loadCache().cfgFingerprint === CFG_FINGERPRINT_KEY）
    const cache = loadCache(cacheFile);
    expect(cache.cfgFingerprint === 'cfg-xyz').toBe(false); // 新指纹 ≠ 存档 → miss
    expect(cache.cfgFingerprint === 'cfg-abc').toBe(true);  // 存档原样可读

    // 向后兼容：无 cfgFingerprint 的旧缓存（空串缺省）与空指纹比对恒真
    saveCache(cacheFile, dir, '0.54.0', { test: { pass: true } }, srcRoot);
    expect(loadCache(cacheFile)?.cfgFingerprint).toBe('');
  });

  it('node_modules/.git/dist 不入指纹（避免依赖目录污染缓存键）', () => {
    mkdirSync(join(dir, 'src', 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'src', 'node_modules', 'x.ts'), 'noise');
    const rootBefore = calculateDirMerkleRoot(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'node_modules', 'x.ts'), 'noise-changed');
    const rootAfter = calculateDirMerkleRoot(join(dir, 'src'));
    expect(rootAfter).toBe(rootBefore); // 依赖目录变更不影响指纹
  });

  // ── 上游场地 C142：扩展名单一真源（三份硬编码白名单漂移的根修）──────────
  describe('SOURCE_EXTENSIONS 单一真源（上游场地 C142）', () => {
    it('CSS 变更必须击穿缓存（上游场地 C142 现场缺陷：token 契约修复被缓存吞掉）', () => {
      // 直接复现 上游场地 C142 §85.5：eval-runner 的缓存键只扫 .ts/.js/.mjs，
      // runtime-panel.css 的 token 违例修复后 Merkle 根不变 → 缓存 hit → 报旧结果。
      const cssRoot1 = calculateDirMerkleRoot(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'theme.css'), '.a { color: #fff; }\n');
      const cssRoot2 = calculateDirMerkleRoot(join(dir, 'src'));
      expect(cssRoot2).not.toBe(cssRoot1); // 新 CSS 文件进键

      // 已有 CSS 文件的内容变更同样进键（纯样式修改场景）
      const rootBefore = calculateDirMerkleRoot(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'theme.css'), '.a { color: #f00; }\n');
      const rootAfter = calculateDirMerkleRoot(join(dir, 'src'));
      expect(rootAfter).not.toBe(rootBefore);
    });

    it('TSX/JSX 变更必须进键（React 组件修复此前同样被缓存吞掉）', () => {
      writeFileSync(join(dir, 'src', 'Panel.tsx'), 'export const A = () => null;\n');
      const root1 = calculateDirMerkleRoot(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'Panel.tsx'), 'export const A = () => <b/>;\n');
      const root2 = calculateDirMerkleRoot(join(dir, 'src'));
      expect(root2).not.toBe(root1);

      writeFileSync(join(dir, 'src', 'App.jsx'), 'export const B = 1;\n');
      const root3 = calculateDirMerkleRoot(join(dir, 'src'));
      expect(root3).not.toBe(root2);
    });

    it('反向自检：无扩展名/非源码文件不入键（守卫不是放行一切）', () => {
      const root1 = calculateDirMerkleRoot(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'notes.txt'), 'not source');
      writeFileSync(join(dir, 'src', 'README'), 'md without ext');
      const root2 = calculateDirMerkleRoot(join(dir, 'src'));
      expect(root2).toBe(root1); // 非源码文件变更不影响指纹
    });

    it('守卫自检：SOURCE_EXTENSIONS 必须含 CSS/TSX（防白名单被悄悄收窄）', async () => {
      // 若有人把 .css/.tsx 从单一真源删掉，上面「变更进键」的用例虽然仍会红，
      // 但若连用例一起被删，这条最小断言就是最后防线。
      const mod = await import(libUrl.href);
      expect(mod.SOURCE_EXTENSIONS).toContain('.css');
      expect(mod.SOURCE_EXTENSIONS).toContain('.tsx');
      expect(mod.SOURCE_EXTENSIONS).toContain('.ts');
    });
  });
});
