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
import type { ToolFace } from './capabilityIndex.ts';

/** 注册面记录器：`reg` 转发到真注册，`faces()` 返回已记录的面（保序 = 注册序）。 */
export interface FaceRecorder {
  reg: (t: ToolRegistration) => (() => void) | null;
  faces: () => ToolFace[];
}

/** 构造记录器（`tools` 为已探测到的宿主槽位）。 */
export function createFaceRecorder(tools: ToolsSlot): FaceRecorder {
  const captured: ToolFace[] = [];
  const reg = (t: ToolRegistration): (() => void) | null => {
    captured.push({ name: t.name, description: t.description, parameters: t.parameters });
    return tools.register!(t) ?? null;
  };
  return { reg, faces: () => captured.slice() };
}
