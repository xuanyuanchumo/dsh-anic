/**
 * 注册面捕获器（cycle-74 T-7405）——注册期边转发边记录，供渐进式披露加载器读取。
 *
 * 为什么需要它（**真实运行时环**的解法，cycle-74 实测）：
 * 披露加载器（`anic_tool_detail` / `anic_tools_search`）要回答「本插件有哪些工具」，
 * 但若它自己 `import toolsFaceCapture`，就会形成环：
 *
 *   tools.ts → toolsIndexLoaderGateway.ts → toolsFaceCapture.ts → tools.ts
 *
 * （importGraph 契约立刻红；且这不只是静态检测问题——运行时初始化顺序同样危险。）
 *
 * 解法是**依赖倒置**：聚合器（tools.ts）本来就逐条持有注册定义，
 * 让它顺手记录并把这个读取闭包**注入**加载器。责任天然归属、环自然消失。
 *
 * 与 `toolsFaceCapture.captureRegisteredFaces()` 的分工：
 *   - 本模块：**注册路径**用（边注册边记，零额外遍历，不重复构造 stub ctx）；
 *   - toolsFaceCapture：**测试与离线工具**用（以 stub ctx 重放一次注册以取全量面）。
 * 两者口径必须一致（同取 name/description/parameters），由契约测试对账。
 */
import type { ToolsSlot, ToolRegistration } from './toolsSlot.ts';
import { wireGuard } from './toolsSlot.ts';
import type { ToolFace } from './capabilityIndex.ts';
import { createScoped } from './logger.ts';

/** 注册面记录器：`reg` 转发到真注册，`faces()` 返回已记录的面（保序 = 注册序）。 */
export interface FaceRecorder {
  reg: (t: ToolRegistration) => (() => void) | null;
  faces: () => ToolFace[];
}

/**
 * 构造记录器（`tools` 为已探测到的宿主槽位）。
 *
 * ★cycle-82（可观测性收口）：这里同时是**工具出口的唯一收口点**。
 * 聚合器 tools.ts 的全部 23 个工具（含各 gateway 内的）都逐条经本 `reg` 注册，
 * 故 `wireGuard` 挂在此处即覆盖全体，无需在 20 处 `execute` 上逐个补丁
 * （逐个补丁的保修期到下一个可选字段为止 —— 见 toolsSlot.wireGuard 头注）。
 * `captured` 记录的是**注册定义**（name/description/parameters），与出口值的
 * sanitize 无关；两者顺序保持「先记录后注册」，避免注册抛错时记录一条幽灵面。
 *
 * ★cycle-99（last-good 回退，借鉴 dsh-ops session-shells:177-193）：同名工具
 * 重注册失败时自动回退重注册**上一次成功的定义**——热重载场景下，新代码注册
 * 抛错不该让该工具从宿主里消失（旧定义还在被会话引用）；双重失败才向上抛。
 * 语义对齐：回退的 disposer 交给调用方（与正常注册同形）。
 */
export function createFaceRecorder(tools: ToolsSlot): FaceRecorder {
  const captured: ToolFace[] = [];
  const lastGood = new Map<string, ToolRegistration>();
  const reg = (t: ToolRegistration): (() => void) | null => {
    captured.push({ name: t.name, description: t.description, parameters: t.parameters });
    try {
      const disposer = tools.register!(wireGuard(t)) ?? null;
      lastGood.set(t.name, t);
      return disposer;
    } catch (err) {
      const prev = lastGood.get(t.name);
      if (prev === undefined) throw err; // 首注册无兜底 → 响亮失败
      const log = createScoped('anic.tools');
      log.warn(`tool ${t.name} re-register failed (${message}) — rolled back to last-good definition`);
      const disposer = tools.register!(wireGuard(prev)) ?? null;
      captured[captured.length - 1] = { name: prev.name, description: prev.description, parameters: prev.parameters };
      return disposer;
    }
  };
  return { reg, faces: () => captured.slice() };
}

/** 错误消息提取（reg 的 catch 用；非 Error 一律 String 化）。 */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
