/**
 * 闭环体检**第五族：.cycles 文档生命周期**（cycle-82 可观测性收口）。
 *
 * ## 为什么需要这一族（用户诉求「.cycles 各文档的生命周期」）
 *
 * 前四族（tools/i18n/routes/skills）回答的是"代码里的资产有没有人读"。
 * 而 ANIC 的**真实交付物**是 `.cycles/` 下的文档：谁在生产它们、哪个门禁依赖它们、
 * 第 N 个循环有没有真的写出来。这一面此前零覆盖，于是：
 *   - 模板躺在 `assets/skill/assets/templates/` 里，**没人知道哪个循环真的用了它**；
 *   - 门禁（G0-G3/Q 系列）读某份文档，但"读的那份在不在"只能等门禁判 FAIL 才知道；
 *   - 面板显示"产物齐全"时，读者无法自己核对是**哪份**缺了。
 *
 * ## 三态 × 逐循环矩阵（不是一句"有/没有"）
 *
 * 每个模板一条记录，三个独立事实：
 *   ① **registered**：模板文件在 templates 目录里（只读扫描）；
 *   ② **produced**：每个 `cycle-N` 是否真的产出了对应产物 —— **逐循环逐模板**的布尔，
 *      缺失能点名到 `cycle-81/交付清单.md`，而不是"本循环不完整"这种无法行动的结论；
 *   ③ **consumed**：谁读它 —— 技能脚本（`assets/skill/scripts/*.mjs`）或宿主源码
 *      （`src/host/**`）。没有消费者的模板是"写了没人读"的缺口。
 *
 * 每个模板还带 **gate**（归属门禁）—— 回答"这份文档缺失会红哪道门"。
 *
 * ## 诚实口径（必须显性标注，防读者误读）
 *
 *   - **不是每个模板都该出现在每个循环**：`intent/spec/plan/review/PR` 是项目级，
 *     `incident/retrospective` 是按需触发（零事故的循环本来就没有 incident，
 *     把它算成"缺失"会让每个健康循环都背一条假待办）。故规格带 `scope`：
 *     `cycle` 进矩阵并点名缺失；`ondemand` 只报累计发生次数；`project` 只判单份存在。
 *   - **缺失是线索不是判决**：历史循环（cycle-1..70）在模板体系定型前产出，
 *     它们缺 `交付清单.md` 不等于缺陷。矩阵如实报事实，处置动作看 `gate` 归属。
 *   - **空目录不算产出**：`test-reports/` 存在但零 .md ⇒ 未产出（init-cycle 会先建
 *     空目录，把空目录算成产出正是最常见的假绿）。
 *
 * ## 纪律
 *
 * 纯只读扫描（R-31）；**空扫描集响亮抛错**（空集恒绿 = 假守卫）；
 * 去注释后判定（注释里举的路径示例不是消费点）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ArtifactLifecycle, ArtifactScope, ArtifactsReport, CyclePresence, TemplateSpec,
} from './artifactsSpecs.ts';
import { TEMPLATE_DIR_REL, TEMPLATE_SPECS } from './artifactsSpecs.ts';

// 拆分后保消费者 import 路径零变更（规格表与形状下移到 artifactsSpecs.ts）。
export type {
  ArtifactLifecycle, ArtifactScope, ArtifactsReport, CyclePresence, TemplateSpec,
} from './artifactsSpecs.ts';
export { TEMPLATE_DIR_REL, TEMPLATE_SPECS } from './artifactsSpecs.ts';

/** 目录项列表（不存在/无权限 → 空数组；"不存在"由上层判定，不在此抛）。 */
function ls(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** 文件/目录是否存在。 */
function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 生产判定（`pattern` 语义见 artifactsSpecs.TemplateSpec.pattern）。
 *
 * 目录前缀分支要求**至少一个 .md**：空目录是脚手架残留（init-cycle 先建目录再写），
 * 把它算成产出会让"G2 通过"与"真有测试报告"脱钩 —— 那是本仓踩过的形态。
 */
function hit(cycleDir: string, pattern: string): string[] {
  if (pattern.endsWith('/')) {
    const files = ls(join(cycleDir, pattern)).filter((f) => f.endsWith('.md'));
    return files.length === 0 ? [] : files.slice(0, 3).map((f) => pattern + f);
  }
  return exists(join(cycleDir, pattern)) ? [pattern] : [];
}

/** 消费判定面：技能脚本（含 lib）+ 宿主源码（host 根与 routes）。 */
function consumerFiles(root: string): string[] {
  const out: string[] = [];
  const push = (dir: string, prefix: string): void => {
    for (const rel of ls(dir)) if (rel.endsWith('.mjs')) out.push(prefix + rel);
  };
  push(join(root, 'assets', 'skill', 'scripts'), 'assets/skill/scripts/');
  push(join(root, 'assets', 'skill', 'scripts', 'lib'), 'assets/skill/scripts/lib/');
  const pushTs = (dir: string, prefix: string): void => {
    for (const rel of ls(dir)) if (rel.endsWith('.ts')) out.push(prefix + rel);
  };
  pushTs(join(root, 'src', 'host'), 'src/host/');
  pushTs(join(root, 'src', 'host', 'routes'), 'src/host/routes/');
  return out;
}

/**
 * 去注释（保留换行 ⇒ 行号与磁盘一致）。
 *
 * 为什么必须去：本仓大量在注释里举路径示例（`// 写到 cycle-N/任务清单.md`），
 * 那些示例不是"读取点"。此处**不复用** scanPrimitives 的实现——本模块要能在
 * 任意 root 下独立跑（契约测试会喂临时夹具根），不依赖仓内扫描器。
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1);
}

/**
 * 消费证据：在消费者文件里找该**产物名/目录名**的出现行（去掉注释后）。
 *
 * 判据刻意宽（产物名出现在任一脚本的非注释行即算消费）：这一族回答的是
 * "有没有代码在处理它"，不是"处理得对不对"（后者是门禁的职责）。
 */
function findConsumers(root: string, spec: TemplateSpec, files: readonly string[]): string[] {
  // 产物名优先（cycle 内的真实文件名）；目录型去掉末尾斜杠与 .cycles/ 前缀。
  const needle = spec.pattern.endsWith('/')
    ? spec.pattern.slice(0, -1)
    : spec.pattern.replace(/^\.cycles[\\/]/, '');
  const hits: string[] = [];
  for (const rel of files) {
    let text = '';
    try {
      text = stripComments(readFileSync(join(root, rel), 'utf8'));
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if ((lines[i] as string).includes(needle)) {
        hits.push(rel + ':' + String(i + 1));
        break;
      }
    }
    if (hits.length >= 3) break;
  }
  return hits;
}

/** 扫描 `.cycles` 的逐循环矩阵与项目级存在性（第五族的本体）。 */
export function scanArtifacts(rootDir: string): ArtifactsReport {
  const templates = ls(join(rootDir, TEMPLATE_DIR_REL)).filter((f) => f.endsWith('.md'));
  if (templates.length === 0) {
    // 响亮失败：模板目录读空 ⇒ 全部 registered=false，面板会显示"15 个模板全缺"，
    // 而真相可能是路径算错或磁盘不可读。静默全红比报错更容易被误读成"该修业务"。
    throw new Error('closure artifacts: template scan empty (' + TEMPLATE_DIR_REL + ')');
  }
  const cyclesRoot = join(rootDir, '.cycles', 'cycles');
  const archiveRoot = join(rootDir, '.cycles', 'archive');
  let cyclesScanned = ls(cyclesRoot).filter((d) => /^cycle-\d+$/.test(d));
  let scannedFromArchive = false;
  if (cyclesScanned.length === 0) {
    // cycle-101 修「归档后崩溃」：全部循环归档后活跃区**合法为空**（archive-cycle 的
    // 正常收口状态），不是扫描故障。旧实现一律 throw ⇒ 归档即触发闭环体检崩溃
    // （真机实测 isolationContract 4 红，错误信息却是「cycle scan empty」——
    // 把合法状态报成故障，正是本仓反复出现的「把没有当错误」族缺陷）。
    // 修法：活跃区空 → 回退归档区；归档也空 → 才 throw（此时确实一处证据都没有）。
    cyclesScanned = ls(archiveRoot).filter((d) => /^cycle-\d+$/.test(d));
    scannedFromArchive = cyclesScanned.length > 0;
  }
  if (cyclesScanned.length === 0) {
    throw new Error('closure artifacts: no cycle dirs in either .cycles/cycles or .cycles/archive');
  }
  const consumers = consumerFiles(rootDir);
  if (consumers.length === 0) {
    throw new Error('closure artifacts: consumer scan empty (no skill scripts / host sources)');
  }

  const items: ArtifactLifecycle[] = TEMPLATE_SPECS.map((spec) => {
    const registered = templates.includes(spec.template);
    const consumedEvidence = findConsumers(rootDir, spec, consumers);
    const missing: string[] = [];
    let projectPresent: boolean | null = null;
    let occurrences: number | null = null;
    let cycles: CyclePresence[] = [];

    if (spec.scope === 'project') {
      projectPresent = exists(join(rootDir, spec.pattern));
      if (!projectPresent) missing.push(spec.pattern);
    } else if (spec.scope === 'ondemand') {
      // 按需类：累计发生次数（.cycles/<dir>/*.md 的条数）。0 次 = 从未触发，
      // **不是**缺失 —— 零事故的循环没有 incident 是健康的。
      const dir = join(rootDir, spec.pattern);
      occurrences = ls(dir).filter((f) => f.endsWith('.md')).length;
    } else {
      // 扫描根跟随实际找到循环的那一侧（活跃区优先；活跃区空则归档区）
      const cycleBase = scannedFromArchive ? archiveRoot : cyclesRoot;
      cycles = cyclesScanned.map((name) => {
        const ev = hit(join(cycleBase, name), spec.pattern);
        // ★点名到 cycle-N/文件名（用户要求：缺失要能被点名，而不是"某循环不完整"）
        if (ev.length === 0) missing.push(name + '/' + spec.pattern);
        return { cycle: name, present: ev.length > 0, evidence: ev };
      });
    }

    const coverage = cycles.length === 0
      ? null
      : cycles.filter((c) => c.present).length / cycles.length;

    return {
      id: spec.id, template: spec.template, label: spec.label, gate: spec.gate,
      scope: spec.scope, registered, consumed: consumedEvidence.length > 0,
      consumedEvidence, projectPresent, occurrences, cycles, missing, coverage,
    };
  });

  return {
    cyclesScanned,
    templatesScanned: templates,
    items,
    totals: {
      templates: items.length,
      registered: items.filter((i) => i.registered).length,
      consumed: items.filter((i) => i.consumed).length,
      missing: items.reduce((n, it) => n + it.missing.length, 0),
      // 「没有矩阵的模板」= cycle 级却一个循环都没评上（规格写错的信号）。
      uncovered: items.filter((i) => i.scope === 'cycle' && i.cycles.length === 0).length,
    },
  };
}

// 投影下移到 artifactsView.ts（cycle-82 拆分：本文件守 T3 ≤250 行）。
// **再导出**保消费者 import 路径零变更（registryClosure / 客户端 / 契约测试）。
export type { ArtifactsView } from './artifactsView.ts';
export { ARTIFACTS_VIEW_CYCLES, toArtifactsView } from './artifactsView.ts';
