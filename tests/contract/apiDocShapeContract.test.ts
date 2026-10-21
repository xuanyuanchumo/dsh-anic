/**
 * API 响应体形状契约（cycle-67 T-6701——cycle-66 欠账的结构性根治）。
 *
 * ## 为什么钉这个
 *
 * cycle-66 补录时发现：invocations/live 的响应体形状在 cycle-47/48/64
 * 三轮协议扩展后，UI 册与可观测性册已同步，**API 参考册却停在 cycle-97**
 * 落后 4 轮——历轮文档同步靠 UI 册单册驱动，API 册没有同步触发器。
 * 手工补录是补求；根治是把「文档字段表 ⇄ 源码接口」固化为契约测试：
 * 下一轮协议扩展加字段时，若不同步 API 册，本测试直接红。
 *
 * ## 三腿同构（任何一腿漂移都红）
 *
 *   宿主源码 invocationFeed.ts 接口 ⇄ API 册 §5 字段表 ⇄ 客户端
 *   renderInvocationsTypes.ts 类型——协议扩展通常三处同改（cycle-47/48/64
 *   先例），钉三腿就是钉整条协议链。
 *
 * ## 守卫纪律（同 guardRegistry / panelBreakpointContract 三条）
 *
 * - 反向自检：先证明集合比较逻辑能判「缺失一个字段」的形态，再谈守卫；
 * - 扫描集非空下限：doc 三段解析出空集 = 表格格式漂移，直接 FAIL；
 * - 双向集合相等：多写一个文档字段（源码没有）与漏写一个（文档缺失）
 *   都算违规——不许单向 contain 吞掉「文档臆造字段」。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEED_SRC = readFileSync(join(ROOT, 'src/host/runtime/invocationFeed.ts'), 'utf8');
const CLIENT_TYPES_SRC = readFileSync(join(ROOT, 'src/client/features/live/renderInvocationsTypes.ts'), 'utf8');
const DOC = readFileSync(join(ROOT, 'docs/agents/API参考-数据面.md'), 'utf8');

/** 从 TS 源码文本提取 `export interface NAME { ... }` 的顶层字段名集合。 */
function interfaceFields(src: string, name: string): Set<string> {
  const m = new RegExp(`export interface ${name} \\{`).exec(src);
  if (!m) throw new Error(`interface not found in source: ${name}`);
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  const body = src.slice(start, i - 1);
  const fields = new Set<string>();
  // 顶层属性行 = 行首恰两空格缩进的 `name` / `name?` 后跟冒号。
  for (const line of body.split('\n')) {
    const fm = /^ {2}(\w+)[?]?\s*:/.exec(line);
    if (fm) fields.add(fm[1] ?? '');
  }
  return fields;
}

/** 提取 doc 中 `### 标题` 到下一个 ##/### 标题之间的正文。 */
function docSection(doc: string, headingPrefix: string): string {
  const m = new RegExp(`### ${headingPrefix}`).exec(doc);
  if (!m) throw new Error(`doc section not found: ${headingPrefix}`);
  const rest = doc.slice(m.index + (m[0]?.length ?? 0));
  const next = rest.search(/^#{2,3} /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** 从 doc 表格首列提取反引号字段名（支持 `turn` / `step` 合并行）。 */
function docTableFields(section: string): Set<string> {
  const fields = new Set<string>();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const firstCell = (line.split('|')[1] ?? '').trim();
    if (firstCell === '---') continue;
    for (const f of firstCell.matchAll(/`(\w+)`/g)) fields.add(f[1] ?? '');
  }
  return fields;
}

/** 双向集合相等（漏写与臆造都判不等）。 */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

// ---- 三腿抽取 ----

// 腿 1：宿主源码。路由响应 = InvocationFeedSnapshot 展开再加 diagnostics（invocationRoute.ts:31）。
const hostSnapshotFields = interfaceFields(FEED_SRC, 'InvocationFeedSnapshot');
const hostResponseFields = new Set([...hostSnapshotFields, 'diagnostics']);
const hostRecordFields = interfaceFields(FEED_SRC, 'InvocationRecord');
const hostDiagFields = interfaceFields(FEED_SRC, 'FeedDiagnostics');

// 腿 2：API 册 §5 三张表。
const docResponseFields = docTableFields(docSection(DOC, '响应体形状'));
const docRecordFields = docTableFields(docSection(DOC, 'InvocationRecord 字段'));
const docDiagFields = docTableFields(docSection(DOC, 'FeedDiagnostics 五计数'));

// 腿 3：客户端类型。
const clientResponseFields = interfaceFields(CLIENT_TYPES_SRC, 'InvocationsJson');
const clientRecordFields = interfaceFields(CLIENT_TYPES_SRC, 'InvocationJson');
const clientDiagFields = interfaceFields(CLIENT_TYPES_SRC, 'FeedDiagnosticsJson');

// 计数头钉：「### InvocationRecord 字段（N）」标题中的 N。
const recordCountInHeading = Number(/### InvocationRecord 字段（(\d+)）/.exec(DOC)?.[1] ?? -1);

describe('cycle-67 T-6701 API 响应体形状三腿契约（文档欠账结构性根治）', () => {
  it('扫描集非空下限：doc 三表解析非空（表格格式漂移 = 假守卫恒绿，直接 FAIL）', () => {
    expect(docResponseFields.size).toBeGreaterThanOrEqual(4);
    expect(docRecordFields.size).toBeGreaterThanOrEqual(12);
    expect(docDiagFields.size).toBeGreaterThanOrEqual(5);
    // 源码侧同理：接口抽取器空集 = 解析形态失效。
    expect(hostRecordFields.size).toBeGreaterThanOrEqual(12);
    expect(clientRecordFields.size).toBeGreaterThanOrEqual(12);
  });

  it('响应体形状三腿：路由响应（Snapshot+diagnostics）⇄ API 册表 ⇄ 客户端 InvocationsJson', () => {
    expect(setsEqual(hostResponseFields, docResponseFields)).toBe(true);
    expect(setsEqual(hostResponseFields, clientResponseFields)).toBe(true);
  });

  it('InvocationRecord 三腿：宿主接口 ⇄ API 册 12 字段表 ⇄ 客户端 InvocationJson（双向相等）', () => {
    expect(setsEqual(hostRecordFields, docRecordFields)).toBe(true);
    expect(setsEqual(hostRecordFields, clientRecordFields)).toBe(true);
    // 显式点名关键字段（聚合断言不吞细节：删掉任何一个字段名都会在此精确报缺）。
    for (const f of ['callId', 'argumentsPreview', 'startedAt', 'status', 'durationMs', 'resultPreview', 'possiblyOrphaned']) {
      expect(docRecordFields.has(f), `API 册 InvocationRecord 表缺字段: ${f}`).toBe(true);
    }
  });

  it('FeedDiagnostics 三腿：宿主接口 ⇄ API 册五计数表 ⇄ 客户端 FeedDiagnosticsJson', () => {
    expect(setsEqual(hostDiagFields, docDiagFields)).toBe(true);
    expect(setsEqual(hostDiagFields, clientDiagFields)).toBe(true);
    for (const f of ['sessionEvents', 'sessionToolCalls', 'toolsResults', 'anicCalls', 'anicResults']) {
      expect(docDiagFields.has(f), `API 册 FeedDiagnostics 表缺计数: ${f}`).toBe(true);
    }
  });

  it('计数头钉：「InvocationRecord 字段（N）」标题数字 == 实际字段数（加字段必须同步改表头计数）', () => {
    expect(recordCountInHeading).toBe(hostRecordFields.size);
  });

  it('反向自检：集合比较逻辑必须能判「缺失一个字段」（先证明有牙再谈守卫）', () => {
    const corrupted = new Set(hostRecordFields);
    corrupted.delete('resultPreview');
    expect(setsEqual(corrupted, docRecordFields)).toBe(false);
    // 同理：多塞一个臆造字段也必须判不等（文档臆造 = 契约违规）。
    const fabricated = new Set(docRecordFields);
    fabricated.add('madeUpField');
    expect(setsEqual(hostRecordFields, fabricated)).toBe(false);
  });
});
