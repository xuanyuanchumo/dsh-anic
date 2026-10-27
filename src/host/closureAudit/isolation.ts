/**
 * 闭环体检**跨项目隔离判定**（cycle-82 可观测性收口）。
 *
 * ## 为什么需要它（用户诉求「不同项目互不污染」）
 *
 * ANIC 是"一个插件服务多个项目"的形态：同一份宿主进程里，`.cycles/` 数据来自
 * 用户选中的 workspace。只要**任何一处**读写路径不是从 workspace 根推导出来，
 * 就会出现两类真实事故：
 *   ① **串项目**：A 项目的门禁记录写进 B 项目的账本 / 面板读到隔壁项目的循环；
 *   ② **写坏插件自身**：路径兜底到 `process.cwd()`（宿主从仓库根启动时 = 插件自己），
 *      测试或工具调用直接把插件源码目录当成目标项目来写。
 * 两者都**不会让测试变红**——只有人某天发现"账本里多了别家的记录"。
 * 本模块把这条不变量做成**可机器断言的观测面**。
 *
 * ## 判定只看**路径来源**（刻意的窄口径）
 *
 * 判据只有一条：每条被声明为"项目内"的读写路径，必须能由 workspace 根 + 相对段
 * 推导出来，且推导结果仍在 workspace 内。具体三态：
 *   - `ok`：路径来自 `.cycles/…` 等**工作区相对**常量；
 *   - `escape`：含 `..` 逃逸或解析后落在 workspace 外（含另一盘符/另一绝对根）；
 *   - `cwd-fallback`：以 `process.cwd()` 兜底（"宿主恰好从目标项目启动"才对的假设）。
 * 另外扫描源码里的**硬编码绝对路径**（`C:\…` / `/home/…`）——那是"写死别的项目"。
 *
 * 为什么不做"文件内容里有没有别人的项目名"这类内容判定：那会产生大量假阳性
 * （文档举例、测试夹具、错误信息里的路径），把一个可信的守卫变成噪声源。
 * 路径来源是**唯一**能稳定判定的维度，也是事故的真实成因。
 *
 * ## 反向自检（本仓纪律）
 *
 * 判据必须能判两态：注入一个 workspace 外的绝对路径，`violations` 必须点名它
 * （见 tests/contract/isolationContract.test.ts）。只报"全绿"而不报"什么时候会红"
 * 的守卫等于没有守卫。
 *
 * 纯只读：不写工作区、不改源码（R-31）；无依赖、无 IO 副作用（除读源码文本）。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/*
 * ★cycle-82 T3 拆分：登记表 + 判据 + 源码扫描下移到 isolationScan.ts
 * （加入绝对路径泄漏面后本文件越界）。此处**再导出**保消费者 import 路径零变更。
 * 判决：本文件只留「编排」（把三块拼成一份报告）+ 投影（去绝对路径）。
 */
export type { IsolationItem, IsolationViolation } from './isolationScan.ts';
export {
  ABS_LITERAL_RE, WORKSPACE_PATHS, inWorkspace, judgePath, scanAbsoluteLiterals, sourceFiles,
} from './isolationScan.ts';
import type { IsolationItem, IsolationViolation } from './isolationScan.ts';
import { WORKSPACE_PATHS, inWorkspace, judgePath, scanAbsoluteLiterals, sourceFiles } from './isolationScan.ts';

export interface IsolationReport {
  /** 全部被观测路径都 ok、无绝对路径泄漏、且无死登记。 */
  ok: boolean;
  /** 被判定的工作区根（**服务端字段**，投影时去掉——绝对路径不出服务端）。 */
  workspace: string;
  items: IsolationItem[];
  /** 跨项目污染类违规（路径越界 / cwd 兜底 / 写死绝对路径）。 */
  violations: IsolationViolation[];
  /**
   * 死登记（登记表里有、源码里找不到任何读写锚点）。
   *
   * 与 `violations` **分开**：它不是"串项目"，而是"登记表漂移"（路径改名/删除后
   * 忘同步）。两类混排会让 ok=false 有两种无法区分的成因，读者无法据以行动。
   */
  dangling: string[];
  /** 判定覆盖的源码文件数（供"扫描集非空"断言）。 */
  scannedFiles: number;
}

/**
 * 在源码里找某条持久化路径的读写锚点（文件名/目录段出现在引号字面量行里）。
 *
 * 判据刻意宽（宁可多认一个锚点，也不漏真写入点）：这一族只回答"有没有人用这条路径"，
 * 路径**对不对**由 judgePath 判（两者分工，互不冒充）。
 */
function findAnchor(files: ReadonlyMap<string, string>, needle: string): string | null {
  for (const [rel, text] of files) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      if (!line.includes(needle)) continue;
      // 去掉纯注释行（注释里举例的路径不是读写点）。
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      return rel + ':' + String(i + 1);
    }
  }
  return null;
}

/**
 * 跨项目隔离判定（给定 workspace 逐项断言）。
 *
 * @param workspace  被检查的工作区根
 * @param pluginRoot 插件源码根（默认 = 本文件所在包；测试可注入夹具）
 * @throws 扫描集为空（零源码文件 / 零登记路径）—— 空集恒绿是假守卫。
 */
export function checkIsolation(workspace: string, pluginRoot: string): IsolationReport {
  const files = new Map<string, string>();
  const sources = sourceFiles(pluginRoot);
  for (const rel of sources) {
    try {
      files.set(rel, readFileSync(join(pluginRoot, rel), 'utf8'));
    } catch { /* 消失的文件 */ }
  }
  if (files.size === 0) {
    throw new Error('closure isolation: source scan empty (no src/host/**/*.ts under plugin root)');
  }
  if (WORKSPACE_PATHS.length === 0) {
    throw new Error('closure isolation: no registered workspace paths (guard is vacuous)');
  }

  const items: IsolationItem[] = [];
  const violations: IsolationViolation[] = [];
  const dangling: string[] = [];

  for (const { id, rel } of WORKSPACE_PATHS) {
    // 锚点 = 声明该路径的源码行；找不到锚点 ⇒ 死登记（不是串项目，但登记表已漂移）。
    const needle = rel.split('/').pop() as string;
    const evidence = findAnchor(files, needle);
    if (evidence === null) {
      dangling.push(id + ' → ' + rel);
      items.push({
        id, relPath: rel, evidence: '(none)',
        inWorkspace: inWorkspace(resolve(workspace), resolve(workspace, rel)),
        source: 'ok',
      });
      continue;
    }
    const judged = judgePath(workspace, rel, evidence);
    items.push({ ...judged, id });
    if (judged.source !== 'ok' || !judged.inWorkspace) {
      violations.push({
        kind: judged.source === 'cwd-fallback' ? 'cwd-fallback' : 'path-escape',
        target: id + ' → ' + rel,
        reason: '路径不在 workspace 内（解析后越界或含 ..）：' + evidence,
      });
    }
  }

  // 绝对路径泄漏也计入 violations（同一个"串项目"语义面），但来源是源码扫描。
  violations.push(...scanAbsoluteLiterals(pluginRoot));

  return { ok: violations.length === 0 && dangling.length === 0, workspace, items, violations, dangling, scannedFiles: files.size };
}

/** 投影用窄视图（**去 workspace 绝对路径**——服务端本地路径不出网）。 */
export interface IsolationView {
  ok: boolean;
  items: Array<{ id: string; relPath: string; inWorkspace: boolean; source: string; evidence: string }>;
  violations: IsolationViolation[];
  dangling: string[];
  scannedFiles: number;
}

/** 服务端报告 → 客户端投影。 */
export function toIsolationView(rep: IsolationReport): IsolationView {
  return {
    ok: rep.ok,
    items: rep.items.map((i) => ({
      id: i.id, relPath: i.relPath, inWorkspace: i.inWorkspace, source: i.source, evidence: i.evidence,
    })),
    violations: rep.violations.map((v) => ({ ...v })),
    dangling: [...rep.dangling],
    scannedFiles: rep.scannedFiles,
  };
}
