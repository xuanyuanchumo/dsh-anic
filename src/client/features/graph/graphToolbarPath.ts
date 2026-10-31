/**
 * 工具栏「路径」组（cycle-95 · WS-C）—— 一个模式开关，键盘可达。
 *
 * ## 为什么是一个 `<button>` 而不是两个下拉框
 *
 * 面板上已有"搜索 + 跳转"，它的心智是"我知道它叫什么"。找路径的心智完全不同：
 * "我要从一个看到的节点走到另一个看到的节点"。用户手里**已经有**这两个节点
 * （图上点得到、键盘 Tab + 方向键也走得到），缺的只是"把它们串起来"的那一步。
 * 所以做成开关：开 → 点在图上依次选起点/终点 → 结果与高亮由状态条给出。
 *
 * 下拉框要求用户把**已经看得到的节点**再按名字输一遍，那是把图为鼠标点的
 * 优势抹掉，退回成文本检索。
 *
 * ## 为什么按钮带 `aria-pressed`
 *
 * 它是**模式开关**（开/关），不是一次性动作。AT 需要播报"已按下"才能让用户
 * 知道自己处在哪个语义里 —— 否则进入模式后节点点击改写这件事对键盘用户
 * 完全不可见（屏幕上只是多了一条状态条）。同一形状见 `graphToolbarView` 的
 * "仅看异常"按钮注释。
 *
 * ## 为什么锚点值是 `'on'/'off'` 而不是布尔
 *
 * `data-anic-graph-path-mode` 既要能断言"有这个东西"，也要能断言"现在是开还是关"。
 * 拆成两个属性（存在 + `aria-pressed`）会让断言分散；一个属性带值最省。
 */
import { createElement, type ReactElement } from 'react';
import { GROUP_LABEL, renderToolbarGroup } from './graphToolbarGroups.ts';
import { t } from '../../i18n.ts';

/**
 * 按钮的可见文案 —— 复用既有键 `graph.pathFind`（"找路径"）。
 *
 * 为什么不新增一个 `graph.pathMode`：两者是同一句话，多一个同义键只会在
 * locale 里多一条需要两边同步维护的死键。按钮是**模式开关**而标题是组标签，
 * 但它们给用户的字面完全相同（见 `graphToolbarPath` 头注的设计裁决）。
 */
function pathLabel(): string {
  return t('graph.pathFind');
}

/** 路径组入参。 */
export interface PathGroupInput {
  /** 是否处于路径选择模式。 */
  active: boolean;
  /** 切换模式。 */
  onToggle: () => void;
}

/** 路径组（工具栏的第 7 组）。 */
export function renderPathGroup(input: PathGroupInput): ReactElement {
  return renderToolbarGroup({
    id: 'path',
    label: GROUP_LABEL.path,
    children: [createElement('button', {
      key: 'path-mode',
      type: 'button',
      // 锚点：模式是否开启进 DOM（状态是异步交互结果，必须可断言）。
      'data-anic-graph-path-mode': input.active ? 'on' : 'off',
      'aria-pressed': input.active ? 'true' : 'false',
      'aria-label': pathLabel(),
      title: pathLabel(),
      onClick: input.onToggle,
      className: 'anic-btn',
      style: {
        padding: '0 6px', fontSize: 10.5,
        // 选中态用边框加粗表达（不靠背景色单独承载信息 —— WCAG 1.4.1）。
        borderWidth: input.active ? 2 : 1,
        fontWeight: input.active ? 'bold' : undefined,
      },
    }, pathLabel())],
  });
}
