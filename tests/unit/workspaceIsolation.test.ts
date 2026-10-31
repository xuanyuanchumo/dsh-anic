/**
 * 多项目隔离契约（cycle-89）—— **三道防线**。
 *
 * ## 被守卫的缺口（实测）
 *
 * `usePanelFetch` 的轮询层此前**没有任何工作区隔离**：`X-ANIC-Workspace` 头是
 * 「首个成功快照响应」学到的，面板**不校验返回载荷属于哪个工作区**。
 * 宿主切到另一个项目时，旧项目的响应仍会 apply 进当前 store —— **串味**。
 *
 * ## 三道防线
 *
 * 1. **载荷守卫**（`acceptPayload`）：响应体声明的工作区与期望不符 → 拒绝应用。
 * 2. **在途丢弃**（世代号）：切工作区后到达的旧响应 → 丢弃。
 * 3. **分键视图态**：缩放/平移/筛选按工作区分键 → 互不污染。
 */
import { describe, expect, it } from 'vitest';
import {
  acceptPayload,
  createEpochGuard,
  declaredWorkspaceOf,
  normalizeWorkspace,
  sameWorkspace,
  workspaceKeyOf,
  UNKNOWN_WORKSPACE_KEY,
} from '../../src/client/components/workspaceGuard.ts';
import {
  createMemoryViewStateStore,
  createViewStateStore,
  loadViewState,
  saveViewState,
} from '../../src/client/components/workspaceViewState.ts';
// cycle-95 WS-D：徽标纯函数（与守卫同源身份键）。
import {
  workspaceBadgeOf,
  workspaceLabelOf,
} from '../../src/client/features/org/workspaceBadge.ts';

describe('normalizeWorkspace：路径归一', () => {
  it('反斜杠 → 正斜杠', () => {
    expect(normalizeWorkspace('D:\\Projects\\dsh-anic')).toBe('d:/projects/dsh-anic');
  });

  it('去尾部斜杠', () => {
    expect(normalizeWorkspace('/home/user/proj/')).toBe('/home/user/proj');
    expect(normalizeWorkspace('/home/user/proj///')).toBe('/home/user/proj');
  });

  it('**Windows 盘符大小写不敏感**', () => {
    expect(normalizeWorkspace('D:\\Proj')).toBe(normalizeWorkspace('d:/proj'));
    expect(sameWorkspace('D:\\Projects\\X', 'd:/projects/x')).toBe(true);
  });

  it('**POSIX 路径大小写敏感**（不归一）', () => {
    expect(sameWorkspace('/home/User/proj', '/home/user/proj')).toBe(false);
  });

  it('空串永不相等', () => {
    expect(sameWorkspace('', '')).toBe(false);
  });
});

describe('workspaceKeyOf：分键', () => {
  it('未知工作区 → 固定键（**不用空串**）', () => {
    expect(workspaceKeyOf(null)).toBe(UNKNOWN_WORKSPACE_KEY);
    expect(workspaceKeyOf(undefined)).toBe(UNKNOWN_WORKSPACE_KEY);
    expect(workspaceKeyOf('')).toBe(UNKNOWN_WORKSPACE_KEY);
    expect(workspaceKeyOf('   ')).toBe(UNKNOWN_WORKSPACE_KEY);
  });

  it('已知工作区 → 归一后的键', () => {
    expect(workspaceKeyOf('D:\\A')).toBe('d:/a');
  });
});

describe('declaredWorkspaceOf：读载荷的工作区标识', () => {
  it('多种常见形态都能读出', () => {
    expect(declaredWorkspaceOf({ workspace: 'D:/a' })).toBe('d:/a');
    expect(declaredWorkspaceOf({ workspaceRoot: 'D:/a' })).toBe('d:/a');
    expect(declaredWorkspaceOf({ root: 'D:/a' })).toBe('d:/a');
    expect(declaredWorkspaceOf({ data: { workspace: 'D:/a' } })).toBe('d:/a');
  });

  it('无标识 → null', () => {
    expect(declaredWorkspaceOf({ foo: 1 })).toBeNull();
    expect(declaredWorkspaceOf([])).toBeNull();
    expect(declaredWorkspaceOf(null)).toBeNull();
    expect(declaredWorkspaceOf('str')).toBeNull();
  });
});

describe('acceptPayload：载荷守卫（防线一）', () => {
  it('**工作区不符 → 拒绝**（串味防线生效）', () => {
    const v = acceptPayload('D:/project-a', { workspace: 'D:/project-b' });
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain('不符');
    expect(v.declared).toBe('d:/project-b');
  });

  it('工作区一致 → 放行', () => {
    const v = acceptPayload('D:/project-a', { workspace: 'D:/project-a' });
    expect(v.accepted).toBe(true);
    expect(v.declared).toBe('d:/project-a');
  });

  it('**载荷无工作区标识 → 放行**（多数端点本就没有该字段）', () => {
    const v = acceptPayload('D:/project-a', { entries: [], total: 0 });
    expect(v.accepted).toBe(true);
    expect(v.declared).toBeNull();
    expect(v.reason).toContain('无串味证据');
  });

  it('**期望工作区未知 → 放行**（无从证伪）', () => {
    const v = acceptPayload(null, { workspace: 'D:/whatever' });
    expect(v.accepted).toBe(true);
  });

  it('路径形态不同但同项目 → 放行（归一生效）', () => {
    const v = acceptPayload('D:\\Project-A', { workspace: 'd:/project-a' });
    expect(v.accepted).toBe(true);
  });

  it('拒绝理由**始终有值**（不能只说「失败」）', () => {
    const v = acceptPayload('D:/a', { workspace: 'D:/b' });
    expect(v.reason.length).toBeGreaterThan(0);
  });
});

describe('createEpochGuard：在途丢弃（防线二）', () => {
  it('初始世代号有效', () => {
    const g = createEpochGuard();
    expect(g.isCurrent(g.current)).toBe(true);
  });

  it('**advance 后旧世代号失效**', () => {
    const g = createEpochGuard();
    const old = g.current;
    g.advance();
    expect(g.isCurrent(old)).toBe(false);
    expect(g.isCurrent(g.current)).toBe(true);
  });

  it('多次 advance 累积', () => {
    const g = createEpochGuard(0);
    expect(g.advance()).toBe(1);
    expect(g.advance()).toBe(2);
    expect(g.current).toBe(2);
  });
});

describe('防线四：当前工作区**可见性**（cycle-95 WS-D）', () => {
  /*
   * 前三道防线都在数据层：串味被拦住了，但界面上没有任何东西告诉用户
   * "你现在看的是哪个项目"。隔离在数据层成立、在视觉层不可见，等于用户
   * 只能靠猜——这正是用户点名的「不能污染」在可观测性上的缺口。
   *
   * 本组的判据只有一条：**徽标的身份键必须就是守卫的身份键**。两处各算一份
   * 归一化，"同一项目两种路径形态"会在徽标上显示为一个、在守卫里判成另一个。
   */
  it('**徽标身份键 ⇄ 守卫分键同源**（同一路径形态两种写法的 key 相等）', () => {
        for (const [a, b] of [
      ['D:\\Project-A', 'd:/project-a'],
      ['D:\\Projects\\X', 'D:/projects/x/'],
      ['/home/user/proj', '/home/user/proj'],
    ] as const) {
      expect(workspaceBadgeOf(a).key, `${a} vs ${b}`).toBe(workspaceKeyOf(b));
    }
  });

  it('**未识别工作区 → 徽标与守卫都用同一个固定键**（不是各自编一个）', () => {
        for (const v of [null, undefined, '', '   ']) {
      expect(workspaceBadgeOf(v).key).toBe(UNKNOWN_WORKSPACE_KEY);
      expect(workspaceBadgeOf(v).unknown).toBe(true);
    }
    // 反向自检：真实工作区不得被判成未识别（否则上面三条是恒真）。
    expect(workspaceBadgeOf('D:/a').unknown).toBe(false);
  });

  it('徽标标签只含末两段（**绝对路径不进可见面**）', () => {
        const label = workspaceLabelOf('D:\\Projects\\TraeProjects\\dsh-anic');
    expect(label).toBe('TraeProjects/dsh-anic');
    expect(label).not.toContain('D:');
    expect(label).not.toContain(String.fromCharCode(92));
  });

  it('**同一 store 切片口径**：config.workspace 与快照头学得的工作区归一到同一个键', () => {
    // config 响应里的 workspace 是原始路径，快照响应头学得的那份也是原始路径；
    // 面板用其中任一个构造徽标，身份键必须相同（否则两拍之间标签会跳）。
        const fromConfig = 'D:\\Projects\\TraeProjects\\dsh-anic';
    const fromHeader = decodeURIComponent('D%3A%5CProjects%5CTraeProjects%5Cdsh-anic');
    expect(workspaceBadgeOf(fromConfig).key).toBe(workspaceBadgeOf(fromHeader).key);
    expect(workspaceBadgeOf(fromConfig).label).toBe(workspaceBadgeOf(fromHeader).label);
  });
});

describe('分键视图态（防线三）', () => {
  it('**两个工作区的视图态互不污染**', () => {
    const store = createMemoryViewStateStore();
    saveViewState(store, 'D:/project-a', { zoom: 2 });
    saveViewState(store, 'D:/project-b', { zoom: 0.5 });
    expect(loadViewState(store, 'D:/project-a')?.zoom).toBe(2);
    expect(loadViewState(store, 'D:/project-b')?.zoom).toBe(0.5);
  });

  it('路径形态不同但同项目 → 同一份视图态', () => {
    const store = createMemoryViewStateStore();
    saveViewState(store, 'D:\\Project-A', { zoom: 3 });
    expect(loadViewState(store, 'd:/project-a')?.zoom).toBe(3);
  });

  it('**不存在 → null**（不返回空对象伪装成默认值）', () => {
    const store = createMemoryViewStateStore();
    expect(loadViewState(store, 'D:/never-seen')).toBeNull();
  });

  it('未知工作区 → 固定键下的一份视图态', () => {
    const store = createMemoryViewStateStore();
    saveViewState(store, null, { zoom: 1.5 });
    expect(loadViewState(store, undefined)?.zoom).toBe(1.5);
    // 与真实工作区不共享。
    expect(loadViewState(store, 'D:/a')).toBeNull();
  });

  it('**localStorage 不可用 → 降级到内存，不抛错**', () => {
    const store = createViewStateStore('anic.test.viewState');
    // 不抛错即可（无论走 localStorage 还是内存路径）。
    expect(() => { saveViewState(store, 'D:/a', { zoom: 2 }); }).not.toThrow();
    expect(loadViewState(store, 'D:/a')?.zoom).toBe(2);
  });

  it('createViewStateStore 在无 localStorage 环境不抛错', () => {
    expect(() => { createViewStateStore('anic.test.viewState2'); }).not.toThrow();
  });
});
