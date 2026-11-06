/**
 * 官方技能注册（cycle-97：结合 DSH 规范暴露技能插件能力；cycle-109：证据化）。
 *
 * 把 ai-native-iteration-cycle 经 `ctx.skills.register()` 注册为 runtime skill：
 *   - 模型在会话目录（<available_skills>，dsh-tool-skill 首个 pre-step 注入）中
 *     发现本技能，经官方 `skill({name})` 工具加载正文；
 *   - 调用进 DSH 轨迹（tool/call + tool/result 会话事件）——
 *     「DSH大模型使用时 dsh 的轨迹要有本技能插件的调用」的官方通道；
 *   - 与工作区 .dsh/skills/ 安装态共存：**project 层同名条目胜过 runtime 条目**
 *     （skills.md「本地发现优先级」），重名不冲突。
 *
 * 契约（KB `site/reference/subsystems/skills.md:290-299`）：
 *   ctx.skills.register({ name, description, whenToUse?, source: 'runtime',
 *                          content, resourceBase?, invocation? }) — 定义校验要求
 *   name/description/source/content 四个字符串；provider 缺省 'runtime'。
 *
 * ## ★ cycle-109：为什么必须**回读**（修 D2「注册了但没激活」的同款缺陷）
 *
 * `register()` 成功**不等于**模型可见：官方语义里 project 层同名条目会**直接赢得**
 * runtime 条目。旧实现的 `log.info('已注册')` 是**无条件**的 —— 工作区里放一个
 * 同名 `.dsh/skills/<name>.md` 就能静默压制本插件技能，而日志照绿。
 * 这正是 `src/index.ts` 文件头亲口命名的「注册了但没激活」缺陷类，只是换到了技能面。
 *
 * 修法：注册后**异步回读** `snapshot()` 并分类三态（`active`/`absent`/`unknown`）。
 * 三态而不是布尔，因为观测**不完整**（`complete:false`）时必须判 `unknown` ——
 * 谎报 `absent` 会让「工作区安装态」被误判成缺失（官方：不完整观测不可缓存、不可下结论）。
 *
 * ## 为什么 `invocation` 只在**显式声明**时才传
 *
 * frontmatter 的两个策略键（`disable-model-invocation` / `user-invocable`）缺省即 true
 * （skills.md:132）。若两个键都没写却仍传 `invocation: {both true}`，就把「用户没表态」
 * 写死成了「用户表过态」—— 未来官方改默认值时会与本插件悄悄分叉。
 * ⇒ **缺键不传**，交给官方默认。
 */
import { readFileSync } from 'node:fs';
import { createScoped } from './logger.ts';
import { pluginAssetDir } from './pluginRoot.ts';
import { noteSkillsChange } from './runtime/skillsChangeCounter.ts';
// cycle-109 T3 拆分：三态判据（纯函数）下移到 runtime/skillVisibility.ts，
// 此处再导出保消费者 import 路径零变更（skillRegistration 仍是技能面的公开门面）。
import { classifySkillVisibility, type SkillSnapshotLike, type SkillVisibilityResult } from './runtime/skillVisibility.ts';

export type { SkillSnapshotLike, SkillVisibility, SkillVisibilityResult } from './runtime/skillVisibility.ts';
export { classifySkillVisibility } from './runtime/skillVisibility.ts';

const log = createScoped('anic:skill-registration');

/** 注册输入：解析后的 frontmatter + 正文。 */
export interface ParsedSkillFrontmatter {
  name?: string;
  description?: string;
  whenToUse?: string;
  /** `disable-model-invocation: true` ⇒ false（缺省 true，skills.md:132）。 */
  modelInvocable?: boolean;
  /** `user-invocable: false` ⇒ false（缺省 true）。 */
  userInvocable?: boolean;
  /** 两个策略键是否**至少出现一个**（决定要不要传 `invocation`）。 */
  invocationDeclared?: boolean;
  body: string;
}

/** frontmatter 布尔值解析：只认 true/false（其他形态视为未表态，不猜）。 */
function parseFrontmatterBool(v: string): boolean | undefined {
  const s = v.trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return undefined;
}

/**
 * 解析 SKILL.md frontmatter（name/description/whenToUse + 两个调用策略键）。
 *
 * 只支持实际用到的两种 YAML 形态：单行 `key: value` 与 `>` 折叠块
 * （缩进续行拼接为单空格——SKILL.md 的多行 description 用的是折叠块）。
 * 其他形态（| 字面块、引号、锚点）不支持：解析不出 name/description 时
 * 调用方跳过注册（fail-closed），不猜。
 */
export function parseSkillFrontmatter(md: string): ParsedSkillFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m || typeof m[1] !== 'string') return { body: md };
  const raw = m[1];
  const out: ParsedSkillFrontmatter = { body: md.slice(m[0].length) };
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i] as string);
    if (!kv) { i += 1; continue; }
    const key = kv[1] as string;
    const inline = (kv[2] as string).trim();
    if (inline === '>' || inline === '|') {
      // 块标量：收集后续更缩进行（或空行），折叠为单空格拼接。
      const parts: string[] = [];
      i += 1;
      while (i < lines.length && (/^\s+\S/.test(lines[i] as string) || (lines[i] as string).trim() === '')) {
        const t = (lines[i] as string).trim();
        if (t) parts.push(t);
        i += 1;
      }
      const value = parts.join(' ').trim();
      if (key === 'name' || key === 'description' || key === 'whenToUse') out[key] = value;
      continue;
    }
    if (inline) {
      const value = inline.replace(/^["']|["']$/g, '');
      if (key === 'name' || key === 'description' || key === 'whenToUse') out[key] = value;
      else if (key === 'disable-model-invocation' || key === 'user-invocable') {
        const b = parseFrontmatterBool(value);
        if (b !== undefined) {
          out.invocationDeclared = true;
          if (key === 'disable-model-invocation') out.modelInvocable = !b;
          else out.userInvocable = b;
        }
      }
    }
    i += 1;
  }
  return out;
}

/** 技能目录（P0-DIR-ROOT：标记驱动解析——统一 dist/源码/junction 三种布局）。 */
function defaultSkillDir(): string {
  try { return pluginAssetDir('skill'); } catch { return ''; }
}

/** 最小 skills 槽位类型（宿主 ctx unknown 的房屋风格：本地窄化）。 */
interface SkillsCapableCtx {
  skills?: {
    register?: (skill: Record<string, unknown>) => () => void;
    snapshot?: (opts?: unknown) => Promise<SkillSnapshotLike>;
  };
  effect?: (fn: () => unknown, label?: string) => unknown;
  on?: (name: string, handler: () => void) => unknown;
}

/**
 * 注册 runtime skill。返回 disposer（宿主提供时）或 null（跳过）。
 *
 * @param ctx 宿主上下文（需已具备 skills 服务——由静态 inject 保证时序）
 * @param skillDir 技能目录（默认 dist 相对推导；测试可注入）
 */
export function registerRuntimeSkill(ctx: unknown, skillDir = defaultSkillDir()): (() => void) | null {
  const c = ctx as SkillsCapableCtx;
  if (!c.skills || typeof c.skills.register !== 'function') {
    log.info('宿主无 skills 服务，runtime 技能注册跳过（多代防御）');
    return null;
  }
  let md = '';
  try {
    md = readFileSync(`${skillDir.replace(/[\\/]+$/, '')}/SKILL.md`, 'utf-8');
  } catch (e) {
    log.warn(`SKILL.md 读取失败，runtime 技能注册跳过：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const parsed = parseSkillFrontmatter(md);
  if (!parsed.name || !parsed.description) {
    log.warn('SKILL.md frontmatter 缺 name/description，runtime 技能注册跳过（fail-closed）');
    return null;
  }
  // 缺键不传（见文件头）：只有显式声明过才构造 invocation。
  const invocation = parsed.invocationDeclared === true
    ? { modelInvocable: parsed.modelInvocable ?? true, userInvocable: parsed.userInvocable ?? true }
    : null;
  const disposer = c.skills.register({
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
    source: 'runtime',
    content: parsed.body,
    // resourceBase：让官方 skill 工具渲染相对资源引导（scripts/references/）。
    resourceBase: { kind: 'directory', path: skillDir },
    ...(invocation === null ? {} : { invocation }),
  });
  // 措辞改「已提交」而非「已注册」：提交成功不等于模型可见（回读另证）。
  log.info(`runtime 技能已提交注册：${parsed.name}${invocation === null ? '' : ` (invocation: model=${String(invocation.modelInvocable)}, user=${String(invocation.userInvocable)})`}`);
  return typeof disposer === 'function' ? disposer : null;
}

/**
 * 回读技能可见性（cycle-109 · 修 D2）。**绝不抛**——取证是旁路，不是激活前置。
 *
 * 为什么 fire-and-forget 而不是 `await`：`apply` 是同步的（cordis 生命周期），
 * 阻塞它去等一次目录快照会把「注册」变成「注册+快照」的耦合；
 * 而注册本身已经是有效的加性贡献，回读只补**结论**。
 */
export async function verifyRuntimeSkillVisibility(
  ctx: unknown,
  skillDir = defaultSkillDir(),
): Promise<SkillVisibilityResult | null> {
  const c = ctx as SkillsCapableCtx;
  let name = '';
  try {
    name = parseSkillFrontmatter(readFileSync(`${skillDir.replace(/[\\/]+$/, '')}/SKILL.md`, 'utf-8')).name ?? '';
  } catch { return null; }
  if (name === '') return null;
  if (!c.skills || typeof c.skills.snapshot !== 'function') {
    return { name, state: 'unknown', reason: 'host has no skills.snapshot — cannot verify visibility (registration itself unaffected)' };
  }
  let snap: SkillSnapshotLike | null = null;
  try {
    snap = await c.skills.snapshot();
  } catch (e) {
    const r: SkillVisibilityResult = { name, state: 'unknown', reason: 'snapshot() threw: ' + (e instanceof Error ? e.message : String(e)) };
    log.warn('技能可见性回读失败（不影响注册）：' + r.reason);
    return r;
  }
  const result = classifySkillVisibility(snap, name);
  // 三态各自出声：`active` 是正面结论（沉默会被误读成"没检查"）。
  if (result.state === 'active') log.info(`技能可见性：${name} → active（${result.reason}）`);
  else if (result.state === 'absent') log.warn(`技能可见性：${name} → ABSENT（${result.reason}）`);
  else log.warn(`技能可见性：${name} → unknown（${result.reason}）`);
  return result;
}

/**
 * 订阅 `skills/change`（cycle-109 · 修 D3 观测不对称）。
 *
 * 官方契约（skills.md:340-352）：事件**不带 diff**，消费方自行重取 snapshot。
 * 本函数只计数（`skillsChangeCounter.ts`），不缓存目录 —— 缓存会变成第二真相源。
 * 宿主无 `ctx.on`（stub/旧代）⇒ 返回 false，不制造假的监听。
 */
export function wireSkillsChange(ctx: unknown): boolean {
  const c = ctx as SkillsCapableCtx;
  if (typeof c.on !== 'function') return false;
  try {
    // 计数叶子零依赖（`skillsChangeCounter.ts`），顶部静态导入不引入环。
    c.on('skills/change', () => { noteSkillsChange(); });
  } catch {
    return false;
  }
  return true;
}

/*
 * 历史注记（cycle-97，删除即失忆故留档）：曾用 ctx.inject(['skills'], cb) 动态挂载，
 * 真实宿主（cordis 4.0.4）里嵌套插件纤维从未激活（服务在场、回调不跑、无错误）；
 * 官方消费方 dsh-skill-badge 一律用静态 `const inject = ["skills"]`。接线已改为
 * 入口静态 inject + apply 内直接注册（见 src/index.ts 文件头）。不再保留
 * wireRuntimeSkillRegistration —— 死防御层与"永不执行的分支"同罪。
 */