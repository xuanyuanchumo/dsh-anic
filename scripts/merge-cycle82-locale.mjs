/**
 * cycle-82 locale 合并脚本（一次性工具，跑完即弃）。
 *
 * 为什么用「文本尾部插入」而不是 `JSON.parse → JSON.stringify`：
 *   `localeKeyAnchors` 按**行号**定位词表键，而 `closureEvidenceAnchorContract`
 *   钉死了 `trace.statusDone === 101` 这类真实行号。整文件重排一次，这些断言
 *   全部漂移（红线）。所以在最后一个 `}` 之前插入新命名空间，既有行号零变化。
 *
 * 为什么 zh/en 同源生成：两文件键集必须全等（i18nDeadKeyContract ④），
 * 两份手写必然漂移。文案表只写一次，两份输出。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const KEYS = {
  graph: {
    toolbarLabel: ['工作流图工具栏', 'Workflow graph toolbar'],
    searchPlaceholder: ['搜索节点（名称或 id）', 'Search nodes (label or id)'],
    searchLabel: ['搜索工作流节点', 'Search workflow nodes'],
    typeGroupLabel: ['按节点类型筛选', 'Filter by node type'],
    verdictLabel: ['按裁决筛选', 'Filter by verdict'],
    zoomIn: ['放大', 'Zoom in'],
    zoomOut: ['缩小', 'Zoom out'],
    zoomFit: ['适配视图', 'Fit to view'],
    zoomFitHint: ['让整张图回到视口内（也可双击图或按 0）', 'Fit the whole graph into the viewport (or double-click the graph / press 0)'],
    zoomReadout: ['当前缩放比例', 'Current zoom level'],
    adjacency: ['高亮邻居', 'Highlight neighbors'],
    adjacencyLabel: ['悬停或聚焦节点时高亮其一跳邻居', 'Highlight one-hop neighbors when hovering or focusing a node'],
    clearFilter: ['清空筛选', 'Clear filters'],
    keyHint: [
      '图区键盘操作：方向键在节点间移动，Home/End 跳到首尾，Enter 或空格打开详情，加号减号缩放，0 适配视图，Escape 清空筛选。滚轮缩放，拖拽平移，双击适配视图。',
      'Graph keyboard controls: arrow keys move between nodes, Home/End jump to first/last, Enter or Space opens details, plus/minus zoom, 0 fits to view, Escape clears filters. Wheel zooms, drag pans, double-click fits to view.',
    ],
    lane: {
      phase: ['阶段', 'Phase'],
      'micro-step': ['微步骤', 'Micro-step'],
      gate: ['门禁', 'Gate'],
      'human-gate': ['人工门', 'Human gate'],
      cycle: ['循环', 'Cycle'],
      'gate-event': ['门禁事件', 'Gate event'],
      incident: ['事故', 'Incident'],
      autonomy: ['自主级', 'Autonomy'],
    },
    verdict: {
      pass: ['通过', 'Pass'],
      fail: ['失败', 'Fail'],
      doubt: ['存疑', 'Doubt'],
      pending: ['待定', 'Pending'],
      skip: ['跳过', 'Skip'],
      none: ['未裁决', 'No verdict'],
    },
  },
  config: {
    title: ['配置与路径', 'Configuration & Paths'],
    ariaLabel: ['ANIC 配置编辑器', 'ANIC configuration editor'],
    hint: [
      '保存会原位改写 `.cycles/config.yml`：注释、空行与未知键原样保留；写后回读校验，不符自动回滚。',
      'Saving edits `.cycles/config.yml` in place: comments, blank lines and unknown keys are preserved; changes are re-read and rolled back on mismatch.',
    ],
    dirty: ['已修改', 'modified'],
    dirtyCount: ['待保存 {count} 项', '{count} pending'],
    save: ['保存', 'Save'],
    saving: ['保存中…', 'Saving…'],
    savedAt: ['已保存（{at}）', 'Saved ({at})'],
    preview: ['预览差异', 'Preview diff'],
    discard: ['放弃修改', 'Discard'],
    reset: ['还原', 'Reset'],
    resetOne: ['还原字段：{field}', 'Reset field: {field}'],
    previewSummary: ['预览：将改动 {count} 个字段（未写入磁盘）', 'Preview: {count} field(s) would change (nothing written)'],
    saveSummary: ['已写入 {count} 个字段', '{count} field(s) written'],
    saveFailed: ['保存失败：{error}', 'Save failed: {error}'],
    backupAt: ['备份：{path}', 'Backup: {path}'],
    group: {
      project: ['项目', 'Project'],
      commands: ['命令', 'Commands'],
      macro: ['宏观循环', 'Macro cycle'],
      anic: ['插件行为', 'Plugin behavior'],
    },
    field: {
      projectName: ['项目名', 'Project name'],
      techStack: ['技术栈（逗号分隔）', 'Tech stack (comma separated)'],
      buildCmd: ['构建命令', 'Build command'],
      typecheckCmd: ['类型检查命令', 'Typecheck command'],
      lintCmd: ['规范检查命令', 'Lint command'],
      testCmd: ['测试命令', 'Test command'],
      coverageCmd: ['覆盖率命令', 'Coverage command'],
      e2eCmd: ['端到端命令', 'E2E command'],
      hygieneCmd: ['卫生检查命令', 'Hygiene command'],
      autonomyLevel: ['自主级（L1–L4）', 'Autonomy level (L1–L4)'],
      complexityBudget: ['复杂度预算', 'Complexity budget'],
      allowedOrigins: ['允许来源（逗号分隔）', 'Allowed origins (comma separated)'],
      toolDisclosure: ['工具披露模式（full/indexed）', 'Tool disclosure (full/indexed)'],
    },
    path: {
      title: ['路径', 'Paths'],
      workspace: ['工作区', 'Workspace'],
      cycles: ['.cycles 目录', '.cycles directory'],
      config: ['配置文件', 'Config file'],
      ledger: ['门禁账本', 'Gate ledger'],
      workflowState: ['工作流状态', 'Workflow state'],
      flowTracker: ['流程跟踪', 'Flow tracker'],
      cyclesDocs: ['轮次文档', 'Cycle documents'],
      evals: ['评估报告', 'Evaluations'],
      techDebt: ['技术债', 'Tech debt'],
      incidents: ['事故记录', 'Incidents'],
      archive: ['归档', 'Archive'],
      skillInstalled: ['已装技能', 'Installed skill'],
      skillScripts: ['技能脚本目录', 'Skill scripts'],
      skillInline: ['内联技能', 'Inline skill'],
      pluginRoot: ['插件根', 'Plugin root'],
      dist: ['构建产物', 'Build output'],
      assets: ['随包资产', 'Bundled assets'],
      agents: ['Agent 卡', 'Agent cards'],
      artifacts: ['工作区工件', 'Workspace artifacts'],
      custom: ['自定义路径', 'Custom path'],
      meta: ['{bytes} · {mtime}', '{bytes} · {mtime}'],
      dir: ['目录', 'dir'],
      missing: ['不存在', 'missing'],
      unresolved: ['（无法解析）', '(unresolved)'],
      copy: ['复制', 'Copy'],
      copyLabel: ['复制路径：{label}', 'Copy path: {label}'],
      probeRejected: ['路径被拒：{reason}', 'Path rejected: {reason}'],
      probeAccepted: ['路径可用：{path}', 'Path accepted: {path}'],
    },
  },
};

/** 取第 idx 个语言（0=zh, 1=en）。 */
const pick = (v, idx) => {
  if (Array.isArray(v)) return v[idx];
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = pick(x, idx);
  return out;
};

/** 按 2 空格缩进序列化一个顶层键（不含外层大括号）。 */
function block(name, obj, idx) {
  const inner = JSON.stringify(pick(obj, idx), null, 2)
    .split('\n')
    // 顶层对象内部每行缩进 2，再整体右移 2 —— 与其他顶层键对齐。
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join(idx === 0 ? '\r\n' : '\n');
  return `  ${JSON.stringify(name)}: ${inner}`;
}

function merge(file, idx) {
  const raw = readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const parsed = JSON.parse(raw);
  const added = Object.keys(KEYS).filter((k) => !(k in parsed));
  const blocks = added.map((k) => block(k, KEYS[k], idx).replace(/\r?\n/g, eol));
  if (blocks.length === 0) {
    console.log(`${file}: nothing to add`);
    return;
  }
  // 在最后一个 `}` 之前插入：`…\n}` → `…,\n<blocks>\n}`
  const close = raw.lastIndexOf('}');
  const head = raw.slice(0, close).replace(/[\r\n]+$/, '');
  const out = `${head},${eol}${blocks.join(`,${eol}`)}${eol}}${eol}`;
  writeFileSync(file, out);
  // 写完必须能解析（否则整个客户端 i18n 崩）——立即回读校验。
  const check = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`${file}: added ${added.join(', ')}; keys=${Object.keys(check).length}`);
}

merge('locale/zh.json', 0);
merge('locale/en.json', 1);
