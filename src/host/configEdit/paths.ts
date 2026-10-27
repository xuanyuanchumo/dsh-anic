/**
 * 插件路径表（cycle-82 路径可视化）。
 *
 * ## 为什么这件事必须做（用户原话点名）
 *
 * 「配置/路径支持自定义可视化编辑等」——`.cycles` 各文档的生命周期此前只在
 * CLI/SKILL.md 里描述，用户无法回答「我的账本到底写到哪个文件、技能装在哪、
 * dist 在哪」。路径表把这条链**显式化**，并且每项都带 exists/bytes/mtime，
 * 让「说存在」变成「读到证据才算存在」。
 *
 * ## 安全边界（这是路径可视化，不是任意文件浏览器）
 *
 * 自定义路径只接受「不含 `..`、realpath 后仍包含在 workspace 内、且自身存在」的
 * 路径，否则**拒绝并说明原因**。把任意路径读出来做成接口，等于给插件开一个
 * 任意文件读取入口——那不是本诉求要的东西。
 *
 * ## 一套推导，不留第二份
 *
 * workspace 相对项一律 `join(root, ...)`；技能目录走 `skillInvoker.resolveSkillScriptsDir`
 * 与 `inlineSkillRoot`；插件根/dist 走 `pluginRoot.resolvePluginRoot`——
 * 这几个解析器已经是全仓唯一实现，这里**只消费不复制**（G-SINGLE）。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { inlineSkillRoot, resolveSkillScriptsDir } from '../skillInvoker.ts';
import { pluginAssetDir, resolvePluginRoot } from '../pluginRoot.ts';

export type PathKind = 'dir' | 'file';

/**
 * 词表键构造：`config.` 前缀 + 短名（与 configSchema 同款理由——locale 合并由
 * Lead 统一做，整串字面量会在合并前被闭环体检报成幽灵消费；前缀形态两头干净）。
 */
const label = (suffix: string): string => 'config.' + suffix;

export interface PathEntry {
  /** 稳定 id（客户端按此分组/复制）。 */
  id: string;
  /** 词表键（docs/anic/cycle-82-config-i18n.md）。 */
  labelKey: string;
  /** 绝对路径；不可解析时为 null（如插件根未找到）。 */
  path: string | null;
  /** 该项语义上的形态（目录/文件）——用来说明「本来是目录」，不用于判定存在性。 */
  kind: PathKind;
  exists: boolean;
  isDir: boolean;
  bytes: number;
  /** ISO 时间戳；不存在/不可读为 null。 */
  mtime: string | null;
  /** 推导来源的一句话说明（为什么是这个路径，不是别的）。 */
  source: string;
}

export interface PathTable {
  workspace: string;
  entries: PathEntry[];
  warnings: string[];
}

/** 单条路径探测（永不抛：权限/竞态一律落到 exists=false）。 */
function probe(id: string, labelKey: string, kind: PathKind, path: string | null, source: string): PathEntry {
  if (path === null) {
    return { id, labelKey, path: null, kind, exists: false, isDir: false, bytes: 0, mtime: null, source };
  }
  try {
    if (!existsSync(path)) {
      return { id, labelKey, path, kind, exists: false, isDir: false, bytes: 0, mtime: null, source };
    }
    const st = statSync(path);
    return {
      id, labelKey, path,
      kind,
      exists: true,
      isDir: st.isDirectory(),
      bytes: st.isDirectory() ? 0 : st.size,
      mtime: st.mtime.toISOString(),
      source,
    };
  } catch {
    return { id, labelKey, path, kind, exists: false, isDir: false, bytes: 0, mtime: null, source };
  }
}

/**
 * 构建路径表（只读）。
 *
 * 顺序即重要性：工作区 → .cycles 契约文件 → 生命周期目录 → 技能 → 插件。
 * 客户端按此顺序渲染，用户从上往下读就是「我的项目长什么样」。
 */
export function collectPaths(workspaceRoot: string): PathTable {
  const root = resolve(workspaceRoot);
  const cycles = join(root, '.cycles');
  const warnings: string[] = [];

  let skillScripts: string | null = null;
  try { skillScripts = resolveSkillScriptsDir(root); } catch { skillScripts = null; }
  let inlineRoot: string | null = null;
  try { inlineRoot = inlineSkillRoot(); } catch { inlineRoot = null; }
  let pluginRoot: string | null = null;
  try { pluginRoot = resolvePluginRoot() || null; } catch { pluginRoot = null; }
  if (pluginRoot === null) warnings.push('plugin root not resolvable (package.json with name=dsh-anic not found upward)');

  const entries: PathEntry[] = [
    probe('workspace', label('path.workspace'), 'dir', root, '宿主会话工作区（X-ANIC-Workspace 头优先）'),
    probe('cycles', label('path.cycles'), 'dir', cycles, 'workspace/.cycles（所有生命周期文档的根）'),
    probe('config', label('path.config'), 'file', join(cycles, 'config.yml'), 'canonical 配置（INV-25 唯一入口）'),
    probe('ledger', label('path.ledger'), 'file', join(cycles, 'gates', 'ledger.json'), '门禁账本（哈希链）'),
    probe('workflowState', label('path.workflowState'), 'file', join(cycles, 'workflow-state.json'), '工作流当前状态快照'),
    probe('flowTracker', label('path.flowTracker'), 'file', join(cycles, 'flow-tracker.json'), '技能流程跟踪（anic_skill 写入）'),
    probe('cyclesDocs', label('path.cyclesDocs'), 'dir', join(cycles, 'cycles'), '每轮 cycle-N 文档目录'),
    probe('evals', label('path.evals'), 'dir', join(cycles, 'evals'), '评估报告'),
    probe('techDebt', label('path.techDebt'), 'dir', join(cycles, 'tech-debt'), '技术债登记'),
    probe('incidents', label('path.incidents'), 'dir', join(cycles, 'incidents'), '事故取证'),
    probe('archive', label('path.archive'), 'dir', join(cycles, 'archive'), '归档循环'),
    probe('skillInstalled', label('path.skillInstalled'), 'dir', join(root, '.dsh', 'skills', 'ai-native-iteration-cycle'), '工作区已装技能（可升级副本）'),
    probe('skillScripts', label('path.skillScripts'), 'dir', skillScripts, 'resolveSkillScriptsDir 解析结果（环境变量 → 工作区 → cwd → 内联）'),
    probe('skillInline', label('path.skillInline'), 'dir', inlineRoot, '插件内联技能底座（assets/skill）'),
    probe('pluginRoot', label('path.pluginRoot'), 'dir', pluginRoot, 'resolvePluginRoot（标记驱动向上查找 package.json）'),
    probe('dist', label('path.dist'), 'dir', pluginRoot ? join(pluginRoot, 'dist') : null, '构建产物目录（宿主加载 dist/host.js）'),
    probe('assets', label('path.assets'), 'dir', pluginRoot ? join(pluginRoot, 'assets') : null, '插件随包资产'),
    probe('agents', label('path.agents'), 'dir', (() => { try { return pluginAssetDir('agents') || null; } catch { return null; } })(), 'agent 卡目录（pluginAssetDir）'),
    probe('artifacts', label('path.artifacts'), 'dir', join(root, 'artifacts'), '工作区工件输出（workflow-snapshot.json 等）'),
  ];

  return { workspace: root, entries, warnings };
}
export type PathRequestResult =
  | { ok: true; entry: PathEntry }
  | { ok: false; reason: string; code: PathRejectCode };

export type PathRejectCode =
  | 'PATH_EMPTY'
  | 'PATH_TRAVERSAL'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_NOT_FOUND';

/** realpath 容错：不存在的路径返回 null（后面的 NOT_FOUND 分支会给出更好的原因）。 */
function safeRealpath(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

/** `child` 是否等于 `parent` 或位于其下（按路径段比较，不做字符串前缀——`/a/bc` 不是 `/a/b` 的子项）。 */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  const withSep = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(withSep);
}

/**
 * 校验一个**自定义**路径请求（相对 workspace 或绝对，但必须落在其内）。
 *
 * 拒绝优先级即诊断顺序：空 → 含 `..` → 在 workspace 外 → 不存在。
 * 每一档都返回可读原因，用户看到的是「为什么不给你这个路径」，
 * 而不是一句「非法」。
 */
export function resolveCustomPath(workspaceRoot: string, raw: unknown): PathRequestResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, code: 'PATH_EMPTY', reason: '路径为空' };
  }
  const req = raw.trim();
  // `..` 一律拒绝，即使 realpath 之后恰好还在界内——因为 `/ws/sub/../../etc` 这类
  // 形状经符号链接/大小写重定向后是否仍在界内取决于平台细节，不做这个赌博。
  if (/(^|[/\\])\.\.([/\\]|$)/.test(req)) {
    return { ok: false, code: 'PATH_TRAVERSAL', reason: '路径包含 .. 段（不做越界赌博）' };
  }
  const abs = resolve(workspaceRoot, req);
  if (!isInside(workspaceRoot, abs)) {
    return { ok: false, code: 'PATH_OUTSIDE_WORKSPACE', reason: '路径落在工作区之外（这里只做工作区可视化）' };
  }
  const realWs = safeRealpath(workspaceRoot) ?? resolve(workspaceRoot);
  const real = safeRealpath(abs);
  if (real === null) {
    return { ok: false, code: 'PATH_NOT_FOUND', reason: '路径不存在（realpath 失败）' };
  }
  // realpath 之后再判一次：符号链接可以把界内路径指到界外，这一档是真正的边界。
  if (!isInside(realWs, real)) {
    return { ok: false, code: 'PATH_OUTSIDE_WORKSPACE', reason: '路径经符号链接解析后落在工作区之外' };
  }
  return { ok: true, entry: probe('custom', label('path.custom'), 'file', real, '自定义请求路径（已通过 realpath 边界校验）') };
}
