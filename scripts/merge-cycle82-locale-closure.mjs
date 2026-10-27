/**
 * cycle-82 locale 合并（第二批：closure.artifacts / closure.isolation）。
 *
 * 为什么单独一个脚本、而不是改 `merge-cycle82-locale.mjs`：
 *   第一批已经把 `graph` / `config` 两个**顶层**命名空间追加到文件尾；本批是往
 *   **既有** `closure` 对象里插入两个子命名空间。两种插入点、两种缩进，混在一个
 *   脚本里会让"插在哪"变成隐式约定——分开写，各自把插入规则写死在注释里。
 *
 * 为什么用「行定位 + 文本插入」而不 JSON 往返：
 *   `localeKeyAnchors` 按行号定位词表键，`closureEvidenceAnchorContract` 钉死了
 *   `trace.statusDone === 101` / `gate.pending === 228` 这类真实行号。JSON 往返会
 *   重排整个文件 ⇒ 这些断言全部漂移。本脚本**只在 `closure` 的闭合行之前插入**，
 *   插入点之前的行号逐个不变。
 *
 * 幂等：`closure.artifacts` 已存在则跳过。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const NEW = {
  artifacts: {
    title: [
      '.cycles 文档生命周期（第五族）：模板 {reg}/{total} 已注册，{cons} 个有消费者',
      '.cycles document lifecycle (5th cluster): {reg}/{total} templates registered, {cons} consumed',
    ],
    window: [
      '矩阵窗口：最近 {n} 个循环（更早的是历史，不逐条列）',
      'Matrix window: last {n} cycles (older ones are history, not listed)',
    ],
    missingTotal: ['缺失点名 {n} 条（按 cycle-N/文件 可逐条核对）', '{n} missing, named by cycle-N/file'],
    noneMissing: ['零缺失——本窗口内每个循环的该模板都在', 'None missing in this window'],
    coverage: ['覆盖 {pct}%', '{pct}% covered'],
    present: ['项目级：已就位', 'Project-level: present'],
    absent: ['项目级：缺失', 'Project-level: absent'],
    occurrences: ['按需触发：累计 {n} 次（0 次是健康的）', 'On-demand: {n} occurrences (0 is healthy)'],
    moreMissing: ['（还有 {n} 条）', '(+{n} more)'],
    scopeCycle: ['每循环应有', 'per-cycle'],
    scopeProject: ['项目级单份', 'project-level'],
    scopeOnDemand: ['按需触发', 'on-demand'],
    hint: [
      '判定口径：方格 = 该循环该模板是否存在（右新左旧）；只有「每循环应有」类点名缺失。事故/复盘零发生不算缺失。',
      'Legend: a square = whether that template exists in that cycle (oldest to newest). Only per-cycle templates are named as missing; zero incidents/retrospectives is healthy.',
    ],
  },
  isolation: {
    ok: [
      '跨项目隔离：{n} 条持久化路径全部落在工作区内（零越界 / 零 cwd 兜底）',
      'Cross-project isolation: all {n} persistence paths stay inside the workspace',
    ],
    broken: [
      '跨项目隔离未通过：{v} 条污染违规 / {d} 条死登记——先修这里，再看下面任何数字',
      'Cross-project isolation FAILED: {v} contamination violations / {d} dangling entries — fix this before trusting any number below',
    ],
    scanned: ['扫描源码 {n} 个文件', '{n} source files scanned'],
    dangling: ['死登记（登记表有、源码无锚点）：{list}', 'Dangling registrations (registered but no source anchor): {list}'],
    moreViolations: ['（还有 {n} 条违规未列出）', '(+{n} more violations not listed)'],
    hint: [
      '判定只看路径来源：每条读写路径必须能由 workspace 根 + 相对段推导出来。.. 逃逸 / process.cwd() 兜底 / 写死绝对路径都会被点名。',
      'Judgement reads path provenance only: every read/write path must derive from the workspace root. .. escapes, process.cwd() fallbacks and hardcoded absolute paths are all flagged.',
    ],
    kind: {
      escape: ['路径越界', 'path escape'],
      cwdFallback: ['cwd 兜底', 'cwd fallback'],
      absolute: ['写死绝对路径', 'hardcoded absolute path'],
    },
  },
};

const pick = (v, idx) => {
  if (Array.isArray(v)) return v[idx];
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = pick(x, idx);
  return out;
};

/** 把一个对象渲染成 `    "name": {...}` 形式的多行文本块（每条内部行右移 4）。 */
function blockOf(name, obj) {
  const json = JSON.stringify(obj, null, 2).split('\n');
  const indented = json.map((l) => '    ' + l);
  // 首行 `    {` → `    "name": {`（其余行已经是正确缩进）。
  indented[0] = `    ${JSON.stringify(name)}: {`;
  return indented;
}

function merge(file, idx) {
  const raw = readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.closure && parsed.closure.artifacts) {
    console.log(`${file}: closure.artifacts already present, skip`);
    return;
  }
  const lines = raw.split('\n');
  const startIdx = lines.findIndex((l) => l.trim().startsWith('"closure": {'));
  if (startIdx < 0) throw new Error(`${file}: closure section not found`);
  let closeIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].replace(/\r$/, '') === '  },') { closeIdx = i; break; }
  }
  if (closeIdx < 0) throw new Error(`${file}: closure close brace not found`);

  // 既有最后一条子键行尾补逗号（原本末项以 `    }` 收尾）。
  let lastKeyIdx = closeIdx - 1;
  while (lastKeyIdx > startIdx && lines[lastKeyIdx].trim() === '') lastKeyIdx -= 1;
  const crlf = raw.includes('\r\n');
  const eol = crlf ? '\r' : '';
  const artifactsLines = blockOf('artifacts', pick(NEW.artifacts, idx));
  const isolationLines = blockOf('isolation', pick(NEW.isolation, idx));
  // 两个新子对象之间需要逗号：artifacts 的末行 `    }` 补 `,`。
  artifactsLines[artifactsLines.length - 1] = artifactsLines[artifactsLines.length - 1] + ',';
  const inserted = [
    `${lines[lastKeyIdx]},`,
    ...artifactsLines,
    ...isolationLines,
  ].map((l) => l.replace(/\r$/, '') + eol);
  const out = [...lines.slice(0, lastKeyIdx), ...inserted, ...lines.slice(closeIdx)].join('\n');
  writeFileSync(file, out);
  const check = JSON.parse(readFileSync(file, 'utf8'));
  const art = Object.keys(check.closure.artifacts ?? {}).length;
  const iso = Object.keys(check.closure.isolation ?? {}).length;
  console.log(`${file}: inserted closure.artifacts(${art}) + closure.isolation(${iso}); top keys=${Object.keys(check).length}`);
}

merge('locale/zh.json', 0);
merge('locale/en.json', 1);
