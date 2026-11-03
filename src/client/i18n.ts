/**
 * 客户端 i18n 最小实现（P0-1 第一步：先落机制，再逐步替换字面量）。
 *
 * 设计约束（docs/anic/13 §独立工程 + 02 §N7）：
 * - 零依赖：不引 i18next 等运行时库（bundle 零依赖纪律）；
 * - 字典与 host 侧共用同一份 `locale/{zh,en}.json`（单一事实源，不复制文案）；
 * - **缺省中文**：未检出明确英文信号时一律 zh —— 与既有中文文案一致，
 *   保证 jsdom / lang 缺失 / 旧宿主等场景的渲染输出不变（测试不假红）；
 * - 缺键回退链：当前语言 → zh → 键名本身（可见的漏翻，而不是空白）。
 *
 * 语言检测顺序：localStorage['anic-lang']（显式覆盖）>
 * document.documentElement.lang（宿主 shell 声明）> 缺省 zh。
 * 不读 navigator.language：jsdom 默认 'en-US'，会让全部既有中文断言变红。
 */
import zh from '../../locale/zh.json';
import en from '../../locale/en.json';

export type ClientLang = 'zh' | 'en';

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
type Dict = { [k: string]: JsonValue };

const DICTS: Record<ClientLang, Dict> = { zh: zh as Dict, en: en as Dict };

/** 点路径取嵌套键（'panel.selfInitOk' → dicts.panel.selfInitOk）。 */
function lookup(dict: Dict, key: string): string | undefined {
  let cur: JsonValue | undefined = dict;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Dict)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function detectClientLang(): ClientLang {
  try {
    const stored = globalThis.localStorage?.getItem('anic-lang');
    if (stored === 'zh' || stored === 'en') return stored;
  } catch { /* localStorage 不可用（沙盒/SSR）→ 继续 */ }
  try {
    const el = document?.documentElement?.lang;
    if (typeof el === 'string' && el.toLowerCase().startsWith('en')) return 'en';
  } catch { /* 无 DOM → 缺省 */ }
  return 'zh';
}

/**
 * 宿主语言联动（cycle-99）：`locale` 服务快照写入本地覆盖层。
 *
 * 为什么写 localStorage 而不是直接改检测链：既有契约「localStorage['anic-lang'] 显式
 * 覆盖最优先」是**用户手动选择**的语义。宿主联动属于**跟随**（用户没手动选过时跟随
 * 宿主设置）——实现为「宿主 active 写入 anic-lang，用户此后手动切换仍能覆盖它」，
 * 优先级链不变，只多了一个写入源。
 *
 * 宿主无 locale 服务（旧宿主/独立测试）→ 本函数不被调用，零行为变化。
 */
export function setLocaleFromHost(active: 'zh' | 'en'): void {
  try {
    // 用户已显式选择（anic-lang 已存在）→ 不覆盖（尊重手动选择）。
    if (globalThis.localStorage?.getItem('anic-lang') !== null) return;
    globalThis.localStorage?.setItem('anic-lang', active);
  } catch { /* storage 不可用 → 本次不联动，不崩 */ }
}

/** 翻译 + `{param}` 插值（与 host 侧 t() 同一约定）。 */
export function t(key: string, params?: Record<string, string | number>): string {
  const lang = detectClientLang();
  const raw = lookup(DICTS[lang], key) ?? lookup(DICTS.zh, key) ?? key;
  if (!params) return raw;
  let out = raw;
  for (const [k, v] of Object.entries(params)) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}
