/**
 * 宿主主题令牌的**上游**名 + 三段 fallback 引用（cycle-83 · V 战线）。
 *
 * ## 为什么单独成文件
 *
 * `tokens.ts` 已 214 行（含 46 个语义令牌的逐条角色注释），加上本段会越过
 * 250 行模块纪律（`truthAuditChecks` 的机械扫描项）。拆分的界线是职责：
 * `tokens.ts` 回答"本仓的语义令牌是什么值"，本文件回答"**宿主主题**如何接进来"。
 *
 * ## 为什么是"上游"而不是"新调色板"
 *
 * 同生态成熟插件（dsh-ops）直接把 `--dsw-alias-*` 当颜色用；本仓已有 46 个
 * `anic-*` + 一套逐值测量的对比度契约（`tests/contract/contrastContract.test.ts`）。
 * 换成宿主名会让那套契约**测不到实际生效值**（它只认 `SEMANTIC` 表）。正确形态
 * 是把宿主令牌夹在中间：
 *
 *   var(--anic-text, var(--dsw-alias-label-primary, #334155))
 *      ①本仓契约      ②宿主主题跟随        ③原语垫底
 *
 * 三段都是**具体来源**：面板内有主题令牌时用本仓值（契约成立），宿主覆盖了
 * `--anic-*` 时跟随宿主，两者都没有时落原语。中间段用 `var()` 不是"把失败推后
 * 一层"——它是"多一个可能命中的上游"，而末段仍是 `SEMANTIC` 里的真值。
 */
import { SEMANTIC, token, type TokenName } from './tokens.ts';

/**
 * 宿主别名映射。只登记"确实有宿主对应物"的那些；未登记的名字 `hostToken`
 * 退化为 `token()`（形状不变，不会给不存在的宿主变量留悬挂引用）。
 *
 * 键是**本仓语义角色**，值是宿主的别名——方向不能反：我们是消费方，不是定义方。
 */
const HOST_UPSTREAM: Partial<Record<TokenName, string>> = {
  'anic-text': '--dsw-alias-label-primary',
  'anic-text-strong': '--dsw-alias-label-primary',
  'anic-text-dim': '--dsw-alias-label-secondary',
  'anic-text-faint': '--dsw-alias-label-tertiary',
  'anic-surface': '--dsw-alias-bg-primary',
  'anic-surface-hover': '--dsw-alias-bg-secondary',
  'anic-border': '--dsw-alias-border-l1',
  'anic-border-strong': '--dsw-alias-border-l3',
  'anic-focus-ring': '--dsw-alias-button-primary-fill',
};

/** 该令牌是否有宿主上游（用于测试与文档核对，不参与渲染）。 */
export function hostUpstreamOf(name: TokenName): string | null {
  return HOST_UPSTREAM[name] ?? null;
}

/**
 * 带宿主上游的令牌引用。
 *
 * 生成串的末段直接插值 `SEMANTIC[name]`（与 `token()` 同源），因此
 * `clientRenderContract` 的"fallback 必须等于 SEMANTIC"判定对两者一致。
 */
export function hostToken(name: TokenName): string {
  const upstream = HOST_UPSTREAM[name];
  if (upstream === undefined) return token(name);
  return `var(--${name}, var(${upstream}, ${SEMANTIC[name]}))`;
}
