/**
 * 颜色数学（P2-A11Y-COLOR）——对比度与「可辨性」的唯一实现处。
 *
 * ## 为什么必须搬到生产代码
 *
 * 改造前 WCAG 相对亮度 / 对比度公式**只存在于测试文件里**
 * （`tests/contract/contrastContract.test.ts` 的私有 `ratio()`）。那意味着：
 * 任何非测试代码想回答"这个色够不够亮"，只能再抄一遍公式 —— 于是同一件事
 * 有两份口径，其中一份必然先漂移。本文件把它们收成一份，测试改为 import。
 *
 * ## 为什么可辨性用 OKLab 而不是 CIELAB
 *
 * `contrastContract` 只回答"色和底色拉不拉得开"，**不回答**"两个类型色之间
 * 拉不拉得开"，而后者正是本仓 9 个节点类型色的真实缺陷（实测最差一对 ΔE≈0.8，
 * 肉眼完全同色）。选 OKLab 是因为它的等距性在**高饱和蓝紫区**仍然成立 ——
 * 类型色恰好大量落在那个区（蓝 / 紫 / 品红）；CIELAB 在那里会把
 * "肉眼明显不同"的一对判成小距离，反向误导校准。
 *
 * `deltaE` 的单位：OKLab 欧氏距离 × 100（便于与设计稿的 "ΔE ≥ 15" 口头阈值
 * 对齐）。JND 约 2，15 是"一眼可分"，9 是本仓亮度带内实测可达上限（见下）。
 *
 * ## 色盲模拟用 Machado 2009（严重度 1.0）
 *
 * 三组 3×3 矩阵作用在**线性 RGB** 上（直接作用在 sRGB 上会系统性低估蓝黄轴
 * 的偏移）。选 Machado 而不是 Brettel/Viénot：前者是连续严重度模型在 1.0 处
 * 的取值，矩阵系数是公开表格值，可逐项复核 —— 这对契约很重要，
 * 因为一条算错的矩阵会让"色盲可辨"永远绿。
 *
 * ## 亮度带：9 色达不到 ΔE ≥ 15 的根因（`feasibleLuminanceBand`）
 *
 * `palette.ts` 要求每个类型色在**浅色 #f8fafc 与暗色 #0f172a 两个表面上同时**
 * ≥ 3.3。这两条约束把可用相对亮度锁进 [0.1441, 0.2541]（宽仅 1.76 倍）：
 * 上限来自"不能太暗，否则浅底上看不见"，下限来自"不能太亮，否则暗底上看不见"。
 * 亮度被锁死之后，9 个色只能靠色相区分，而 OKLab 在固定亮度环上最多塞下
 * 约 9 个"互相 ΔE ≥ 9"的点 —— ΔE ≥ 15 对 9 色是**几何上不可达**的，
 * 不是搜索算法不够好。所以本仓的策略是：颜色达到可达上限（≈9），
 * 剩余区分度由**形状通道**承担（WCAG 1.4.1 要求的"非仅靠颜色"）。
 */

/** sRGB 三通道（0–255）。 */
export type Rgb = readonly [number, number, number];

/** OKLab 三元组。`L` 0–1，`a`/`b` 约 ±0.4。 */
export interface Oklab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

/** 色觉缺陷类型（Machado 2009 三支）。 */
export type ColorBlindKind = 'deuter' | 'protan' | 'tritan';

/**
 * 解析十六进制颜色。
 *
 * **不可解析即抛**，不返回兜底值：静默兜底会让"rgba()/var() 令牌"被当成
 * 某个合法颜色参与测量，于是守卫永远是绿的（这正是要防的失效模式）。
 */
export function parseHex(value: string): Rgb {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
  if (m === null) throw new Error(`颜色测量只接受十六进制颜色，收到：${value}`);
  // `noUncheckedIndexedAccess` 下 `m[1]` 是 `string | undefined`。正则已捕获组 1
  // 必然存在，但**不靠"必然"来收窄**：显式取默认空串会让下面的长度判断走 6 位分支，
  // 那样 `#` 会被静默当成黑色参与测量 —— 正是本函数头注禁止的"静默兜底"。
  const raw = m[1];
  if (raw === undefined) throw new Error(`颜色测量无法提取通道：${value}`);
  const hex = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const out = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r, g, b] = out;
  if (r === undefined || g === undefined || b === undefined) {
    throw new Error(`颜色测量通道不足：${value}`);
  }
  return [r, g, b];
}

/** 单通道 sRGB → 线性（WCAG 2.x / IEC 61966-2-1 同式）。 */
function linearize(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** 线性 → sRGB 单通道（0–255，四舍五入并夹紧）。 */
function encode(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, s)) * 255);
}

/** WCAG 2.x 相对亮度。 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG 2.x 对比度（1–21）。参数顺序无关。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = la >= lb ? la : lb;
  const lo = la >= lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB 十六进制 → OKLab（Björn Ottosson 的原始矩阵）。 */
export function oklabOf(hex: string): Oklab {
  const [r8, g8, b8] = parseHex(hex);
  const r = linearize(r8);
  const g = linearize(g8);
  const b = linearize(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}

/**
 * 两色的可辨性距离（OKLab 欧氏距离 × 100）。
 *
 * 同色必须恰好 0 —— 契约的反向自检依赖这一点（喂 `#398ce3` vs `#398ce3`
 * 若返回非 0，说明某个环节做了不该做的夹紧/取整）。
 */
export function deltaE(a: string, b: string): number {
  const x = oklabOf(a);
  const y = oklabOf(b);
  return 100 * Math.sqrt((x.L - y.L) ** 2 + (x.a - y.a) ** 2 + (x.b - y.b) ** 2);
}

/**
 * Machado 2009（严重度 1.0）三支矩阵，作用在**线性** RGB 上。
 * 数值逐项摘自论文附录表，任何一项被改动都会让色盲契约失去判别力。
 */
const MACHADO: Record<ColorBlindKind, readonly number[]> = {
  deuter: [
    0.367322, 0.860646, -0.227968,
    0.280085, 0.672501, 0.047413,
    -0.011820, 0.042940, 0.968881,
  ],
  protan: [
    0.152286, 1.052583, -0.204868,
    0.114503, 0.786281, 0.099216,
    -0.003882, -0.048116, 1.051998,
  ],
  tritan: [
    1.255528, -0.076749, -0.178779,
    -0.078411, 0.930809, 0.147602,
    0.004733, 0.691367, 0.303900,
  ],
};

/** 模拟某种色觉缺陷后的颜色（返回十六进制，便于直接参与 ΔE 与对比度测量）。 */
export function simulateColorBlind(hex: string, kind: ColorBlindKind): string {
  const [r8, g8, b8] = parseHex(hex);
  const r = linearize(r8);
  const g = linearize(g8);
  const b = linearize(b8);
  const m = MACHADO[kind];
  // 显式解构而不是 `m[row*3]` 直取：`noUncheckedIndexedAccess` 下索引访问是
  // `number | undefined`，而静默当 0 参与矩阵乘法会算出**错误的模拟色**且不报错。
  const channel = (row: number): number => {
    const c0 = m[row * 3];
    const c1 = m[row * 3 + 1];
    const c2 = m[row * 3 + 2];
    if (c0 === undefined || c1 === undefined || c2 === undefined) {
      throw new Error(`色盲矩阵不足：kind=${kind} row=${String(row)}`);
    }
    return c0 * r + c1 * g + c2 * b;
  };
  return `#${[0, 1, 2].map((row) => encode(channel(row)).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 「两个表面同时 ≥ threshold」这把前景色的**相对亮度**锁死在哪一段。
 *
 * 返回区间是开区间之外的闭区间：`[min, max]`。`min` 来自更暗的表面
 * （太暗则暗底上看不见），`max` 来自更亮的表面（太亮则浅底上看不见）。
 *
 * 本仓实测：浅色 `#f8fafc`、暗色 `#0f172a`、阈值 3.3 → `[0.1441, 0.2541]`。
 * 这段区间就是"9 色达不到 ΔE ≥ 15"的根因（详见文件头）。
 */
export function feasibleLuminanceBand(
  surfaceA: string,
  surfaceB: string,
  threshold: number,
): { min: number; max: number } {
  if (!(threshold > 1)) throw new Error(`对比度阈值必须大于 1，收到：${String(threshold)}`);
  const la = relativeLuminance(surfaceA);
  const lb = relativeLuminance(surfaceB);
  const dark = Math.min(la, lb);
  const light = Math.max(la, lb);
  const min = threshold * (dark + 0.05) - 0.05;
  const max = (light + 0.05) / threshold - 0.05;
  if (min > max) throw new Error(`两个表面 ${surfaceA}/${surfaceB} 在阈值 ${String(threshold)} 下无可行亮度段`);
  return { min, max };
}
