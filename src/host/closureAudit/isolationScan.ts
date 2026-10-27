/**
 * 跨项目隔离判定的**扫描原语与登记表**（cycle-82：isolation.ts 拆分之一）。
 *
 * 从 isolation.ts 下移——该文件承载「登记表 + 判据 + 源码扫描 + 编排 + 投影」五职责，
 * 加入绝对路径泄漏面后越界（>250 行）。本文件只放**单一真相源的数据与纯判据**，
 * 不含编排、不含投影。
 *
 * 消费者 import 路径零变更：isolation.ts 再导出本文件的全部公开名。
 *
 * 为什么判据要独立成纯函数：契约测试必须能**直接喂一个 workspace 外的绝对路径**
 * 看它是否被点名（反向自检）。藏在编排函数里的判据只能靠构造整个仓库来测，
 * 那样的守卫写不出「两态都有」的断言。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** 一条被观测的项目内路径。 */
export interface IsolationItem {
  /** 稳定 id（`ledger` / `flow-tracker` …；面板与断言用）。 */
  id: string;
  /** 判定为"项目内"时的 workspace 相对路径（`/` 分隔）。 */
  relPath: string;
  /** 读取/写入它的源码锚点（file:line）。 */
  evidence: string;
  /** 该路径是否确实落在 workspace 内（解析后判定，不信字面量）。 */
  inWorkspace: boolean;
  /**
   * 路径来源判定（**本模块的核心读数**）：
   *   ok            来自工作区相对常量；
   *   escape        含 `..` 逃逸 / 解析后在工作区外；
   *   cwd-fallback  以 process.cwd() 兜底（"宿主恰好从目标项目启动"才对的假设）。
   */
  source: 'ok' | 'escape' | 'cwd-fallback';
}

/** 违规项（机器可判，面板据此分组）。 */
export interface IsolationViolation {
  /**
   * 违规类别 —— **只含跨项目污染类**。
   *
   * 刻意**不含**「登记了但没人用」：那是"死登记"，不是串项目。
   * 两类混在一个数组里会让 `ok=false` 有两种截然不同的原因，读者无法据以行动
   * （一个要修路径来源，一个要删/接登记），故死登记单列 `dangling`。
   */
  kind: 'path-escape' | 'cwd-fallback' | 'absolute-literal';
  /** 涉及的路径或源码位置。 */
  target: string;
  /** 人读理由（为什么这是问题）。 */
  reason: string;
}

/**
 * 被观测的**项目内状态路径**清单（单一真相源）。
 *
 * 这些是 ANIC 真正的持久化面：账本、状态机、流程追踪、配置、技术债、门禁、
 * 评估、流程记录、带历史、自主级历史、热重载历史、自举记录。
 * 新增持久化点必须在此登记 —— 漏登记的面不会被任何断言看见（本仓反复踩的形态）。
 */
export const WORKSPACE_PATHS: ReadonlyArray<{ id: string; rel: string }> = [
  { id: 'ledger', rel: '.cycles/gates/ledger.json' },
  { id: 'workflow-state', rel: '.cycles/workflow-state.json' },
  { id: 'flow-tracker', rel: '.cycles/flow-tracker.json' },
  { id: 'config', rel: '.cycles/config.yml' },
  { id: 'tech-debt', rel: '.cycles/tech-debt' },
  { id: 'gates', rel: '.cycles/gates' },
  { id: 'evals', rel: '.cycles/evals' },
  { id: 'flows', rel: '.cycles/flows' },
  { id: 'band-history', rel: '.cycles/band-history.json' },
  { id: 'autonomy-history', rel: '.cycles/autonomy-history.json' },
  { id: 'reload-history', rel: '.cycles/reload-history.json' },
  { id: 'self-bootstrap', rel: '.cycles/self-bootstrap.json' },
];

/**
 * 源码扫描面 = `src/host/` 的**递归全量**（cycle-82 修：原实现是硬编码五个目录、
 * 且 `readdirSync` 不递归 ⇒ 只扫到 `src/host/*.ts` 一层）。
 *
 * 被修的失明形态（本轮真机实测）：`configEdit/paths.ts` 里**有** `.cycles/evals` 的
 * 读取锚点，但 `src/host/configEdit/` 不在旧目录表里 ⇒ 该锚点不可见 ⇒ `evals` 被判
 * 「死登记」。更严重的是同一失明也作用于 `absolute-literal` 扫描：新增子目录里的
 * 写死绝对路径不会被报。
 *
 * 为什么改成目录驱动而不是补一条 `'src/host/configEdit'`：补目录是同一错误的第 N 次
 * 重复（新增子目录又漏）。判据只该依赖"源码在 src/host 下"，不依赖"哪几个子目录曾经存在"。
 */
const SOURCE_ROOT = 'src/host';

/**
 * 硬编码绝对路径形态：Windows 盘符 / POSIX 家目录与常见根。
 *
 * 只认**引号字面量里**的形态：`'C:\…'` / `"/home/…"`。裸注释（本仓大量"实测踩坑"
 * 注释里带真实路径）不算泄漏 —— 见 scanAbsoluteLiterals 的注释行过滤。
 */
export const ABS_LITERAL_RE = /['"`]((?:[A-Za-z]:[\\/])|(?:[\\/](?:home|Users|root|var|opt|tmp)[\\/]))/;

/** 目录项（读失败 → 空，不抛）。 */
function ls(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** 收集源码文件（相对插件根、/ 分隔）——递归，相对路径用 `/` 便于锚点显示。 */
export function sourceFiles(pluginRoot: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const name of ls(join(pluginRoot, rel))) {
      const childRel = rel + '/' + name;
      // 目录判定：再 ls 一次能读出内容即目录（避免 statSync 对消失文件抛错）。
      const grand = ls(join(pluginRoot, childRel));
      if (grand.length > 0 || name.indexOf('.') < 0) { walk(childRel); continue; }
      if (name.endsWith('.ts')) out.push(childRel);
    }
  };
  walk(SOURCE_ROOT);
  return out;
}

/**
 * 路径是否落在 workspace 内（**解析后**判定，不信字面量）。
 *
 * 用 `relative()` 而不是 `startsWith()`：后者会把 `/a/proj-evil` 判成在 `/a/proj` 内
 * （前缀碰撞）；`relative` 给出 `../proj-evil` ⇒ 逃逸。跨盘符时 relative 返回绝对
 * 路径（以盘符/斜杠起头）⇒ 也是逃逸。
 */
export function inWorkspace(workspace: string, candidate: string): boolean {
  const rel = relative(resolve(workspace), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 判定**单条路径**的来源与归属（核心判据，纯函数 —— 反向自检直接喂它）。
 *
 * 先判 `..` 字面量再判解析结果：一个靠"深度正好够"才不越界的路径，下次挪目录就炸，
 * 即便当下解析结果仍在工作区内也应报 escape（脆弱写法 = 未来的事故）。
 */
export function judgePath(workspace: string, relPath: string, evidence: string): IsolationItem {
  const base = resolve(workspace);
  const hasDotDot = relPath.split(/[\\/]/).includes('..');
  const resolved = isAbsolute(relPath) ? resolve(relPath) : resolve(base, relPath);
  const inside = inWorkspace(base, resolved);
  if (hasDotDot) return { id: '', relPath, inWorkspace: false, evidence, source: 'escape' };
  return { id: '', relPath, inWorkspace: inside, evidence, source: inside ? 'ok' : 'escape' };
}

/**
 * 源码里的**绝对路径泄漏**扫描（"写死别的项目"形态）。
 *
 * 与 checkIsolation 分开：前者判"声明的工作区路径对不对"，本函数判"源码里有没有
 * 直接写死的绝对路径"。两类缺一都漏：一个正确使用 `.cycles` 的模块仍可能在别处
 * 写死 `C:\Projects\other\…`。
 */
export function scanAbsoluteLiterals(pluginRoot: string): IsolationViolation[] {
  const out: IsolationViolation[] = [];
  for (const rel of sourceFiles(pluginRoot)) {
    let text = '';
    try {
      text = readFileSync(join(pluginRoot, rel), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      const trimmed = line.trim();
      // 注释里举的例子（含本仓的"实测踩坑"注释）不是泄漏 —— 只认代码行。
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (ABS_LITERAL_RE.test(line)) {
        out.push({
          kind: 'absolute-literal',
          target: rel + ':' + String(i + 1),
          reason: '源码里写死绝对路径（跨项目复用时会指向本机这一台/这一个项目）',
        });
      }
    }
  }
  return out;
}
