/**
 * 属性路径消费证据（cycle-112）—— 结构化元数据族的第二种消费形态。
 *
 * ## 为什么单独成模块
 *
 * `i18nClosure.ts` 已达 T3 上限（≤250 行）纪律，属性路径判定与本域同源但独立
 * 可测；拆出后 i18nClosure 只保留「何时调用」，判定器本身可被单测直接引用。
 *
 * ## 被守卫缺陷（真机闭环实测）
 *
 * `meta.description` 是 locale 词条，唯一消费者是 `scripts/validate-dsh.mjs:75`
 * 的 `d.meta.description`（DSH 清单合规门）——属性路径访问不含引号字面量 ⇒
 * `quotedLiteralMatch` 看不见它 ⇒ 闭环把它判成 `producedGap=1`（"只声明没接线"），
 * 面板「闭环与自举」域因此长期 ⚠️。它不是删除判决：该键**必须**存在
 * （DSH 清单要求非空），且真的被代码读取。
 *
 * ## 口径边界（防止把任意属性访问冒充成词表消费）
 *
 * 只对 `meta.` 前缀开放属性路径证据。理由：`meta.*` 是本仓唯一「结构化元数据」
 * 族（title/description 由工具链按属性路径读），其余键族一律仍要求引号字面量
 * ——宽口径会把 `obj.state.loading` 这类同名属性访问误判为词表消费
 * （cycle-75 的 `anic.agent.` 假阳性同族）。
 */

/** 该键是否属于「按属性路径读取」的结构化元数据族。 */
export function isPropertyPathKey(key: string): boolean {
  return key.startsWith('meta.');
}

/** 该行是否含 `.<key>` 属性路径访问（前后不得再跟标识符字符）。 */
export function propertyPathMatch(line: string, key: string): boolean {
  const escaped = key.split('.').join('\\.');
  const re = new RegExp('\\.' + escaped + '(?![A-Za-z0-9_/.-])');
  return re.test(line);
}