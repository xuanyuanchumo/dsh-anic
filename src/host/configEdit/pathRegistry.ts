/**
 * 路径登记表 + 探测原语（cycle-83：从 paths.ts 拆出）。
 *
 * ## 登记表是「这个项目有哪些路径」的唯一真相源
 *
 * 登记表回答「这条路径**本来**在哪」；`.cycles/paths.json` 回答「这次跑把它们放哪」。
 * 合并成一份的后果很具体：下次有人改了覆盖表，看到表里 19 行就会分不清
 * 「这条路径本来存在吗，还是只是覆盖表制造出来的」。分层后默认值永远是唯一基线，
 * 覆盖表坏了也只是「解析回落到默认」。
 *
 * ## 哪些项可被覆盖（`overridable`）
 *
 * 只开**工作区内的生命周期目录**（轮次文档 / 评估 / 技术债 / 事故 / 归档 / 工件）。
 * 以下三类**不开**，不是没做，而是开了就是撒谎：
 *   - 契约文件（config.yml / ledger.json / workflow-state / flow-tracker）：
 *     INV-25 等不变量把它们钉在 `.cycles/` 下，覆盖成别处只会让表说 A、读方去 B；
 *   - `workspace` / `cycles`：它们是其余项的锚，改锚等于改坐标系；
 *   - 插件侧 resolve 驱动项：位置由 `resolvePluginRoot` 等解析器推导，
 *     用户覆盖不了，也不该覆盖（那会让「dist 在哪」变成信念而不是构建事实）。
 *
 * ## 覆盖只影响解析层（诚实边界，必须说出来）
 *
 * 覆盖生效后本表解析到用户位置；但**不读这张覆盖表的消费方仍按默认路径读写**。
 * 这句话同时出现在响应 warnings 与渲染提示里——否则用户会以为
 * 「我把 evals 挪到 docs/evals 了」而技能脚本继续写 `.cycles/evals`。
 */
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inlineSkillRoot, resolveSkillScriptsDir } from '../skillInvoker.ts';
import { pluginAssetDir, resolvePluginRoot } from '../pluginRoot.ts';

export type PathKind = 'dir' | 'file';

/** 词表键构造：`config.` 前缀 + 短名（整串字面量会被闭环体检报幽灵消费，见 configTypes）。 */
export function pathLabel(suffix: string): string {
  return 'config.' + suffix;
}

/** 探测结果（客户端 ConfigPathJson 逐字段对应）。 */
export interface PathEntry {
  id: string;
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
  /** cycle-83：解析结果套用了 `.cycles/paths.json` 的覆盖（默认解析时为 false）。 */
  overridden: boolean;
  /** 该项是否为「登记表允许覆盖的项」（客户端据此决定是否给编辑入口）。 */
  editable: boolean;
}

export interface PathTable {
  workspace: string;
  entries: PathEntry[];
  warnings: string[];
  /** cycle-83：覆盖表是否被整份忽略（fail-closed 信号，客户端据此着色）。 */
  overridesIgnored: boolean;
}

/** 解析上下文：resolve 驱动项都从这里取（一次构建，避免 4s 轮询里反复走 fs 查找）。 */
export interface PathContext {
  root: string;
  cycles: string;
  pluginRoot: string | null;
  skillScripts: string | null;
  inlineRoot: string | null;
  agentsDir: string | null;
}

const safe = <T>(fn: () => T | null | undefined): T | null => {
  try { return fn() ?? null; } catch { return null; }
};

export function buildPathContext(workspaceRoot: string): PathContext {
  const root = resolve(workspaceRoot);
  return {
    root,
    cycles: join(root, '.cycles'),
    pluginRoot: safe(() => resolvePluginRoot()),
    skillScripts: safe(() => resolveSkillScriptsDir(root)),
    inlineRoot: safe(() => inlineSkillRoot()),
    agentsDir: safe(() => pluginAssetDir('agents')),
  };
}

/** 登记项（顺序即渲染顺序：工作区 → .cycles 契约 → 生命周期 → 技能 → 插件）。 */
export interface PathDef {
  id: string;
  /** 词表短名（`config.path.<suffix>`）。 */
  suffix: string;
  kind: PathKind;
  /** 推导来源的一句话说明（为什么是这个路径，不是别的）。 */
  source: string;
  /** 工作区相对默认路径（`/` 分隔）。 */
  rel?: string;
  /** resolve 驱动项（插件侧/技能解析器）。 */
  resolve?: (ctx: PathContext) => string | null;
  /** 是否允许被 `.cycles/paths.json` 覆盖（理由见文件头）。 */
  overridable?: boolean;
}

export const PATH_DEFS: readonly PathDef[] = [
  { id: 'workspace', suffix: 'path.workspace', kind: 'dir', source: '宿主会话工作区（X-ANIC-Workspace 头优先）', resolve: (c) => c.root },
  { id: 'cycles', suffix: 'path.cycles', kind: 'dir', source: 'workspace/.cycles（所有生命周期文档的根）', resolve: (c) => c.cycles },
  { id: 'config', suffix: 'path.config', kind: 'file', source: 'canonical 配置（INV-25 唯一入口）', rel: '.cycles/config.yml' },
  { id: 'ledger', suffix: 'path.ledger', kind: 'file', source: '门禁账本（哈希链）', rel: '.cycles/gates/ledger.json' },
  { id: 'workflowState', suffix: 'path.workflowState', kind: 'file', source: '工作流当前状态快照', rel: '.cycles/workflow-state.json' },
  { id: 'flowTracker', suffix: 'path.flowTracker', kind: 'file', source: '技能流程跟踪（anic_skill 写入）', rel: '.cycles/flow-tracker.json' },
  // ── 可覆盖的生命周期目录（用户可自定义组织方式）───────────────────────────
  { id: 'cyclesDocs', suffix: 'path.cyclesDocs', kind: 'dir', source: '每轮 cycle-N 文档目录', rel: '.cycles/cycles', overridable: true },
  { id: 'evals', suffix: 'path.evals', kind: 'dir', source: '评估报告', rel: '.cycles/evals', overridable: true },
  { id: 'techDebt', suffix: 'path.techDebt', kind: 'dir', source: '技术债登记', rel: '.cycles/tech-debt', overridable: true },
  { id: 'incidents', suffix: 'path.incidents', kind: 'dir', source: '事故取证', rel: '.cycles/incidents', overridable: true },
  { id: 'archive', suffix: 'path.archive', kind: 'dir', source: '归档循环', rel: '.cycles/archive', overridable: true },
  { id: 'artifacts', suffix: 'path.artifacts', kind: 'dir', source: '工作区工件输出（workflow-snapshot.json 等）', rel: 'artifacts', overridable: true },
  // ── 工作区内的固定项（契约/安装位置：覆盖会与读方分家）───────────────────
  { id: 'skillInstalled', suffix: 'path.skillInstalled', kind: 'dir', source: '工作区已装技能（可升级副本）', rel: '.dsh/skills/ai-native-iteration-cycle' },
  // ── resolve 驱动项（派生自解析器，不是本表拼的）──────────────────────────
  { id: 'skillScripts', suffix: 'path.skillScripts', kind: 'dir', source: 'resolveSkillScriptsDir 解析结果（环境变量 → 工作区 → cwd → 内联）', resolve: (c) => c.skillScripts },
  { id: 'skillInline', suffix: 'path.skillInline', kind: 'dir', source: '插件内联技能底座（assets/skill）', resolve: (c) => c.inlineRoot },
  { id: 'pluginRoot', suffix: 'path.pluginRoot', kind: 'dir', source: 'resolvePluginRoot（标记驱动向上查找 package.json）', resolve: (c) => c.pluginRoot },
  { id: 'dist', suffix: 'path.dist', kind: 'dir', source: '构建产物目录（宿主加载 dist/host.js）', resolve: (c) => (c.pluginRoot === null ? null : join(c.pluginRoot, 'dist')) },
  { id: 'assets', suffix: 'path.assets', kind: 'dir', source: '插件随包资产', resolve: (c) => (c.pluginRoot === null ? null : join(c.pluginRoot, 'assets')) },
  { id: 'agents', suffix: 'path.agents', kind: 'dir', source: 'agent 卡目录（pluginAssetDir）', resolve: (c) => c.agentsDir },
];

const BY_ID = new Map(PATH_DEFS.map((d) => [d.id, d]));

export function pathDefById(id: string): PathDef | undefined {
  return BY_ID.get(id);
}

/** 可覆盖的 id 清单（客户端与校验层共用，避免两处各自抄一份白名单）。 */
export function overridablePathIds(): string[] {
  return PATH_DEFS.filter((d) => d.overridable === true).map((d) => d.id);
}

/** 默认解析（不套覆盖）：登记表 → 绝对路径。 */
export function defaultPathOf(def: PathDef, ctx: PathContext): string | null {
  if (def.rel !== undefined) return join(ctx.root, ...def.rel.split('/'));
  return def.resolve === undefined ? null : def.resolve(ctx);
}

/** 单条探测（永不抛：权限/竞态一律落到 exists=false）。 */
export function probeEntry(
  def: PathDef,
  ctx: PathContext,
  at: { path: string | null; overridden: boolean },
): PathEntry {
  const path = at.path;
  const base = {
    id: def.id, labelKey: pathLabel(def.suffix), kind: def.kind, source: def.source,
    overridden: at.overridden, editable: def.overridable === true,
  };
  if (path === null) return { ...base, path: null, exists: false, isDir: false, bytes: 0, mtime: null };
  try {
    if (!existsSync(path)) return { ...base, path, exists: false, isDir: false, bytes: 0, mtime: null };
    const st = statSync(path);
    return {
      ...base, path,
      exists: true,
      isDir: st.isDirectory(),
      bytes: st.isDirectory() ? 0 : st.size,
      mtime: st.mtime.toISOString(),
    };
  } catch {
    return { ...base, path, exists: false, isDir: false, bytes: 0, mtime: null };
  }
}

/**
 * ## cycle-95 删除 `probeDefault()`（为什么删）
 *
 * 注释自称「供覆盖校验与默认表使用」，但**两处都不用它**：
 * `paths.ts` 的 `resolvePathsFor` 对每一个登记项直接内联调用
 * `probeEntry(def, ctx, { path: defaultPathOf(def, ctx), overridden: false })`，
 * 与本函数**逐字节等价**；覆盖校验走的是 `probeEntry` + `pathOverrideRules`。
 *
 * ⇒ 这是同一判定的**第二份包装**，多一个入口就多一个「谁才是默认探测」的疑问。
 * 全仓去注释后零消费（audit-wiring 全仓零文本命中），tests/ 也无引用。
 * 本仓教训：没人用的兼容层是最贵的兼容层。
 */
