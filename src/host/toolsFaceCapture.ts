/**
 * 注册面捕获（cycle-73 T-7301）——「宿主真正会收到的工具定义」的**唯一**取法。
 *
 * 为什么抽出来：生成器（scripts/generate-capability-index.mjs）、契约测试
 *（tests/contract/capabilityIndexContract.test.ts）与运行时探针（P7）都需要注册面。
 * 三处各写一份捕获逻辑 = 三条会向坏方向漂移的同义实现（CLAUDE.md 单一实现纪律，
 * 本仓既有先例：配置读取第二入口即架构违规 INV-25）。
 *
 * 取法说明：以 stub ctx 调 `registerAnicTools` 并截获 `tools.register` 收到的定义。
 * 这是**注册真相**（宿主拿到的就是这些），不是对源码文本的正则提取——
 * 索引要记 `parameters` 的 canonical 哈希，而嵌套 JSON Schema 的正则提取不可靠。
 *
 * 纯函数、零副作用：不写盘、不改全局状态。
 */
import { registerAnicTools } from './tools.ts';
import type { ToolFace } from './capabilityIndex.ts';

/**
 * 捕获本插件注册的全部工具定义（保序 = 注册序）。
 *
 * stub ctx 只提供 `register`：真实宿主还会校验 output、注入 exec 等，
 * 但那些都不影响 name/description/parameters 三字段的取值。
 */
export function captureRegisteredFaces(): ToolFace[] {
  const registered: ToolFace[] = [];
  const ctx = {
    tools: {
      register: (t: ToolFace): (() => void) => {
        registered.push({ name: t.name, description: t.description, parameters: t.parameters });
        return () => undefined;
      },
    },
    get: () => undefined,
    workspaceRegistry: { list: () => [] },
  };
  registerAnicTools(ctx);
  return registered;
}
