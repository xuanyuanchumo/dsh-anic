// tasks.mjs — P0-P3 任务表行解析唯一实现（进化 iteration-4，修 N-1 的根因面）
// 背景：gate-check.mjs checkG1（v1.8.0 重写）与 archive-cycle.mjs isCycleComplete（v1.8.3 重写）
// 都要回答"这个 cycle 的任务是否全部完成"。原先 archive-cycle 用整文件 includes('待办')——
// 与 G1 修复前的自陷同族（模板图例"待办 → 进行中 → 完成"会让永远完不成的模板被判 in-progress）。
// 两处判定必须共享同一实现，否则"G1 说完成、归档说没完成"的分叉迟早出现。
//
// 任务行 = 以 | 开头、≥6 单元格、首列非空（排除模板占位行）、首列 ≠ '任务'（排除表头）、
// 末列是**已知状态值**（见 TASK_STATUS_VALUES）。图例/状态约定等说明文字不参与判定。
//
// cycle-72 修 G1「诚实即假 PASS」陷阱（archivist-round 实证，Lead 复核）：
//   原实现 TASK_STATUS_RE = /^(待办|进行中|完成)$/ 是**封闭白名单**，末列不在三值内的行
//   被 `continue` **静默丢弃**——即不进 G1 分母。后果：如实写「部分完成」的任务会让 G1
//   输出 `All N tasks completed`（假 PASS，方向是 fail-open）；而写合法值「进行中」反而放行不了。
//   越诚实越容易通过 = 与 skill 包自己的纪律「守卫必须是 ERROR，告警级守卫等于没有守卫」冲突。
//   修法：把已知中态/终态词**显式纳入分母**（非「完成」一律计 pending），
//   而不是把无法识别的状态值当噪声丢掉；真正的噪声（模板占位行、表头、图例）仍由
//   首列/单元格数/表头三条件排除。

export const TASK_STATUS_COMPLETE = '完成';

/** 已知状态值（正典来源）。新增状态词必须加在这里——否则该行会被静默丢弃。 */
export const TASK_STATUS_VALUES = [
  '待办',
  '进行中',
  '部分完成',
  '未完成',
  '未开始',
  '阻塞',
  TASK_STATUS_COMPLETE,
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const TASK_STATUS_RE = new RegExp(`^(${TASK_STATUS_VALUES.map(escapeRe).join('|')})$`);

export function parseTaskRows(content) {
  const rows = [];
  for (const line of String(content).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 6) continue;
    if (!cells[0] || cells[0].replace(/`/g, '').trim() === '') continue; // 模板占位行（首列空）
    if (cells[0] === '任务') continue; // 表头
    if (!TASK_STATUS_RE.test(cells[cells.length - 1])) continue;
    rows.push(cells);
  }
  return rows;
}

export function summarizeTaskRows(content) {
  const rows = parseTaskRows(content);
  const pending = rows.filter(cells => cells[cells.length - 1] !== TASK_STATUS_COMPLETE);
  return { total: rows.length, pendingCount: pending.length, allCompleted: rows.length > 0 && pending.length === 0 };
}
