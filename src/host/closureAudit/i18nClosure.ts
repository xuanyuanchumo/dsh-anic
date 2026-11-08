/**
 * 闭环体检：词表面（i18n 键）的扫描 + 三态判定。
 *
 * 从 assetClosure.ts 拆出以满足模块纪律（一域一文件 / 单文件 ≤250 行，truthAudit T3）。
 * assetClosure.ts 保留路由族并**再导出**本模块两个公开函数（flattenKeys / keyAnchor）
 * 与自身族入口，消费者 import 路径零变更。
 *
 * 扫描器边界（本域与 assetClosure 同源教训）：stripComments 不识别**正则字面量**——正则里
 * 出现引号字符会让去注释状态机失衡、把后续整段代码误当字符串。故本文件内所有含引号的
 * 匹配一律用 RegExp 构造（引号落在字符串里，状态机看得见）。守卫见 closureAuditScan 自指哨兵。
 *
 * produced 语义：词表条目没有独立写入点 → producedAt=null，如实标注而不是假装有。
 *
 * ── cycle-75 T2 实测收口（本文件三处判定，全部有可复现证据）────────────────
 *
 * ① `endsWithSeparator` 放宽（'.' + '_'）**没有**引入新假阳性。实测 A/B（同一文件集，
 *    仅替换本模块的 dynamicKeyPrefixes 实现）：HEAD=45 → 现行=42，落差 3 项**全部**是
 *    `budget.status_normal/warn/alert`——它们是 `t(`budget.status_${data.status}`)` 的
 *    真实计算键。故 **42 是真值，45 才是假阳性值**（把 3 个真被消费的键报成未消费）。
 * ② 契约担心的「`closure.cluster.` 前缀误认领三键」在本实现里**不存在**：那三个键在
 *    renderClosure.ts 的 CLUSTER_LABEL_KEYS 里是**字面量**，直接命中 quotedLiteralMatch
 *    （dynamic=false）。该前缀只在**不去注释**时才被构造（renderClosure.ts 头注里的反例
 *    写法）；dynamicKeyPrefixes 已先 stripComments ⇒ 前缀根本不产生。
 * ③ **真实根因是「调用边界」而非前缀匹配**：原用 `line.indexOf('t(')` 找调用点，无词法
 *    边界 ⇒ `agentCards.get(…)` 里 `get(` 的尾串 `t(` 被当成 i18n 调用，凭空造出
 *    `anic.agent.` 前缀。今日认领 0 键（无害），但属**同族假阳性发生器**：一旦新增
 *    anic.agent.* 键，Map 查表就会被冒充成「已消费」。已改 isTranslationCall() 边界。
 * ④ 消费面收窄：assets/**（内联技能脚本）不是本插件 locale/zh.json 的读取方——技能脚本以
 *    **目标项目**目录为根探测词表，与冻结的 routeConsumerUniverse 同口径。实测计数中性。
 * ⑤ 字面量证据改为**去注释后**取（纪律⑥）：此前 evidence 会锚到注释行（实测 4 处）。
 */
import type { ClusterAudit, ClosureItem } from './scanPrimitives.ts';
import { assertScanNonEmpty, collectRefs, kindOf, quoteClasses, stripComments, tallyProduced } from './scanPrimitives.ts';
// cycle-75：键 → 真实行号索引（修叶子名全文匹配导致的 definedAt 误报）。
import { buildKeyLineIndex, flattenKeys, keyAnchor } from './localeKeyAnchors.ts';
// cycle-76：倒排索引证据查询（O(1) 查表替代逐项全仓扫描）。
import type { EvidenceIndex } from './evidenceIndex.ts';
import { evidenceFor } from './evidenceIndex.ts';
import { isPropertyPathKey, propertyPathMatch } from './propertyPathEvidence.ts';

function escapeDots(key: string): string {
  return key.split('.').join('\\.');
}

/** 该行的引号字面量里是否**恰好**含某个 key/路径（前后不得再跟标识符字符）。 */
function quotedLiteralMatch(line: string, token: string): boolean {
  const q = quoteClasses();
  const re = new RegExp('[' + q + ']' + escapeDots(token) + '(?![A-Za-z0-9_/.-])');
  return re.test(line);
}


const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const BACKTICK = String.fromCharCode(96);
const BS = String.fromCharCode(92);
/** `t(` 之前的标识符字符：命中即说明这是别的调用名的尾串（get( / split( / list( …）。 */
const IDENT_TAIL = new RegExp('[A-Za-z0-9_$]');

/**
 * `at` 处的 `t(` 是否**真的是对 t 的调用**（而不是 `get(` / `split(` / `list(` 的尾串）。
 *
 * 本仓实测教训（cycle-75 T2）：`agentCards.get(`anic.agent.${gate}.${role}`)` 里的 `get(`
 * 曾被 `indexOf('t(')` 当成 i18n 调用，凭空产出 `anic.agent.` 计算键前缀。它当时认领 0 个键，
 * 但同族假阳性一旦遇到同名键就会把 Map 查表冒充成词表消费。故必须在调用点加词法边界。
 *
 * 只排除标识符字符（不排除 '.'）——`i18n.t('a.b.')` 这类方法调用仍是合法翻译调用。
 */
function isTranslationCall(line: string, at: number): boolean {
  return at === 0 || !IDENT_TAIL.test(line.charAt(at - 1));
}

/**
 * 前缀是否以**键分隔符**结尾（决定它能否作为「前缀族」去匹配一批键）。
 *
 * 本仓 locale 用两种分隔符：层级用 `.`，族内枚举用 `_`。
 * 例：`closure.cluster.` 匹配 `closure.cluster.tools`；
 *     `budget.status_` 匹配 `budget.status_normal/warn/alert`。
 * 非分隔符结尾（如 `panel.tit`）不构成前缀——否则会误匹配 `panel.titleX` 之类的无关键。
 *
 * cycle-75 实测：放宽到 '_' **未引入假阳性**——本仓唯一由此新增的前缀是 budget.status_，
 * 它认领的 3 个键确实由 `t(`budget.status_${data.status}`)` 消费（变动前后 45→42 即此 3 项）。
 */
export function endsWithSeparator(prefix: string): boolean {
  return prefix.endsWith('.') || prefix.endsWith('_');
}

export function dynamicKeyPrefixes(files: Map<string, string>, allowFiles: (rel: string) => boolean): Array<{ prefix: string; site: string }> {
  const out: Array<{ prefix: string; site: string }> = [];
  const BT = BACKTICK;
  for (const [rel, raw] of files) {
    if (!allowFiles(rel)) continue;
    // 去注释：注释里的模板示例（文档写法）不算消费。本仓实测：不去注释时本函数会从
    // renderClosure.ts 头注与自身文档注释里造出 closure.cluster./PREFIX./x. 三个假前缀。
    const src = stripComments(raw).split('\n');
    for (let i = 0; i < src.length; i += 1) {
      const line = src[i] as string;
      let at = line.indexOf('t(');
      while (at >= 0) {
        // 调用边界：跳过 `get(` / `split(` 之类尾串，只看真的 t( 调用点。
        if (isTranslationCall(line, at)) {
          let rest = line.slice(at + 2);
          const ws = rest.length - rest.replace(new RegExp('^' + BS + 's+'), '').length;
          rest = rest.slice(ws);
          const head = rest.charAt(0);
          if (head === BT) {
            // cycle-74 修复（原实现恒不命中，与其自身文档契约不符）：
            //   ① 原 `indexOf(BT + '${')` 搜的是「反引号**紧接** ${」——而反引号在首位、
            //      ${ 在中段 ⇒ 永远找不到 ⇒ 模板分支从不触发；应搜 `${` 本身。
            //      实测：最小样例 `t(`ns.sub_${x}`)` 在 HEAD 下命中 0，修复后命中 1。
            //   ② 原 `prefix.endsWith('.')` 排除了下划线分隔的键族，
            //      而本模块注释点名的正是 `t(`budget.status_${…}`)`（下划线）。
            // 两处合并导致「真实被消费的键被误报未消费」——与幽灵消费同族的假阳性。
            const stop = rest.indexOf('${');
            if (stop > 1) {
              const prefix = rest.slice(1, stop);
              if (endsWithSeparator(prefix)) out.push({ prefix, site: rel + ':' + String(i + 1) });
            }
          } else if (head === SQ || head === DQ) {
            const close = rest.indexOf(head, 1);
            if (close > 1) {
              const literal = rest.slice(1, close);
              const after = rest.slice(close + 1).replace(new RegExp('^' + BS + 's+'), '');
              if (endsWithSeparator(literal) && after.charAt(0) === '+') {
                out.push({ prefix: literal, site: rel + ':' + String(i + 1) });
              }
            }
          }
        }
        at = line.indexOf('t(', at + 1);
      }
    }
  }
  return out;
}

// cycle-112：flattenKeys / keyAnchor 迁至 localeKeyAnchors.ts（T3 行数纪律），
// 再导出保持既有 import 面（tests 与 assetClosure 从本文件取）。
export { flattenKeys, keyAnchor };


/**
 * 词表消费面：真正读得到该键的代码面。
 * docs/*.md 是散文（引用键名不等于渲染），.json 是数据/夹具，均不计消费。
 * assets/** 是**内联技能脚本包**——它读的是**目标项目**的词表（eval-runner.mjs 的
 * checkI18n 以 projectDir 为根探测 src/i18n、src/client/i18n、public/locales、locale/、
 * src/locale/），不是本插件 locale/zh.json 的读取方 ⇒ 计入消费面属**假消费**。
 * 口径与冻结的 assetClosure.routeConsumerUniverse 一致（该面已排除 assets/）。
 */
function i18nConsumerUniverse(rel: string): boolean {
  if (rel.startsWith('locale/') || rel.startsWith('docs/') || rel.startsWith('assets/')) return false;
  if (rel.endsWith('.json') || rel.endsWith('.md')) return false;
  return /^(src|scripts|bin|tests)\//.test(rel);
}

/**
 * 词表族闭环（cycle-76：支持传入**倒排索引**；缺省回落逐项全扫，外部行为不变）。
 *
 * 索引路径下不再需要「先把所有文件去注释存成一张表」（那本身是 O(files) 内存 +
 * 每键再扫一遍）；`index.literal` 已按「最大化取字面量」建表，按 key 精确查表
 * 即等价于既有 `quotedLiteralMatch`（后者本来就要求键后不接 `[A-Za-z0-9_/.-]`）。
 */
export function i18nClosure(files: Map<string, string>, index?: EvidenceIndex): ClusterAudit {
  const zhRaw = files.get('locale/zh.json');
  assertScanNonEmpty(zhRaw === undefined ? 0 : 1, 'locale-zh');
  const keys = flattenKeys(JSON.parse(zhRaw as string) as Record<string, unknown>);
  assertScanNonEmpty(keys.length, 'i18n-keys');
  const dyn = dynamicKeyPrefixes(files, i18nConsumerUniverse);
  // 判定纪律⑥：字面量证据必须在**去注释**文本上取（否则 evidence 会锚到注释行——
  // 实测曾把 closure.cluster.tools 锚到示例注释、panel.selfInitOk 锚到 JSDoc）。
  // 索引路径由 evidenceIndex 内部 stripComments；回落路径保留原表。
  const literal = index !== undefined ? null : new Map<string, string>();
  if (literal !== null) for (const [rel, raw] of files) literal.set(rel, stripComments(raw));
  // 键 → 行号索引**建一次复用**（302 键 × 全文重扫是 O(n²)，且每键都要准确。
  const keyLines = buildKeyLineIndex(zhRaw as string);
  const items: ClosureItem[] = keys.map((key) => {
    let evidence = index !== undefined
      ? evidenceFor(index.literal, key, i18nConsumerUniverse)
      : collectRefs(literal as Map<string, string>, (line) => quotedLiteralMatch(line, key), i18nConsumerUniverse);
    // cycle-112：结构化元数据键的属性路径证据（`d.meta.description` 形态）。
    // 倒排索引只收引号字面量 ⇒ 索引路径下本条需回落到逐文件扫；只对 meta.* 族
    // 触发，代价 = 一遍文件读（该族键数 ≤3，审计总耗时实测无感）。
    if (evidence.length === 0 && isPropertyPathKey(key)) {
      const literalFallback = literal ?? (() => {
        const m = new Map<string, string>();
        for (const [rel, raw] of files) m.set(rel, stripComments(raw));
        return m;
      })();
      evidence = collectRefs(literalFallback, (line) => propertyPathMatch(line, key), i18nConsumerUniverse);
    }
    let dynamic = false;
    if (evidence.length === 0) {
      // 计算键：命中的前缀全部取自 src/ 生产代码（模板在渲染器里）
      const hits = [...new Set(dyn.filter((d) => key.startsWith(d.prefix)).map((d) => d.site))].slice(0, 3);
      if (hits.length > 0) { evidence = hits; dynamic = true; }
    }
    return {
      cluster: 'i18n',
      id: key,
      definedAt: keyAnchor(zhRaw as string, key, keyLines),
      // cycle-75 诚实标注：词表条目由 t() 纯查找，**没有独立写入点** ⇒
      // producedAt=null 且 producedKind='no-write-point'，不是「缺失」。
      producedAt: null,
      producedKind: 'no-write-point' as const,
      producedEvidence: [],
      consumed: evidence.length > 0,
      evidenceKind: dynamic ? 'code' : kindOf(evidence),
      dynamic,
      evidence,
    };
  });
  const consumed = items.filter((it) => it.consumed).length;
  const codeConsumed = items.filter((it) => it.evidenceKind === 'code').length;
  return { cluster: 'i18n', unit: 'locale key', total: items.length, consumed, codeConsumed, producedByKind: tallyProduced(items), unconsumed: items.length - consumed, items };
}

/** 幽灵词表消费：源码里 t() / labelKey 引用的键在 zh.json 里不存在。 */
export function i18nGhosts(files: Map<string, string>, defined: readonly string[]): string[] {
  const known = new Set(defined);
  const ghosts = new Set<string>();
  for (const [rel, raw] of files) {
    if (!rel.startsWith('src/')) continue;
    // 去注释：注释里写出的示例键（如本仓文档里解释「别用 t('x.' + y)」）不是消费。
    const lines = stripComments(raw).split('\n');
    for (const line of lines) {
      const tRe = new RegExp('\\bt\\(\\s*[' + quoteClasses() + ']([a-zA-Z][A-Za-z0-9_]*\\.[A-Za-z0-9_.]+)[' + quoteClasses() + ']', 'g');
      for (const m of line.matchAll(tRe)) {
        if (m[1] && !known.has(m[1])) ghosts.add(m[1]);
      }
      const lkRe = new RegExp('labelKey:\\s*[' + quoteClasses() + ']([a-zA-Z][A-Za-z0-9_]*\\.[A-Za-z0-9_.]+)[' + quoteClasses() + ']', 'g');
      for (const m of line.matchAll(lkRe)) {
        if (m[1] && !known.has(m[1])) ghosts.add(m[1]);
      }
    }
  }
  // 悬空前缀（'x.y.'）不是键名——它是计算键的前缀，已由 dynamicKeyPrefixes 认领。
  return [...ghosts].filter((g) => !g.endsWith('.')).sort();
}
