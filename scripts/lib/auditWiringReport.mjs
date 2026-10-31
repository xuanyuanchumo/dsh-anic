/**
 * 接线审计的**报告投影层**（cycle-94 · 从 `audit-wiring.mjs` 拆出，守 ≤250 行纪律）。
 *
 * ## 为什么拆（职责，不是行数）
 *
 * `audit-wiring.mjs` 的正文回答的是「**怎么判定**」——扫描、倒排索引、死导出判据、
 * 幽灵路由对账、自检四腿。它们各自都值得被单独读懂，且判据一旦改动必须能被
 * 一次性审阅完。
 *
 * 本文件只回答「**判完之后怎么呈现**」——JSON 形态、人类可读摘要、退出码。
 * 这两件事的变更节奏完全不同：判据每轮都可能变（新增一种缺口形态），
 * 而呈现形态很稳定（加个字段而已）。
 *
 * ## 呈现层的三条纪律
 *
 * 1. **P0 必须逐条点名**：只给"共 2 条"的计数等于没说 —— 读者还得自己跑一遍 --json
 *    再解析。点名到 `名字 @ 文件` 才能让人当场定位。
 * 2. **P1 也逐条列出但不当场阻断**：它们是别域的债，本任务不该越权改；但**也不能藏**
 *    —— 藏起来等于"我们不认为它是问题"，那会让债在无声中累积。
 * 3. **自检状态永远打印**：`selfCheck` 三腿（孤儿抓到 / 孤儿清除 / 幽灵抓到）若任一
 *    为 false，脚本以 **exit 2** 结束（与"有 P0 断点"的 exit 1 区分）。
 *    两个非零码语义不同：1 = 发现了缺口，2 = 判定器本身坏了。
 *    **这个区分是整条纪律的关键** —— 若两者都返回 1，"0 条断点"就不可信了。
 *
 * ## 边界
 *
 * 纯投影（吃已算好的数据，不读盘、不再判定）。
 */

/** 一条死导出（名字 + 所在文件）。
 *  @typedef {{ name: string, file: string }} DeadExport */

/** 一条幽灵路由（客户端在取、宿主没注册）。
 *  @typedef {{ path: string, refs: string[] }} GhostRoute */

/** 一条未声明也未消费的路由。
 *  @typedef {{ id: string, at: string }} UndeclaredRoute */

/** 自检三腿。
 *  @typedef {{ orphanCaught: boolean, orphanCleared: boolean, ghostCaught: boolean }} SelfCheckResult */

/**
 * 构建报告对象（`--json` 的形态，也是人类摘要的唯一数据源）。
 *
 * 为什么不给人类摘要另算一遍：两份投影必然漂移（本仓教训：`windowedOut` 与
 * `foldedSummary` 就曾各算一份）。让摘要只做 `report` 的渲染，数字就不会分叉。
 *
 * @param {{
 *   auditedAt: string, scannedFiles: number, exportTotal: number,
 *   dead: DeadExport[], p0Dead: DeadExport[], p1Dead: DeadExport[],
 *   selfOnly: number, testOnly: number,
 *   routes: { registered: number, consumed: number, declaredChannel: number,
 *             unconsumedUndeclared: UndeclaredRoute[], ghostRoutes: GhostRoute[] },
 *   tools: { total: number, noConsumer: string[], channelOnly: string[] },
 *   selfCheck: SelfCheckResult,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildReport(input) {
  const p0 = input.routes.ghostRoutes.length
    + input.routes.unconsumedUndeclared.length
    + input.p0Dead.length;
  return {
    auditedAt: input.auditedAt,
    scannedFiles: input.scannedFiles,
    exports: {
      total: input.exportTotal,
      dead: input.dead.length,
      p0Dead: input.p0Dead,
      p1Dead: input.p1Dead,
      selfOnly: input.selfOnly,
      testOnly: input.testOnly,
    },
    routes: {
      registered: input.routes.registered,
      consumed: input.routes.consumed,
      declaredChannel: input.routes.declaredChannel,
      unconsumedUndeclared: input.routes.unconsumedUndeclared,
      ghostRoutes: input.routes.ghostRoutes,
    },
    tools: {
      total: input.tools.total,
      noConsumer: input.tools.noConsumer,
      channelOnly: input.tools.channelOnly,
    },
    selfCheck: input.selfCheck,
    p0,
  };
}

/**
 * 打印人类可读摘要（逐条点名，见文件头纪律 1/2）。
 *
 * @param write 输出函数（便于测试替换为收集器；缺省 process.stdout.write）
 */
export function printSummary(
  report,
  write = (s) => { process.stdout.write(s); },
) {
  const r = report;
  const line = (s) => { write(s + '\n'); };
  line('[audit-wiring] scanned ' + String(r.scannedFiles) + ' files, ' + String(r.exports.total) + ' exports');
  line('  exports   dead=' + String(r.exports.dead)
    + ' (P0本域 ' + String(r.exports.p0Dead.length) + ' / P1别域 ' + String(r.exports.p1Dead.length) + ')'
    + ' selfOnly=' + String(r.exports.selfOnly) + ' testOnly=' + String(r.exports.testOnly));
  line('  routes    registered=' + String(r.routes.registered) + ' consumed=' + String(r.routes.consumed)
    + ' declaredChannel=' + String(r.routes.declaredChannel)
    + ' 未声明未消费=' + String(r.routes.unconsumedUndeclared.length)
    + ' 幽灵路由=' + String(r.routes.ghostRoutes.length));
  line('  tools     total=' + String(r.tools.total) + ' 零消费=' + String(r.tools.noConsumer.length)
    + ' 仅通道=' + String(r.tools.channelOnly.length));
  for (const g of r.routes.ghostRoutes) line('    P0 幽灵路由 ' + g.path + ' ← ' + g.refs.join(', '));
  for (const u of r.routes.unconsumedUndeclared) line('    P0 未声明未消费 ' + u.id + ' @ ' + String(u.at));
  for (const j of r.exports.p0Dead) line('    P0 本域死导出 ' + j.name + ' @ ' + j.file);
  // P1 逐条列出（不当场阻断，但绝不隐藏 —— 见文件头纪律 2）。
  for (const j of r.exports.p1Dead) line('    P1 别域死导出 ' + j.name + ' @ ' + j.file);
  line('  selfCheck orphanCaught=' + String(r.selfCheck.orphanCaught)
    + ' orphanCleared=' + String(r.selfCheck.orphanCleared)
    + ' ghostCaught=' + String(r.selfCheck.ghostCaught));
  line('  P0 total = ' + String(r.p0));
}

/**
 * 决定退出码（**两个非零码语义不同**，见文件头纪律 3）。
 *
 * - `0`：无 P0 断点且自检通过；
 * - `1`：有 P0 断点（发现缺口）；
 * - `2`：自检失败（**判定器本身坏了，"0 条断点"不可信**）。
 */
export function exitCodeOf(p0, sc) {
  const selfCheckOk = sc.orphanCaught && sc.orphanCleared && sc.ghostCaught;
  if (!selfCheckOk) return 2;
  return p0 === 0 ? 0 : 1;
}
