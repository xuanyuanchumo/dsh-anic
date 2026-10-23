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
 */
import type { ClusterAudit, ClosureItem } from './scanPrimitives.ts';
import { assertScanNonEmpty, collectRefs, kindOf, quoteClasses, stripComments } from './scanPrimitives.ts';

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

/**
 * 计算键前缀扫描：t(`PREFIX.${expr}`) 与 t('PREFIX.' + expr) 两种构造形态。
 *
 * 为什么必须认这类引用（实测教训）：renderBudget 用 t(`budget.status_${data.status}`)
 * 消费 budget.status_normal/warn/alert 三键，而 data.status 的联合类型正是这三值
 * （renderBudget.ts 的 isBudget 守卫逐个校验过）。只看字面量会把这三个**真实被消费**
 * 的键报成未消费——与幽灵消费同族的假阳性。
 */
export function dynamicKeyPrefixes(files: Map<string, string>, allowFiles: (rel: string) => boolean): Array<{ prefix: string; site: string }> {
  const out: Array<{ prefix: string; site: string }> = [];
  const BT = BACKTICK;
  for (const [rel, raw] of files) {
    if (!allowFiles(rel)) continue;
    // 去注释：注释里的模板示例（文档写法）不算消费。
    const src = stripComments(raw).split('\n');
    for (let i = 0; i < src.length; i += 1) {
      const line = src[i] as string;
      let at = line.indexOf('t(');
      while (at >= 0) {
        let rest = line.slice(at + 2);
        const ws = rest.length - rest.replace(new RegExp('^' + BS + 's+'), '').length;
        rest = rest.slice(ws);
        const head = rest.charAt(0);
        if (head === BT) {
          const stop = rest.indexOf(BT + '${');
          if (stop > 1) {
            const prefix = rest.slice(1, stop);
            if (prefix.endsWith('.')) out.push({ prefix, site: rel + ':' + String(i + 1) });
          }
        } else if (head === SQ || head === DQ) {
          const close = rest.indexOf(head, 1);
          if (close > 1) {
            const literal = rest.slice(1, close);
            const after = rest.slice(close + 1).replace(new RegExp('^' + BS + 's+'), '');
            if (literal.endsWith('.') && after.charAt(0) === '+') {
              out.push({ prefix: literal, site: rel + ':' + String(i + 1) });
            }
          }
        }
        at = line.indexOf('t(', at + 1);
      }
    }
  }
  return out;
}

/** locale 嵌套对象 → 打点扁平键（closure.title 这种命名空间路径必须展开）。 */
export function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix === '' ? k : prefix + '.' + k;
    if (v !== null && typeof v === 'object') out.push(...flattenKeys(v as Record<string, unknown>, key));
    else out.push(key);
  }
  return out;
}

/** 词表定义锚点：在 zh.json 里找叶子键所在行（找不到记 1 行——不谎报精确行号）。 */
export function keyAnchor(raw: string, key: string): string {
  const leaf = key.split('.').pop() ?? key;
  const lines = raw.split('\n');
  const re = new RegExp('^\\s*[' + quoteClasses() + ']' + escapeDots(leaf) + '[' + quoteClasses() + ']\\s*:');
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i] as string)) return 'locale/zh.json:' + String(i + 1);
  }
  return 'locale/zh.json:1';
}

/**
 * 词表消费面：真正读得到该键的代码面。
 * docs/*.md 是散文（引用键名不等于渲染），.json 是数据/夹具，均不计消费。
 */
function i18nConsumerUniverse(rel: string): boolean {
  if (rel.startsWith('locale/') || rel.startsWith('docs/')) return false;
  if (rel.endsWith('.json') || rel.endsWith('.md')) return false;
  return /^(src|assets|scripts|bin|tests)\//.test(rel);
}

export function i18nClosure(files: Map<string, string>): ClusterAudit {
  const zhRaw = files.get('locale/zh.json');
  assertScanNonEmpty(zhRaw === undefined ? 0 : 1, 'locale-zh');
  const keys = flattenKeys(JSON.parse(zhRaw as string) as Record<string, unknown>);
  assertScanNonEmpty(keys.length, 'i18n-keys');
  const dyn = dynamicKeyPrefixes(files, i18nConsumerUniverse);
  const items: ClosureItem[] = keys.map((key) => {
    let evidence = collectRefs(files, (line) => quotedLiteralMatch(line, key), i18nConsumerUniverse);
    let dynamic = false;
    if (evidence.length === 0) {
      // 计算键：命中的前缀全部取自 src/ 生产代码（模板在渲染器里）
      const hits = [...new Set(dyn.filter((d) => key.startsWith(d.prefix)).map((d) => d.site))].slice(0, 3);
      if (hits.length > 0) { evidence = hits; dynamic = true; }
    }
    return {
      cluster: 'i18n',
      id: key,
      definedAt: keyAnchor(zhRaw as string, key),
      producedAt: null,
      consumed: evidence.length > 0,
      evidenceKind: dynamic ? 'code' : kindOf(evidence),
      dynamic,
      evidence,
    };
  });
  const consumed = items.filter((it) => it.consumed).length;
  const codeConsumed = items.filter((it) => it.evidenceKind === 'code').length;
  return { cluster: 'i18n', unit: 'locale key', total: items.length, consumed, codeConsumed, unconsumed: items.length - consumed, items };
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
