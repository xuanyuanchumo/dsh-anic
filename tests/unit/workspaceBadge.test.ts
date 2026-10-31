/**
 * 工作区徽标契约（cycle-95 WS-D）—— **当前工作区可见性** 的机械守卫。
 *
 * ## 被守卫的缺口（实测）
 *
 * 多项目隔离在数据层有三道防线（`workspaceIsolation.test.ts` 守载荷守卫/在途丢弃/
 * 分键视图态），但**视觉层零覆盖**：`workflow-snapshot` 的响应头学了工作区，
 * 面板界面却从不显示"你在看哪个项目"；`UNKNOWN_WORKSPACE_KEY` 在 UI 上没有呈现。
 * 于是用户看到的是"某个项目的面板"，而不是"这是 dxsh-anic / 这是未识别项目"。
 *
 * 本文件把三件事钉成机械断言：
 *   ① **纯函数四边界**（null/空 → 未识别；Windows；POSIX；超长中间省略）；
 *   ② **不泄露绝对路径**（UI 只出现末两段；全文不得出现盘符反斜杠形态）；
 *   ③ **跨项目态三态**（无历史 / 有历史 / 畸形形状），且渲染锚点可被外部测量。
 *
 * 纪律（与 clientRenderContract 同形）：每条负向断言的**正例**先被证明能命中，
 * 否则"没渲出某串"可能只是渲染器根本没工作（假绿经典形态）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  crossProjectViewOf,
  renderWorkspaceBadge,
  workspaceBadgeOf,
  WorkspaceBadge,
  workspaceLabelOf,
} from '../../src/client/features/org/workspaceBadge.ts';
import { t } from '../../src/client/i18n.ts';
import { UNKNOWN_WORKSPACE_KEY } from '../../src/client/components/workspaceGuard.ts';
import { createPanelStore } from '../../src/client/components/panelStore.ts';
import { createInitialPanelState, type PanelState } from '../../src/client/panelState.ts';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UNKNOWN_LABEL = t('workspace.unknown');
const ELLIPSIS = String.fromCharCode(0x2026);

/** 渲染 → 文本 + 锚点集合（DOM 断言统一走这条，避免每处手写正则）。 */
function probe(input: Parameters<typeof renderWorkspaceBadge>[0]): {
  html: string; text: string; key: string | null; unknown: string | null;
} {
  const html = renderToStaticMarkup(createElement(renderWorkspaceBadge, input));
  // 去标签后的可见文本（严格转义由 React 负责，这里只剥标记取文案）。
  const text = html.replace(/<[^>]*>/g, '');
  const key = /data-anic-workspace-key="([^"]*)"/.exec(html)?.[1] ?? null;
  const unknown = /data-anic-workspace-unknown="([^"]*)"/.exec(html)?.[1] ?? null;
  return { html, text, key, unknown };
}

describe('① workspaceLabelOf：四种边界都有确定答案', () => {
  it('**null / undefined / 空串 → 未识别项目**（绝不返回空串）', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(workspaceLabelOf(v), `${String(v)} 必须显式说未识别`).toBe(UNKNOWN_LABEL);
    }
    // 未识别项目是**可见文案**，不是空串——空串会被读成"没有这回事"。
    expect(UNKNOWN_LABEL.length).toBeGreaterThan(0);
  });

  it('Windows 路径 → 末两段（保留项目尾名，丢掉盘根与中间层）', () => {
    expect(workspaceLabelOf('D:\\Projects\\TraeProjects\\dsh-anic')).toBe('TraeProjects/dsh-anic');
    expect(workspaceLabelOf('C:/Users/a/proj')).toBe('a/proj');
  });

  it('POSIX 路径 → 末两段（同样不显示绝对前缀）', () => {
    expect(workspaceLabelOf('/home/user/proj')).toBe('user/proj');
    // 单段路径（如容器里的 /app）不硬凑两段（不渲染成 "/app" 或 "app/"）。
    expect(workspaceLabelOf('/app')).toBe('app');
  });

  it('两种分隔符混写 → 归一到 `a/b`（标签形态稳定，不随输入分隔符抖动）', () => {
    const mixed = 'D:\\Projects/TraeProjects\\dsh-anic';
    expect(workspaceLabelOf(mixed)).toBe('TraeProjects/dsh-anic');
    expect(workspaceLabelOf(mixed)).toBe(workspaceLabelOf('D:/Projects/TraeProjects/dsh-anic'));
  });

  it('超长（>40 字符）→ 中间省略，且首尾仍在（标签仍可辨认）', () => {
    // 末两段本身就 30+ 字符：长项目名在 Windows 上也常见（末两段才是被显示的部分，
    // 若只用"路径很长但末两段很短"的夹具，省略分支根本没被触发——假绿）。
    const long = '/home/very-deeply/nested/chain/of/directories-many/final-project-name-with-a-long-tail';
    expect('directories-many/final-project-name-with-a-long-tail'.length).toBeGreaterThan(40);
    const label = workspaceLabelOf(long);
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label).toContain(ELLIPSIS);
    // 头（末两段的前一段）与尾（项目名）必须都还在，否则省略等于丢身份。
    expect(label.startsWith('directories')).toBe(true);
    expect(label.endsWith('long-tail')).toBe(true);
  });

  it('≤40 字符不省略（正例：证明省略分支不是恒真）', () => {
    const short = '/x/proj';
    expect(workspaceLabelOf(short)).toBe('x/proj');
    expect(workspaceLabelOf(short)).not.toContain(ELLIPSIS);
  });
});

describe('② workspaceBadgeOf：标签与身份键**同源**', () => {
  it('已知工作区 → unknown=false，key 是归一化身份键（不是原路径）', () => {
    const b = workspaceBadgeOf('D:\\Projects\\dsh-anic');
    expect(b.unknown).toBe(false);
    expect(b.label).toBe('Projects/dsh-anic');
    // key 走 workspaceGuard 的归一（Windows 小写），与载荷守卫同一身份口径。
    expect(b.key).toBe('d:/projects/dsh-anic');
  });

  it('**未识别 → unknown=true 且 key = UNKNOWN_WORKSPACE_KEY**', () => {
    const b = workspaceBadgeOf(null);
    expect(b.unknown).toBe(true);
    expect(b.key).toBe(UNKNOWN_WORKSPACE_KEY);
    expect(b.label).toBe(UNKNOWN_LABEL);
  });

  it('两种路径形态同项目 → 同一 key（视图不抖动、隔离口径一致）', () => {
    expect(workspaceBadgeOf('D:\\Project-A').key).toBe(workspaceBadgeOf('d:/project-a').key);
  });
});

describe('③ renderWorkspaceBadge：可见文案 + 锚点契约', () => {
  it('渲染 “项目 · 末两段”，带 key 与身份锚点', () => {
    const v = probe({ workspace: 'D:/Projects/TraeProjects/dsh-anic' });
    expect(v.text).toContain('TraeProjects/dsh-anic');
    expect(v.key).toBe('d:/projects/traeprojects/dsh-anic');
    expect(v.unknown).toBeNull(); // 已知工作区**不得**挂 unknown 锚点
    expect(v.html).toContain('data-anic-workspace-badge');
    // 可访问名存在（徽标是说明不是控件，但读屏必须能念出它在说工作区）。
    expect(/aria-label="[^"]{2,}"/.test(v.html)).toBe(true);
  });

  it('**未识别项目显式渲染**（不是空白、不是省略）', () => {
    const v = probe({ workspace: null });
    expect(v.text).toContain(UNKNOWN_LABEL);
    expect(v.text.trim().length).toBeGreaterThan(UNKNOWN_LABEL.length);
    expect(v.key).toBe(UNKNOWN_WORKSPACE_KEY);
    expect(v.unknown).toBe('true');
  });

  it('**UI 不出现绝对路径**（末两段口径：无盘符、无反斜杠）', () => {
    const v = probe({ workspace: 'D:\\Projects\\TraeProjects\\dsh-anic' });
    // 正例先证：标签本身在场（否则"没有盘符"可能只是什么都没渲）。
    expect(v.text).toContain('TraeProjects/dsh-anic');
    expect(v.text).not.toContain('D:');
    expect(v.text).not.toContain(':');
    expect(v.html).not.toContain(String.fromCharCode(92)); // 反斜杠（Windows 分隔符）
    // 末两段以外的路径段不得出现在可见文本里（这是"信息泄露"的真判据）。
    expect(v.text).not.toContain('Projects/TraeProjects');
  });
});

describe('④ crossProjectViewOf：跨项目态三态（无历史 / 有历史 / 畸形）', () => {
  it('**无跨项目历史 → present=false**（不留空壳、不伪造 0 次）', () => {
    for (const input of [null, undefined, {}, { crossProjectHistory: [] }, { crossProjectHistory: 'oops' }, 42, 'str']) {
      const v = crossProjectViewOf(input);
      expect(v.present, `${JSON.stringify(input)} 不该被判有跨项目态`).toBe(false);
      expect(v.count).toBe(0);
      expect(v.target).toBeNull();
    }
  });

  it('有历史 → present=true，取**最后一条**带工作区的记录为目标', () => {
    const v = crossProjectViewOf({
      crossProjectHistory: [
        { workspace: 'D:\\Projects\\other-a', kind: 'evaluate' },
        { workspace: 'D:/Projects/other-b', kind: 'iterate' },
      ],
    });
    expect(v.present).toBe(true);
    expect(v.count).toBe(2);
    expect(v.target).toBe('D:/Projects/other-b');
    // 目标标签同样是末两段（跨项目行也不泄露绝对路径）。
    expect(v.targetLabel).toBe('Projects/other-b');
  });

  it('末条缺 workspace 字段 → 向前回退到最后一条**有效**记录（不渲染空目标）', () => {
    const v = crossProjectViewOf({
      crossProjectHistory: [{ workspace: 'D:/Projects/other-a' }, { kind: 'evaluate' }, null],
    });
    expect(v.present).toBe(true);
    expect(v.count).toBe(3);
    expect(v.target).toBe('D:/Projects/other-a');
  });

  it('全部条目都无有效 workspace → present=true 但 target=null（如实：有跨项目态、无目标）', () => {
    const v = crossProjectViewOf({ crossProjectHistory: [{ kind: 'evaluate' }, { workspace: '' }] });
    expect(v.present).toBe(true);
    expect(v.count).toBe(2);
    expect(v.target).toBeNull();
    expect(v.targetLabel).toBeNull();
  });
});

describe('⑤ 跨项目可视化：源项目与目标项目同屏（D2）', () => {
  it('有跨项目历史 → 渲染「跨项目」标记 + 目标 + 次数三件', () => {
    const v = probe({
      workspace: 'D:/Projects/TraeProjects/dsh-anic',
      bootstrap: { crossProjectHistory: [{ workspace: 'D:/Projects/other-proj' }] },
    });
    expect(v.html).toContain('data-anic-workspace-cross="true"');
    expect(v.html).toContain('data-anic-cross-target="Projects/other-proj"');
    expect(v.html).toContain('data-anic-cross-count="1"');
    expect(v.text).toContain('dsh-anic'); // 源项目名在同屏
    expect(v.text).toContain('other-proj'); // 目标项目名在同屏
  });

  it('**无跨项目历史 → 不渲染跨项目段**（零占位，不改变既有布局）', () => {
    const plain = probe({ workspace: 'D:/Projects/dsh-anic' });
    const withEmpty = probe({ workspace: 'D:/Projects/dsh-anic', bootstrap: { crossProjectHistory: [] } });
    expect(plain.html).not.toContain('data-anic-workspace-cross');
    expect(withEmpty.html).not.toContain('data-anic-workspace-cross');
    // 反向自检：同一判据在有历史的树上必须命中（否则"没有"是恒真）。
    expect(probe({ workspace: 'D:/Works', bootstrap: { crossProjectHistory: [{ workspace: 'D:/B' }] } }).html)
      .toContain('data-anic-workspace-cross');
  });

  it('跨项目行里次数随条目数变化（不是固定文案）', () => {
    const one = probe({ workspace: 'D:/A', bootstrap: { crossProjectHistory: [{ workspace: 'D:/B' }] } });
    const two = probe({ workspace: 'D:/A', bootstrap: { crossProjectHistory: [{ workspace: 'D:/B' }, { workspace: 'D:/C' }] } });
    expect(one.html).toContain('data-anic-cross-count="1"');
    expect(two.html).toContain('data-anic-cross-count="2"');
    expect(one.text).not.toBe(two.text);
  });
});

describe('⑥ 词表键：zh/en 同步且占位符一致（本任务独占 locale 写权）', () => {
  it('workspace.* 六键两端齐全（单边加键会让 parity 契约红）', () => {
    const zh = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'locale', 'zh.json'), 'utf8')) as Record<string, Record<string, string>>;
    const en = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'locale', 'en.json'), 'utf8')) as Record<string, Record<string, string>>;
    const keys = ['badge', 'badgeAria', 'unknown', 'crossProject', 'crossProjectLine', 'crossProjectCount'];
    expect(Object.keys(zh['workspace'] ?? {}).sort()).toEqual(keys.slice().sort());
    expect(Object.keys(en['workspace'] ?? {}).sort()).toEqual(keys.slice().sort());
    // 占位符名两端必须相同（en 换名会让插值静默丢参）。
    for (const k of ['badge', 'badgeAria', 'crossProjectLine', 'crossProjectCount']) {
      const ph = (s: string): string[] => (s.match(/\{[a-z]+\}/g) ?? []).sort();
      expect(ph(zh['workspace']?.[k] ?? ''), k + ' 占位符不一致').toEqual(ph(en['workspace']?.[k] ?? ''));
    }
  });
});

describe('⑦ store 绑定组件（装配层那一行的可测形态）', () => {
  /*
   * 装配层（`WorkflowGraphPanel.ts`，Lead 独占）只需要一行：
   *   createElement(WorkspaceBadge, { store, key: 'workspace-badge' })
   *
   * 本组在这里先把那一行**跑起来**：证明它读的是既有切片（config.workspace 与
   * bootstrap），而不是某个新端点的自造字段。这样 Lead 收口时不是在"接一个没跑过
   * 的组件"——接线的语义已经在测试里成立过一次。
   */
  const mount = (workspace: string | null, bootstrap: unknown): string => {
    const store = createPanelStore(createInitialPanelState());
    // 直接写切片（与 panelPeriodicTarget 的 apply 同一形态：整片替换）。
    store.setState({
      config: workspace === null ? null : ({ workspace } as PanelState['config']),
      bootstrap: bootstrap as PanelState['bootstrap'],
    });
    return renderToStaticMarkup(createElement(WorkspaceBadge, { store }));
  };

  it('config 已拉到 → 渲染真实工作区标签', () => {
    const html = mount('D:/Projects/TraeProjects/dsh-anic', null);
    expect(html).toContain('TraeProjects/dsh-anic');
    expect(html).not.toContain('data-anic-workspace-unknown');
  });

  it('**config 未拉到 → 如实显示未识别项目**（不渲染空白，也不猜路径）', () => {
    const html = mount(null, null);
    expect(html).toContain(UNKNOWN_LABEL);
    expect(html).toContain('data-anic-workspace-unknown="true"');
    expect(html).toContain(UNKNOWN_WORKSPACE_KEY);
  });

  it('bootstrap 切片带跨项目历史 → 徽标同时出跨项目段（两切片各读一半）', () => {
    const html = mount('D:/A', { status: 'IDLE', crossProjectHistory: [{ workspace: 'D:/B' }] });
    expect(html).toContain('data-anic-workspace-cross="true"');
    expect(html).toContain('data-anic-cross-target="B"');
  });
});
