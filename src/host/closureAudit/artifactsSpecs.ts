/**
 * 闭环体检第五族（.cycles 文档生命周期）的**规格表**（cycle-82 T3 ≤250 行拆分）。
 *
 * 从 artifactsClosure.ts 下移——该文件承载「规格表 + 扫描 + 投影」三职责，加入
 * 逐循环矩阵后越界。本文件只放**声明式的映射表与形状**，不含任何文件遍历。
 *
 * 消费者 import 路径零变更：artifactsClosure.ts 再导出本文件的全部公开名。
 *
 * ## 为什么映射表必须独立成「声明」而不是散在扫描逻辑里
 *
 * 模板 → 产物名 → 存放路径 这三段是**规范**（正典在
 * `assets/skill/references/gates.md`「产物类型与命名规范」），不是实现细节。
 * 一旦它和扫描代码缠在一起，"加一个模板"就要读懂递归；写成表之后，
 * 加模板 = 加一行，而契约测试能直接对表与真实文件系统交叉验证。
 */
import { join } from 'node:path';

/** 模板的作用域：决定"缺失"该怎么读。 */
export type ArtifactScope =
  /** 每个 cycle-N 目录都应有（缺失 = 该循环不完整）。 */
  | 'cycle'
  /** 项目级单份在 .cycles/ 下或仓库根（不进 cycle-N）。 */
  | 'project'
  /** 按需触发（事故/复盘：零发生就没有，不算缺失）。 */
  | 'ondemand';

/** 一个模板的生命周期规格（单一真相源：加模板只改这张表）。 */
export interface TemplateSpec {
  /** 模板文件名（`assets/skill/assets/templates/<template>`）。 */
  template: string;
  /** 稳定 id（面板与断言用）。 */
  id: string;
  /**
   * 产出判据（相对 `cycle-N/` 或相对仓库根，随 scope 定）：
   *   - 精确子路径（`任务清单.md`）→ 文件存在即产出；
   *   - 目录前缀（`test-reports/`）→ 目录内**至少一个 .md** 才算产出
   *     （空目录不算：init-cycle 会先建空目录，把空目录算成产出正是最常见的假绿）。
   */
  pattern: string;
  scope: ArtifactScope;
  /** 归属门禁 / 质量维度（回答"这份文档缺失会红哪道门"）。 */
  gate: string;
  /** 中文名（面板展示；不引 locale 以保持本模块零依赖可测）。 */
  label: string;
}

/** 模板目录（相对插件根）。 */
export const TEMPLATE_DIR_REL = 'assets/skill/assets/templates';

/**
 * 15 类模板的生命周期规格。
 *
 * 映射来源是正典 `assets/skill/references/gates.md`「产物类型与命名规范」表的
 * 机器可读投影 —— 契约测试用真实文件系统交叉验证两边一致（表漂移即红）。
 *
 * 注意 `test-report` 的 `pattern` 是**目录**不是文件名：正典命名是带时间戳的
 * `test-report_YYYYMMDD_HHMMSS.md`，等名比对会把真实产出全判成缺失
 * （这是本表唯一一处必须用通配的原因，其余都是精确名）。
 */
export const TEMPLATE_SPECS: readonly TemplateSpec[] = [
  { template: 'intent.md', id: 'intent', pattern: join('.cycles', 'intent', 'intent.md'), scope: 'project', gate: 'H0(意图接受)', label: '意图' },
  { template: 'spec.md', id: 'spec', pattern: join('.cycles', 'intent', 'spec.md'), scope: 'project', gate: 'G0/E2(规格符合)', label: '规格' },
  { template: 'plan.md', id: 'plan', pattern: join('.cycles', 'intent', 'plan.md'), scope: 'project', gate: 'G0/E2(规格符合)', label: '计划' },
  { template: 'eval-report.md', id: 'eval-report', pattern: '项目评估报告.md', scope: 'cycle', gate: 'G0(评估收敛)', label: '项目评估报告' },
  { template: 'cycle-plan.md', id: 'cycle-plan', pattern: '当前循环总规划.md', scope: 'cycle', gate: 'G1(任务收敛)', label: '当前循环总规划' },
  { template: 'task-list.md', id: 'task-list', pattern: '任务清单.md', scope: 'cycle', gate: 'G1(任务收敛)', label: '任务清单' },
  { template: 'page-state.md', id: 'page-state', pattern: '当前循环页面状态.md', scope: 'cycle', gate: 'G1(任务收敛)', label: '当前循环页面状态' },
  { template: 'test-report.md', id: 'test-report', pattern: 'test-reports/', scope: 'cycle', gate: 'G2(测试收敛)', label: '测试报告' },
  { template: 'non-functional-report.md', id: 'non-functional-report', pattern: '非功能验证报告.md', scope: 'cycle', gate: 'G2/Q3(非功能)', label: '非功能验证报告' },
  { template: 'delivery-checklist.md', id: 'delivery-checklist', pattern: '交付清单.md', scope: 'cycle', gate: 'Q8(交付完整)', label: '交付清单' },
  { template: 'audit-log.md', id: 'audit-log', pattern: '审计日志.md', scope: 'cycle', gate: 'H3(Release 交付闸)', label: '审计日志' },
  { template: 'incident.md', id: 'incident', pattern: join('.cycles', 'incidents'), scope: 'ondemand', gate: '熔断(CB1/CB2)', label: '事故记录' },
  { template: 'retrospective.md', id: 'retrospective', pattern: join('.cycles', 'retrospectives'), scope: 'ondemand', gate: 'H4(门禁仲裁)', label: '复盘报告' },
  { template: 'review.md', id: 'review', pattern: join('.cycles', 'REVIEW.md'), scope: 'project', gate: 'R11(评审须有证据)', label: '评审标准' },
  { template: 'PULL_REQUEST_TEMPLATE.md', id: 'pull-request-template', pattern: join('.github', 'PULL_REQUEST_TEMPLATE.md'), scope: 'project', gate: 'H2(破坏性操作)', label: 'PR 模板' },
];

/** 单个循环矩阵的一行：这个模板在该循环**存在与否**。 */
export interface CyclePresence {
  cycle: string;
  present: boolean;
  /** 命中的相对路径（present 时给出证据；缺失为空）。 */
  evidence: string[];
}

/** 一个模板的完整生命周期记录（注册 / 生产 / 消费 + 缺失点名）。 */
export interface ArtifactLifecycle {
  id: string;
  template: string;
  label: string;
  gate: string;
  scope: ArtifactScope;
  /** ① 模板已注册（模板文件在 templates 目录里）。 */
  registered: boolean;
  /** ③ 有消费者（技能脚本写/读 或 宿主代码读）。 */
  consumed: boolean;
  /** ③ 的逐条证据（file:line）。 */
  consumedEvidence: string[];
  /** ② 项目级模板：仓库根是否存在（cycle 级为 null——见 cycles 矩阵）。 */
  projectPresent: boolean | null;
  /** ② 按需类模板：累计发生次数（0 = 从未触发；**不是**缺失）。 */
  occurrences: number | null;
  /** ② 逐循环矩阵（cycle 级才有；其余为空数组）。 */
  cycles: CyclePresence[];
  /** 缺失点名（`cycle-81/交付清单.md` 形态）——可直接当待办清单。 */
  missing: string[];
  /** 该模板在已扫描循环里的覆盖率（present 数 / 循环数；无矩阵时为 null）。 */
  coverage: number | null;
}

/** 第五族的服务端汇总。 */
export interface ArtifactsReport {
  /** 扫描的循环目录名（排序后；供"矩阵对了几行"的断言）。 */
  cyclesScanned: string[];
  templatesScanned: string[];
  items: ArtifactLifecycle[];
  /** 汇总：模板数 / 已注册 / 有消费者 / 缺失点名总数 / 空矩阵数。 */
  totals: { templates: number; registered: number; consumed: number; missing: number; uncovered: number };
}
