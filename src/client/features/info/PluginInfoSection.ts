/**
 * 插件信息面板（cycle-111）—— 工作台 settings 域的「关于 / 反馈」分区。
 *
 * ## 为什么是静态分区而不是 store 分区
 *
 * 数据面 `PLUGIN_INFO` 是构建期常量（package.json 单一事实源的投影）——
 * 它不随运行时 tick 变化，订阅 store 切片只会带来无意义的重渲。因此本组件
 * 不接 store、不进 2s/4s 轮询档；信息主体一次渲染，终生稳定。
 *
 * ## 反馈入口（用户验收项：插件信息面板 + GitHub 反馈跳转）
 *
 * 四个入口全部是 `<a target="_blank" rel="noreferrer">`（新标签页打开外部站，
 * 不污染宿主 SPA 路由；noreferrer 防 referrer 泄漏宿主会话 URL）：
 *   - 问题反馈 → repository issues（用户原话「反馈入口如跳转到对应的 github 链接」）；
 *   - 仓库主页 / npm 包页 / 文档 → 发现-反馈-查文档的完整旅程闭环。
 * 全部链接文案走 locale（wb.info.*），锚点 `data-anic-info-link=<kind>` 供
 * 契约测试与 E2E 定位。
 *
 * ## 隔离纪律（本面板唯一动 DOM 的地方）
 *
 * 「检查更新」按钮：真实浏览器打开 npm 包页（用户自行比对最新版本），
 * 无 DOM（测试/沙盒）时静默——与 scrollToDomainCard 同款 try/catch 纪律。
 * 绝不做自动网络请求（面板数据面零网络纪律：自查/快照等运行时数据由
 * 各自分区拉取，本面板是静态元信息，拉版本号反而引入跨域与延迟问题）。
 */
import { createElement, type ReactElement, type SyntheticEvent } from 'react';
import { t } from '../../i18n.ts';
import { token } from '../../../shared/tokens.ts';
import { PLUGIN_INFO } from '../../info/pluginInfo.ts';
import { renderFoldableSection } from '../../components/sectionShell.ts';

/** 反馈/入口链接种类（锚点 data-anic-info-link 的值域；封闭集合）。 */
type InfoLinkKind = 'issues' | 'repo' | 'npm' | 'docs';

/** 入口表：kind → 链接目标（PLUGIN_INFO 字段名同源——加入口改这两处）。 */
const LINKS: ReadonlyArray<{ kind: InfoLinkKind; href: string }> = [
  { kind: 'issues', href: PLUGIN_INFO.issues },
  { kind: 'repo', href: PLUGIN_INFO.repository },
  { kind: 'npm', href: PLUGIN_INFO.npm },
  { kind: 'docs', href: PLUGIN_INFO.docs },
];

/**
 * 用系统浏览器打开 URL（真实浏览器行为；无 DOM 静默）。
 * 独立导出：按钮 onClick 与契约测试同用一个入口，行为不漂移。
 */
export function openExternal(url: string): void {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch { /* 无 DOM（测试/沙盒）→ 无处可开，静默 */ }
}

/** 信息行（label + value）：版本 / 构建时间等元信息的最小排版单元。 */
function infoRow(label: string, value: ReactElement | string, rowKey: string): ReactElement {
  return createElement('div', {
    key: rowKey,
    'data-anic-info-row': rowKey,
    style: { display: 'flex', gap: 8, fontSize: 11, padding: '1px 0', color: token('anic-text') },
  },
  createElement('span', { style: { color: token('anic-text-faint'), minWidth: 64 } }, label),
  value);
}

/** 外链 `<a>`：新标签 + noreferrer + 锚点（契约测试按 kind 断言）。 */
function infoLink(kind: InfoLinkKind, href: string): ReactElement {
  return createElement('a', {
    key: kind,
    href,
    target: '_blank',
    rel: 'noreferrer',
    'data-anic-info-link': kind,
    style: { color: token('anic-status-active'), textDecoration: 'none' },
    onClick: (e: SyntheticEvent<HTMLAnchorElement>): void => {
      // 宿主 SPA 可能拦截 <a> 跳转（preventDefault）→ 兜底走 window.open，
      // 保证「点了必出去」；未被拦截则放行浏览器默认行为。
      if (e.defaultPrevented) { openExternal(href); }
    },
  }, t(`wb.info.${kind}`));
}

/**
 * 插件信息面板体（静态；不订阅 store）。
 * 供 PluginInfoSection 的折叠壳使用，独立导出供单元测试直测渲染形状。
 */
export function renderPluginInfoBody(): ReactElement {
  return createElement('div', { 'data-anic-info': 'true' },
    infoRow(t('wb.info.name'), PLUGIN_INFO.name, 'name'),
    infoRow(t('wb.info.version'), createElement('span', {
      'data-anic-info-version': PLUGIN_INFO.version,
      style: { fontWeight: 600, color: token('anic-text-strong') },
    }, `v${PLUGIN_INFO.version}`), 'version'),
    infoRow(t('wb.info.builtAt'), new Date(PLUGIN_INFO.builtAt).toLocaleString(), 'builtAt'),
    // 反馈入口行：四个外链（问题反馈优先——它是用户验收的「反馈入口」主位）。
    infoRow(t('wb.info.links'), createElement('span', {
      'data-anic-info-links': 'true',
      style: { display: 'inline-flex', gap: 10, flexWrap: 'wrap' },
    }, ...LINKS.map(({ kind, href }) => infoLink(kind, href))), 'links'),
  );
}

/**
 * 插件信息分区（settings 域；fold id = 'pluginInfo'）。
 *
 * 为什么用 renderFoldableSection：与配置/自举分区同壳——settings 域的分区
 * 形态统一（折叠壳 + locale 标题），默认收纳（纯元信息不是兜底观测面）。
 */
export function PluginInfoSection(): ReactElement {
  // 注意：id 必须与 title 同行——装配契约扫描器按「renderFoldableSection 紧跟
  // id 字面量」的单行形态提取分区 id 集（panelAssemblyContract 腿1），多行写法
  // 会让扫描器漏掉本分区（实测踩过：多行 ⇒ locale 多一键红）。注释里也**不能**
  // 出现该调用形态的字面量（引号字面量 = 消费的扫描口径会把注释当成真 id——
  // 本仓自指陷阱第二例，见 i18nDeadKeyContract 头注 k() 的教训）。
  return renderFoldableSection({ id: 'pluginInfo', title: t('fold.pluginInfo'), defaultOpen: false,
    children: renderPluginInfoBody() });
}
