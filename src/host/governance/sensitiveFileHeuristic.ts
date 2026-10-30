/**
 * 敏感文件误报判据（cycle-89/90 · 从 `hitlAudit.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 背景：H1 判据的两次同族误报
 *
 * H1 的本意是「**凭据**文件未被 .gitignore 保护」。但 `SENSITIVE_PATTERNS` 是
 * **子串匹配**，于是任何名字里带 `token` 的文件都命中：
 *
 * | 文件 | 是什么 | 有凭据吗 | 误报？ |
 * |---|---|---|---|
 * | `src/shared/tokens.ts` | CSS 设计令牌表 | ❌ | ✅ cycle-89 已修 |
 * | `src/shared/hostTokens.ts` | 宿主主题令牌映射 | ❌ | ✅ cycle-89 已修 |
 * | `tests/unit/hitlDesignToken.test.ts` | **测这个守卫的测试文件** | ❌ | ✅ cycle-90 本轮 |
 *
 * 两次都导致 **H1 熔断** ⇒ 按协议要**回退 L4**。为两个无害文件丢掉整轮自主性，
 * 是**假熔断**的典型代价。
 *
 * ## 判据：问「**是不是真凭据容器**」，不是「名字里有没有敏感词」
 *
 * 豁免两类：
 * ① **精确匹配的设计令牌表**（`tokens.ts` / `hostTokens.ts`）；
 * ② **测试文件**（`*.test.ts`）—— 测试里出现 token 字样几乎总是「测试某个
 *    与 token 有关的行为」，不是「测试文件里存了 token」。
 *
 * **真凭据必须仍被拦下**：`token.json` / `secrets.ts` / `credentials.json` /
 * `.env` —— 它们既不是精确白名单，也不是测试文件。
 * ⚠️ 若将来放宽豁免范围，**守卫就变哑了**（告警级守卫等于没有守卫）。
 *
 * ## 为什么用**精确文件名**而不是「按目录/扩展名排除」
 *
 * 凭据文件的典型命名是 `token.json` / `secrets.ts` —— **含** `token`/`secret`
 * 但**不等于** `tokens.ts`。精确匹配既消掉误报，又不放过真凭据；
 * 且 `tokens.ts.bak` / `mytokens.ts` 也不会被放过。
 */

/** 精确匹配的设计令牌表文件名。 */
const DESIGN_TOKEN_FILENAMES: readonly string[] = ['tokens.ts', 'hostTokens.ts'];

/**
 * 该文件是否是「含 token 字样但**不是凭据文件**」的误报命中。
 *
 * @param filePath 变更文件路径（相对工作区）
 */
export function isNonCredentialTokenMention(filePath: string): boolean {
  const basename = filePath.split('/').pop() ?? filePath;
  if (DESIGN_TOKEN_FILENAMES.includes(basename)) return true;
  // 测试文件：含 token 字样但是「测行为」而非「存凭据」。
  return /\.test\.ts$/.test(basename);
}
